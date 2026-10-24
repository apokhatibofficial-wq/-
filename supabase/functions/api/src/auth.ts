// Passwords, TOTP, sessions and one-time links. Everything here runs in the "system" RLS scope because the
// caller's hospital is not known until the credentials are checked.
import type { Config } from "./config.ts";
import { audit, Db, Scopes, type Tx } from "./db.ts";
import { type EmailMessage, linkEmail } from "./email.ts";
import { CompanyRoles, type Principal, requiresTotp, Roles } from "./permissions.ts";
import {
  base32,
  decryptSecret,
  encryptSecret,
  hashPassword,
  Ids,
  newToken,
  Passwords,
  tokenHash,
  Totp,
  validatePassword,
  verifyPassword,
} from "./security.ts";

export interface Deps {
  config: Config;
  db: Db;
  now: () => Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const MaxFailedAttempts = 5;
export const LockoutMs = 15 * MINUTE;
export const AdminIdleMs = 8 * HOUR;
export const StaffIdleMs = 12 * HOUR;
/** Hard limit: a session ends 7 days after sign-in however active it is. */
export const MaxSessionAgeMs = 7 * 24 * HOUR;
/** QR-scanner accounts (shared phones): the session ends 12 hours after sign-in (SCREENS.md §4). */
export const ScannerMaxAgeMs = 12 * HOUR;

export const LinkValidityMin: Record<string, number> = { setup: 30, activation: 24 * 60, reset: 60 };

export function idleFor(roles: readonly string[]): number {
  return roles.some((r) => r === Roles.reception || r === Roles.scanner || r === Roles.doctor) &&
      !roles.some((r) => r === Roles.hospAdmin || CompanyRoles.includes(r))
    ? StaffIdleMs
    : AdminIdleMs;
}

export function maxAgeFor(roles: readonly string[]): number {
  return roles.length > 0 && roles.every((r) => r === Roles.scanner) ? ScannerMaxAgeMs : MaxSessionAgeMs;
}

export type LoginResult =
  | { outcome: "ok"; token: string; principal: Principal }
  | { outcome: "invalid" | "mfa_required" | "mfa_not_enrolled" | "hospital_suspended" }
  | { outcome: "locked"; lockedUntil: Date };

interface LoginRow {
  id: string;
  email: string;
  scope: "company" | "hospital";
  hospital_id: string | null;
  password_hash: string | null;
  totp_secret_enc: Uint8Array | null;
  totp_last_step: number | null;
  status: string;
  failed_attempts: number;
  locked_until: Date | null;
  roles: string[];
  hospital_status: string | null;
  staff_totp_required: boolean;
}

export async function login(d: Deps, email: string, password: string, totpCode: string | null, client: "web" | "windows"): Promise<LoginResult> {
  return await d.db.run(Scopes.system, async (tx) => {
    const [u] = await tx<LoginRow[]>`
      SELECT u.id, u.email::text AS email, u.scope, u.hospital_id, u.password_hash, u.totp_secret_enc, u.totp_last_step, u.status,
             u.failed_attempts, u.locked_until,
             array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles,
             h.status AS hospital_status, coalesce(h.staff_totp_required, false) AS staff_totp_required
      FROM users u LEFT JOIN hospitals h ON h.id = u.hospital_id
      WHERE u.email = ${email.trim()}
      FOR UPDATE OF u`;
    if (!u) {
      await verifyPassword(password, null);
      return { outcome: "invalid" };
    }
    const now = d.now();
    if (u.locked_until && u.locked_until > now) return { outcome: "locked", lockedUntil: u.locked_until };

    const check = await verifyPassword(password, u.password_hash);
    if (!check.ok || u.status !== "active") return await fail(d, tx, u);
    if (u.hospital_status === "suspended") return { outcome: "hospital_suspended" };

    const totpNeeded = requiresTotp(u.roles) || u.staff_totp_required || u.totp_secret_enc !== null;
    let step: number | null = null;
    if (totpNeeded) {
      if (u.totp_secret_enc === null) return { outcome: "mfa_not_enrolled" };
      if (!totpCode || !totpCode.trim()) return { outcome: "mfa_required" };
      step = await Totp.verify(await decryptSecret(d.config.totpEncryptionKey, u.totp_secret_enc), totpCode, u.totp_last_step, now.getTime());
      if (step === null) return await fail(d, tx, u);
    }

    const newHash = check.needsRehash ? await hashPassword(password) : null;
    await tx`
      UPDATE users SET failed_attempts = 0, locked_until = NULL,
             totp_last_step = coalesce(${step}::bigint, totp_last_step),
             password_hash = coalesce(${newHash}::text, password_hash), updated_at = now()
      WHERE id = ${u.id}`;
    const { token, principal } = await createSession(d, tx, u.id, u.email, u.scope, u.hospital_id, u.roles, client);
    await audit(tx, u.id, u.hospital_id, "login", u.id, { client });
    return { outcome: "ok", token, principal };
  });
}

async function fail(d: Deps, tx: Tx, u: LoginRow): Promise<LoginResult> {
  const attempts = u.failed_attempts + 1;
  const lockUntil = attempts >= MaxFailedAttempts ? new Date(d.now().getTime() + LockoutMs) : null;
  await tx`UPDATE users SET failed_attempts = ${lockUntil === null ? attempts : 0}, locked_until = ${lockUntil}, updated_at = now()
           WHERE id = ${u.id}`;
  if (lockUntil !== null) {
    await audit(tx, null, u.hospital_id, "login_locked", u.id);
    return { outcome: "locked", lockedUntil: lockUntil };
  }
  return { outcome: "invalid" };
}

async function createSession(d: Deps, tx: Tx, userId: string, email: string, scope: "company" | "hospital", hospitalId: string | null,
  roles: string[], client: "web" | "windows"): Promise<{ token: string; principal: Principal }> {
  const token = newToken();
  const id = Ids.session();
  const now = d.now().getTime();
  await tx`
    INSERT INTO sessions (id, user_id, token_hash, client, expires_at, absolute_expires_at)
    VALUES (${id}, ${userId}, ${await tokenHash(token)}, ${client}, ${new Date(now + idleFor(roles))}, ${new Date(now + maxAgeFor(roles))})`;
  return { token, principal: { sessionId: id, userId, email, scope, hospitalId, roles, client, viaCookie: client === "web" } };
}

/** Resolves a session token. Sliding idle expiry; suspended hospitals and inactive users are rejected. */
export async function validateSession(d: Deps, token: string, viaCookie: boolean): Promise<Principal | null> {
  return await d.db.run(Scopes.system, async (tx) => {
    const now = d.now();
    const [s] = await tx<
      { id: string; user_id: string; email: string; scope: "company" | "hospital"; hospital_id: string | null; client: "web" | "windows"; last_seen_at: Date; roles: string[] }[]
    >`
      SELECT s.id, s.user_id, u.email::text AS email, u.scope, u.hospital_id, s.client, s.last_seen_at,
             array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN hospitals h ON h.id = u.hospital_id
      WHERE s.token_hash = ${await tokenHash(token)} AND s.revoked_at IS NULL AND s.expires_at > ${now} AND s.absolute_expires_at > ${now}
        AND u.status = 'active' AND (h.id IS NULL OR h.status <> 'suspended')`;
    if (!s) return null;
    if (now.getTime() - s.last_seen_at.getTime() > MINUTE) {
      await tx`UPDATE sessions SET last_seen_at = ${now}, expires_at = least(${new Date(now.getTime() + idleFor(s.roles))}, absolute_expires_at)
               WHERE id = ${s.id}`;
    }
    return { sessionId: s.id, userId: s.user_id, email: s.email, scope: s.scope, hospitalId: s.hospital_id, roles: s.roles, client: s.client, viaCookie };
  });
}

export async function logout(d: Deps, p: Principal): Promise<void> {
  await d.db.run(Scopes.system, async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = ${p.sessionId} AND revoked_at IS NULL`;
    await audit(tx, p.userId, p.hospitalId, "logout", p.userId);
  });
}

export async function revokeUserSessions(tx: Tx, userId: string, reason: string): Promise<number> {
  const r = await tx`UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason} WHERE user_id = ${userId} AND revoked_at IS NULL`;
  return r.count;
}

export async function revokeHospitalSessions(tx: Tx, hospitalId: string, reason: string): Promise<number> {
  const r = await tx`
    UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason}
    WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE hospital_id = ${hospitalId})`;
  return r.count;
}

// ------------------------------------------------------------------ one-time links

/** The token goes in the URL fragment so it never reaches server logs or Referer headers. */
export function linkUrl(config: Config, scope: string, token: string): string {
  return (scope === "company" ? config.adminWebUrl : config.hospitalWebUrl) + "/link#t=" + token;
}

/** Issues a single-use link and returns the email to send after the transaction commits. */
export async function issueLink(d: Deps, tx: Tx, userId: string, purpose: string, createdBy: string | null): Promise<{ mail: EmailMessage; url: string }> {
  const [user] = await tx<{ email: string; scope: string }[]>`SELECT email::text AS email, scope FROM users WHERE id = ${userId}`;
  // Any earlier unused link for this user stops working.
  await tx`UPDATE one_time_links SET expires_at = now() WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > now()`;
  const token = newToken();
  const validity = LinkValidityMin[purpose];
  await tx`
    INSERT INTO one_time_links (id, user_id, purpose, token_hash, expires_at, created_by)
    VALUES (${Ids.link()}, ${userId}, ${purpose}, ${await tokenHash(token)}, ${new Date(d.now().getTime() + validity * MINUTE)}, ${createdBy})`;
  const url = linkUrl(d.config, user.scope, token);
  return { mail: linkEmail(user.email, purpose, url, validity), url };
}

interface LinkRow {
  id: string;
  user_id: string;
  purpose: string;
  pending_totp_enc: Uint8Array | null;
  email: string;
  scope: string;
  hospital_id: string | null;
  roles: string[];
  staff_totp_required: boolean;
}

async function findLink(tx: Tx, token: string): Promise<LinkRow | undefined> {
  const [l] = await tx<LinkRow[]>`
    SELECT l.id, l.user_id, l.purpose, l.pending_totp_enc, u.email::text AS email, u.scope, u.hospital_id,
           array(SELECT role FROM user_roles r WHERE r.user_id = u.id) AS roles,
           coalesce(h.staff_totp_required, false) AS staff_totp_required
    FROM one_time_links l JOIN users u ON u.id = l.user_id LEFT JOIN hospitals h ON h.id = u.hospital_id
    WHERE l.token_hash = ${await tokenHash(token)} AND l.used_at IS NULL AND l.expires_at > now() AND u.status <> 'disabled'
    FOR UPDATE OF l`;
  return l;
}

export interface LinkInfo {
  purpose: string;
  scope: string;
  email: string;
  totpRequired: boolean;
  totpUri: string | null;
  totpSecret: string | null;
}

/** Looks at a link without consuming it. Creates the pending TOTP secret on first use. */
export async function inspectLink(d: Deps, token: string): Promise<LinkInfo | null> {
  return await d.db.run(Scopes.system, async (tx) => {
    const l = await findLink(tx, token);
    if (!l) return null;
    const required = requiresTotp(l.roles) || l.staff_totp_required;
    if (!required) return { purpose: l.purpose, scope: l.scope, email: l.email, totpRequired: false, totpUri: null, totpSecret: null };
    let secret: Uint8Array;
    if (l.pending_totp_enc === null) {
      secret = Totp.newSecret();
      await tx`UPDATE one_time_links SET pending_totp_enc = ${await encryptSecret(d.config.totpEncryptionKey, secret)} WHERE id = ${l.id}`;
    } else secret = await decryptSecret(d.config.totpEncryptionKey, l.pending_totp_enc);
    return {
      purpose: l.purpose,
      scope: l.scope,
      email: l.email,
      totpRequired: true,
      totpUri: Totp.provisioningUri(secret, l.email),
      totpSecret: base32(secret),
    };
  });
}

export type LinkOutcome = "ok" | "invalid_or_expired" | "bad_password" | "bad_totp";

/** Sets the password (and TOTP) and consumes the link. All existing sessions are revoked. */
export async function completeLink(d: Deps, token: string, password: string, totpCode: string | null): Promise<LinkOutcome> {
  return await d.db.run(Scopes.system, async (tx) => {
    const l = await findLink(tx, token);
    if (!l) return "invalid_or_expired";
    if (validatePassword(password, l.email) !== null) return "bad_password";

    const required = requiresTotp(l.roles) || l.staff_totp_required;
    let secretEnc: Uint8Array | null = null;
    let step: number | null = null;
    if (required) {
      if (l.pending_totp_enc === null) return "bad_totp";
      step = await Totp.verify(await decryptSecret(d.config.totpEncryptionKey, l.pending_totp_enc), totpCode, null, d.now().getTime());
      if (step === null) return "bad_totp";
      secretEnc = l.pending_totp_enc;
    }
    await tx`
      UPDATE users SET password_hash = ${await hashPassword(password)}, totp_secret_enc = ${secretEnc}, totp_last_step = ${step}::bigint,
             status = 'active', failed_attempts = 0, locked_until = NULL,
             password_changed_at = now(), updated_at = now()
      WHERE id = ${l.user_id}`;
    await tx`UPDATE one_time_links SET used_at = now(), pending_totp_enc = NULL WHERE id = ${l.id}`;
    await revokeUserSessions(tx, l.user_id, "password_set");
    if (l.hospital_id !== null && l.roles.includes(Roles.hospAdmin)) {
      await tx`UPDATE hospitals SET status = 'active', updated_at = now() WHERE id = ${l.hospital_id} AND status = 'pending'`;
    }
    await audit(tx, l.user_id, l.hospital_id, "link_completed", l.user_id, { purpose: l.purpose });
    return "ok";
  });
}

export { Passwords };
