using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class AuthorizationTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Acceptance 2/25: anonymous callers are refused by the server on every protected route")]
    public async Task AnonymousRefused()
    {
        var anon = api.Anonymous();
        foreach (var path in new[] { "/admin/hospitals", "/admin/reports", "/admin/audit", "/hospital/me", "/hospital/users", "/auth/me" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Get(path)).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Post("/admin/hospitals", new { nameAr = "x", nameEn = "x", adminEmail = "a@b.co", slug = "abc" })).Status);

        // A made-up session token is no better than none.
        anon.SessionToken = MedLink.Api.Security.Tokens.NewToken();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Get("/admin/hospitals")).Status);
    }

    [Fact(DisplayName = "Acceptance 25: each company role can do only what the matrix allows")]
    public async Task CompanyRoleMatrix()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (support, _) = await api.CompanyUserAsync(Roles.Support);
        var (viewer, _) = await api.CompanyUserAsync(Roles.Viewer);
        var (hid, _, _, _) = await api.HospitalAsync(owner);

        object NewHospital() => new { nameAr = "م", nameEn = "Matrix Hospital", adminEmail = TestApi.NewEmail("m"), slug = "mx-" + Guid.NewGuid().ToString("N")[..8] };

        // Create / edit: owner only.
        Assert.Equal(HttpStatusCode.Forbidden, (await support.Post("/admin/hospitals", NewHospital())).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Post("/admin/hospitals", NewHospital())).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await support.Patch($"/admin/hospitals/{hid}", new { nameAr = "x", nameEn = "y" })).Status);
        // Suspend: owner only.
        Assert.Equal(HttpStatusCode.Forbidden, (await support.Post($"/admin/hospitals/{hid}/suspend", new { reason = "testing roles" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Post($"/admin/hospitals/{hid}/suspend", new { reason = "testing roles" })).Status);
        // Recover access: owner and support, not viewer.
        var checks = new { checks = new[] { true, true, true } };
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Post($"/admin/hospitals/{hid}/recover-admin", checks)).Status);
        Assert.Equal(HttpStatusCode.OK, (await support.Post($"/admin/hospitals/{hid}/recover-admin", checks)).Status);
        // Reports: everyone. Audit: owner full, support hospital-only, viewer none.
        foreach (var c in new[] { owner, support, viewer })
            Assert.Equal(HttpStatusCode.OK, (await c.Get("/admin/reports")).Status);
        var ownerAudit = await owner.Get("/admin/audit");
        Assert.Equal("full", ownerAudit.Body.GetProperty("scope").GetString());
        var supportAudit = await support.Get("/admin/audit");
        Assert.Equal("hospital", supportAudit.Body.GetProperty("scope").GetString());
        Assert.All(supportAudit.Body.GetProperty("entries").EnumerateArray(), e => Assert.NotEqual(System.Text.Json.JsonValueKind.Null, e.GetProperty("hospitalId").ValueKind));
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Get("/admin/audit")).Status);
    }

    [Fact(DisplayName = "Hospital users cannot reach the company console, and company users cannot use hospital routes")]
    public async Task ScopesAreSeparate()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, hadmin) = await api.HospitalAsync(owner);
        foreach (var path in new[] { "/admin/hospitals", "/admin/reports", "/admin/audit" })
            Assert.Equal(HttpStatusCode.Forbidden, (await hadmin.Get(path)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await hadmin.Post("/admin/hospitals", new { nameAr = "x", nameEn = "x", adminEmail = "a@b.co", slug = "zzz" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Get("/hospital/me")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Get("/hospital/users")).Status);
    }

    [Fact(DisplayName = "Cookie requests that change state need the CSRF token")]
    public async Task CsrfRequired()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var body = new { nameAr = "م", nameEn = "Csrf Hospital", adminEmail = TestApi.NewEmail("c"), slug = "csrf-" + Guid.NewGuid().ToString("N")[..8] };
        var noToken = await owner.Post("/admin/hospitals", body, csrf: false);
        Assert.Equal(HttpStatusCode.Forbidden, noToken.Status);
        Assert.Equal("CSRF_INVALID", noToken.Body.GetProperty("error").GetString());
        var saved = owner.Csrf;
        owner.Csrf = "forged";
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/admin/hospitals", body)).Status);
        owner.Csrf = saved;
        Assert.Equal(HttpStatusCode.Created, (await owner.Post("/admin/hospitals", body)).Status);
    }

    [Fact(DisplayName = "Suspending a hospital revokes its sessions and blocks sign-in; reactivating restores it")]
    public async Task SuspendAndReactivate()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, slug, admin, adminClient) = await api.HospitalAsync(owner);

        Assert.Equal((HttpStatusCode)422, (await owner.Post($"/admin/hospitals/{hid}/suspend", new { reason = "" })).Status);
        Assert.Equal(HttpStatusCode.OK, (await owner.Post($"/admin/hospitals/{hid}/suspend", new { reason = "Contract paused by management" })).Status);

        Assert.Equal(HttpStatusCode.Unauthorized, (await adminClient.Get("/hospital/me")).Status);
        await api.AllowNextTotpAsync(admin.Email);
        var login = await api.Anonymous().LoginAsync(admin.Email, admin.Password, admin.TotpSecret);
        Assert.Equal(HttpStatusCode.Forbidden, login.Status);
        Assert.Equal("HOSPITAL_SUSPENDED", login.Body.GetProperty("error").GetString());

        // The booking link stays reserved but stops accepting bookings; data is kept.
        var pub = await api.Anonymous().Get($"/public/book/{slug}");
        Assert.False(pub.Body.GetProperty("acceptingBookings").GetBoolean());

        Assert.Equal(HttpStatusCode.OK, (await owner.Post($"/admin/hospitals/{hid}/reactivate", new { reason = "Contract renewed" })).Status);
        var again = await api.SignInAsync(admin);
        Assert.Equal("active", (await again.Get("/hospital/me")).Body.GetProperty("status").GetString());

        await using var db = await fx.OwnerAsync();
        var actions = (await db.QueryAsync<string>("SELECT action FROM audit_log WHERE hospital_id = @hid ORDER BY id", new { hid })).ToList();
        Assert.Contains("hospital_suspend", actions);
        Assert.Contains("hospital_reactivate", actions);
    }

    [Fact(DisplayName = "Recovering admin access needs all 3 identity checks, revokes sessions and emails a 1-hour reset link")]
    public async Task RecoverAdmin()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, _, admin, adminClient) = await api.HospitalAsync(owner);

        Assert.Equal((HttpStatusCode)422, (await owner.Post($"/admin/hospitals/{hid}/recover-admin", new { checks = new[] { true, true, false } })).Status);
        Assert.Equal((HttpStatusCode)422, (await owner.Post($"/admin/hospitals/{hid}/recover-admin", new { checks = new[] { true } })).Status);

        var before = fx.Email.Sent.Count;
        var ok = await owner.Post($"/admin/hospitals/{hid}/recover-admin", new { checks = new[] { true, true, true } });
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.True(fx.Email.Sent.Count > before);
        var mail = fx.Email.LastTo(admin.Email);
        Assert.Equal("reset", mail.Kind);
        Assert.Equal(HttpStatusCode.Unauthorized, (await adminClient.Get("/hospital/me")).Status);

        await using var db = await fx.OwnerAsync();
        var exp = await db.ExecuteScalarAsync<DateTime>("SELECT expires_at FROM one_time_links WHERE token_hash = @h",
            new { h = MedLink.Api.Security.Tokens.Hash(CapturingEmailSender.TokenFrom(mail)) });
        Assert.InRange((exp - DateTime.UtcNow).TotalMinutes, 59, 60.1);

        // The reset re-enrols TOTP and sets a new password; the old password stops working.
        var (newPassword, newSecret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(mail));
        await api.AllowNextTotpAsync(admin.Email);
        Assert.Equal(HttpStatusCode.Unauthorized, (await api.Anonymous().LoginAsync(admin.Email, admin.Password, newSecret)).Status);
        await api.SignInAsync(admin with { Password = newPassword, TotpSecret = newSecret });
    }
}
