using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class TeamAndSessionTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Team: only an Owner invites company staff, by an emailed 24-hour activation link")]
    public async Task InviteTeam()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (support, _) = await api.CompanyUserAsync(Roles.Support);
        var email = TestApi.NewEmail("support");

        Assert.Equal(HttpStatusCode.Forbidden, (await support.Get("/admin/team")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await support.Post("/admin/team", new { email, role = Roles.Viewer })).Status);
        Assert.Equal((HttpStatusCode)422, (await owner.Post("/admin/team", new { email, role = Roles.HospAdmin })).Status);

        var r = await owner.Post("/admin/team", new { email, role = Roles.Support });
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var mail = fx.Email.LastTo(email);
        Assert.Equal("activation", mail.Kind);
        Assert.Contains("https://admin.medlink.website/link#t=", mail.TextBody);
        var (password, secret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(mail));
        Assert.NotNull(secret); // 2FA is mandatory for company users
        var c = await api.SignInAsync(new TestUser(r.Body.GetProperty("id").GetString()!, email, password, secret));
        Assert.Equal(HttpStatusCode.OK, (await c.Get("/admin/reports")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/admin/team", new { email, role = Roles.Viewer })).Status);
    }

    [Fact(DisplayName = "Team: role changes revoke sessions; nobody can change themselves; two Owners demoting each other at once leave one Owner")]
    public async Task TeamChanges()
    {
        var (a, aUser) = await api.CompanyUserAsync(Roles.Owner);
        var (viewer, viewerUser) = await api.CompanyUserAsync(Roles.Viewer);

        Assert.Equal(HttpStatusCode.Conflict, (await a.Patch($"/admin/team/{aUser.Id}", new { role = Roles.Viewer })).Status);
        Assert.Equal(HttpStatusCode.OK, (await a.Patch($"/admin/team/{viewerUser.Id}", new { role = Roles.Support })).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.Get("/admin/reports")).Status);

        var (b, bUser) = await api.CompanyUserAsync(Roles.Owner);
        // Make A and B the only active Owners (other test classes create owners in the same database).
        List<string> parked;
        await using (var db = await fx.OwnerAsync())
            parked = (await db.QueryAsync<string>("""
                UPDATE users SET status = 'disabled' WHERE scope = 'company' AND status = 'active' AND id NOT IN (@a, @b)
                  AND id IN (SELECT user_id FROM user_roles WHERE role = 'owner') RETURNING id
                """, new { a = aUser.Id, b = bUser.Id })).ToList();
        try
        {
            var results = await Task.WhenAll(
                a.Patch($"/admin/team/{bUser.Id}", new { role = Roles.Viewer }),
                b.Patch($"/admin/team/{aUser.Id}", new { role = Roles.Viewer }));
            Assert.Equal(1, results.Count(r => r.Status == HttpStatusCode.OK));
            Assert.All(results.Where(r => r.Status != HttpStatusCode.OK),
                r => Assert.Contains(r.Status, new[] { HttpStatusCode.Conflict, HttpStatusCode.Unauthorized }));
            await using var db = await fx.OwnerAsync();
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("""
                SELECT count(*) FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'owner'
                WHERE u.id IN (@a, @b) AND u.status = 'active'
                """, new { a = aUser.Id, b = bUser.Id }));
        }
        finally
        {
            await using var db = await fx.OwnerAsync();
            await db.ExecuteAsync("UPDATE users SET status = 'active' WHERE id = ANY(@parked)", new { parked = parked.ToArray() });
        }
    }

    [Fact(DisplayName = "reset-company-user: server-side recovery revokes sessions and issues a 1-hour reset link")]
    public async Task CliResetCompanyUser()
    {
        var (client, user) = await api.CompanyUserAsync(Roles.Owner);
        var auth = (AuthService)api.Factory.Services.GetService(typeof(AuthService))!;
        var url = await auth.ResetCompanyUserAsync(user.Email);
        Assert.StartsWith("https://admin.medlink.website/link#t=", url);
        var token = url[(url.IndexOf("#t=") + 3)..];
        fx.Secrets.Add(token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.Get("/auth/me")).Status);
        var inspect = await api.Anonymous().Post("/auth/link/inspect", new { token }, csrf: false);
        Assert.Equal("reset", inspect.Body.GetProperty("purpose").GetString());
        await Assert.ThrowsAsync<InvalidOperationException>(() => auth.ResetCompanyUserAsync(TestApi.NewEmail("nobody")));
    }

    [Fact(DisplayName = "A session ends 7 days after sign-in even if it is used all the time")]
    public async Task AbsoluteSessionLimit()
    {
        var (client, user) = await api.CompanyUserAsync(Roles.Viewer);
        Assert.Equal(HttpStatusCode.OK, (await client.Get("/auth/me")).Status);
        await using var db = await fx.OwnerAsync();
        Assert.True(await db.ExecuteScalarAsync<bool>("SELECT bool_and(absolute_expires_at - created_at BETWEEN interval '6 days 23 hours' AND interval '7 days 1 minute') FROM sessions WHERE user_id = @id", new { id = user.Id }));
        // Simulate a session that is still within its idle window but past the 7-day limit.
        await db.ExecuteAsync("UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() + interval '1 hour' WHERE user_id = @id", new { id = user.Id });
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.Get("/auth/me")).Status);
    }

    [Fact(DisplayName = "Hospital time zone is chosen at creation and can be edited; unknown zones are refused")]
    public async Task HospitalTimezone()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        object Body(string tz) => new { nameAr = "م", nameEn = "Tz Hospital", adminEmail = TestApi.NewEmail("tz"), slug = "tz-" + Guid.NewGuid().ToString("N")[..8], timezone = tz };
        Assert.Equal((HttpStatusCode)422, (await owner.Post("/admin/hospitals", Body("Not/AZone"))).Status);
        var r = await owner.Post("/admin/hospitals", Body("Europe/Istanbul"));
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var id = r.Body.GetProperty("id").GetString();
        Assert.Equal("Europe/Istanbul", (await owner.Get($"/admin/hospitals/{id}")).Body.GetProperty("hospital").GetProperty("timezone").GetString());
        Assert.Equal(HttpStatusCode.OK, (await owner.Patch($"/admin/hospitals/{id}", new { nameAr = "م", nameEn = "Tz Hospital", timezone = "Africa/Tripoli" })).Status);
        Assert.Equal("Africa/Tripoli", (await owner.Get($"/admin/hospitals/{id}")).Body.GetProperty("hospital").GetProperty("timezone").GetString());
        Assert.Equal((HttpStatusCode)422, (await owner.Patch($"/admin/hospitals/{id}", new { nameAr = "م", nameEn = "Tz", timezone = "Nowhere" })).Status);
    }
}
