// Attendance events and the approved conflict policy (README decisions). Status is always derived from all events:
// - a manual correction beats every QR, reception and automatic event; if corrections disagree, the latest received
//   wins and the booking is flagged for review;
// - otherwise the earliest "arrived" wins, and "arrived" beats an automatic "no-show";
// - no event is ever deleted.
import { audit, isUniqueViolation, type Tx } from "./db.ts";
import { Ids } from "./security.ts";
import { localDate } from "./tz.ts";

export interface AttendanceEvent {
  type: string;
  source: string;
  at: Date;
  receivedAt: Date;
}

export interface AttendanceState {
  status: string;
  arrivedAt: Date | null;
  needsReview: boolean;
}

export function derive(events: AttendanceEvent[]): AttendanceState {
  const corrections = events.filter((e) => e.source === "correction").sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  if (corrections.length > 0) {
    const winner = corrections[corrections.length - 1];
    const conflict = new Set(corrections.map((c) => c.type)).size > 1;
    return { status: winner.type, arrivedAt: winner.type === "arrived" ? winner.at : null, needsReview: conflict };
  }
  const arrivals = events.filter((e) => e.type === "arrived");
  if (arrivals.length > 0) return { status: "arrived", arrivedAt: new Date(Math.min(...arrivals.map((e) => e.at.getTime()))), needsReview: false };
  if (events.some((e) => e.type === "no_show" && e.source === "auto")) return { status: "no_show", arrivedAt: null, needsReview: false };
  return { status: "waiting", arrivedAt: null, needsReview: false };
}

export interface RecordRequest {
  hospitalId: string;
  bookingId: string;
  type: string;
  source: string;
  at: Date;
  actorId: string | null;
  deviceId: string | null;
  clientEventId: string | null;
  reason: string | null;
}

/** "applied", "duplicate" (same client_event_id seen before) or "rejected" with a code. */
export interface RecordResult {
  outcome: "applied" | "duplicate" | "rejected";
  code: string | null;
  state: AttendanceState | null;
  ref: string | null;
}

/** Offline events may be up to 7 days old; device clocks may run up to 5 minutes fast. */
export const MaxEventAgeMs = 7 * 24 * 3600_000, MaxClockSkewMs = 5 * 60_000;

export async function record(tx: Tx, r: RecordRequest, now: Date): Promise<RecordResult> {
  if (r.clientEventId !== null) {
    const [seen] = await tx<{ booking_id: string }[]>`SELECT booking_id FROM attendance_events WHERE client_event_id = ${r.clientEventId}::uuid`;
    if (seen) return { outcome: "duplicate", code: null, state: await current(tx, seen.booking_id), ref: null };
  }
  // Lock the booking so concurrent events for it are applied one at a time.
  const [b] = await tx<{ id: string; ref: string; status: string; slot_start: Date; timezone: string }[]>`
    SELECT b.id, b.ref, b.status, b.slot_start, h.timezone FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
    WHERE b.id = ${r.bookingId} AND b.hospital_id = ${r.hospitalId} FOR UPDATE OF b`;
  if (!b) return { outcome: "rejected", code: "NOT_FOUND", state: null, ref: null };
  if (b.status === "cancelled") return { outcome: "rejected", code: "CANCELLED", state: null, ref: b.ref };
  if (r.at.getTime() > now.getTime() + MaxClockSkewMs || r.at.getTime() < now.getTime() - MaxEventAgeMs) {
    return { outcome: "rejected", code: "BAD_TIME", state: null, ref: b.ref };
  }
  // A check-in must happen on the appointment's own day (in hospital time). Corrections may be made later.
  if ((r.source === "qr" || r.source === "reception") && localDate(b.slot_start, b.timezone) !== localDate(r.at, b.timezone)) {
    return { outcome: "rejected", code: "OTHER_DAY", state: null, ref: b.ref };
  }
  try {
    await tx.savepoint((sp) => sp`
      INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at, actor_id, device_id, client_event_id, reason)
      VALUES (${Ids.attendance()}, ${r.hospitalId}, ${r.bookingId}, ${r.type}, ${r.source}, ${r.at}, ${r.actorId}, ${r.deviceId},
              ${r.clientEventId}::uuid, ${r.reason})`);
  } catch (e) {
    // The same client event arrived twice at the same moment.
    if (isUniqueViolation(e)) return { outcome: "duplicate", code: null, state: await current(tx, r.bookingId), ref: b.ref };
    throw e;
  }
  // Corrections also go to the audit log (who, when, what); the reason itself stays with the event.
  if (r.source === "correction") await audit(tx, r.actorId, r.hospitalId, "attendance_correct", r.bookingId, { type: r.type });
  return { outcome: "applied", code: null, state: await recompute(tx, r.bookingId), ref: b.ref };
}

/** Re-derives the booking's status from all of its events and stores it (bumping the sync sequence if it changed). */
export async function recompute(tx: Tx, bookingId: string): Promise<AttendanceState> {
  const events = await tx<{ type: string; source: string; at: Date; received_at: Date }[]>`
    SELECT type, source, at, received_at FROM attendance_events WHERE booking_id = ${bookingId} ORDER BY received_at, id`;
  const s = derive(events.map((e) => ({ type: e.type, source: e.source, at: e.at, receivedAt: e.received_at })));
  await tx`
    UPDATE bookings SET status = ${s.status}, arrived_at = ${s.arrivedAt}, needs_review = ${s.needsReview}
    WHERE id = ${bookingId} AND status <> 'cancelled'
      AND (status IS DISTINCT FROM ${s.status} OR arrived_at IS DISTINCT FROM ${s.arrivedAt}::timestamptz OR needs_review IS DISTINCT FROM ${s.needsReview})`;
  return s;
}

async function current(tx: Tx, bookingId: string): Promise<AttendanceState | null> {
  const [x] = await tx<{ status: string; arrived_at: Date | null; needs_review: boolean }[]>`
    SELECT status, arrived_at, needs_review FROM bookings WHERE id = ${bookingId}`;
  return x ? { status: x.status, arrivedAt: x.arrived_at, needsReview: x.needs_review } : null;
}
