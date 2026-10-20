using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using OtpNet;

namespace MedLink.Api.Tests.Infrastructure;

/// <summary>
/// A browser-like client. The session cookie is production-shaped (__Host-, Secure), which HttpClient
/// will not send over the in-memory http:// test server, so it is carried by hand, as is the CSRF header.
/// </summary>
public sealed class ApiClient(HttpClient http)
{
    public string? SessionToken { get; set; }
    public string? Csrf { get; set; }
    public string? LastSetCookie { get; private set; }

    public async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path, object? body = null, bool csrf = true)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body);
        if (SessionToken is not null) req.Headers.Add("Cookie", "__Host-medlink_session=" + SessionToken);
        if (csrf && Csrf is not null) req.Headers.Add("X-CSRF-Token", Csrf);
        using var res = await http.SendAsync(req);
        if (res.Headers.TryGetValues("Set-Cookie", out var cookies))
        {
            LastSetCookie = string.Join("\n", cookies);
            foreach (var c in cookies)
            {
                var first = c.Split(';')[0];
                if (first.StartsWith("__Host-medlink_session="))
                {
                    var v = first["__Host-medlink_session=".Length..];
                    SessionToken = v.Length == 0 ? null : v;
                }
            }
        }
        var text = await res.Content.ReadAsStringAsync();
        var json = text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone();
        return (res.StatusCode, json);
    }

    public Task<(HttpStatusCode Status, JsonElement Body)> Get(string path) => SendAsync(HttpMethod.Get, path);
    public Task<(HttpStatusCode Status, JsonElement Body)> Post(string path, object body, bool csrf = true) => SendAsync(HttpMethod.Post, path, body, csrf);
    public Task<(HttpStatusCode Status, JsonElement Body)> Patch(string path, object body) => SendAsync(HttpMethod.Patch, path, body);
    public Task<(HttpStatusCode Status, JsonElement Body)> Put(string path, object body) => SendAsync(HttpMethod.Put, path, body);
    public Task<(HttpStatusCode Status, JsonElement Body)> Delete(string path) => SendAsync(HttpMethod.Delete, path);

    public async Task<(HttpStatusCode Status, JsonElement Body)> LoginAsync(string email, string password, string? totpSecretBase32)
    {
        var code = totpSecretBase32 is null ? null : new Totp(Base32Encoding.ToBytes(totpSecretBase32)).ComputeTotp(DateTime.UtcNow);
        var r = await Post("/auth/login", new { email, password, totp = code }, csrf: false);
        if (r.Status == HttpStatusCode.OK && r.Body.TryGetProperty("csrf", out var c) && c.ValueKind == JsonValueKind.String)
            Csrf = c.GetString();
        return r;
    }
}

public sealed record TestUser(string Id, string Email, string Password, string? TotpSecret);

/// <summary>A running API over the shared test database, plus helpers that create accounts the real way.</summary>
public sealed class TestApi : IDisposable
{
    public MedLinkFixture Fx { get; }
    public WebApplicationFactory<Program> Factory { get; }
    public HttpClient Http { get; }

    public TestApi(MedLinkFixture fx, int authRate = 10_000)
    {
        Fx = fx;
        Factory = fx.CreateFactory(authRate);
        Http = Factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
    }

    public ApiClient Anonymous() => new(Http);

    public void Dispose()
    {
        Http.Dispose();
        Factory.Dispose();
    }

    public static string NewEmail(string prefix) => $"{prefix}-{Guid.NewGuid():N}@test.invalid";

    /// <summary>Completes a one-time link the way a person would: inspect, enrol TOTP, set a password.</summary>
    public async Task<(string Password, string? TotpSecret)> CompleteLinkAsync(string token)
    {
        Fx.Secrets.Add(token);
        var anon = Anonymous();
        var inspect = await anon.Post("/auth/link/inspect", new { token }, csrf: false);
        Assert.Equal(HttpStatusCode.OK, inspect.Status);
        string? secret = inspect.Body.GetProperty("totpRequired").GetBoolean() ? inspect.Body.GetProperty("totpSecret").GetString() : null;
        if (secret is not null) Fx.Secrets.Add(secret);
        var password = MedLinkFixture.Secret();
        Fx.Secrets.Add(password);
        var code = secret is null ? null : new Totp(Base32Encoding.ToBytes(secret)).ComputeTotp(DateTime.UtcNow);
        var done = await anon.Post("/auth/link/complete", new { token, password, totp = code }, csrf: false);
        Assert.Equal(HttpStatusCode.OK, done.Status);
        return (password, secret);
    }

    /// <summary>
    /// The server rejects a TOTP code whose time step was already used. Tests sign in several times within
    /// one 30-second window, so they clear the remembered step first (directly in the test database).
    /// </summary>
    public async Task AllowNextTotpAsync(string email)
    {
        await using var c = await Fx.OwnerAsync();
        await c.ExecuteAsync("UPDATE users SET totp_last_step = NULL WHERE email = @email", new { email });
    }

    public async Task<ApiClient> SignInAsync(TestUser u)
    {
        await AllowNextTotpAsync(u.Email);
        var client = Anonymous();
        var login = await client.LoginAsync(u.Email, u.Password, u.TotpSecret);
        Assert.Equal(HttpStatusCode.OK, login.Status);
        Fx.Secrets.Add(client.SessionToken!);
        return client;
    }

    /// <summary>A company user created like a colleague would be: a row with no password plus a setup link.</summary>
    public async Task<(ApiClient Client, TestUser User)> CompanyUserAsync(string role)
    {
        var email = NewEmail(role);
        var id = "usr_" + Ulid.NewUlid();
        await using (var c = await Fx.OwnerAsync())
        {
            await c.ExecuteAsync("INSERT INTO users (id, scope, email) VALUES (@id, 'company', @email)", new { id, email });
            await c.ExecuteAsync("INSERT INTO user_roles (user_id, role) VALUES (@id, @role)", new { id, role });
        }
        var auth = Factory.Services.GetRequiredService<AuthService>();
        var db = Factory.Services.GetRequiredService<Db>();
        var link = await db.RunAsync(DbScope.System, (cn, t) => auth.IssueLinkAsync(cn, t, id, "setup", null));
        var (password, secret) = await CompleteLinkAsync(CapturingEmailSender.TokenFrom(link.Mail));
        var user = new TestUser(id, email, password, secret);
        return (await SignInAsync(user), user);
    }

    /// <summary>A hospital admin invites a staff member; the staff member activates the emailed link and signs in.</summary>
    public async Task<(ApiClient Client, TestUser User)> StaffAsync(ApiClient hospitalAdmin, string role)
    {
        var email = NewEmail(role);
        var r = await hospitalAdmin.Post("/hospital/users", new { email, role });
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var (password, secret) = await CompleteLinkAsync(CapturingEmailSender.TokenFrom(Fx.Email.LastTo(email)));
        var user = new TestUser(r.Body.GetProperty("id").GetString()!, email, password, secret);
        return (await SignInAsync(user), user);
    }

    public async Task<(string HospitalId, string Slug, TestUser Admin, ApiClient AdminClient)> HospitalAsync(ApiClient owner, string? slug = null)
    {
        slug ??= "h-" + Guid.NewGuid().ToString("N")[..12];
        var adminEmail = NewEmail("hadmin");
        var create = await owner.Post("/admin/hospitals", new { nameAr = "مستشفى الاختبار", nameEn = "Test Hospital", nameTr = "Test Hastanesi", adminEmail, slug });
        Assert.Equal(HttpStatusCode.Created, create.Status);
        var hospitalId = create.Body.GetProperty("id").GetString()!;
        var (password, secret) = await CompleteLinkAsync(CapturingEmailSender.TokenFrom(Fx.Email.LastTo(adminEmail)));
        await using var c = await Fx.OwnerAsync();
        var adminId = await c.ExecuteScalarAsync<string>("SELECT id FROM users WHERE email = @adminEmail", new { adminEmail });
        var admin = new TestUser(adminId!, adminEmail, password, secret);
        return (hospitalId, slug, admin, await SignInAsync(admin));
    }
}
