using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MedLink.App;

public enum LoginStatus { Ok, NeedTotp, Invalid, Locked, RateLimited, MfaNotEnrolled, Suspended, Offline, Error }

/// <summary>The signed-in user as the server describes them. Roles and permissions decide what the screen shows; the server re-checks every action.</summary>
public sealed record UserInfo(string Id, string Email, string? HospitalId, string[] Roles, string[] Permissions)
{
    public bool Can(string permission) => Permissions.Contains(permission);
    /// <summary>The Windows app needs a list to show: full bookings (reception, admin) or own departments (doctor).</summary>
    public bool CanUseWindowsApp => Can("BookingsView") || Can("BookingsViewOwnDepartment");
}

public sealed record LoginResult(LoginStatus Status, string? Token = null, UserInfo? User = null);

/// <summary>Sign-in for the Windows app: the server returns a bearer token (client = "windows"), never a cookie.</summary>
public sealed class AuthClient(HttpClient http)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<LoginResult> LoginAsync(string email, string password, string? totp, CancellationToken ct = default)
    {
        HttpResponseMessage r;
        try { r = await http.PostAsJsonAsync("/auth/login", new { email = email.Trim(), password, totp, client = "windows" }, Json, ct); }
        catch (HttpRequestException) { return new LoginResult(LoginStatus.Offline); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return new LoginResult(LoginStatus.Offline); }
        using var _ = r;
        JsonElement body = default;
        try { body = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct); } catch (JsonException) { }
        string? Str(string n) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (r.StatusCode == HttpStatusCode.TooManyRequests) return new LoginResult(LoginStatus.RateLimited);
        if (r.IsSuccessStatusCode)
        {
            if (Str("status") == "mfa_required") return new LoginResult(LoginStatus.NeedTotp);
            var token = Str("token");
            return token is null ? new LoginResult(LoginStatus.Error) : new LoginResult(LoginStatus.Ok, token, ParseUser(body.GetProperty("user")));
        }
        return Str("error") switch
        {
            "ACCOUNT_LOCKED" => new LoginResult(LoginStatus.Locked),
            "MFA_NOT_ENROLLED" => new LoginResult(LoginStatus.MfaNotEnrolled),
            "HOSPITAL_SUSPENDED" => new LoginResult(LoginStatus.Suspended),
            "INVALID_CREDENTIALS" => new LoginResult(LoginStatus.Invalid),
            _ => new LoginResult((int)r.StatusCode >= 500 ? LoginStatus.Offline : LoginStatus.Error),
        };
    }

    public static UserInfo ParseUser(JsonElement u) => new(
        u.GetProperty("id").GetString()!, u.GetProperty("email").GetString()!,
        u.TryGetProperty("hospitalId", out var h) && h.ValueKind == JsonValueKind.String ? h.GetString() : null,
        u.GetProperty("roles").EnumerateArray().Select(x => x.GetString()!).ToArray(),
        u.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).ToArray());

    /// <summary>Checks a saved token. Null user + Offline=false means the session is no longer valid.</summary>
    public async Task<(UserInfo? User, bool Offline)> MeAsync(string token, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/auth/me");
        req.Headers.Authorization = new("Bearer", token);
        try
        {
            using var r = await http.SendAsync(req, ct);
            if (r.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) return (null, false);
            if (!r.IsSuccessStatusCode) return (null, true);
            var body = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            return (ParseUser(body.GetProperty("user")), false);
        }
        catch (HttpRequestException) { return (null, true); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return (null, true); }
    }

    public async Task<bool> LogoutAsync(string token, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/auth/logout") { Content = JsonContent.Create(new { }) };
        req.Headers.Authorization = new("Bearer", token);
        try { using var r = await http.SendAsync(req, ct); return r.IsSuccessStatusCode; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return false; }
    }

    /// <summary>The connection pill on the sign-in screen.</summary>
    public async Task<bool> PingAsync(CancellationToken ct = default)
    {
        try { using var r = await http.GetAsync("/health", ct); return r.IsSuccessStatusCode; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return false; }
    }
}
