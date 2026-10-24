// The phone scanner (SCREENS.md §4), for every role with the check-in permission (QR scanner, reception, hospital
// admin). A scanned code is verified and checked in at once; a booking number is looked up first, and the staff member
// confirms the patient's identity before checking in. Details are shown only for this hospital's bookings, never for
// another hospital's or an unknown code.
import type { Hono } from "hono";
import { permission, route } from "../app.ts";
import { record } from "../attendance.ts";
import { Scopes, type Tx } from "../db.ts";
import { body, type Ctx, deps, type Env, json, principal, raw, str } from "../http.ts";
import { tokenHash } from "../security.ts";
import { localDate, localTime } from "../tz.ts";
import { parseGuid } from "./bookings.ts";

interface Row {
  id: string;
  ref: string;
  patient_name: string | null;
  slot_start: Date;
  status: string;
  arrived_at: Date | null;
  anonymized_at: Date | null;
  dep_ar: string;
  dep_en: string | null;
  dep_tr: string | null;
  timezone: string;
}

const select = (tx: Tx) =>
  tx`
  SELECT b.id, b.ref, b.patient_name, b.slot_start, b.status, b.arrived_at, b.anonymized_at,
         d.name_ar AS dep_ar, d.name_en AS dep_en, d.name_tr AS dep_tr, h.timezone
  FROM bookings b JOIN departments d ON d.id = b.department_id JOIN hospitals h ON h.id = b.hospital_id`;

/** The result card: kind (design table) and, for this hospital's bookings only, the facts. */
function card(c: Ctx, kind: string, b?: Row, bookingId: string | null = null) {
  if (!b) return json(c, { kind });
  return json(c, {
    kind,
    bookingId,
    booking: {
      ref: b.ref,
      patientName: b.patient_name,
      date: localDate(b.slot_start, b.timezone),
      time: localTime(b.slot_start, b.timezone),
      department: { ar: b.dep_ar, en: b.dep_en, tr: b.dep_tr },
      arrivedAt: b.arrived_at ? localTime(b.arrived_at, b.timezone) : null,
    },
  });
}

/** Classifies a booking of this hospital before any check-in: cancelled, other day, already in, or ready. */
function classify(b: Row, now: Date): string {
  if (b.status === "cancelled") return "cancelled";
  if (localDate(b.slot_start, b.timezone) !== localDate(now, b.timezone)) return "otherday";
  if (b.status === "arrived") return "already";
  return "ready";
}

export function scanRoutes(app: Hono<Env>) {
  // Scan: verify the code, then check in at once (source "qr"). A repeated clientEventId is applied once.
  route(app, "POST", "/scan/qr", permission("CheckIn"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b0 = await body(c);
    const code = str(b0, "code")?.trim() ?? "";
    const clientEventId = parseGuid(raw(b0, "clientEventId"), "clientEventId");
    if (!/^MLK1\.[A-Za-z0-9_-]{22}$/.test(code)) return card(c, "bad");
    const hash = await tokenHash(code);
    const now = d.now();
    const result = await d.db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const [b] = await tx<Row[]>`${select(tx)} WHERE b.qr_token_hash = ${hash} AND b.hospital_id = ${p.hospitalId} FOR UPDATE OF b`;
      if (!b) return null;
      // Anonymised after the retention period: the code is no longer valid.
      if (b.anonymized_at !== null) return { kind: "bad" as string, row: undefined as Row | undefined };
      const kind = classify(b, now);
      if (kind !== "ready") return { kind, row: b };
      const r = await record(tx, {
        hospitalId: p.hospitalId!, bookingId: b.id, type: "arrived", source: "qr", at: now,
        actorId: p.userId, deviceId: null, clientEventId, reason: null,
      }, now);
      const [after] = await tx<Row[]>`${select(tx)} WHERE b.id = ${b.id}`;
      // A manual correction outranks a scan (approved policy): the scan is recorded, the status stays as corrected.
      return { kind: after.status === "arrived" ? (r.outcome === "duplicate" ? "already" : "ok") : "corrected", row: after };
    });
    if (result !== null) return card(c, result.kind, result.row);
    // Not this hospital's: say whether it is another hospital's booking, without any detail.
    const [{ elsewhere }] = await d.db.run(Scopes.system, (tx) => tx<{ elsewhere: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM bookings WHERE qr_token_hash = ${hash} AND anonymized_at IS NULL) AS elsewhere`);
    return card(c, elsewhere ? "other" : "bad");
  });

  // Manual: by the full booking number of this hospital only (another hospital's number is simply "not found").
  route(app, "GET", "/scan/lookup", permission("CheckIn"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const q = (c.req.query("ref") ?? "").trim().toUpperCase();
    if (!/^ML-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(q)) return card(c, "notfound");
    const [b] = await d.db.run(Scopes.hospital(p.hospitalId), (tx) =>
      tx<Row[]>`${select(tx)} WHERE b.ref = ${q} AND b.hospital_id = ${p.hospitalId} AND b.anonymized_at IS NULL`);
    if (!b) return card(c, "notfound");
    const kind = classify(b, d.now());
    return card(c, kind === "ready" ? "found" : kind, b, kind === "ready" ? b.id : null);
  });

  // Manual check-in after the identity check (source "reception": a person checked it, not a scanned code).
  route(app, "POST", "/scan/checkin", permission("CheckIn"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b0 = await body(c);
    const bookingId = str(b0, "bookingId");
    const clientEventId = parseGuid(raw(b0, "clientEventId"), "clientEventId");
    if (!bookingId) return card(c, "notfound");
    const now = d.now();
    const r = await d.db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const [b] = await tx<Row[]>`${select(tx)} WHERE b.id = ${bookingId} AND b.hospital_id = ${p.hospitalId} AND b.anonymized_at IS NULL FOR UPDATE OF b`;
      if (!b) return { kind: "notfound", row: undefined as Row | undefined };
      const kind = classify(b, now);
      if (kind !== "ready") return { kind, row: b };
      const rr = await record(tx, {
        hospitalId: p.hospitalId!, bookingId: b.id, type: "arrived", source: "reception", at: now,
        actorId: p.userId, deviceId: null, clientEventId, reason: null,
      }, now);
      const [after] = await tx<Row[]>`${select(tx)} WHERE b.id = ${b.id}`;
      return { kind: after.status === "arrived" ? (rr.outcome === "duplicate" ? "already" : "ok") : "corrected", row: after };
    });
    return card(c, r.kind, r.row);
  });
}
