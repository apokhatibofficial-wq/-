// The server-side permission matrix (Company Console › Roles). The UI only mirrors it.
// "◐" (partial) in the design for Support on the audit log means: hospital-related entries only,
// not company-internal ones (sign-ins of company users).

export const Roles = {
  owner: "owner",
  support: "support",
  viewer: "viewer",
  hospAdmin: "hosp_admin",
  reception: "reception",
  scanner: "scanner",
  doctor: "doctor",
} as const;

export const CompanyRoles: readonly string[] = [Roles.owner, Roles.support, Roles.viewer];
export const HospitalRoles: readonly string[] = [Roles.hospAdmin, Roles.reception, Roles.scanner, Roles.doctor];

/** TOTP is mandatory for company users and hospital admins (BACKEND-SPEC §3). */
export function requiresTotp(roles: readonly string[]): boolean {
  return roles.some((r) => CompanyRoles.includes(r) || r === Roles.hospAdmin);
}

/** In the order of the .NET enum: the first eight are company permissions, the rest hospital permissions. */
export const Permissions = [
  "HospitalsCreateEdit",
  "HospitalsSuspend",
  "RecoverAdminAccess",
  "ViewReports",
  "ViewAuditFull",
  "ViewAuditHospitalOnly",
  "PlatformSettings",
  "ManageTeam",
  "HospitalRead",
  "FormEditPublish",
  "HospitalSettings",
  "BookingsView",
  "CheckIn",
  "AttendanceCorrect",
  "HospitalUsersManage",
  /** Doctor: today's list for their own department(s), without phone numbers (owner's decision). */
  "BookingsViewOwnDepartment",
] as const;

export type Permission = typeof Permissions[number];

const Map: Record<string, Permission[]> = {
  owner: ["HospitalsCreateEdit", "HospitalsSuspend", "RecoverAdminAccess", "ViewReports", "ViewAuditFull", "ViewAuditHospitalOnly", "PlatformSettings", "ManageTeam"],
  support: ["RecoverAdminAccess", "ViewReports", "ViewAuditHospitalOnly"],
  viewer: ["ViewReports"],
  hosp_admin: ["HospitalRead", "FormEditPublish", "HospitalSettings", "BookingsView", "CheckIn", "AttendanceCorrect", "HospitalUsersManage"],
  reception: ["HospitalRead", "BookingsView", "CheckIn", "AttendanceCorrect"],
  scanner: ["HospitalRead", "CheckIn"],
  doctor: ["HospitalRead", "BookingsViewOwnDepartment"],
};

/** Permissions that only company users can hold; all others are hospital permissions. */
export function isCompanyPermission(p: Permission): boolean {
  return Permissions.indexOf(p) <= Permissions.indexOf("ManageTeam");
}

export function has(roles: readonly string[], p: Permission): boolean {
  return roles.some((r) => (Map[r] ?? []).includes(p));
}

/** Distinct, in the order the .NET API listed them (role by role). */
export function permissionsFor(roles: readonly string[]): Permission[] {
  const out: Permission[] = [];
  for (const r of roles) for (const p of Map[r] ?? []) if (!out.includes(p)) out.push(p);
  return out;
}

/** The authenticated caller, built only from the server-side session row. */
export interface Principal {
  sessionId: string;
  userId: string;
  email: string;
  scope: "company" | "hospital";
  hospitalId: string | null;
  roles: string[];
  client: "web" | "windows";
  viaCookie: boolean;
}

export const isCompany = (p: Principal) => p.scope === "company";
