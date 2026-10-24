// Public booking (the booking site) and the hospital's bookings: the day list, lookup by booking number, details with
// history, cancellation, and check-in/correction from the web.
import type { Hono } from "hono";
import { anonymous, permission, route, signedIn } from "../app.ts";
import { record } from "../attendance.ts";
import { computeDays, openCount } from "../availability.ts";
import { type BookingRequest, createBooking, loadDepartment, resolveHospital } from "../bookings.ts";
import { audit, Scopes, type Tx } from "../db.ts";
import { questionsFromStored } from "../forms.ts";
import { isValidSlug } from "../hospitals.ts";
import { BadRequest, body, type Ctx, deps, type Env, json, principal, raw, str } from "../http.ts";
import { has, type Principal } from "../permissions.ts";
import { addDays, dayStartUtc, localDate, localTime, weekday } from "../tz.ts";
import { isIsoDate } from "./hospital.ts";

const err = (c: Ctx, code: string, status: number, detail: unknown = null) => json(c, { error: code, detail }, status);
const err2 = (c: Ctx, code: string, status: number) => json(c, { error: code }, status);

/** An ISO 8601 date-time (with Z or an offset; without one it is taken as UTC), like .NET's DateTimeOffset binding. */
export function parseInstant(v: unknown, name: string): Date | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/i.test(v)) throw new BadRequest(name);
  const withZone = /(Z|[+-]\d{2}:\d{2})$/i.test(v) ? v : v + "Z";
  const d = new Date(withZone.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(d.getTime())) throw new BadRequest(name);
  return d;
}

/** A GUID field (client_event_id). */
export function parseGuid(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(v)) throw new BadRequest(name);
  const hex = v.replace(/[{}-]/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function publicBookingRoutes(app: Hono<Env>) {
  route(app, "GET", "/public/hospitals/:slug/form", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    if (!isValidSlug(slug)) return err(c, "NOT_FOUND", 404);
    const r = await deps(c).db.run(Scopes.system, async (tx) => {
      const h = await resolveHospital(tx, slug);
      if (!h) return null;
      const [v] = await tx<{ id: string; version: number; schema_json: unknown }[]>`
        SELECT v.id, v.version, v.schema_json FROM hospital_active_form a JOIN form_versions v ON v.id = a.form_version_id WHERE a.hospital_id = ${h.id}`;
      return { form: v ? { versionId: v.id, version: v.version, questions: questionsFromStored(v.schema_json) } : null };
    });
    return r === null ? err(c, "NOT_FOUND", 404) : json(c, r);
  });

  route(app, "GET", "/public/hospitals/:slug/availability", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    const departmentId = c.req.query("departmentId") ?? null;
    if (!isValidSlug(slug) || departmentId === null) return err(c, "NOT_FOUND", 404);
    const d = deps(c);
    return await d.db.run(Scopes.system, async (tx) => {
      const h = await resolveHospital(tx, slug);
      if (!h) return err(c, "NOT_FOUND", 404);
      const [{ exists }] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM departments WHERE id = ${departmentId} AND hospital_id = ${h.id} AND active) AS exists`;
      if (!exists) return err(c, "DEPARTMENT_INVALID", 404);
      const now = d.now();
      const { blocks, closed, booked } = await loadDepartment(tx, h.id, departmentId, new Date(now.getTime() - 86400_000),
        new Date(now.getTime() + (h.window_days + 2) * 86400_000));
      const days = h.status === "active" ? computeDays(h.timezone, now, h.window_days, h.min_notice_min, blocks, closed, booked) : [];
      return json(c, {
        timezone: h.timezone,
        windowDays: h.window_days,
        minNoticeMin: h.min_notice_min,
        days: days.map((x) => ({
          date: x.date,
          weekday: weekday(x.date),
          status: x.status,
          open: openCount(x),
          // Only bookable slots are listed, and never how many people booked them.
          slots: x.slots.map((s) => ({ start: s.startUtc, time: s.localTime })),
        })),
      });
    });
  });

  route(app, "POST", "/public/hospitals/:slug/bookings", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    const b = await body(c);
    if (!isValidSlug(slug)) return err(c, "NOT_FOUND", 404);
    const answers = raw(b, "answers");
    if (answers !== null && (typeof answers !== "object" || Array.isArray(answers))) throw new BadRequest("answers");
    const req: BookingRequest = {
      departmentId: str(b, "departmentId"),
      slotStart: parseInstant(raw(b, "slotStart"), "slotStart"),
      patientName: str(b, "patientName"),
      phone: str(b, "phone"),
      formVersionId: str(b, "formVersionId"),
      answers: answers as Record<string, unknown> | null,
    };
    const key = c.req.header("Idempotency-Key") || null;
    const d = deps(c);
    const r = await createBooking(d.config, d.db, d.now(), slug, key, req);
    return r.error === undefined ? json(c, r.body, r.status) : err(c, r.error, r.status, r.body ?? null);
  });
}

interface BookingRow {
  id: string;
  ref: string;
  slot_start: Date;
  department_id: string;
  dep_name_ar: string;
  dep_name_en: string | null;
  dep_name_tr: string | null;
  patient_name: string | null;
  phone: string | null;
  status: string;
  form_version: number | null;
  created_at: Date;
  cancel_reason: string | null;
  arrived_at: Date | null;
  needs_review: boolean;
}

const bookingSelect = (tx: Tx) =>
  tx`
  SELECT b.id, b.ref, b.slot_start, b.department_id, d.name_ar AS dep_name_ar, d.name_en AS dep_name_en, d.name_tr AS dep_name_tr,
         b.patient_name, b.phone, b.status, v.version AS form_version, b.created_at, b.cancel_reason,
         b.arrived_at, b.needs_review
  FROM bookings b JOIN departments d ON d.id = b.department_id LEFT JOIN form_versions v ON v.id = b.form_version_id`;

function bookingDto(b: BookingRow, tz: string, full: boolean) {
  return {
    id: b.id,
    ref: b.ref,
    slotStart: b.slot_start,
    localDate: localDate(b.slot_start, tz),
    localTime: localTime(b.slot_start, tz),
    department: { id: b.department_id, ar: b.dep_name_ar, en: b.dep_name_en, tr: b.dep_name_tr },
    // Doctors (own departments, read-only) get no phone numbers or staff-written reasons (owner's decision, Phase 8).
    patientName: b.patient_name,
    phone: full ? b.phone : null,
    status: b.status,
    formVersion: b.form_version,
    arrivedAt: b.arrived_at,
    needsReview: b.needs_review,
    createdAt: b.created_at,
    cancelReason: full ? b.cancel_reason : null,
  };
}

/** Who may read bookings: all of them (BookingsView) or a doctor's own departments only; null = refused. */
function readFilter(tx: Tx, p: Principal) {
  if (has(p.roles, "BookingsView")) return { full: true, only: tx`` };
  if (has(p.roles, "BookingsViewOwnDepartment")) {
    return { full: false, only: tx` AND b.department_id IN (SELECT department_id FROM doctor_departments WHERE user_id = ${p.userId})` };
  }
  return null;
}

const canRead = (p: Principal) => has(p.roles, "BookingsView") || has(p.roles, "BookingsViewOwnDepartment");

async function hospitalTz(tx: Tx, hospitalId: string): Promise<string> {
  const [{ timezone }] = await tx<{ timezone: string }[]>`SELECT timezone FROM hospitals WHERE id = ${hospitalId}`;
  return timezone;
}

/**
 * Hospital staff: the day's bookings, lookup by full booking number, and cancellation by reception. Doctors read their
 * own departments only, without phone numbers or reasons, and without the form answers.
 */
export function hospitalBookingRoutes(app: Hono<Env>) {
  route(app, "GET", "/hospital/bookings", signedIn, async (c) => {
    const p = principal(c);
    if (!canRead(p)) return err(c, "FORBIDDEN", 403);
    const date = c.req.query("date") ?? null, ref = c.req.query("ref") ?? null;
    const d = deps(c);
    return await d.db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const f = readFilter(tx, p)!;
      const tz = await hospitalTz(tx, p.hospitalId!);
      if (ref !== null && ref.trim()) {
        // Full booking number only: no name search (SCREENS.md §4).
        const one = await tx<BookingRow[]>`${bookingSelect(tx)} WHERE b.hospital_id = ${p.hospitalId} AND b.ref = ${ref.trim().toUpperCase()}${f.only}`;
        return json(c, { bookings: one.map((b) => bookingDto(b, tz, f.full)) });
      }
      let day: string;
      if (date === null) day = localDate(d.now(), tz);
      else if (!isIsoDate(date)) return err(c, "DATE_INVALID", 422);
      else day = date;
      const from = dayStartUtc(day, tz), to = dayStartUtc(addDays(day, 1), tz);
      const rows = await tx<BookingRow[]>`
        ${bookingSelect(tx)} WHERE b.hospital_id = ${p.hospitalId} AND b.slot_start >= ${from} AND b.slot_start < ${to}${f.only}
        ORDER BY b.slot_start, b.seat_no`;
      return json(c, { date: day, bookings: rows.map((b) => bookingDto(b, tz, f.full)) });
    });
  });

  route(app, "GET", "/hospital/bookings/:id", signedIn, async (c) => {
    const p = principal(c);
    if (!canRead(p)) return err(c, "FORBIDDEN", 403);
    const id = c.req.param("id")!;
    return await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const f = readFilter(tx, p)!;
      const [b] = await tx<BookingRow[]>`${bookingSelect(tx)} WHERE b.id = ${id} AND b.hospital_id = ${p.hospitalId}${f.only}`;
      if (!b) return err(c, "NOT_FOUND", 404);
      const tz = await hospitalTz(tx, p.hospitalId!);
      const answers = f.full ? await tx<{ question_id: string; value_json: unknown }[]>`
        SELECT question_id, value_json FROM booking_answers WHERE booking_id = ${id}` : [];
      const [schema] = f.full ? await tx<{ schema_json: unknown }[]>`
        SELECT v.schema_json FROM bookings b JOIN form_versions v ON v.id = b.form_version_id WHERE b.id = ${id}` : [];
      // The status history, as in the Windows detail panel (who and where; reasons for full readers only).
      const events = await tx<{ type: string; source: string; at: Date; reason: string | null; actor: string | null }[]>`
        SELECT e.type, e.source, e.at, e.reason, u.email::text AS actor
        FROM attendance_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.booking_id = ${id} ORDER BY e.at, e.received_at`;
      return json(c, {
        booking: bookingDto(b, tz, f.full),
        answers: Object.fromEntries(answers.map((a) => [a.question_id, a.value_json])),
        questions: schema ? questionsFromStored(schema.schema_json) : [],
        events: events.map((e) => ({ type: e.type, source: e.source, at: e.at, reason: f.full ? e.reason : null, actor: f.full ? e.actor : null })),
      });
    });
  });

  // Patients cannot cancel online (owner's decision); reception and the hospital admin can, with a reason.
  route(app, "POST", "/hospital/bookings/:id/cancel", permission("AttendanceCorrect"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const reason = str(await body(c), "reason")?.trim() ?? null;
    if (reason === null || reason.length < 3 || reason.length > 300) return err(c, "REASON_REQUIRED", 422);
    return await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const r = await tx`
        UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${p.userId}, cancel_reason = ${reason}
        WHERE id = ${id} AND hospital_id = ${p.hospitalId} AND status = 'waiting'`;
      if (r.count === 0) {
        const [{ exists }] = await tx<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM bookings WHERE id = ${id} AND hospital_id = ${p.hospitalId}) AS exists`;
        return exists ? err(c, "NOT_CANCELLABLE", 409) : err(c, "NOT_FOUND", 404);
      }
      // The reason is staff-written; no patient data goes into the audit log.
      await audit(tx, p.userId, p.hospitalId, "booking_cancel", id);
      return json(c, { status: "ok" });
    });
  });

  // Check in (reception) or correct (with a reason) from the web.
  route(app, "POST", "/hospital/bookings/:id/attendance", signedIn, async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const type = str(b, "type"), reasonRaw = str(b, "reason");
    const correction = reasonRaw !== null;
    if (correction ? !has(p.roles, "AttendanceCorrect") : !has(p.roles, "CheckIn")) return err2(c, "FORBIDDEN", 403);
    if (!(type === "arrived" || type === "no_show" || type === "waiting") || (!correction && type !== "arrived")) return err2(c, "TYPE_INVALID", 422);
    if (correction && (reasonRaw!.trim().length < MinReason || reasonRaw!.trim().length > 300)) return err2(c, "REASON_REQUIRED", 422);
    const d = deps(c);
    const now = d.now();
    const r = await d.db.run(Scopes.hospital(p.hospitalId), (tx) =>
      record(tx, {
        hospitalId: p.hospitalId!,
        bookingId: id,
        type: type!,
        source: correction ? "correction" : "reception",
        at: now,
        actorId: p.userId,
        deviceId: null,
        clientEventId: null,
        reason: reasonRaw?.trim() ?? null,
      }, now));
    return r.outcome === "rejected"
      ? err2(c, r.code!, r.code === "NOT_FOUND" ? 404 : 409)
      : json(c, { status: r.state!.status, arrivedAt: r.state!.arrivedAt, needsReview: r.state!.needsReview });
  });
}

/** Corrections need a reason of at least 5 characters (SCREENS.md, Windows detail panel). */
export const MinReason = 5;
