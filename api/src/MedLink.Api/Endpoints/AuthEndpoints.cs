using MedLink.Api.Auth;
using MedLink.Api.Config;
using MedLink.Api.Security;

namespace MedLink.Api.Endpoints;

public static class AuthEndpoints
{
    public sealed record LoginRequest(string? Email, string? Password, string? Totp, string? Client);
    public sealed record LinkTokenRequest(string? Token);
    public sealed record CompleteLinkRequest(string? Token, string? Password, string? Totp);

    public static void MapAuth(this WebApplication app)
    {
        var g = app.MapGroup("/auth"); // rate-limited by the global limiter in Startup

        g.MapPost("/login", async (LoginRequest req, HttpContext ctx, AuthService auth, MedLinkOptions o) =>
        {
            if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrEmpty(req.Password) || req.Password.Length > PasswordHasher.MaxLength || req.Email.Length > 254)
                return Results.Json(new { error = "INVALID_CREDENTIALS" }, statusCode: 401);
            var client = req.Client == "windows" ? "windows" : "web";
            var r = await auth.LoginAsync(req.Email, req.Password, req.Totp, client, ctx.RequestAborted);
            switch (r.Outcome)
            {
                case LoginOutcome.Ok:
                    var p = r.Principal!;
                    var body = new
                    {
                        status = "ok",
                        user = Me(p),
                        csrf = client == "web" ? HttpAuth.CsrfFor(o, p.SessionId) : null,
                        // The Windows app keeps its token in memory (BACKEND-SPEC §3); the web never sees it.
                        token = client == "windows" ? r.Token : null,
                    };
                    if (client == "web") HttpAuth.SetSessionCookie(ctx.Response, o, r.Token!, AuthService.IdleFor(p.Roles));
                    return Results.Json(body);
                case LoginOutcome.MfaRequired:
                    return Results.Json(new { status = "mfa_required" });
                case LoginOutcome.Locked:
                    return Results.Json(new { error = "ACCOUNT_LOCKED", lockedUntil = r.LockedUntil }, statusCode: 423);
                case LoginOutcome.MfaNotEnrolled:
                    return Results.Json(new { error = "MFA_NOT_ENROLLED" }, statusCode: 403);
                case LoginOutcome.HospitalSuspended:
                    return Results.Json(new { error = "HOSPITAL_SUSPENDED" }, statusCode: 403);
                default:
                    return Results.Json(new { error = "INVALID_CREDENTIALS" }, statusCode: 401);
            }
        }).RequireJson();

        g.MapPost("/logout", async (HttpContext ctx, AuthService auth, MedLinkOptions o) =>
        {
            await auth.LogoutAsync(ctx.RequirePrincipal(), ctx.RequestAborted);
            HttpAuth.ClearSessionCookie(ctx.Response, o);
            return Results.Json(new { status = "ok" });
        }).RequireSignedIn();

        g.MapGet("/me", (HttpContext ctx, MedLinkOptions o) =>
        {
            var p = ctx.RequirePrincipal();
            return Results.Json(new { user = Me(p), csrf = p.ViaCookie ? HttpAuth.CsrfFor(o, p.SessionId) : null });
        }).RequireSignedIn();

        // One-time links (setup / activation / reset). Tokens travel in POST bodies, never in URLs.
        g.MapPost("/link/inspect", async (LinkTokenRequest req, AuthService auth, HttpContext ctx) =>
        {
            if (string.IsNullOrEmpty(req.Token) || req.Token.Length > 64) return Results.Json(new { error = "LINK_INVALID" }, statusCode: 410);
            var info = await auth.InspectLinkAsync(req.Token, ctx.RequestAborted);
            return info is null
                ? Results.Json(new { error = "LINK_INVALID" }, statusCode: 410)
                : Results.Json(new
                {
                    purpose = info.Purpose,
                    scope = info.Scope,
                    email = info.Email,
                    totpRequired = info.TotpRequired,
                    totpUri = info.TotpUri,
                    totpSecret = info.TotpSecret,
                    passwordMinLength = PasswordHasher.MinLength,
                });
        }).RequireJson();

        g.MapPost("/link/complete", async (CompleteLinkRequest req, AuthService auth, HttpContext ctx) =>
        {
            if (string.IsNullOrEmpty(req.Token) || req.Token.Length > 64 || req.Password is null || req.Password.Length > PasswordHasher.MaxLength)
                return Results.Json(new { error = "LINK_INVALID" }, statusCode: 410);
            return await auth.CompleteLinkAsync(req.Token, req.Password, req.Totp, ctx.RequestAborted) switch
            {
                LinkOutcome.Ok => Results.Json(new { status = "ok" }),
                LinkOutcome.BadPassword => Results.Json(new { error = "PASSWORD_WEAK", minLength = PasswordHasher.MinLength }, statusCode: 422),
                LinkOutcome.BadTotp => Results.Json(new { error = "TOTP_INVALID" }, statusCode: 422),
                _ => Results.Json(new { error = "LINK_INVALID" }, statusCode: 410),
            };
        }).RequireJson();
    }

    private static object Me(Principal p) => new
    {
        id = p.UserId,
        email = p.Email,
        scope = p.Scope,
        hospitalId = p.HospitalId,
        roles = p.Roles,
        permissions = PermissionMatrix.For(p.Roles).Select(x => x.ToString()),
    };
}
