using System.Net.Mail;
using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Email;
using Npgsql;

namespace MedLink.Api.Auth;

/// <summary>
/// Inviting, re-inviting, changing roles and disabling users — shared by the company Team tab and by
/// hospital admins managing their staff. Nobody can change their own account, and no password is ever
/// set by someone else: accounts are completed only through one-time links.
/// </summary>
public static class UserAdmin
{
    public sealed class UserRow
    {
        public string Id { get; set; } = "";
        public string Email { get; set; } = "";
        public string Status { get; set; } = "";
        public string[] Roles { get; set; } = [];
        public bool Has2fa { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? LastSeenAt { get; set; }
    }

    public static object Dto(UserRow u) => new
    {
        id = u.Id, email = u.Email, status = u.Status, roles = u.Roles, has2fa = u.Has2fa,
        createdAt = DateTime.SpecifyKind(u.CreatedAt, DateTimeKind.Utc),
        lastSeenAt = u.LastSeenAt is { } l ? DateTime.SpecifyKind(l, DateTimeKind.Utc) : (DateTime?)null,
    };

    private const string Select = """
        SELECT u.id, u.email::text AS email, u.status, u.totp_secret_enc IS NOT NULL AS has2fa, u.created_at,
               array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles,
               (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
        FROM users u
        """;

    /// <summary>Company users (hospitalId null) or the users of one hospital. RLS restricts the rows again.</summary>
    public static Task<IEnumerable<UserRow>> ListAsync(NpgsqlConnection c, NpgsqlTransaction t, string? hospitalId) =>
        hospitalId is null
            ? c.QueryAsync<UserRow>(Select + " WHERE u.scope = 'company' ORDER BY u.created_at", transaction: t)
            : c.QueryAsync<UserRow>(Select + " WHERE u.hospital_id = @hospitalId ORDER BY u.created_at", new { hospitalId }, t);

    public static Task<UserRow?> GetAsync(NpgsqlConnection c, NpgsqlTransaction t, string id, string? hospitalId) =>
        c.QuerySingleOrDefaultAsync<UserRow>(Select + (hospitalId is null
            ? " WHERE u.id = @id AND u.scope = 'company'"
            : " WHERE u.id = @id AND u.hospital_id = @hospitalId") + " FOR UPDATE OF u", new { id, hospitalId }, t);

    public static bool IsEmail(string? s)
    {
        if (string.IsNullOrWhiteSpace(s) || s.Length > 254) return false;
        try { return new MailAddress(s).Address == s.Trim() && s.Contains('.'); }
        catch (FormatException) { return false; }
    }

    public sealed record InviteResult(string? Error, string? UserId = null, EmailMessage? Mail = null);

    public static async Task<InviteResult> InviteAsync(NpgsqlConnection c, NpgsqlTransaction t, AuthService auth,
        string? hospitalId, string email, string role, Principal actor)
    {
        if (await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM users WHERE email = @email)", new { email }, t))
            return new InviteResult("EMAIL_TAKEN");
        var id = MedLink.Api.Security.Ids.User();
        await c.ExecuteAsync("INSERT INTO users (id, scope, hospital_id, email) VALUES (@id, @scope, @hospitalId, @email)",
            new { id, scope = hospitalId is null ? "company" : "hospital", hospitalId, email }, t);
        await c.ExecuteAsync("INSERT INTO user_roles (user_id, role) VALUES (@id, @role)", new { id, role }, t);
        var link = await auth.IssueLinkAsync(c, t, id, "activation", actor.UserId);
        await AuditLog.WriteAsync(c, t, actor.UserId, hospitalId, "user_invite", id, new { role });
        return new InviteResult(null, id, link.Mail);
    }

    /// <summary>Role change and/or enable/disable. Any change revokes the user's sessions.</summary>
    public static async Task ChangeAsync(NpgsqlConnection c, NpgsqlTransaction t, UserRow u, string? newRole, bool? disabled,
        string? hospitalId, Principal actor)
    {
        if (newRole is not null && !(u.Roles.Length == 1 && u.Roles[0] == newRole))
        {
            await c.ExecuteAsync("DELETE FROM user_roles WHERE user_id = @id", new { id = u.Id }, t);
            await c.ExecuteAsync("INSERT INTO user_roles (user_id, role) VALUES (@id, @newRole)", new { id = u.Id, newRole }, t);
            await AuthService.RevokeUserSessionsAsync(c, t, u.Id, "role_changed");
            await AuditLog.WriteAsync(c, t, actor.UserId, hospitalId, "user_role", u.Id, new { from = string.Join(",", u.Roles), to = newRole });
        }
        if (disabled is { } d && d != (u.Status == "disabled"))
        {
            await c.ExecuteAsync("""
                UPDATE users SET updated_at = now(), status = CASE WHEN @d THEN 'disabled'
                    WHEN password_hash IS NOT NULL THEN 'active' ELSE 'pending' END
                WHERE id = @id
                """, new { id = u.Id, d }, t);
            if (d) await AuthService.RevokeUserSessionsAsync(c, t, u.Id, "user_disabled");
            await AuditLog.WriteAsync(c, t, actor.UserId, hospitalId, d ? "user_disable" : "user_enable", u.Id);
        }
    }

    /// <summary>New activation link for a pending user, or a password-reset link for an active one.</summary>
    public static async Task<EmailMessage> SendLinkAsync(NpgsqlConnection c, NpgsqlTransaction t, AuthService auth, UserRow u,
        string? hospitalId, Principal actor)
    {
        var purpose = u.Status == "pending" ? "activation" : "reset";
        var link = await auth.IssueLinkAsync(c, t, u.Id, purpose, actor.UserId);
        await AuditLog.WriteAsync(c, t, actor.UserId, hospitalId, "user_link", u.Id, new { purpose });
        return link.Mail;
    }

    public static async Task<bool> TrySendAsync(IEmailSender email, EmailMessage msg, ILogger log)
    {
        try { await email.SendAsync(msg); return true; }
        catch (Exception e)
        {
            log.LogError("email delivery failed: {Kind} {Error}", msg.Kind, e.GetType().Name);
            return false;
        }
    }
}
