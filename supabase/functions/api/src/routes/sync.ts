// Windows-app sync (BACKEND-SPEC §5): devices pull booking changes after a sequence number and push attendance events
// from a local outbox. Events carry a client_event_id, so a retried push never applies twice. The local database is
// never trusted for permissions: every pushed event is re-checked here.
import type { Hono } from "hono";
import { permission, route, signedIn } from "../app.ts";
import { record, type RecordResult } from "../attendance.ts";
import { audit, Scopes, type Tx } from "../db.ts";
import { BadRequest, body, type Ctx, deps, type Env, json, principal, raw, requireJsonType, str } from "../http.ts";
import { has, type Principal } from "../permissions.ts";
import { Ids } from "../security.ts";
import { addDays, dayStartUtc, localDate, localTime } from "../tz.ts";
import { MinReason, parseGuid, parseInstant } from "./bookings.ts";

export const MaxActiveDevices = 25, PullPageSize = 500, MaxPushEvents = 200;

const err = (c: Ctx, code: string, status: number) => json(c, { error: code }, status);

/** The device must belong to the caller's hospital and not be revoked. */
async function deviceOk(tx: Tx, deviceId: string | null, hospitalId: string): Promise<boolean> {
  const [{ ok }] = await tx<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM devices WHERE id = ${deviceId} AND hospital_id = ${hospitalId} AND revoked_at IS NULL) AS ok`;
  return ok;
}

function queryNumber(c: Ctx, name: string): number | null {
  const v = c.req.query(name);
  if (v === undefined || v === "") return null;
  if (!/^-?\d{1,18}$/.test(v)) throw new BadRequest(name);
  return Number(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PushEvent {
  clientEventId: string | null;
  bookingId: string | null;
  ref: string | null;
  type: string | null;
  source: string | null;
  at: Date | null;
  reason: string | null;
}

function parsePushEvent(v: unknown): PushEvent {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("event");
  const o = v as Record<string, unknown>;
  return {
    clientEventId: parseGuid(raw(o, "clientEventId"), "clientEventId"),
    bookingId: str(o, "bookingId"),
    ref: str(o, "ref"),
    type: str(o, "type"),
    source: str(o, "source"),
    at: parseInstant(raw(o, "at"), "at"),
    reason: str(o, "reason"),
  };
}

async function pushOne(tx: Tx, p: Principal, deviceId: string, e: PushEvent, now: Date): Promise<RecordResult> {
  const rejected = (code: string): RecordResult => ({ outcome: "rejected", code, state: null, ref: null });
  if (e.clientEventId === null || e.at === null) return rejected("INVALID");
  const source = e.source ?? "reception";
  if (source !== "reception" && source !== "correction") return rejected("SOURCE_INVALID");
  // Permissions come from the server-side session, never from the device's local copy.
  if (source === "reception" && (e.type !== "arrived" || !has(p.roles, "CheckIn"))) return rejected("FORBIDDEN");
  if (source === "correction") {
    if (!has(p.roles, "AttendanceCorrect")) return rejected("FORBIDDEN");
    if (!(e.type === "arrived" || e.type === "no_show" || e.type === "waiting")) return rejected("TYPE_INVALID");
    if (e.reason === null || e.reason.trim().length < MinReason || e.reason.trim().length > 300) return rejected("REASON_REQUIRED");
  }
  // Offline check-in is by booking number only (owner's decision); the device may send the id when it has it.
  let bookingId = e.bookingId;
  if (bookingId === null && e.ref !== null) {
    const [r] = await tx<{ id: string }[]>`SELECT id FROM bookings WHERE hospital_id = ${p.hospitalId} AND ref = ${e.ref.trim().toUpperCase()}`;
    bookingId = r?.id ?? null;
  }
  if (bookingId === null) return rejected("NOT_FOUND");
  return await record(tx, {
    hospitalId: p.hospitalId!, bookingId, type: e.type!, source, at: e.at, actorId: p.userId, deviceId,
    clientEventId: e.clientEventId, reason: source === "correction" ? e.reason!.trim() : null,
  }, now);
}

export function syncRoutes(app: Hono<Env>) {
  // ---------------------------------------------------------------- devices
  route(app, "POST", "/sync/devices", permission("HospitalRead"), async (c) => {
    const p = principal(c);
    const name = str(await body(c), "name")?.trim() ?? "";
    if (!name || name.length > 80) return err(c, "NAME_REQUIRED", 422);
    return await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7240200, hashtext(${p.hospitalId}))`;
      const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM devices WHERE hospital_id = ${p.hospitalId} AND revoked_at IS NULL`;
      if (n >= MaxActiveDevices) return err(c, "DEVICE_LIMIT", 409);
      const id = Ids.device();
      await tx`INSERT INTO devices (id, hospital_id, name, registered_by) VALUES (${id}, ${p.hospitalId}, ${name}, ${p.userId})`;
      await audit(tx, p.userId, p.hospitalId, "device_register", id);
      return json(c, { deviceId: id }, 201);
    });
  });

  route(app, "GET", "/hospital/devices", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const rows = await deps(c).db.run(Scopes.hospital(p.hospitalId), (tx) =>
      tx<{ id: string; name: string; registered_by: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null }[]>`
        SELECT d.id, d.name, u.email::text AS registered_by, d.created_at, d.last_seen_at, d.revoked_at
        FROM devices d JOIN users u ON u.id = d.registered_by WHERE d.hospital_id = ${p.hospitalId} ORDER BY d.revoked_at NULLS FIRST, d.created_at`);
    return json(c, {
      devices: rows.map((d) => ({
        id: d.id, name: d.name, registeredBy: d.registered_by, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revoked: d.revoked_at !== null,
      })),
      maxActive: MaxActiveDevices,
    });
  });

  route(app, "POST", "/hospital/devices/:id/revoke", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    requireJsonType(c);
    const n = await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const r = await tx`UPDATE devices SET revoked_at = now() WHERE id = ${id} AND hospital_id = ${p.hospitalId} AND revoked_at IS NULL`;
      if (r.count > 0) await audit(tx, p.userId, p.hospitalId, "device_revoke", id);
      return r.count;
    });
    return n === 0 ? err(c, "NOT_FOUND", 404) : json(c, { status: "ok" });
  });

  // ---------------------------------------------------------------- pull
  // Bookings from yesterday to +30 days (hospital time) that changed after `since`. With `wait`, the call holds for up
  // to 25 s until something changes (long-poll), so a QR check-in shows up without a refresh.
  route(app, "GET", "/sync/pull", signedIn, async (c) => {
    const p = principal(c);
    const d = deps(c);
    const canSeeAll = has(p.roles, "BookingsView");
    if (!canSeeAll && !has(p.roles, "BookingsViewOwnDepartment")) return err(c, "FORBIDDEN", 403);
    const deviceId = c.req.query("deviceId") ?? null;
    const after = Math.max(0, queryNumber(c, "since") ?? 0);
    const wait = Math.min(Math.max(queryNumber(c, "wait") ?? 0, 0), 25);
    // Real time (not the injectable clock): the wait is about this request, not about booking times.
    const deadline = Date.now() + wait * 1000;
    while (true) {
      const result = await d.db.run(Scopes.hospital(p.hospitalId), async (tx) => {
        if (!await deviceOk(tx, deviceId, p.hospitalId!)) return { done: true, res: err(c, "DEVICE_REVOKED", 403) };
        const [h] = await tx<{ name_ar: string; name_en: string; name_tr: string | null; timezone: string; grace: number }[]>`
          SELECT name_ar, name_en, name_tr, timezone, no_show_grace_min AS grace FROM hospitals WHERE id = ${p.hospitalId}`;
        const today = localDate(d.now(), h.timezone);
        const from = dayStartUtc(addDays(today, -1), h.timezone), to = dayStartUtc(addDays(today, 31), h.timezone);
        const rows = await tx<
          { id: string; ref: string; department_id: string; slot_start: Date; patient_name: string | null; phone: string | null; status: string; arrived_at: Date | null; needs_review: boolean; sync_seq: number; created_at: Date }[]
        >`
          SELECT b.id, b.ref, b.department_id, b.slot_start, b.patient_name, b.phone, b.status, b.arrived_at, b.needs_review, b.sync_seq, b.created_at
          FROM bookings b
          WHERE b.hospital_id = ${p.hospitalId} AND b.sync_seq > ${after} AND b.slot_start >= ${from} AND b.slot_start < ${to}
          ${canSeeAll ? tx`` : tx`AND b.department_id IN (SELECT department_id FROM doctor_departments WHERE user_id = ${p.userId})`}
          ORDER BY b.sync_seq LIMIT ${PullPageSize + 1}`;
        const more = rows.length > PullPageSize;
        if (more) rows.pop();
        if (rows.length === 0 && Date.now() < deadline) return { done: false, res: null };
        const cursor = rows.length > 0 ? rows[rows.length - 1].sync_seq : after;
        await tx`UPDATE devices SET last_seen_at = now(), last_seq = greatest(last_seq, ${cursor}) WHERE id = ${deviceId}`;
        // The attendance history of each booking, for the detail panel (also offline). Doctors get no reasons.
        const ids = rows.map((r) => r.id);
        const history = await tx<{ booking_id: string; type: string; source: string; at: Date; reason: string | null }[]>`
          SELECT booking_id, type, source, at, reason FROM attendance_events WHERE booking_id = ANY(${ids}::text[]) ORDER BY received_at`;
        const deps_ = await tx<{ id: string; name_ar: string; name_en: string | null; name_tr: string | null; active: boolean }[]>`
          SELECT id, name_ar, name_en, name_tr, active FROM departments WHERE hospital_id = ${p.hospitalId} ORDER BY sort`;
        return {
          done: true,
          res: json(c, {
            cursor,
            hasMore: more,
            hospital: { name: { ar: h.name_ar, en: h.name_en, tr: h.name_tr }, timezone: h.timezone, noShowGraceMin: h.grace },
            departments: deps_.map((x) => ({ id: x.id, name: { ar: x.name_ar, en: x.name_en, tr: x.name_tr }, active: x.active })),
            bookings: rows.map((b) => ({
              id: b.id,
              ref: b.ref,
              departmentId: b.department_id,
              slotStart: b.slot_start,
              localDate: localDate(b.slot_start, h.timezone),
              localTime: localTime(b.slot_start, h.timezone),
              patientName: b.patient_name,
              // Doctors' PCs never receive phone numbers (owner's decision: least personal data).
              phone: canSeeAll ? b.phone : null,
              status: b.status,
              arrivedAt: b.arrived_at,
              needsReview: b.needs_review,
              seq: b.sync_seq,
              bookedAt: b.created_at,
              events: history.filter((e) => e.booking_id === b.id).map((e) => ({ type: e.type, source: e.source, at: e.at, reason: canSeeAll ? e.reason : null })),
            })),
          }),
        };
      });
      if (result.done) return result.res!;
      if (c.req.raw.signal.aborted) return c.body(null, 499 as any);
      await sleep(1000);
    }
  });

  // ---------------------------------------------------------------- push
  // Hospital accounts only; each event is then checked against the caller's permissions.
  route(app, "POST", "/sync/push", permission("HospitalRead"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b = await body(c);
    const deviceId = str(b, "deviceId");
    const eventsRaw = raw(b, "events");
    if (eventsRaw !== null && !Array.isArray(eventsRaw)) throw new BadRequest("events");
    const events = ((eventsRaw as unknown[] | null) ?? []).map(parsePushEvent);
    if (events.length > MaxPushEvents) return err(c, "TOO_MANY_EVENTS", 422);
    return await d.db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      if (!await deviceOk(tx, deviceId, p.hospitalId!)) return err(c, "DEVICE_REVOKED", 403);
      const results = [];
      for (const e of events) {
        const r = await pushOne(tx, p, deviceId!, e, d.now());
        results.push({
          clientEventId: e.clientEventId, outcome: r.outcome, code: r.code, ref: r.ref,
          status: r.state?.status ?? null, arrivedAt: r.state?.arrivedAt ?? null, needsReview: r.state?.needsReview ?? null,
        });
      }
      await tx`UPDATE devices SET last_seen_at = now() WHERE id = ${deviceId}`;
      return json(c, { results });
    });
  });
}
