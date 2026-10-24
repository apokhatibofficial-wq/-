// Inviting, re-inviting, changing roles and disabling users — shared by the company Team tab and by hospital admins
// managing their staff. Nobody can change their own account, and no password is ever set by someone else: accounts
// are completed only through one-time links.
import { type Deps, issueLink, revokeUserSessions } from "./auth.ts";
import { audit, type Tx } from "./db.ts";
import type { EmailMessage } from "./email.ts";
import { type Principal, Roles } from "./permissions.ts";
import { Ids } from "./security.ts";

export interface UserRow {
  id: string;
  email: string;
  status: string;
  roles: string[];
  department_ids: string[];
  has2fa: boolean;
  created_at: Date;
  last_seen_at: Date | null;
}

export const userDto = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  status: u.status,
  roles: u.roles,
  departmentIds: u.department_ids,
  has2fa: u.has2fa,
  createdAt: u.created_at,
  lastSeenAt: u.last_seen_at,
});

const select = (tx: Tx) =>
  tx`
  SELECT u.id, u.email::text AS email, u.status, u.totp_secret_enc IS NOT NULL AS has2fa, u.created_at,
         array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles,
         array(SELECT department_id FROM doctor_departments d WHERE d.user_id = u.id ORDER BY department_id) AS department_ids,
         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
  FROM users u`;

/** Company users (hospitalId null) or the users of one hospital. RLS restricts the rows again. */
export async function listUsers(tx: Tx, hospitalId: string | null): Promise<UserRow[]> {
  return hospitalId === null
    ? await tx<UserRow[]>`${select(tx)} WHERE u.scope = 'company' ORDER BY u.created_at`
    : await tx<UserRow[]>`${select(tx)} WHERE u.hospital_id = ${hospitalId} ORDER BY u.created_at`;
}

export async function getUser(tx: Tx, id: string, hospitalId: string | null): Promise<UserRow | undefined> {
  const [u] = hospitalId === null
    ? await tx<UserRow[]>`${select(tx)} WHERE u.id = ${id} AND u.scope = 'company' FOR UPDATE OF u`
    : await tx<UserRow[]>`${select(tx)} WHERE u.id = ${id} AND u.hospital_id = ${hospitalId} FOR UPDATE OF u`;
  return u;
}

/** The address checks of System.Net.Mail.MailAddress, as the .NET API used them: one @, no spaces or brackets, a dot. */
export function isEmail(s: string | null): boolean {
  if (s === null || !s.trim() || s.length > 254) return false;
  const t = s.trim();
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/.test(t) && !t.startsWith(".") && !t.includes("..") && t.includes(".") &&
    !t.split("@")[1].startsWith(".") && !t.split("@")[1].endsWith(".") && !t.split("@")[0].endsWith(".");
}

export type InviteResult = { error: string } | { error: null; userId: string; mail: EmailMessage };

export async function invite(d: Deps, tx: Tx, hospitalId: string | null, email: string, role: string, actor: Principal): Promise<InviteResult> {
  const [{ taken }] = await tx<{ taken: boolean }[]>`SELECT EXISTS (SELECT 1 FROM users WHERE email = ${email}) AS taken`;
  if (taken) return { error: "EMAIL_TAKEN" };
  const id = Ids.user();
  await tx`INSERT INTO users (id, scope, hospital_id, email) VALUES (${id}, ${hospitalId === null ? "company" : "hospital"}, ${hospitalId}, ${email})`;
  await tx`INSERT INTO user_roles (user_id, role) VALUES (${id}, ${role})`;
  const link = await issueLink(d, tx, id, "activation", actor.userId);
  await audit(tx, actor.userId, hospitalId, "user_invite", id, { role });
  return { error: null, userId: id, mail: link.mail };
}

/** Role change and/or enable/disable. Any change revokes the user's sessions. */
export async function changeUser(tx: Tx, u: UserRow, newRole: string | null, disabled: boolean | null, hospitalId: string | null, actor: Principal) {
  if (newRole !== null && !(u.roles.length === 1 && u.roles[0] === newRole)) {
    await tx`DELETE FROM user_roles WHERE user_id = ${u.id}`;
    await tx`INSERT INTO user_roles (user_id, role) VALUES (${u.id}, ${newRole})`;
    if (u.roles.includes(Roles.doctor)) await tx`DELETE FROM doctor_departments WHERE user_id = ${u.id}`;
    await revokeUserSessions(tx, u.id, "role_changed");
    await audit(tx, actor.userId, hospitalId, "user_role", u.id, { from: u.roles.join(","), to: newRole });
  }
  if (disabled !== null && disabled !== (u.status === "disabled")) {
    await tx`
      UPDATE users SET updated_at = now(), status = CASE WHEN ${disabled}::boolean THEN 'disabled'
          WHEN password_hash IS NOT NULL THEN 'active' ELSE 'pending' END
      WHERE id = ${u.id}`;
    if (disabled) await revokeUserSessions(tx, u.id, "user_disabled");
    await audit(tx, actor.userId, hospitalId, disabled ? "user_disable" : "user_enable", u.id);
  }
}

/** A doctor sees only the bookings of these departments (owner's decision). Replaces the whole set. */
export async function setDoctorDepartments(tx: Tx, userId: string, hospitalId: string, departmentIds: string[], actor: Principal) {
  await tx`DELETE FROM doctor_departments WHERE user_id = ${userId}`;
  for (const dep of departmentIds) {
    await tx`INSERT INTO doctor_departments (user_id, department_id, hospital_id) VALUES (${userId}, ${dep}, ${hospitalId})`;
  }
  await audit(tx, actor.userId, hospitalId, "doctor_departments", userId, { count: departmentIds.length });
}

/** New activation link for a pending user, or a password-reset link for an active one. */
export async function sendUserLink(d: Deps, tx: Tx, u: UserRow, hospitalId: string | null, actor: Principal): Promise<EmailMessage> {
  const purpose = u.status === "pending" ? "activation" : "reset";
  const link = await issueLink(d, tx, u.id, purpose, actor.userId);
  await audit(tx, actor.userId, hospitalId, "user_link", u.id, { purpose });
  return link.mail;
}
