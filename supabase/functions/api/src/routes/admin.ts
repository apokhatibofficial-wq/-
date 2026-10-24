// Company console API (admin.medlink.website): hospitals, audit log, reports, team, system settings.
// Every route requires a company-scope permission.
import type { Hono } from "hono";
import { permission, route, signedIn } from "../app.ts";
import { issueLink, revokeHospitalSessions, revokeUserSessions } from "../auth.ts";
import { audit, isUniqueViolation, Scopes, type Tx } from "../db.ts";
import { type EmailMessage, trySend } from "../email.ts";
import { changeSlug, checkSlug, clean, defaultTimezone, effectiveRules, isValidSlug, isValidTimezone } from "../hospitals.ts";
import { body, bool, BadRequest, requireJsonType, type Ctx, deps, type Env, int, json, principal, raw, str } from "../http.ts";
import { CompanyRoles, has, type Principal, Roles } from "../permissions.ts";
import { Ids } from "../security.ts";
import { changeUser, getUser, invite, isEmail, listUsers, sendUserLink, userDto } from "../users.ts";

/** The admin and hospital endpoints answer errors with a "detail" field (null when there is nothing to add). */
const err = (c: Ctx, code: string, status: number, detail: unknown = null) => json(c, { error: code, detail }, status);
/** Team and settings endpoints answer errors without it. */
const err2 = (c: Ctx, code: string, status: number) => json(c, { error: code }, status);

const scopeOf = (p: Principal) => (p.scope === "company" ? Scopes.company : Scopes.hospital(p.hospitalId));

interface HospitalRow {
  id: string;
  name_ar: string;
  name_en: string;
  name_tr: string | null;
  status: string;
  slug: string | null;
  users: number;
  created_at: Date;
  timezone: string;
  booking_window_days: number | null;
  min_notice_min: number | null;
  last_sync_at: Date | null;
  bookings30d: number;
}

const hospitalSelect = (tx: Tx) =>
  tx`
  SELECT h.id, h.name_ar, h.name_en, h.name_tr, h.status, h.created_at, h.timezone, h.booking_window_days, h.min_notice_min,
         (SELECT slug FROM hospital_slugs s WHERE s.hospital_id = h.id AND s.is_primary) AS slug,
         (SELECT count(*)::int FROM users u WHERE u.hospital_id = h.id AND u.status <> 'disabled') AS users,
         (SELECT max(d.last_seen_at) FROM devices d WHERE d.hospital_id = h.id) AS last_sync_at,
         (SELECT count(*)::int FROM bookings b WHERE b.hospital_id = h.id AND b.created_at > now() - interval '30 days') AS bookings30d
  FROM hospitals h`;

const hospitalDto = (h: HospitalRow) => ({
  id: h.id,
  name: { ar: h.name_ar, en: h.name_en, tr: h.name_tr },
  status: h.status,
  slug: h.slug,
  users: h.users,
  createdAt: h.created_at,
  timezone: h.timezone,
  // Per-hospital overrides; null = the company-wide value from System settings.
  bookingWindowDays: h.booking_window_days,
  minNoticeMin: h.min_notice_min,
  // Latest pull or push from any Windows device (revoked ones included); null means no PC has ever connected.
  lastSyncAt: h.last_sync_at,
  bookings30d: h.bookings30d,
});

export const MaxWindowDays = 365, MaxNoticeMin = 1440, MaxPerPhone = 50;

async function settingsRow(tx: Tx) {
  const [s] = await tx<
    { default_timezone: string; booking_window_days: number; min_notice_min: number; patient_can_cancel: boolean; per_phone_daily_limit: number; updated_at: Date }[]
  >`SELECT default_timezone, booking_window_days, min_notice_min, patient_can_cancel, per_phone_daily_limit, updated_at FROM platform_settings WHERE id`;
  return {
    defaultTimezone: s.default_timezone,
    bookingWindowDays: s.booking_window_days,
    minNoticeMin: s.min_notice_min,
    patientCanCancel: s.patient_can_cancel,
    perPhoneDailyLimit: s.per_phone_daily_limit,
    updatedAt: s.updated_at,
  };
}

/** Optional query-string integer, like the .NET binding: absent → null, not a number → 400. */
function queryInt(c: Ctx, name: string): number | null {
  const v = c.req.query(name);
  if (v === undefined || v === "") return null;
  if (!/^-?\d+$/.test(v)) throw new BadRequest(name);
  return Number.parseInt(v, 10);
}

export function adminRoutes(app: Hono<Env>) {
  route(app, "GET", "/admin/hospitals", permission("ViewReports"), async (c) => {
    const p = principal(c);
    const rows = await deps(c).db.run(scopeOf(p), (tx) => tx<HospitalRow[]>`${hospitalSelect(tx)} ORDER BY h.created_at DESC`);
    return json(c, { hospitals: rows.map(hospitalDto) });
  });

  route(app, "GET", "/admin/hospitals/:id", permission("ViewReports"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const result = await deps(c).db.run(scopeOf(p), async (tx) => {
      const [h] = await tx<HospitalRow[]>`${hospitalSelect(tx)} WHERE h.id = ${id}`;
      if (!h) return null;
      const old = await tx<{ slug: string; retired_at: Date; redirect_until: Date }[]>`
        SELECT slug, retired_at, redirect_until FROM hospital_slugs WHERE hospital_id = ${id} AND NOT is_primary ORDER BY retired_at DESC`;
      return {
        hospital: hospitalDto(h),
        oldSlugs: old.map((o) => ({ slug: o.slug, retiredAt: o.retired_at, redirectUntil: o.redirect_until })),
        nextSlugChangeAt: old.length > 0 ? new Date(old[0].retired_at.getTime() + 30 * 24 * 60 * 60_000) : null,
      };
    });
    return result === null ? err(c, "NOT_FOUND", 404) : json(c, result);
  });

  route(app, "GET", "/admin/slugs/check", permission("HospitalsCreateEdit"), async (c) => {
    const p = principal(c);
    const slug = c.req.query("slug") ?? null, hospitalId = c.req.query("hospitalId") ?? null;
    const state = await deps(c).db.run(scopeOf(p), (tx) => checkSlug(tx, slug, hospitalId));
    return json(c, { state });
  });

  route(app, "POST", "/admin/hospitals", permission("HospitalsCreateEdit"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b = await body(c);
    const nameAr = clean(str(b, "nameAr"), 200), nameEn = clean(str(b, "nameEn"), 200), nameTr = clean(str(b, "nameTr"), 200);
    const adminEmailRaw = str(b, "adminEmail"), slug = str(b, "slug"), timezone = str(b, "timezone");
    if (nameAr === null || nameEn === null) return err(c, "NAME_REQUIRED", 422);
    if (!isEmail(adminEmailRaw)) return err(c, "EMAIL_INVALID", 422);
    if (!isValidSlug(slug)) return err(c, "SLUG_INVALID", 422);
    if (timezone !== null && !isValidTimezone(timezone)) return err(c, "TIMEZONE_INVALID", 422);
    const adminEmail = adminEmailRaw!.trim();
    try {
      const created = await d.db.run(scopeOf(p), async (tx) => {
        if (await checkSlug(tx, slug, null) !== "ok") return { error: "SLUG_TAKEN" } as const;
        const [{ taken }] = await tx<{ taken: boolean }[]>`SELECT EXISTS (SELECT 1 FROM users WHERE email = ${adminEmail}) AS taken`;
        if (taken) return { error: "EMAIL_TAKEN" } as const;
        const id = Ids.hospital();
        // No zone given → the company-wide default from System settings.
        const tz = timezone ?? await defaultTimezone(tx);
        await tx`INSERT INTO hospitals (id, name_ar, name_en, name_tr, timezone) VALUES (${id}, ${nameAr}, ${nameEn}, ${nameTr}, ${tz})`;
        await tx`INSERT INTO hospital_slugs (slug, hospital_id, is_primary) VALUES (${slug}, ${id}, true)`;
        const userId = Ids.user();
        await tx`INSERT INTO users (id, scope, hospital_id, email) VALUES (${userId}, 'hospital', ${id}, ${adminEmail})`;
        await tx`INSERT INTO user_roles (user_id, role) VALUES (${userId}, 'hosp_admin')`;
        const link = await issueLink(d, tx, userId, "activation", p.userId);
        await audit(tx, p.userId, id, "hospital_create", id, { slug });
        return { error: null, id, mail: link.mail };
      });
      if (created.error !== null) return err(c, created.error, 409);
      const sent = await trySend(d.email, created.mail);
      return json(c, { id: created.id, slug, emailSent: sent }, 201);
    } catch (e) {
      // A concurrent request claimed the slug or email between the check and the insert.
      if (isUniqueViolation(e)) {
        const constraint = (e as { constraint_name?: string }).constraint_name ?? "";
        return err(c, constraint.includes("email") ? "EMAIL_TAKEN" : "SLUG_TAKEN", 409);
      }
      throw e;
    }
  });

  route(app, "PATCH", "/admin/hospitals/:id", permission("HospitalsCreateEdit"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const nameAr = clean(str(b, "nameAr"), 200), nameEn = clean(str(b, "nameEn"), 200);
    const slug = str(b, "slug"), timezone = str(b, "timezone"), nameTrRaw = str(b, "nameTr");
    if (nameAr === null || nameEn === null) return err(c, "NAME_REQUIRED", 422);
    if (timezone !== null && !isValidTimezone(timezone)) return err(c, "TIMEZONE_INVALID", 422);
    try {
      return await d.db.run(scopeOf(p), async (tx) => {
        const [cur] = await tx<HospitalRow[]>`${hospitalSelect(tx)} WHERE h.id = ${id} FOR UPDATE OF h`;
        if (!cur) return err(c, "NOT_FOUND", 404);
        let change: { oldSlug?: string | null } | null = null;
        if (slug !== null && slug !== cur.slug) {
          const r = await changeSlug(tx, id, slug, d.now());
          // changeSlug validates before it writes, so nothing has changed when it reports an error.
          if (r.error !== null) return err(c, r.error, r.error === "SLUG_INVALID" ? 422 : 409, r.nextChangeAt ?? null);
          change = r;
        }
        const nameTr = clean(nameTrRaw, 200);
        await tx`UPDATE hospitals SET name_ar = ${nameAr}, name_en = ${nameEn}, name_tr = ${nameTr},
                 timezone = coalesce(${timezone}, timezone), updated_at = now() WHERE id = ${id}`;
        await audit(tx, p.userId, id, "hospital_edit", id, {
          names: nameAr !== cur.name_ar || nameEn !== cur.name_en || nameTr !== cur.name_tr,
          timezone: timezone !== null && timezone !== cur.timezone ? timezone : null,
          oldSlug: change?.oldSlug ?? null,
          newSlug: change?.oldSlug ? slug : null,
        });
        return json(c, { status: "ok" });
      });
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "SLUG_TAKEN", 409);
      throw e;
    }
  });

  const setSuspended = (suspend: boolean) => async (c: Ctx) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const reason = str(await body(c), "reason")?.trim() ?? null;
    if (reason === null || reason.length < 5 || reason.length > 500) return err(c, "REASON_REQUIRED", 422);
    return await deps(c).db.run(scopeOf(p), async (tx) => {
      const [h] = await tx<{ status: string }[]>`SELECT status FROM hospitals WHERE id = ${id} FOR UPDATE`;
      if (!h) return err(c, "NOT_FOUND", 404);
      if (suspend === (h.status === "suspended")) return err(c, suspend ? "ALREADY_SUSPENDED" : "NOT_SUSPENDED", 409);
      if (suspend) {
        await tx`UPDATE hospitals SET status = 'suspended', updated_at = now() WHERE id = ${id}`;
        await revokeHospitalSessions(tx, id, "hospital_suspended");
      } else {
        // Back to "active" if an admin has activated their account, otherwise still awaiting activation.
        await tx`
          UPDATE hospitals SET updated_at = now(), status = CASE WHEN EXISTS (
              SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'hosp_admin'
              WHERE u.hospital_id = ${id} AND u.status = 'active') THEN 'active' ELSE 'pending' END
          WHERE id = ${id}`;
      }
      // The reason is operator-written free text kept for the audit trail.
      await audit(tx, p.userId, id, suspend ? "hospital_suspend" : "hospital_reactivate", id, { reason });
      return json(c, { status: "ok" });
    });
  };
  route(app, "POST", "/admin/hospitals/:id/suspend", permission("HospitalsSuspend"), setSuspended(true));
  route(app, "POST", "/admin/hospitals/:id/reactivate", permission("HospitalsSuspend"), setSuspended(false));

  route(app, "POST", "/admin/hospitals/:id/recover-admin", permission("RecoverAdminAccess"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const id = c.req.param("id")!;
    const checks = raw(await body(c), "checks");
    if (checks !== null && (!Array.isArray(checks) || checks.some((x) => typeof x !== "boolean"))) throw new BadRequest("checks");
    // The identity checklist (3 items) must be fully confirmed. A WhatsApp message alone never changes a password.
    if (!Array.isArray(checks) || checks.length !== 3 || !checks.every((x) => x === true)) return err(c, "IDENTITY_CHECKS_INCOMPLETE", 422);
    const mails = await d.db.run(scopeOf(p), async (tx) => {
      const [{ exists }] = await tx<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM hospitals WHERE id = ${id}) AS exists`;
      if (!exists) return null;
      const admins = await tx<{ id: string; status: string }[]>`
        SELECT u.id, u.status FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'hosp_admin'
        WHERE u.hospital_id = ${id} AND u.status <> 'disabled'`;
      const out: EmailMessage[] = [];
      for (const a of admins) {
        await revokeUserSessions(tx, a.id, "admin_recovery");
        // An admin who never activated gets a fresh activation link instead of a reset link.
        out.push((await issueLink(d, tx, a.id, a.status === "pending" ? "activation" : "reset", p.userId)).mail);
      }
      await audit(tx, p.userId, id, "admin_recover", id, { admins: admins.length, identityChecks: 3 });
      return out;
    });
    if (mails === null) return err(c, "NOT_FOUND", 404);
    if (mails.length === 0) return err(c, "NO_ADMIN", 409);
    let sent = true;
    for (const m of mails) sent = (await trySend(d.email, m)) && sent;
    return json(c, { status: "ok", emailSent: sent });
  });

  route(app, "GET", "/admin/audit", signedIn, async (c) => {
    const p = principal(c);
    const full = has(p.roles, "ViewAuditFull");
    if (!full && !has(p.roles, "ViewAuditHospitalOnly")) return err(c, "FORBIDDEN", 403);
    const limit = Math.min(Math.max(queryInt(c, "limit") ?? 200, 1), 500);
    const rows = await deps(c).db.run(scopeOf(p), (tx) =>
      tx<{ at: Date; action: string; target: string; hospital_id: string | null; actor: string | null; meta: unknown }[]>`
        SELECT a.at, a.action, a.target, a.hospital_id, u.email::text AS actor, a.meta_json AS meta
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        ${full ? tx`` : tx`WHERE a.hospital_id IS NOT NULL`}
        ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`
    );
    return json(c, {
      entries: rows.map((r) => ({ at: r.at, action: r.action, target: r.target, hospitalId: r.hospital_id, actor: r.actor, meta: r.meta })),
      scope: full ? "full" : "hospital",
    });
  });

  route(app, "GET", "/admin/reports", permission("ViewReports"), async (c) => {
    const p = principal(c);
    const rows = await deps(c).db.run(scopeOf(p), (tx) => tx<HospitalRow[]>`${hospitalSelect(tx)} ORDER BY h.name_en`);
    // Aggregates only, never patient data.
    return json(c, {
      totalBookings: 0,
      averageAttendance: null,
      activeHospitals: rows.filter((r) => r.status === "active").length,
      hospitals: rows.map((r) => ({ id: r.id, name: { ar: r.name_ar, en: r.name_en, tr: r.name_tr }, bookings: 0, attendance: null, noShow: null })),
    });
  });

  // ---------------------------------------------------------------- team (company staff). Owner only.
  // At least one active Owner always remains.
  route(app, "GET", "/admin/team", permission("ManageTeam"), async (c) => {
    const p = principal(c);
    const users = await deps(c).db.run(scopeOf(p), (tx) => listUsers(tx, null));
    return json(c, { users: users.map(userDto) });
  });

  route(app, "POST", "/admin/team", permission("ManageTeam"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const b = await body(c);
    const email = str(b, "email"), role = str(b, "role");
    if (!isEmail(email)) return err2(c, "EMAIL_INVALID", 422);
    if (role === null || !CompanyRoles.includes(role)) return err2(c, "ROLE_INVALID", 422);
    try {
      const r = await d.db.run(scopeOf(p), (tx) => invite(d, tx, null, email!.trim(), role, p));
      if (r.error !== null) return err2(c, r.error, 409);
      return json(c, { id: r.userId, emailSent: await trySend(d.email, r.mail) }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err2(c, "EMAIL_TAKEN", 409);
      throw e;
    }
  });

  route(app, "PATCH", "/admin/team/:id", permission("ManageTeam"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const role = str(b, "role"), disabled = bool(b, "disabled");
    if (id === p.userId) return err2(c, "CANNOT_CHANGE_SELF", 409);
    if (role !== null && !CompanyRoles.includes(role)) return err2(c, "ROLE_INVALID", 422);
    return await deps(c).db.run(scopeOf(p), async (tx) => {
      // Serialise owner changes so two requests cannot remove the last two owners at once.
      await tx`SELECT pg_advisory_xact_lock(7240003)`;
      const u = await getUser(tx, id, null);
      if (!u) return err2(c, "NOT_FOUND", 404);
      const losesOwner = u.roles.includes(Roles.owner) && u.status === "active" && ((role !== null && role !== Roles.owner) || disabled === true);
      if (losesOwner) {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT count(*) AS n FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'owner'
          WHERE u.scope = 'company' AND u.status = 'active' AND u.id <> ${id}`;
        if (n === 0) return err2(c, "LAST_OWNER", 409);
      }
      await changeUser(tx, u, role, disabled, null, p);
      return json(c, { status: "ok" });
    });
  });

  route(app, "POST", "/admin/team/:id/send-link", permission("ManageTeam"), async (c) => {
    const p = principal(c);
    const d = deps(c);
    const id = c.req.param("id")!;
    requireJsonType(c);
    if (id === p.userId) return err2(c, "CANNOT_CHANGE_SELF", 409);
    const mail = await d.db.run(scopeOf(p), async (tx) => {
      const u = await getUser(tx, id, null);
      if (!u || u.status === "disabled") return null;
      return await sendUserLink(d, tx, u, null, p);
    });
    if (mail === null) return err2(c, "NOT_FOUND", 404);
    return json(c, { status: "ok", emailSent: await trySend(d.email, mail) });
  });

  // ---------------------------------------------------------------- system settings and per-hospital booking rules
  route(app, "GET", "/admin/settings", permission("ViewReports"), async (c) => {
    const p = principal(c);
    return json(c, await deps(c).db.run(scopeOf(p), settingsRow));
  });

  route(app, "PATCH", "/admin/settings", permission("PlatformSettings"), async (c) => {
    const p = principal(c);
    const b = await body(c);
    const tz = str(b, "defaultTimezone"), w = int(b, "bookingWindowDays"), n = int(b, "minNoticeMin");
    const cancel = bool(b, "patientCanCancel"), limit = int(b, "perPhoneDailyLimit");
    if (tz !== null && !isValidTimezone(tz)) return err2(c, "TIMEZONE_INVALID", 422);
    if (w !== null && (w < 1 || w > MaxWindowDays)) return err2(c, "WINDOW_INVALID", 422);
    if (n !== null && (n < 0 || n > MaxNoticeMin)) return err2(c, "NOTICE_INVALID", 422);
    if (limit !== null && (limit < 0 || limit > MaxPerPhone)) return err2(c, "LIMIT_INVALID", 422);
    const row = await deps(c).db.run(scopeOf(p), async (tx) => {
      await tx`
        UPDATE platform_settings SET
          default_timezone = coalesce(${tz}, default_timezone),
          booking_window_days = coalesce(${w}::int, booking_window_days),
          min_notice_min = coalesce(${n}::int, min_notice_min),
          patient_can_cancel = coalesce(${cancel}::boolean, patient_can_cancel),
          per_phone_daily_limit = coalesce(${limit}::int, per_phone_daily_limit),
          updated_at = now(), updated_by = ${p.userId}
        WHERE id`;
      await audit(tx, p.userId, null, "platform_settings", "platform", {
        DefaultTimezone: tz, BookingWindowDays: w, MinNoticeMin: n, PatientCanCancel: cancel, PerPhoneDailyLimit: limit,
      });
      return await settingsRow(tx);
    });
    return json(c, row);
  });

  route(app, "PUT", "/admin/hospitals/:id/booking-rules", permission("HospitalsCreateEdit"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const b = await body(c);
    const w = int(b, "bookingWindowDays"), n = int(b, "minNoticeMin");
    if (w !== null && (w < 1 || w > MaxWindowDays)) return err2(c, "WINDOW_INVALID", 422);
    if (n !== null && (n < 0 || n > MaxNoticeMin)) return err2(c, "NOTICE_INVALID", 422);
    return await deps(c).db.run(scopeOf(p), async (tx) => {
      const r = await tx`UPDATE hospitals SET booking_window_days = ${w}, min_notice_min = ${n}, updated_at = now() WHERE id = ${id}`;
      if (r.count === 0) return err2(c, "NOT_FOUND", 404);
      await audit(tx, p.userId, id, "booking_rules", id, { BookingWindowDays: w, MinNoticeMin: n });
      const eff = await effectiveRules(tx, id);
      return json(c, { bookingWindowDays: eff.windowDays, minNoticeMin: eff.minNoticeMin, overridden: eff.overridden });
    });
  });
}

export { scopeOf };
