using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Config;
using MedLink.Api.Data;
using MedLink.Api.Email;
using MedLink.Api.Security;
using Npgsql;

namespace MedLink.Api.Auth;

public enum LoginOutcome { Ok, Invalid, Locked, MfaRequired, MfaNotEnrolled, HospitalSuspended }

public sealed record LoginResult(LoginOutcome Outcome, string? Token = null, Principal? Principal = null, DateTimeOffset? LockedUntil = null);

public sealed record IssuedLink(EmailMessage Mail, string Url);

public sealed record LinkInfo(string Purpose, string Scope, string Email, bool TotpRequired, string? TotpUri, string? TotpSecret);

public enum LinkOutcome { Ok, InvalidOrExpired, BadPassword, BadTotp }

/// <summary>
/// Passwords, TOTP, sessions and one-time links. Everything here runs in the <c>system</c> RLS scope
/// because the caller's hospital is not known until the credentials are checked.
/// </summary>
public sealed class AuthService(Db db, PasswordHasher hasher, TotpService totp, MedLinkOptions options, TimeProvider clock)
{
    public const int MaxFailedAttempts = 5;
    public static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan AdminIdle = TimeSpan.FromHours(8);
    public static readonly TimeSpan StaffIdle = TimeSpan.FromHours(12);
    /// <summary>Hard limit: a session ends 7 days after sign-in however active it is.</summary>
    public static readonly TimeSpan MaxSessionAge = TimeSpan.FromDays(7);

    public static readonly Dictionary<string, TimeSpan> LinkValidity = new()
    {
        ["setup"] = TimeSpan.FromMinutes(30),
        ["activation"] = TimeSpan.FromHours(24),
        ["reset"] = TimeSpan.FromHours(1),
    };

    private DateTimeOffset Now => clock.GetUtcNow();

    private sealed class LoginRow
    {
        public string Id { get; set; } = "";
        public string Email { get; set; } = "";
        public string Scope { get; set; } = "";
        public string? HospitalId { get; set; }
        public string? PasswordHash { get; set; }
        public byte[]? TotpSecretEnc { get; set; }
        public long? TotpLastStep { get; set; }
        public string Status { get; set; } = "";
        public int FailedAttempts { get; set; }
        public DateTime? LockedUntil { get; set; }
        public string[] Roles { get; set; } = [];
        public string? HospitalStatus { get; set; }
        public bool StaffTotpRequired { get; set; }
    }

    public static TimeSpan IdleFor(IEnumerable<string> roles) =>
        roles.Any(r => r is Roles.Reception or Roles.Scanner) && !roles.Any(r => r is Roles.HospAdmin || Roles.Company.Contains(r))
            ? StaffIdle : AdminIdle;

    public Task<LoginResult> LoginAsync(string email, string password, string? totpCode, string client, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            var u = await conn.QuerySingleOrDefaultAsync<LoginRow>("""
                SELECT u.id, u.email::text AS email, u.scope, u.hospital_id, u.password_hash, u.totp_secret_enc, u.totp_last_step, u.status,
                       u.failed_attempts, u.locked_until,
                       array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles,
                       h.status AS hospital_status, coalesce(h.staff_totp_required, false) AS staff_totp_required
                FROM users u LEFT JOIN hospitals h ON h.id = u.hospital_id
                WHERE u.email = @email
                FOR UPDATE OF u
                """, new { email = email.Trim() }, tx);

            if (u is null)
            {
                hasher.Verify(password, null, out _);
                return new LoginResult(LoginOutcome.Invalid);
            }
            if (u.LockedUntil is { } lu && new DateTimeOffset(DateTime.SpecifyKind(lu, DateTimeKind.Utc)) > Now)
                return new LoginResult(LoginOutcome.Locked, LockedUntil: new DateTimeOffset(DateTime.SpecifyKind(lu, DateTimeKind.Utc)));

            if (!hasher.Verify(password, u.PasswordHash, out var rehash) || u.Status != "active")
                return await FailAsync(conn, tx, u);

            if (u.HospitalStatus == "suspended")
                return new LoginResult(LoginOutcome.HospitalSuspended);

            var totpNeeded = Roles.RequiresTotp(u.Roles) || u.StaffTotpRequired || u.TotpSecretEnc is not null;
            long? step = null;
            if (totpNeeded)
            {
                if (u.TotpSecretEnc is null) return new LoginResult(LoginOutcome.MfaNotEnrolled);
                if (string.IsNullOrWhiteSpace(totpCode)) return new LoginResult(LoginOutcome.MfaRequired);
                step = totp.Verify(totp.Decrypt(u.TotpSecretEnc), totpCode, u.TotpLastStep);
                if (step is null) return await FailAsync(conn, tx, u);
            }

            await conn.ExecuteAsync("""
                UPDATE users SET failed_attempts = 0, locked_until = NULL,
                       totp_last_step = coalesce(@step, totp_last_step),
                       password_hash = coalesce(@newHash, password_hash), updated_at = now()
                WHERE id = @id
                """, new { id = u.Id, step, newHash = rehash ? hasher.Hash(password) : null }, tx);

            var (token, principal) = await CreateSessionAsync(conn, tx, u.Id, u.Email, u.Scope, u.HospitalId, u.Roles, client);
            await AuditLog.WriteAsync(conn, tx, u.Id, u.HospitalId, "login", u.Id, new { client });
            return new LoginResult(LoginOutcome.Ok, token, principal);
        }, ct);

    private async Task<LoginResult> FailAsync(NpgsqlConnection conn, NpgsqlTransaction tx, LoginRow u)
    {
        var attempts = u.FailedAttempts + 1;
        DateTimeOffset? lockUntil = attempts >= MaxFailedAttempts ? Now + LockoutDuration : null;
        await conn.ExecuteAsync("""
            UPDATE users SET failed_attempts = @a, locked_until = @l, updated_at = now() WHERE id = @id
            """, new { id = u.Id, a = lockUntil is null ? attempts : 0, l = lockUntil?.UtcDateTime }, tx);
        if (lockUntil is not null)
        {
            await AuditLog.WriteAsync(conn, tx, null, u.HospitalId, "login_locked", u.Id);
            return new LoginResult(LoginOutcome.Locked, LockedUntil: lockUntil);
        }
        return new LoginResult(LoginOutcome.Invalid);
    }

    private async Task<(string Token, Principal Principal)> CreateSessionAsync(NpgsqlConnection conn, NpgsqlTransaction tx,
        string userId, string email, string scope, string? hospitalId, string[] roles, string client)
    {
        var token = Tokens.NewToken();
        var id = Ids.Session();
        await conn.ExecuteAsync("""
            INSERT INTO sessions (id, user_id, token_hash, client, expires_at, absolute_expires_at)
            VALUES (@id, @userId, @hash, @client, @exp, @abs)
            """, new { id, userId, hash = Tokens.Hash(token), client, exp = (Now + IdleFor(roles)).UtcDateTime, abs = (Now + MaxSessionAge).UtcDateTime }, tx);
        return (token, new Principal(id, userId, email, scope, hospitalId, roles, client, client == "web"));
    }

    private sealed class SessionRow
    {
        public string Id { get; set; } = "";
        public string UserId { get; set; } = "";
        public string Email { get; set; } = "";
        public string Scope { get; set; } = "";
        public string? HospitalId { get; set; }
        public string Client { get; set; } = "";
        public DateTime LastSeenAt { get; set; }
        public string[] Roles { get; set; } = [];
    }

    /// <summary>Resolves a session token. Sliding idle expiry; suspended hospitals and inactive users are rejected.</summary>
    public Task<Principal?> ValidateSessionAsync(string token, bool viaCookie, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            var s = await conn.QuerySingleOrDefaultAsync<SessionRow>("""
                SELECT s.id, s.user_id, u.email::text AS email, u.scope, u.hospital_id, s.client, s.last_seen_at,
                       array(SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY role) AS roles
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                LEFT JOIN hospitals h ON h.id = u.hospital_id
                WHERE s.token_hash = @hash AND s.revoked_at IS NULL AND s.expires_at > @now AND s.absolute_expires_at > @now
                  AND u.status = 'active' AND (h.id IS NULL OR h.status <> 'suspended')
                """, new { hash = Tokens.Hash(token), now = Now.UtcDateTime }, tx);
            if (s is null) return null;
            if (Now - new DateTimeOffset(DateTime.SpecifyKind(s.LastSeenAt, DateTimeKind.Utc)) > TimeSpan.FromMinutes(1))
                await conn.ExecuteAsync("UPDATE sessions SET last_seen_at = @now, expires_at = least(@exp, absolute_expires_at) WHERE id = @id",
                    new { id = s.Id, now = Now.UtcDateTime, exp = (Now + IdleFor(s.Roles)).UtcDateTime }, tx);
            return new Principal(s.Id, s.UserId, s.Email, s.Scope, s.HospitalId, s.Roles, s.Client, viaCookie);
        }, ct);

    public Task LogoutAsync(Principal p, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            await conn.ExecuteAsync("UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = @id AND revoked_at IS NULL",
                new { id = p.SessionId }, tx);
            await AuditLog.WriteAsync(conn, tx, p.UserId, p.HospitalId, "logout", p.UserId);
        }, ct);

    public static Task<int> RevokeUserSessionsAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string userId, string reason) =>
        conn.ExecuteAsync("UPDATE sessions SET revoked_at = now(), revoke_reason = @reason WHERE user_id = @userId AND revoked_at IS NULL",
            new { userId, reason }, tx);

    public static Task<int> RevokeHospitalSessionsAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string hospitalId, string reason) =>
        conn.ExecuteAsync("""
            UPDATE sessions SET revoked_at = now(), revoke_reason = @reason
            WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE hospital_id = @hospitalId)
            """, new { hospitalId, reason }, tx);

    // ------------------------------------------------------------------ one-time links

    /// <summary>Issues a single-use link and returns the email to send after the transaction commits.</summary>
    public async Task<IssuedLink> IssueLinkAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string userId, string purpose, string? createdBy)
    {
        var user = await conn.QuerySingleAsync<(string Email, string Scope)>(
            "SELECT email::text, scope FROM users WHERE id = @userId", new { userId }, tx);
        // Any earlier unused link for this user stops working.
        await conn.ExecuteAsync("UPDATE one_time_links SET expires_at = now() WHERE user_id = @userId AND used_at IS NULL AND expires_at > now()",
            new { userId }, tx);
        var token = Tokens.NewToken();
        var validity = LinkValidity[purpose];
        await conn.ExecuteAsync("""
            INSERT INTO one_time_links (id, user_id, purpose, token_hash, expires_at, created_by)
            VALUES (@id, @userId, @purpose, @hash, @exp, @createdBy)
            """, new { id = Ids.Link(), userId, purpose, hash = Tokens.Hash(token), exp = (Now + validity).UtcDateTime, createdBy }, tx);
        var url = LinkUrl(user.Scope, token);
        return new IssuedLink(LinkEmails.Build(user.Email, purpose, url, validity), url);
    }

    /// <summary>The token goes in the URL fragment so it never reaches server logs or Referer headers.</summary>
    public string LinkUrl(string scope, string token) =>
        (scope == "company" ? options.AdminWebUrl : options.HospitalWebUrl) + "/link#t=" + token;

    private sealed class LinkRow
    {
        public string Id { get; set; } = "";
        public string UserId { get; set; } = "";
        public string Purpose { get; set; } = "";
        public byte[]? PendingTotpEnc { get; set; }
        public string Email { get; set; } = "";
        public string Scope { get; set; } = "";
        public string? HospitalId { get; set; }
        public string[] Roles { get; set; } = [];
        public bool StaffTotpRequired { get; set; }
    }

    private static Task<LinkRow?> FindLinkAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string token) =>
        conn.QuerySingleOrDefaultAsync<LinkRow>("""
            SELECT l.id, l.user_id, l.purpose, l.pending_totp_enc, u.email::text AS email, u.scope, u.hospital_id,
                   array(SELECT role FROM user_roles r WHERE r.user_id = u.id) AS roles,
                   coalesce(h.staff_totp_required, false) AS staff_totp_required
            FROM one_time_links l JOIN users u ON u.id = l.user_id LEFT JOIN hospitals h ON h.id = u.hospital_id
            WHERE l.token_hash = @hash AND l.used_at IS NULL AND l.expires_at > now() AND u.status <> 'disabled'
            FOR UPDATE OF l
            """, new { hash = Tokens.Hash(token) }, tx);

    /// <summary>Looks at a link without consuming it. Creates the pending TOTP secret on first use.</summary>
    public Task<LinkInfo?> InspectLinkAsync(string token, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            var l = await FindLinkAsync(conn, tx, token);
            if (l is null) return null;
            var required = Roles.RequiresTotp(l.Roles) || l.StaffTotpRequired;
            if (!required) return new LinkInfo(l.Purpose, l.Scope, l.Email, false, null, null);
            byte[] secret;
            if (l.PendingTotpEnc is null)
            {
                secret = totp.NewSecret();
                await conn.ExecuteAsync("UPDATE one_time_links SET pending_totp_enc = @enc WHERE id = @id",
                    new { id = l.Id, enc = totp.Encrypt(secret) }, tx);
            }
            else secret = totp.Decrypt(l.PendingTotpEnc);
            return new LinkInfo(l.Purpose, l.Scope, l.Email, true, totp.ProvisioningUri(secret, l.Email), TotpService.Base32(secret));
        }, ct);

    /// <summary>Sets the password (and TOTP) and consumes the link. All existing sessions are revoked.</summary>
    public Task<LinkOutcome> CompleteLinkAsync(string token, string password, string? totpCode, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            var l = await FindLinkAsync(conn, tx, token);
            if (l is null) return LinkOutcome.InvalidOrExpired;
            if (PasswordHasher.Validate(password, l.Email) is not null) return LinkOutcome.BadPassword;

            var required = Roles.RequiresTotp(l.Roles) || l.StaffTotpRequired;
            byte[]? secretEnc = null;
            long? step = null;
            if (required)
            {
                if (l.PendingTotpEnc is null) return LinkOutcome.BadTotp;
                step = totp.Verify(totp.Decrypt(l.PendingTotpEnc), totpCode, null);
                if (step is null) return LinkOutcome.BadTotp;
                secretEnc = l.PendingTotpEnc;
            }

            await conn.ExecuteAsync("""
                UPDATE users SET password_hash = @hash, totp_secret_enc = @secretEnc, totp_last_step = @step,
                       status = 'active', failed_attempts = 0, locked_until = NULL,
                       password_changed_at = now(), updated_at = now()
                WHERE id = @id
                """, new { id = l.UserId, hash = hasher.Hash(password), secretEnc, step }, tx);
            await conn.ExecuteAsync("UPDATE one_time_links SET used_at = now(), pending_totp_enc = NULL WHERE id = @id", new { id = l.Id }, tx);
            await RevokeUserSessionsAsync(conn, tx, l.UserId, "password_set");
            if (l.HospitalId is not null && l.Roles.Contains(Roles.HospAdmin))
                await conn.ExecuteAsync("UPDATE hospitals SET status = 'active', updated_at = now() WHERE id = @id AND status = 'pending'",
                    new { id = l.HospitalId }, tx);
            await AuditLog.WriteAsync(conn, tx, l.UserId, l.HospitalId, "link_completed", l.UserId, new { purpose = l.Purpose });
            return LinkOutcome.Ok;
        }, ct);

    // ------------------------------------------------------------------ bootstrap

    /// <summary>
    /// Creates the first company owner with no password and returns the setup link.
    /// Refuses if any company user already exists.
    /// </summary>
    public Task<string> BootstrapAdminAsync(string email, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(7240002)", transaction: tx);
            if (await conn.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM users WHERE scope = 'company')", transaction: tx))
                throw new InvalidOperationException("A company user already exists. bootstrap-admin can only run once.");
            var id = Ids.User();
            await conn.ExecuteAsync("INSERT INTO users (id, scope, email) VALUES (@id, 'company', @email)", new { id, email }, tx);
            await conn.ExecuteAsync("INSERT INTO user_roles (user_id, role) VALUES (@id, 'owner')", new { id }, tx);
            var link = await IssueLinkAsync(conn, tx, id, "setup", null);
            await AuditLog.WriteAsync(conn, tx, null, null, "bootstrap_admin", id);
            return link.Url;
        }, ct);

    /// <summary>
    /// Server-side recovery for a company user who lost their password or phone (for example the only Owner).
    /// Run on the VM by someone with SSH access; revokes all sessions and prints a 1-hour reset link.
    /// </summary>
    public Task<string> ResetCompanyUserAsync(string email, CancellationToken ct = default) =>
        db.RunAsync(DbScope.System, async (conn, tx) =>
        {
            var u = await conn.QuerySingleOrDefaultAsync<(string Id, string Status)?>(
                "SELECT id, status FROM users WHERE email = @email AND scope = 'company' FOR UPDATE", new { email }, tx)
                ?? throw new InvalidOperationException("No company user with that email.");
            if (u.Status == "disabled") throw new InvalidOperationException("That company user is disabled.");
            await RevokeUserSessionsAsync(conn, tx, u.Id, "cli_reset");
            var link = await IssueLinkAsync(conn, tx, u.Id, u.Status == "pending" ? "setup" : "reset", null);
            await AuditLog.WriteAsync(conn, tx, null, null, "company_user_reset_cli", u.Id);
            return link.Url;
        }, ct);
}
