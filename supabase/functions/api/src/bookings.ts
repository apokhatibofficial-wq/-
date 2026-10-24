// Public booking. Guarantees (BACKEND-SPEC §5): a seat is taken at most once (partial unique index + retry on the
// next seat); a repeated Idempotency-Key returns the original booking; availability and answers are re-checked on the
// server at confirm time; the QR token is 128 random-looking bits with no personal data, and only its hash is stored.
import { Buffer } from "node:buffer";
import { type Block, computeDay } from "./availability.ts";
import type { Config } from "./config.ts";
import { Db, isUniqueViolation, Scopes, type Tx } from "./db.ts";
import { type FormQuestion, questionsFromStored, validateAnswers } from "./forms.ts";
import { base64Url, fixedTimeEquals, Ids, randomBytes, tokenHash } from "./security.ts";
import { addDays, dayStartUtc, localDate, localTime } from "./tz.ts";

export interface PublicHospital {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_tr: string | null;
  status: string;
  timezone: string;
  window_days: number;
  min_notice_min: number;
  per_phone_daily_limit: number;
}

const RefAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const OldFormGraceMs = 2 * 3600_000;
export const IdempotencyReplayMs = 24 * 3600_000;

export function newRef(): string {
  const r = randomBytes(6);
  return "ML-" + Array.from(r, (b) => RefAlphabet[b % 32]).join("");
}

export function normalizePhone(raw: string | null): string | null | "" {
  if (raw === null || !raw.trim()) return null;
  const s = raw.replace(/[\s\-()]/g, "");
  return /^\+?[0-9]{7,15}$/.test(s) ? s : "";
}

let qrKeyCache: { from: Uint8Array; key: CryptoKey } | null = null;

/** "MLK1." + 22 base64url characters (128 bits), derived from the booking ID with a server key. */
export async function qrToken(config: Config, bookingId: string): Promise<string> {
  if (qrKeyCache?.from !== config.sessionSigningKey) {
    const base = await crypto.subtle.importKey("raw", config.sessionSigningKey as BufferSource, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode("medlink/qr/v1") },
      base,
      256,
    );
    const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    qrKeyCache = { from: config.sessionSigningKey, key };
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", qrKeyCache.key, new TextEncoder().encode(bookingId)));
  return "MLK1." + base64Url(mac.subarray(0, 16));
}

/** Hospital by its current slug or a slug still inside its 90-day redirect window. */
export async function resolveHospital(tx: Tx, slug: string): Promise<PublicHospital | undefined> {
  const [h] = await tx<PublicHospital[]>`
    SELECT h.id, (SELECT p.slug FROM hospital_slugs p WHERE p.hospital_id = h.id AND p.is_primary) AS slug,
           h.name_ar, h.name_en, h.name_tr, h.status, h.timezone,
           coalesce(h.booking_window_days, ps.booking_window_days) AS window_days,
           coalesce(h.min_notice_min, ps.min_notice_min) AS min_notice_min,
           ps.per_phone_daily_limit
    FROM hospital_slugs s JOIN hospitals h ON h.id = s.hospital_id CROSS JOIN platform_settings ps
    WHERE s.slug = ${slug} AND ps.id AND (s.is_primary OR s.redirect_until > now())`;
  return h;
}

export async function loadDepartment(tx: Tx, hospitalId: string, departmentId: string, from: Date, to: Date):
  Promise<{ blocks: Block[]; closed: Set<string>; booked: Map<number, number> }> {
  const blocks = (await tx<{ weekday: number; start_min: number; end_min: number; slot_minutes: number; capacity: number }[]>`
    SELECT weekday, start_min, end_min, slot_minutes, capacity FROM schedules WHERE hospital_id = ${hospitalId} AND department_id = ${departmentId}`)
    .map((b) => ({ weekday: b.weekday, startMin: b.start_min, endMin: b.end_min, slotMinutes: b.slot_minutes, capacity: b.capacity }));
  const closed = new Set((await tx<{ date: string }[]>`
    SELECT to_char(date, 'YYYY-MM-DD') AS date FROM closures WHERE hospital_id = ${hospitalId} AND (department_id IS NULL OR department_id = ${departmentId})`)
    .map((r) => r.date));
  const booked = new Map((await tx<{ slot_start: Date; n: number }[]>`
    SELECT slot_start, count(*)::int AS n FROM bookings
    WHERE hospital_id = ${hospitalId} AND department_id = ${departmentId} AND status <> 'cancelled' AND slot_start >= ${from} AND slot_start < ${to}
    GROUP BY slot_start`).map((r) => [r.slot_start.getTime(), r.n]));
  return { blocks, closed, booked };
}

export interface BookingRequest {
  departmentId: string | null;
  slotStart: Date | null;
  patientName: string | null;
  phone: string | null;
  formVersionId: string | null;
  answers: Record<string, unknown> | null;
}

export interface BookingResult {
  status: number;
  error?: string;
  body?: unknown;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function createBooking(config: Config, db: Db, now: Date, slug: string, idempotencyKey: string | null, req: BookingRequest): Promise<BookingResult> {
  if (idempotencyKey === null || idempotencyKey.length < 8 || idempotencyKey.length > 64 || !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
    return { status: 400, error: "IDEMPOTENCY_KEY_REQUIRED" };
  }
  const name = req.patientName?.trim() ?? null;
  if (name === null || name.length < 2 || name.length > 80) return { status: 422, error: "NAME_INVALID" };
  const phone = normalizePhone(req.phone);
  if (phone === "") return { status: 422, error: "PHONE_INVALID" };
  if (req.departmentId === null || req.slotStart === null) return { status: 422, error: "SLOT_REQUIRED" };
  const departmentId = req.departmentId;
  const slotStart = req.slotStart;
  const requestHash = await sha256(JSON.stringify({
    d: departmentId,
    s: Math.floor(slotStart.getTime() / 1000),
    n: name,
    p: phone,
    f: req.formVersionId,
    a: Object.keys(req.answers ?? {}).sort().map((k) => [k, JSON.stringify(req.answers![k])]),
  }));

  return await db.run(Scopes.system, async (tx) => {
    const h = await resolveHospital(tx, slug);
    if (!h) return { status: 404, error: "NOT_FOUND" };

    // 1. Same Idempotency-Key → the original booking (or a clear refusal if the request differs).
    const replay = await replayBooking(config, tx, h, idempotencyKey, requestHash, now);
    if (replay) return replay;

    if (h.status !== "active") return { status: 409, error: "NOT_ACCEPTING" };
    const [dep] = await tx<{ name_ar: string; name_en: string | null; name_tr: string | null }[]>`
      SELECT name_ar, name_en, name_tr FROM departments WHERE id = ${departmentId} AND hospital_id = ${h.id} AND active`;
    if (!dep) return { status: 422, error: "DEPARTMENT_INVALID" };

    // 2. The slot must still be offered: schedule, closures, booking window, minimum notice.
    const day = localDate(slotStart, h.timezone);
    const today = localDate(now, h.timezone);
    if (day < today || day > addDays(today, h.window_days - 1)) return { status: 409, error: "SLOT_UNAVAILABLE" };
    const { blocks, closed, booked } = await loadDepartment(tx, h.id, departmentId, slotStart, new Date(slotStart.getTime() + 1000));
    const offered = computeDay(h.timezone, now, day, h.min_notice_min, blocks, closed, new Map());
    const slot = offered.slots.find((s) => s.startUtc.getTime() === slotStart.getTime());
    if (!slot) return { status: 409, error: "SLOT_UNAVAILABLE" };
    if ((booked.get(slotStart.getTime()) ?? 0) >= slot.capacity) return { status: 409, error: "SLOT_FULL" };

    // 3. Answers are validated against the version the patient opened (accepted for 2 h after it is replaced).
    const form = await resolveForm(tx, h.id, req.formVersionId, now);
    if (form.error) return { status: 409, error: form.error, body: { currentVersionId: form.currentId } };
    let answers: Record<string, unknown>;
    if (form.questions === null) {
      const keys = Object.keys(req.answers ?? {});
      if (keys.length > 0) return { status: 422, error: "ANSWER_UNKNOWN_QUESTION", body: { questionId: keys[0] } };
      answers = {};
    } else {
      const v = validateAnswers(form.questions, req.answers);
      if (v.error !== null) return { status: 422, error: v.error, body: { questionId: v.questionId } };
      answers = v.answers;
    }

    // 4. Optional per-phone daily limit (System settings; 0 = none).
    if (phone !== null && h.per_phone_daily_limit > 0) {
      const from = dayStartUtc(day, h.timezone), to = dayStartUtc(addDays(day, 1), h.timezone);
      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM bookings WHERE hospital_id = ${h.id} AND phone = ${phone} AND status <> 'cancelled'
          AND slot_start >= ${from} AND slot_start < ${to}`;
      if (n >= h.per_phone_daily_limit) return { status: 429, error: "PHONE_LIMIT" };
    }

    // 5. Take the first free seat. A concurrent booking of the same seat fails the unique index; try the next.
    for (let attempt = 0; attempt < slot.capacity + 3; attempt++) {
      const [free] = await tx<{ s: number }[]>`
        SELECT s FROM generate_series(1, ${slot.capacity}::int) s
        WHERE s NOT IN (SELECT seat_no FROM bookings WHERE hospital_id = ${h.id} AND department_id = ${departmentId} AND slot_start = ${slotStart} AND status <> 'cancelled')
        ORDER BY s LIMIT 1`;
      if (!free) return { status: 409, error: "SLOT_FULL" };
      const id = Ids.booking();
      const reference = newRef();
      const qrHash = await tokenHash(await qrToken(config, id));
      try {
        await tx.savepoint((sp) => sp`
          INSERT INTO bookings (id, hospital_id, ref, department_id, slot_start, seat_no, patient_name, phone, form_version_id,
                                qr_token_hash, idempotency_key, request_hash)
          VALUES (${id}, ${h.id}, ${reference}, ${departmentId}, ${slotStart}, ${free.s}, ${name}, ${phone}, ${form.id},
                  ${qrHash}, ${idempotencyKey}, ${Buffer.from(requestHash)})`);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if ((e as { constraint_name?: string }).constraint_name === "bookings_hospital_id_idempotency_key_key") {
          return await replayBooking(config, tx, h, idempotencyKey, requestHash, now) ?? { status: 409, error: "IDEMPOTENCY_CONFLICT" };
        }
        continue; // seat or reference taken meanwhile
      }
      for (const [q, v] of Object.entries(answers)) {
        await tx`INSERT INTO booking_answers (booking_id, hospital_id, question_id, value_json) VALUES (${id}, ${h.id}, ${q}, ${tx.json(v as any)})`;
      }
      return { status: 201, body: await confirmation(config, h, id, reference, slotStart, dep) };
    }
    return { status: 409, error: "SLOT_FULL" };
  });
}

async function replayBooking(config: Config, tx: Tx, h: PublicHospital, key: string, requestHash: Uint8Array, now: Date): Promise<BookingResult | null> {
  const [p] = await tx<
    { id: string; ref: string; slot_start: Date; request_hash: Uint8Array; created_at: Date; name_ar: string; name_en: string | null; name_tr: string | null }[]
  >`
    SELECT b.id, b.ref, b.slot_start, b.request_hash, b.created_at, d.name_ar, d.name_en, d.name_tr
    FROM bookings b JOIN departments d ON d.id = b.department_id
    WHERE b.hospital_id = ${h.id} AND b.idempotency_key = ${key}`;
  if (!p) return null;
  if (!fixedTimeEquals(new Uint8Array(p.request_hash), requestHash)) return { status: 409, error: "IDEMPOTENCY_MISMATCH" };
  if (now.getTime() - p.created_at.getTime() > IdempotencyReplayMs) return { status: 409, error: "IDEMPOTENCY_EXPIRED" };
  return { status: 200, body: await confirmation(config, h, p.id, p.ref, p.slot_start, p) };
}

async function confirmation(config: Config, h: PublicHospital, id: string, reference: string, slotStart: Date,
  dep: { name_ar: string; name_en: string | null; name_tr: string | null }) {
  return {
    ref: reference,
    qr: await qrToken(config, id),
    slotStart,
    localDate: localDate(slotStart, h.timezone),
    localTime: localTime(slotStart, h.timezone),
    department: { ar: dep.name_ar, en: dep.name_en, tr: dep.name_tr },
    hospital: { ar: h.name_ar, en: h.name_en, tr: h.name_tr },
  };
}

/** The form version a booking is validated against. */
export async function resolveForm(tx: Tx, hospitalId: string, requested: string | null, now: Date):
  Promise<{ id: string | null; questions: FormQuestion[] | null; error: string | null; currentId: string | null }> {
  const [active] = await tx<{ id: string; schema_json: unknown }[]>`
    SELECT v.id, v.schema_json FROM hospital_active_form a JOIN form_versions v ON v.id = a.form_version_id WHERE a.hospital_id = ${hospitalId}`;
  if (requested === null) {
    return active ? { id: null, questions: null, error: "FORM_UPDATED", currentId: active.id } : { id: null, questions: null, error: null, currentId: null };
  }
  if (active?.id === requested) return { id: requested, questions: questionsFromStored(active.schema_json), error: null, currentId: null };
  // An older version stays valid for 2 hours after the next version was published.
  const [old] = await tx<{ schema_json: unknown; superseded_at: Date | null }[]>`
    SELECT v.schema_json,
           (SELECT min(n.published_at) FROM form_versions n WHERE n.hospital_id = v.hospital_id AND n.version > v.version) AS superseded_at
    FROM form_versions v WHERE v.id = ${requested} AND v.hospital_id = ${hospitalId}`;
  if (old?.superseded_at && now.getTime() - old.superseded_at.getTime() <= OldFormGraceMs) {
    return { id: requested, questions: questionsFromStored(old.schema_json), error: null, currentId: null };
  }
  return { id: null, questions: null, error: "FORM_UPDATED", currentId: active?.id ?? null };
}

