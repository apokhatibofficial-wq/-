// Hospital-scope API. The hospital is always the one in the caller's session; any hospital ID in the query string or
// body is ignored. RLS enforces the same rule again inside PostgreSQL. Also the public booking-link resolution.
import type { Hono } from "hono";
import { anonymous, permission, route } from "../app.ts";
import { audit, isUniqueViolation, pgCode, Scopes, type Tx } from "../db.ts";
import { trySend } from "../email.ts";
import { clean, effectiveRules, isValidSlug, isValidTimezone } from "../hospitals.ts";
import { BadRequest, body, bool, type Ctx, deps, type Env, int, json, principal, raw, requireJsonType, str, strArray } from "../http.ts";
import { Roles } from "../permissions.ts";
import { Ids } from "../security.ts";
import { changeUser, getUser, invite, type InviteResult, isEmail, listUsers, sendUserLink, setDoctorDepartments, userDto } from "../users.ts";

const err = (c: Ctx, code: string, status: number, detail: unknown = null) => json(c, { error: code, detail }, status);
const hs = (c: Ctx) => Scopes.hospital(principal(c).hospitalId);

/** Roles a hospital admin may give. Hospital admins themselves are managed by the company. */
const StaffRoles: string[] = [Roles.reception, Roles.scanner, Roles.doctor];

/** Doctors need 1–50 of the hospital's own departments; other roles take none. */
async function doctorDepartments(tx: Tx, hospitalId: string, role: string, requested: string[] | null): Promise<{ error: string | null; ids: string[] }> {
  if (role !== Roles.doctor) return { error: requested && requested.length > 0 ? "DEPARTMENTS_NOT_ALLOWED" : null, ids: [] };
  const ids = [...new Set(requested ?? [])];
  if (ids.length === 0 || ids.length > 50) return { error: "DEPARTMENTS_REQUIRED", ids: [] };
  const [{ n }] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM departments WHERE hospital_id = ${hospitalId} AND id = ANY(${ids}::text[])`;
  return n === ids.length ? { error: null, ids } : { error: "DEPARTMENT_INVALID", ids: [] };
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function parseHhmm(s: string | null): number | null {
  if (s === null || s.length !== 5 || s[2] !== ":" || !/^\d\d$/.test(s.slice(0, 2)) || !/^\d\d$/.test(s.slice(3))) return null;
  const h = Number(s.slice(0, 2)), m = Number(s.slice(3));
  if (h === 24 && m === 0) return 1440;
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? h * 60 + m : null;
}

async function departmentsWithSchedules(tx: Tx, hospitalId: string) {
  const deps = await tx<{ id: string; name_ar: string; name_en: string | null; name_tr: string | null; active: boolean; sort: number }[]>`
    SELECT id, name_ar, name_en, name_tr, active, sort FROM departments WHERE hospital_id = ${hospitalId} ORDER BY sort, created_at`;
  const sch = await tx<{ department_id: string; weekday: number; start_min: number; end_min: number; slot_minutes: number; capacity: number }[]>`
    SELECT department_id, weekday, start_min, end_min, slot_minutes, capacity FROM schedules WHERE hospital_id = ${hospitalId} ORDER BY weekday, start_min`;
  return deps.map((d) => ({
    id: d.id,
    name: { ar: d.name_ar, en: d.name_en, tr: d.name_tr },
    active: d.active,
    sort: d.sort,
    schedules: sch.filter((x) => x.department_id === d.id).map((x) => ({
      weekday: x.weekday,
      start: hhmm(x.start_min),
      end: hhmm(x.end_min),
      slotMinutes: x.slot_minutes,
      capacity: x.capacity,
    })),
  }));
}

/** A required integer field of a JSON object (missing → 0, like a non-nullable .NET int; wrong type → 400). */
function reqInt(o: Record<string, unknown>, name: string): number {
  return int(o, name) ?? 0;
}

export function hospitalRoutes(app: Hono<Env>) {
  route(app, "GET", "/hospital/me", permission("HospitalRead"), async (c) => {
    const p = principal(c);
    const r = await deps(c).db.run(hs(c), async (tx) => {
      const [h] = await tx<
        { id: string; name_ar: string; name_en: string; name_tr: string | null; status: string; timezone: string; no_show_grace_min: number; retention_months: number; staff_totp_required: boolean; slug: string | null }[]
      >`
        SELECT h.id, h.name_ar, h.name_en, h.name_tr, h.status, h.timezone, h.no_show_grace_min, h.retention_months, h.staff_totp_required,
               (SELECT slug FROM hospital_slugs s WHERE s.hospital_id = h.id AND s.is_primary) AS slug
        FROM hospitals h WHERE h.id = ${p.hospitalId}`;
      return { h, rules: await effectiveRules(tx, p.hospitalId!) };
    });
    const { h, rules } = r;
    return json(c, {
      id: h.id,
      name: { ar: h.name_ar, en: h.name_en, tr: h.name_tr },
      status: h.status,
      timezone: h.timezone,
      noShowGraceMin: h.no_show_grace_min,
      retentionMonths: h.retention_months,
      staffTotpRequired: h.staff_totp_required,
      slug: h.slug,
      // Set by the company (System settings, or this hospital's override); read-only here.
      bookingRules: { windowDays: rules.windowDays, minNoticeMin: rules.minNoticeMin, overridden: rules.overridden },
    });
  });

  route(app, "PATCH", "/hospital/settings", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const b = await body(c);
    const g = int(b, "noShowGraceMin"), r = int(b, "retentionMonths"), tz = str(b, "timezone"), totp = bool(b, "staffTotpRequired");
    if (g !== null && (g < 0 || g > 240)) return err(c, "GRACE_INVALID", 422);
    if (r !== null && (r < 1 || r > 120)) return err(c, "RETENTION_INVALID", 422);
    if (tz !== null && !isValidTimezone(tz)) return err(c, "TIMEZONE_INVALID", 422);
    await deps(c).db.run(hs(c), async (tx) => {
      await tx`
        UPDATE hospitals SET no_show_grace_min = coalesce(${g}::int, no_show_grace_min),
               retention_months = coalesce(${r}::int, retention_months), timezone = coalesce(${tz}, timezone),
               staff_totp_required = coalesce(${totp}::boolean, staff_totp_required), updated_at = now()
        WHERE id = ${p.hospitalId}`;
      await audit(tx, p.userId, p.hospitalId, "hospital_settings", p.hospitalId!, { noShowGraceMin: g, retentionMonths: r, timezone: tz, staffTotpRequired: totp });
    });
    return json(c, { status: "ok" });
  });

  // ---------------------------------------------------------------- staff
  route(app, "GET", "/hospital/users", permission("HospitalUsersManage"), async (c) => {
    const p = principal(c);
    const users = await deps(c).db.run(hs(c), (tx) => listUsers(tx, p.hospitalId));
    return json(c, { users: users.map(userDto) });
  });

  // Deliberately filtered by RLS alone (no hospital_id condition): proves the database layer on its own.
  route(app, "GET", "/hospital/users/:id", permission("HospitalUsersManage"), async (c) => {
    const id = c.req.param("id")!;
    const [u] = await deps(c).db.run(hs(c), (tx) => tx<{ id: string; email: string; status: string }[]>`
      SELECT id, email::text AS email, status FROM users WHERE id = ${id}`);
    return u ? json(c, { id: u.id, email: u.email, status: u.status }) : err(c, "NOT_FOUND", 404);
  });

  route(app, "POST", "/hospital/users", permission("HospitalUsersManage"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b = await body(c);
    const email = str(b, "email"), role = str(b, "role"), departmentIds = strArray(b, "departmentIds");
    if (!isEmail(email)) return err(c, "EMAIL_INVALID", 422);
    if (role === null || !StaffRoles.includes(role)) return err(c, "ROLE_INVALID", 422);
    try {
      const r: InviteResult = await d.db.run(hs(c), async (tx) => {
        const dep = await doctorDepartments(tx, p.hospitalId!, role, departmentIds);
        if (dep.error !== null) return { error: dep.error };
        const r = await invite(d, tx, p.hospitalId, email!.trim(), role, p);
        if (r.error === null && dep.ids.length > 0) await setDoctorDepartments(tx, r.userId, p.hospitalId!, dep.ids, p);
        return r;
      });
      if (r.error !== null) return err(c, r.error, r.error.startsWith("DEPARTMENT") ? 422 : 409);
      return json(c, { id: r.userId, emailSent: await trySend(d.email, r.mail) }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "EMAIL_TAKEN", 409);
      throw e;
    }
  });

  route(app, "PATCH", "/hospital/users/:id", permission("HospitalUsersManage"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const newRole = str(b, "role"), disabled = bool(b, "disabled"), departmentIds = strArray(b, "departmentIds");
    if (id === p.userId) return err(c, "CANNOT_CHANGE_SELF", 409);
    if (newRole !== null && !StaffRoles.includes(newRole)) return err(c, "ROLE_INVALID", 422);
    return await deps(c).db.run(hs(c), async (tx) => {
      const u = await getUser(tx, id, p.hospitalId);
      if (!u) return err(c, "NOT_FOUND", 404);
      if (u.roles.includes(Roles.hospAdmin)) return err(c, "ADMIN_MANAGED_BY_COMPANY", 409);
      const role = newRole ?? u.roles[0] ?? "";
      const roleChanges = newRole !== null && !(u.roles.length === 1 && u.roles[0] === newRole);
      let depIds: string[] = [];
      if (role === Roles.doctor && (roleChanges || departmentIds !== null)) {
        const dep = await doctorDepartments(tx, p.hospitalId!, role, departmentIds);
        if (dep.error !== null) return err(c, dep.error, 422);
        depIds = dep.ids;
      } else if (departmentIds !== null && departmentIds.length > 0) return err(c, "DEPARTMENTS_NOT_ALLOWED", 422);
      await changeUser(tx, u, newRole, disabled, p.hospitalId, p);
      if (depIds.length > 0) await setDoctorDepartments(tx, u.id, p.hospitalId!, depIds, p);
      return json(c, { status: "ok" });
    });
  });

  route(app, "POST", "/hospital/users/:id/send-link", permission("HospitalUsersManage"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const id = c.req.param("id")!;
    requireJsonType(c);
    if (id === p.userId) return err(c, "CANNOT_CHANGE_SELF", 409);
    const r = await d.db.run(hs(c), async (tx) => {
      const u = await getUser(tx, id, p.hospitalId);
      if (!u || u.status === "disabled") return { error: "NOT_FOUND" } as const;
      if (u.roles.includes(Roles.hospAdmin)) return { error: "ADMIN_MANAGED_BY_COMPANY" } as const;
      return { error: null, mail: await sendUserLink(d, tx, u, p.hospitalId, p) };
    });
    if (r.error !== null) return err(c, r.error, r.error === "NOT_FOUND" ? 404 : 409);
    return json(c, { status: "ok", emailSent: await trySend(d.email, r.mail) });
  });

  // ---------------------------------------------------------------- departments & schedules
  route(app, "GET", "/hospital/departments", permission("HospitalRead"), async (c) => {
    const p = principal(c);
    return json(c, { departments: await deps(c).db.run(hs(c), (tx) => departmentsWithSchedules(tx, p.hospitalId!)) });
  });

  route(app, "POST", "/hospital/departments", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const b = await body(c);
    const ar = clean(str(b, "nameAr"), 120), en = clean(str(b, "nameEn"), 120), tr = clean(str(b, "nameTr"), 120);
    const active = bool(b, "active"), sortIn = int(b, "sort");
    if (ar === null) return err(c, "NAME_REQUIRED", 422);
    try {
      const id = await deps(c).db.run(hs(c), async (tx) => {
        const id = Ids.department();
        let sort = sortIn;
        if (sort === null) {
          [{ sort }] = await tx<{ sort: number }[]>`SELECT coalesce(max(sort), 0) + 10 AS sort FROM departments WHERE hospital_id = ${p.hospitalId}`;
        }
        await tx`
          INSERT INTO departments (id, hospital_id, name_ar, name_en, name_tr, active, sort)
          VALUES (${id}, ${p.hospitalId}, ${ar}, ${en}, ${tr}, ${active ?? true}, ${sort})`;
        await audit(tx, p.userId, p.hospitalId, "department_create", id);
        return id;
      });
      return json(c, { id }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "NAME_TAKEN", 409);
      throw e;
    }
  });

  route(app, "PATCH", "/hospital/departments/:id", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const nameAr = str(b, "nameAr"), active = bool(b, "active"), sort = int(b, "sort");
    const en = clean(str(b, "nameEn"), 120), tr = clean(str(b, "nameTr"), 120);
    const ar = nameAr === null ? null : clean(nameAr, 120);
    if (nameAr !== null && ar === null) return err(c, "NAME_REQUIRED", 422);
    try {
      const n = await deps(c).db.run(hs(c), async (tx) => {
        const r = await tx`
          UPDATE departments SET name_ar = coalesce(${ar}, name_ar),
                 name_en = CASE WHEN ${nameAr !== null}::boolean THEN ${en} ELSE name_en END,
                 name_tr = CASE WHEN ${nameAr !== null}::boolean THEN ${tr} ELSE name_tr END,
                 active = coalesce(${active}::boolean, active), sort = coalesce(${sort}::int, sort), updated_at = now()
          WHERE id = ${id} AND hospital_id = ${p.hospitalId}`;
        if (r.count > 0) await audit(tx, p.userId, p.hospitalId, "department_edit", id, { active });
        return r.count;
      });
      return n === 0 ? err(c, "NOT_FOUND", 404) : json(c, { status: "ok" });
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "NAME_TAKEN", 409);
      throw e;
    }
  });

  // Replaces the department's whole weekly timetable in one transaction.
  route(app, "PUT", "/hospital/departments/:id/schedules", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const blocksRaw = raw(await body(c), "blocks");
    if (blocksRaw !== null && !Array.isArray(blocksRaw)) throw new BadRequest("blocks");
    const blocks = (blocksRaw as unknown[] | null) ?? [];
    if (blocks.length > 70) return err(c, "TOO_MANY_BLOCKS", 422);
    const rows: { w: number; s: number; e: number; slot: number; cap: number }[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b === null || typeof b !== "object" || Array.isArray(b)) throw new BadRequest("block");
      const o = b as Record<string, unknown>;
      const weekday = reqInt(o, "weekday"), slot = reqInt(o, "slotMinutes"), cap = reqInt(o, "capacity");
      const st = parseHhmm(str(o, "start")), en = parseHhmm(str(o, "end"));
      if (weekday < 0 || weekday > 6 || st === null || en === null || st >= 1440 || en <= st || slot < 5 || slot > 240 || cap < 1 || cap > 100 || en - st < slot) {
        return err(c, "SCHEDULE_INVALID", 422, i);
      }
      rows.push({ w: weekday, s: st, e: en, slot, cap });
    }
    try {
      return await deps(c).db.run(hs(c), async (tx) => {
        const [{ exists }] = await tx<{ exists: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM departments WHERE id = ${id} AND hospital_id = ${p.hospitalId}) AS exists`;
        if (!exists) return err(c, "NOT_FOUND", 404);
        await tx`DELETE FROM schedules WHERE department_id = ${id}`;
        for (const r of rows) {
          await tx`
            INSERT INTO schedules (id, hospital_id, department_id, weekday, start_min, end_min, slot_minutes, capacity)
            VALUES (${Ids.schedule()}, ${p.hospitalId}, ${id}, ${r.w}, ${r.s}, ${r.e}, ${r.slot}, ${r.cap})`;
        }
        await audit(tx, p.userId, p.hospitalId, "schedule_edit", id, { blocks: rows.length });
        return json(c, { status: "ok" });
      });
    } catch (e) {
      if (pgCode(e) === "23P01") return err(c, "SCHEDULE_OVERLAP", 409);
      throw e;
    }
  });

  // ---------------------------------------------------------------- closures
  route(app, "GET", "/hospital/closures", permission("HospitalRead"), async (c) => {
    const p = principal(c);
    const rows = await deps(c).db.run(hs(c), (tx) => tx<{ id: string; date: string; department_id: string | null; reason: string | null }[]>`
      SELECT id, to_char(date, 'YYYY-MM-DD') AS date, department_id, reason FROM closures
      WHERE hospital_id = ${p.hospitalId} AND date >= current_date - 1 ORDER BY date`);
    return json(c, { closures: rows.map((r) => ({ id: r.id, date: r.date, departmentId: r.department_id, reason: r.reason })) });
  });

  route(app, "POST", "/hospital/closures", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const b = await body(c);
    const date = str(b, "date"), departmentId = str(b, "departmentId"), reason = str(b, "reason");
    if (!isIsoDate(date)) return err(c, "DATE_INVALID", 422);
    if (reason !== null && reason.length > 200) return err(c, "REASON_TOO_LONG", 422);
    try {
      return await deps(c).db.run(hs(c), async (tx) => {
        if (departmentId !== null) {
          const [{ exists }] = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM departments WHERE id = ${departmentId} AND hospital_id = ${p.hospitalId}) AS exists`;
          if (!exists) return err(c, "NOT_FOUND", 404);
        }
        const id = Ids.closure();
        await tx`
          INSERT INTO closures (id, hospital_id, department_id, date, reason, created_by)
          VALUES (${id}, ${p.hospitalId}, ${departmentId}, ${date}::date, ${clean(reason, 200)}, ${p.userId})`;
        await audit(tx, p.userId, p.hospitalId, "closure_add", id, { date });
        return json(c, { id }, 201);
      });
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "CLOSURE_EXISTS", 409);
      throw e;
    }
  });

  route(app, "DELETE", "/hospital/closures/:id", permission("HospitalSettings"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const n = await deps(c).db.run(hs(c), async (tx) => {
      const r = await tx`DELETE FROM closures WHERE id = ${id} AND hospital_id = ${p.hospitalId}`;
      if (r.count > 0) await audit(tx, p.userId, p.hospitalId, "closure_remove", id);
      return r.count;
    });
    return n === 0 ? err(c, "NOT_FOUND", 404) : json(c, { status: "ok" });
  });
}

/** yyyy-MM-dd, a real calendar date. */
export function isIsoDate(s: string | null): s is string {
  if (s === null) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ---------------------------------------------------------------- public booking-link resolution
interface SlugInfo {
  hospital_id: string;
  is_primary: boolean;
  redirect_until: Date | null;
  name_ar: string;
  name_en: string;
  name_tr: string | null;
  status: string;
  current: string | null;
}

async function resolve(c: Ctx, slug: string): Promise<SlugInfo | undefined> {
  const [x] = await deps(c).db.run(Scopes.system, (tx) => tx<SlugInfo[]>`
    SELECT s.hospital_id, s.is_primary, s.redirect_until, h.name_ar, h.name_en, h.name_tr, h.status,
           (SELECT p.slug FROM hospital_slugs p WHERE p.hospital_id = s.hospital_id AND p.is_primary) AS current
    FROM hospital_slugs s JOIN hospitals h ON h.id = s.hospital_id WHERE s.slug = ${slug}`);
  return x;
}

const stillRedirecting = (c: Ctx, x: SlugInfo) => x.current !== null && x.redirect_until !== null && x.redirect_until > deps(c).now();

async function activeBody(c: Ctx, x: SlugInfo, slug: string) {
  const deps_ = await deps(c).db.run(Scopes.system, (tx) => tx<{ id: string; name_ar: string; name_en: string | null; name_tr: string | null }[]>`
    SELECT id, name_ar, name_en, name_tr FROM departments WHERE hospital_id = ${x.hospital_id} AND active ORDER BY sort, created_at`);
  return {
    state: "active",
    slug,
    name: { ar: x.name_ar, en: x.name_en, tr: x.name_tr },
    acceptingBookings: x.status === "active",
    departments: deps_.map((d) => ({ id: d.id, name: { ar: d.name_ar, en: d.name_en, tr: d.name_tr } })),
  };
}

/**
 * Active slug → 200. Retired slug within 90 days → 301 to the new slug. After that → 410 LINK_CHANGED. Unknown → 404.
 * Only display fields are returned.
 */
export function publicSlugRoutes(app: Hono<Env>) {
  // HTTP semantics, for crawlers and the Cloudflare Pages Function: 200 / 301 / 410 / 404.
  route(app, "GET", "/public/book/:slug", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    if (!isValidSlug(slug)) return json(c, { error: "NOT_FOUND" }, 404);
    const x = await resolve(c, slug);
    if (!x) return json(c, { error: "NOT_FOUND" }, 404);
    if (!x.is_primary) {
      if (!stillRedirecting(c, x)) return json(c, { error: "LINK_CHANGED" }, 410);
      c.header("Location", "/public/book/" + x.current);
      return json(c, { state: "moved", slug: x.current }, 301);
    }
    return json(c, await activeBody(c, x, slug));
  });

  // For the booking app: never redirects. A renamed link (within 90 days) answers with the current hospital page.
  route(app, "GET", "/public/slugs/:slug", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    if (!isValidSlug(slug)) return json(c, { error: "NOT_FOUND" }, 404);
    const x = await resolve(c, slug);
    if (!x) return json(c, { error: "NOT_FOUND" }, 404);
    if (!x.is_primary && !stillRedirecting(c, x)) return json(c, { state: "changed" });
    return json(c, await activeBody(c, x, x.is_primary ? slug : x.current!));
  });
}
