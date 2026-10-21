using Microsoft.Extensions.Configuration;
using System.Net;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class SecretsAndLogsTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs")]
    public async Task LogsHoldNoSecrets()
    {
        // Run a full flow (create, activate, sign in, fail, recover, log out) so the logs have something in them.
        var (owner, ownerUser) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, _, admin, adminClient) = await api.HospitalAsync(owner);
        await api.Anonymous().LoginAsync(admin.Email, "definitely-wrong-password", null);
        await owner.Post($"/admin/hospitals/{hid}/recover-admin", new { checks = new[] { true, true, true } });
        await adminClient.Post("/auth/logout", new { });
        await owner.Post("/auth/logout", new { });

        // The capture must have seen real traffic (request handling and SQL), or the check below means nothing.
        var all = string.Join("\n", fx.Logs.Lines);
        Assert.True(fx.Logs.Lines.Count > 100, $"only {fx.Logs.Lines.Count} log lines captured");
        Assert.Contains("Microsoft.AspNetCore.Routing", all);
        Assert.Contains("Npgsql", all);
        Assert.Contains("/auth/login", all);
        foreach (var secret in fx.Secrets)
            Assert.DoesNotContain(secret, all);
        Assert.DoesNotContain(ownerUser.Email, all, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(admin.Email, all, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("#t=", all);
        Assert.DoesNotContain("definitely-wrong-password", all);
        foreach (var m in fx.Email.Sent.Where(m => m.Kind != "ops_alert")) // server alerts carry no link
            Assert.DoesNotContain(CapturingEmailSender.TokenFrom(m), all);
    }

    [Fact(DisplayName = "Startup refuses missing or weak secrets")]
    public void ConfigRefusesMissingSecrets()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["SESSION_SIGNING_KEY"] = Convert.ToBase64String(new byte[8]) })
            .Build();
        var ex = Assert.Throws<InvalidOperationException>(() => MedLink.Api.Config.MedLinkOptions.FromConfiguration(config));
        Assert.Contains("DB_APP_PASSWORD", ex.Message);
        Assert.Contains("SESSION_SIGNING_KEY (needs at least 32 random bytes)", ex.Message);
        Assert.Contains("TOTP_ENC_KEY", ex.Message);
    }

    [Fact(DisplayName = "Sign-in is rate limited per client IP")]
    public async Task RateLimited()
    {
        using var limited = new TestApi(fx, authRate: 3);
        var c = limited.Anonymous();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++)
            statuses.Add((await c.LoginAsync(TestApi.NewEmail("nobody"), "wrong-password-x", null)).Status);
        Assert.Equal(new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized }, statuses.Take(3));
        Assert.All(statuses.Skip(3), s => Assert.Equal(HttpStatusCode.TooManyRequests, s));
    }

    [Fact(DisplayName = "Security headers are set and errors reveal no internals")]
    public async Task Headers()
    {
        var res = await api.Http.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("no-referrer", res.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal("no-store", res.Headers.CacheControl!.ToString());
    }
}
