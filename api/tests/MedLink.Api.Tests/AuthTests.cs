using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Security;
using MedLink.Api.Tests.Infrastructure;
using Npgsql;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class AuthTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Acceptance 1: create a hospital account, the admin activates it and signs in")]
    public async Task CreateHospitalAndSignIn()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var adminEmail = TestApi.NewEmail("hadmin");
        var slug = "al-noor-" + Guid.NewGuid().ToString("N")[..6];

        var create = await owner.Post("/admin/hospitals", new { nameAr = "مستشفى النور", nameEn = "Al Noor Hospital", nameTr = "", adminEmail, slug });
        Assert.Equal(HttpStatusCode.Created, create.Status);
        var id = create.Body.GetProperty("id").GetString()!;
        Assert.Matches("^hsp_[0-9A-HJKMNP-TV-Z]{26}$", id);
        Assert.True(create.Body.GetProperty("emailSent").GetBoolean());

        // No password exists yet; the hospital waits for activation.
        await using (var c = await fx.OwnerAsync())
        {
            var row = await c.QuerySingleAsync<(string? PasswordHash, string Status, string HStatus)>(
                "SELECT u.password_hash, u.status, h.status AS hstatus FROM users u JOIN hospitals h ON h.id = u.hospital_id WHERE u.email = @adminEmail", new { adminEmail });
            Assert.Null(row.PasswordHash);
            Assert.Equal("pending", row.Status);
            Assert.Equal("pending", row.HStatus);
        }

        var mail = fx.Email.LastTo(adminEmail);
        Assert.Equal("activation", mail.Kind);
        Assert.Contains("https://app.medlink.website/link#t=", mail.TextBody);

        var token = CapturingEmailSender.TokenFrom(mail);
        var (password, secret) = await api.CompleteLinkAsync(token);
        Assert.NotNull(secret); // TOTP is mandatory for hospital admins

        var admin = api.Anonymous();
        await api.AllowNextTotpAsync(adminEmail);
        var noCode = await admin.LoginAsync(adminEmail, password, null);
        Assert.Equal(HttpStatusCode.OK, noCode.Status);
        Assert.Equal("mfa_required", noCode.Body.GetProperty("status").GetString());
        Assert.Null(admin.SessionToken);

        var ok = await admin.LoginAsync(adminEmail, password, secret);
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.Contains("__Host-medlink_session=", admin.LastSetCookie);
        Assert.Contains("httponly", admin.LastSetCookie!.ToLowerInvariant());
        Assert.Contains("secure", admin.LastSetCookie.ToLowerInvariant());
        Assert.Contains("samesite=strict", admin.LastSetCookie.ToLowerInvariant());
        Assert.False(ok.Body.TryGetProperty("token", out var t) && t.ValueKind == System.Text.Json.JsonValueKind.String);

        var me = await admin.Get("/hospital/me");
        Assert.Equal(HttpStatusCode.OK, me.Status);
        Assert.Equal(id, me.Body.GetProperty("id").GetString());
        Assert.Equal("active", me.Body.GetProperty("status").GetString());
        Assert.Equal(slug, me.Body.GetProperty("slug").GetString());
    }

    [Fact(DisplayName = "A one-time link works once and stops working after it expires")]
    public async Task LinksAreSingleUseAndExpire()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var adminEmail = TestApi.NewEmail("hadmin");
        await owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Expiry Hospital", adminEmail, slug = "exp-" + Guid.NewGuid().ToString("N")[..8] });
        var token = CapturingEmailSender.TokenFrom(fx.Email.LastTo(adminEmail));
        await api.CompleteLinkAsync(token);

        var anon = api.Anonymous();
        Assert.Equal(HttpStatusCode.Gone, (await anon.Post("/auth/link/inspect", new { token }, csrf: false)).Status);
        Assert.Equal(HttpStatusCode.Gone, (await anon.Post("/auth/link/complete", new { token, password = MedLinkFixture.Secret() }, csrf: false)).Status);

        // An expired link (aged directly in the database) is refused.
        var adminEmail2 = TestApi.NewEmail("hadmin");
        await owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Expiry Hospital 2", adminEmail = adminEmail2, slug = "exp-" + Guid.NewGuid().ToString("N")[..8] });
        var token2 = CapturingEmailSender.TokenFrom(fx.Email.LastTo(adminEmail2));
        fx.Secrets.Add(token2);
        await using (var c = await fx.OwnerAsync())
            await c.ExecuteAsync("UPDATE one_time_links SET expires_at = now() - interval '1 second' WHERE token_hash = @h", new { h = Tokens.Hash(token2) });
        Assert.Equal(HttpStatusCode.Gone, (await anon.Post("/auth/link/inspect", new { token = token2 }, csrf: false)).Status);
    }

    [Fact(DisplayName = "Weak passwords and wrong TOTP codes are rejected when completing a link")]
    public async Task LinkCompletionValidates()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var adminEmail = TestApi.NewEmail("hadmin");
        await owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Validation Hospital", adminEmail, slug = "val-" + Guid.NewGuid().ToString("N")[..8] });
        var token = CapturingEmailSender.TokenFrom(fx.Email.LastTo(adminEmail));
        fx.Secrets.Add(token);
        var anon = api.Anonymous();
        await anon.Post("/auth/link/inspect", new { token }, csrf: false);
        var weak = await anon.Post("/auth/link/complete", new { token, password = "short", totp = "000000" }, csrf: false);
        Assert.Equal((HttpStatusCode)422, weak.Status);
        var badCode = await anon.Post("/auth/link/complete", new { token, password = MedLinkFixture.Secret(), totp = "000000" }, csrf: false);
        Assert.Equal((HttpStatusCode)422, badCode.Status);
        Assert.Equal("TOTP_INVALID", badCode.Body.GetProperty("error").GetString());
        // The link survives failed attempts and still works.
        Assert.Equal(HttpStatusCode.OK, (await anon.Post("/auth/link/inspect", new { token }, csrf: false)).Status);
    }

    [Fact(DisplayName = "5 failed sign-ins lock the account for 15 minutes, even for the right password")]
    public async Task LockoutAfterFiveFailures()
    {
        var (_, user) = await api.CompanyUserAsync(Roles.Viewer);
        var c = api.Anonymous();
        for (var i = 0; i < 4; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await c.LoginAsync(user.Email, "wrong-password-" + i, null)).Status);
        var fifth = await c.LoginAsync(user.Email, "wrong-password-5", null);
        Assert.Equal((HttpStatusCode)423, fifth.Status);
        await api.AllowNextTotpAsync(user.Email);
        var right = await c.LoginAsync(user.Email, user.Password, user.TotpSecret);
        Assert.Equal((HttpStatusCode)423, right.Status);
        Assert.Null(c.SessionToken);

        await using var db = await fx.OwnerAsync();
        var until = await db.ExecuteScalarAsync<DateTime>("SELECT locked_until FROM users WHERE id = @id", new { id = user.Id });
        Assert.InRange((until - DateTime.UtcNow).TotalMinutes, 14, 15.1);

        // When the lock has passed, the right password works again.
        await db.ExecuteAsync("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = @id", new { id = user.Id });
        await api.AllowNextTotpAsync(user.Email);
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(user.Email, user.Password, user.TotpSecret)).Status);
    }

    [Fact(DisplayName = "A wrong TOTP code counts as a failed attempt and a used code cannot be replayed")]
    public async Task TotpFailuresAndReplay()
    {
        var (_, user) = await api.CompanyUserAsync(Roles.Viewer);
        var c = api.Anonymous();
        await api.AllowNextTotpAsync(user.Email);
        var bad = await c.Post("/auth/login", new { email = user.Email, password = user.Password, totp = "123456" }, csrf: false);
        Assert.Equal(HttpStatusCode.Unauthorized, bad.Status);
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT failed_attempts FROM users WHERE id = @id", new { id = user.Id }));

        var code = new OtpNet.Totp(OtpNet.Base32Encoding.ToBytes(user.TotpSecret!)).ComputeTotp(DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, (await c.Post("/auth/login", new { email = user.Email, password = user.Password, totp = code }, csrf: false)).Status);
        var replay = await api.Anonymous().Post("/auth/login", new { email = user.Email, password = user.Password, totp = code }, csrf: false);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.Status);
    }

    [Fact(DisplayName = "Logout revokes the session on the server")]
    public async Task LogoutRevokes()
    {
        var (client, user) = await api.CompanyUserAsync(Roles.Viewer);
        var token = client.SessionToken!;
        Assert.Equal(HttpStatusCode.OK, (await client.Get("/auth/me")).Status);
        Assert.Equal(HttpStatusCode.OK, (await client.Post("/auth/logout", new { })).Status);

        var reused = api.Anonymous();
        reused.SessionToken = token;
        Assert.Equal(HttpStatusCode.Unauthorized, (await reused.Get("/auth/me")).Status);

        await using var db = await fx.OwnerAsync();
        var row = await db.QuerySingleAsync<(byte[] TokenHash, string Reason)>(
            "SELECT token_hash, revoke_reason AS reason FROM sessions WHERE user_id = @id AND revoked_at IS NOT NULL", new { id = user.Id });
        Assert.Equal(Tokens.Hash(token), row.TokenHash);
        Assert.Equal("logout", row.Reason);
    }

    [Fact(DisplayName = "Windows clients get a bearer token instead of a cookie")]
    public async Task WindowsBearer()
    {
        var (_, user) = await api.CompanyUserAsync(Roles.Viewer);
        await api.AllowNextTotpAsync(user.Email);
        var code = new OtpNet.Totp(OtpNet.Base32Encoding.ToBytes(user.TotpSecret!)).ComputeTotp(DateTime.UtcNow);
        var c = api.Anonymous();
        var r = await c.Post("/auth/login", new { email = user.Email, password = user.Password, totp = code, client = "windows" }, csrf: false);
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Null(c.SessionToken);
        var token = r.Body.GetProperty("token").GetString()!;
        fx.Secrets.Add(token);
        using var req = new HttpRequestMessage(HttpMethod.Get, "/auth/me");
        req.Headers.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.OK, (await api.Http.SendAsync(req)).StatusCode);
    }

    [Fact(DisplayName = "Password storage: Argon2id with the required parameters, salted, never plaintext")]
    public async Task PasswordStorage()
    {
        var (_, user) = await api.CompanyUserAsync(Roles.Viewer);
        await using var db = await fx.OwnerAsync();
        var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id = @id", new { id = user.Id });
        Assert.StartsWith("$argon2id$v=19$m=65536,t=3,p=1$", hash);
        Assert.DoesNotContain(user.Password, hash);

        // Same password, different salt → different hash; and it verifies.
        var hasher = new PasswordHasher();
        var h1 = hasher.Hash(user.Password);
        var h2 = hasher.Hash(user.Password);
        Assert.NotEqual(h1, h2);
        Assert.True(hasher.Verify(user.Password, h1, out var rehash));
        Assert.False(rehash);
        Assert.False(hasher.Verify(user.Password + "x", h1, out _));

        // The plaintext appears nowhere in the database.
        var dump = string.Join("\n", await db.QueryAsync<string>("""
            SELECT row_to_json(t)::text FROM users t UNION ALL SELECT row_to_json(t)::text FROM sessions t
            UNION ALL SELECT row_to_json(t)::text FROM one_time_links t UNION ALL SELECT row_to_json(t)::text FROM audit_log t
            """));
        foreach (var secret in fx.Secrets) Assert.DoesNotContain(secret, dump);

        // The database itself refuses anything that is not an Argon2id hash.
        var ex = await Assert.ThrowsAsync<PostgresException>(() =>
            db.ExecuteAsync("UPDATE users SET password_hash = 'plaintext' WHERE id = @id", new { id = user.Id }));
        Assert.Equal(PostgresErrorCodes.CheckViolation, ex.SqlState);
    }

    [Fact(DisplayName = "bootstrap-admin creates one owner with a setup link and refuses to run twice")]
    public async Task BootstrapOnce()
    {
        // A separate, freshly migrated database, so the shared one (which already has company users) is untouched.
        var dbName = "boot_" + Guid.NewGuid().ToString("N")[..8];
        await using (var c = await fx.OwnerAsync()) await c.ExecuteAsync($"CREATE DATABASE {dbName}");
        var ownerCs = new NpgsqlConnectionStringBuilder(fx.OwnerConnectionString) { Database = dbName }.ConnectionString;
        await MedLink.Api.Data.Migrator.MigrateAsync(ownerCs, null);
        await using (var c = new NpgsqlConnection(ownerCs)) { await c.OpenAsync(); await c.ExecuteAsync($"GRANT CONNECT ON DATABASE {dbName} TO medlink_app"); }
        var appCs = new NpgsqlConnectionStringBuilder(fx.AppConnectionString) { Database = dbName }.ConnectionString;

        await using var ds = new NpgsqlDataSourceBuilder(appCs).Build();
        var opts = (MedLink.Api.Config.MedLinkOptions)api.Factory.Services.GetService(typeof(MedLink.Api.Config.MedLinkOptions))!;
        var auth = new AuthService(new Db(ds), new PasswordHasher(), new TotpService(opts), opts, TimeProvider.System);

        var email = TestApi.NewEmail("owner");
        var url = await auth.BootstrapAdminAsync(email);
        Assert.StartsWith("https://admin.medlink.website/link#t=", url);
        fx.Secrets.Add(url[(url.IndexOf("#t=") + 3)..]);

        await using (var c = new NpgsqlConnection(ownerCs))
        {
            await c.OpenAsync();
            var u = await c.QuerySingleAsync<(string? PasswordHash, string Role, DateTime ExpiresAt)>("""
                SELECT u.password_hash, r.role, l.expires_at FROM users u JOIN user_roles r ON r.user_id = u.id
                JOIN one_time_links l ON l.user_id = u.id WHERE u.email = @email
                """, new { email });
            Assert.Null(u.PasswordHash);
            Assert.Equal("owner", u.Role);
            Assert.InRange((u.ExpiresAt - DateTime.UtcNow).TotalMinutes, 29, 30.1);
        }

        var again = await Assert.ThrowsAsync<InvalidOperationException>(() => auth.BootstrapAdminAsync(TestApi.NewEmail("owner2")));
        Assert.Contains("already exists", again.Message);
    }
}
