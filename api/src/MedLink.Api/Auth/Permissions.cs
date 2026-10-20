namespace MedLink.Api.Auth;

public static class Roles
{
    public const string Owner = "owner", Support = "support", Viewer = "viewer";
    public const string HospAdmin = "hosp_admin", Reception = "reception", Scanner = "scanner";

    public static readonly string[] Company = [Owner, Support, Viewer];
    public static readonly string[] Hospital = [HospAdmin, Reception, Scanner];

    /// <summary>TOTP is mandatory for company users and hospital admins (BACKEND-SPEC §3).</summary>
    public static bool RequiresTotp(IEnumerable<string> roles) =>
        roles.Any(r => Company.Contains(r) || r == HospAdmin);
}

/// <summary>
/// The server-side permission matrix (Company Console › Roles). The UI only mirrors it.
/// "◐" (partial) in the design for Support on the audit log means: hospital-related entries only,
/// not company-internal ones (sign-ins of company users).
/// </summary>
public enum Permission
{
    // Company
    HospitalsCreateEdit,
    HospitalsSuspend,
    RecoverAdminAccess,
    ViewReports,
    ViewAuditFull,
    ViewAuditHospitalOnly,
    ManageTeam,
    // Hospital
    HospitalRead,
    FormEditPublish,
    HospitalSettings,
    BookingsView,
    CheckIn,
    AttendanceCorrect,
    HospitalUsersManage,
}

public static class PermissionMatrix
{
    private static readonly Dictionary<string, Permission[]> Map = new()
    {
        [Roles.Owner] = [Permission.HospitalsCreateEdit, Permission.HospitalsSuspend, Permission.RecoverAdminAccess,
                         Permission.ViewReports, Permission.ViewAuditFull, Permission.ViewAuditHospitalOnly, Permission.ManageTeam],
        [Roles.Support] = [Permission.RecoverAdminAccess, Permission.ViewReports, Permission.ViewAuditHospitalOnly],
        [Roles.Viewer] = [Permission.ViewReports],
        [Roles.HospAdmin] = [Permission.HospitalRead, Permission.FormEditPublish, Permission.HospitalSettings, Permission.BookingsView,
                             Permission.CheckIn, Permission.AttendanceCorrect, Permission.HospitalUsersManage],
        [Roles.Reception] = [Permission.HospitalRead, Permission.BookingsView, Permission.CheckIn, Permission.AttendanceCorrect],
        [Roles.Scanner] = [Permission.HospitalRead, Permission.CheckIn],
    };

    /// <summary>Permissions that only company users can hold; all others are hospital permissions.</summary>
    public static bool IsCompanyPermission(Permission p) => p <= Permission.ManageTeam;

    public static bool Has(IEnumerable<string> roles, Permission p) =>
        roles.Any(r => Map.TryGetValue(r, out var ps) && ps.Contains(p));

    public static IEnumerable<Permission> For(IEnumerable<string> roles) =>
        roles.SelectMany(r => Map.GetValueOrDefault(r) ?? []).Distinct();
}
