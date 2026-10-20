using MedLink.Api.Config;
using MedLink.Api.Security;

namespace MedLink.Api.Auth;

public static class HttpAuth
{
    /// <summary>__Host- prefix: Secure, Path=/, no Domain, so it cannot be set or read by sibling subdomains.</summary>
    public const string CookieName = "__Host-medlink_session";
    public const string DevCookieName = "medlink_session";
    public const string CsrfHeader = "X-CSRF-Token";

    public static string SessionCookieName(MedLinkOptions o) => o.CookieSecure ? CookieName : DevCookieName;

    public static string CsrfFor(MedLinkOptions o, string sessionId) => Tokens.Hmac(o.SessionSigningKey, "csrf:" + sessionId);

    public static void SetSessionCookie(HttpResponse res, MedLinkOptions o, string token, TimeSpan idle) =>
        res.Cookies.Append(SessionCookieName(o), token, new CookieOptions
        {
            HttpOnly = true,
            Secure = o.CookieSecure,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            MaxAge = idle,
            IsEssential = true,
        });

    public static void ClearSessionCookie(HttpResponse res, MedLinkOptions o) =>
        res.Cookies.Delete(SessionCookieName(o), new CookieOptions { Secure = o.CookieSecure, SameSite = SameSiteMode.Strict, Path = "/" });

    /// <summary>
    /// Resolves the session from the cookie (web) or the Authorization header (Windows app),
    /// and enforces CSRF on unsafe cookie-authenticated requests.
    /// </summary>
    public static async Task Middleware(HttpContext ctx, RequestDelegate next)
    {
        var o = ctx.RequestServices.GetRequiredService<MedLinkOptions>();
        var auth = ctx.RequestServices.GetRequiredService<AuthService>();

        string? token = null;
        var viaCookie = false;
        var header = ctx.Request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.Ordinal)) token = header[7..].Trim();
        else if (ctx.Request.Cookies.TryGetValue(SessionCookieName(o), out var c)) { token = c; viaCookie = true; }

        if (!string.IsNullOrEmpty(token) && token.Length <= 64)
        {
            var p = await auth.ValidateSessionAsync(token, viaCookie, ctx.RequestAborted);
            if (p is not null)
            {
                var unsafeMethod = !(HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method) || HttpMethods.IsOptions(ctx.Request.Method));
                if (viaCookie && unsafeMethod)
                {
                    var sent = ctx.Request.Headers[CsrfHeader].ToString();
                    if (string.IsNullOrEmpty(sent) || !Tokens.FixedTimeEquals(sent, CsrfFor(o, p.SessionId)))
                    {
                        await Results.Json(new { error = "CSRF_INVALID" }, statusCode: 403).ExecuteAsync(ctx);
                        return;
                    }
                }
                ctx.SetPrincipal(p);
            }
        }
        await next(ctx);
    }

    /// <summary>Requires a signed-in caller of the permission's scope who holds the permission. Checked on the server for every request.</summary>
    public static TBuilder Require<TBuilder>(this TBuilder b, Permission permission) where TBuilder : IEndpointConventionBuilder =>
        b.AddEndpointFilter(async (fctx, next) =>
        {
            var p = fctx.HttpContext.GetPrincipal();
            if (p is null) return Results.Json(new { error = "UNAUTHENTICATED" }, statusCode: 401);
            var companyPermission = PermissionMatrix.IsCompanyPermission(permission);
            if (companyPermission != p.IsCompany || !p.Has(permission))
                return Results.Json(new { error = "FORBIDDEN" }, statusCode: 403);
            return await next(fctx);
        });

    public static TBuilder RequireSignedIn<TBuilder>(this TBuilder b) where TBuilder : IEndpointConventionBuilder =>
        b.AddEndpointFilter(async (fctx, next) =>
            fctx.HttpContext.GetPrincipal() is null
                ? Results.Json(new { error = "UNAUTHENTICATED" }, statusCode: 401)
                : await next(fctx));

    /// <summary>JSON-only bodies: cross-origin form posts cannot reach the API without a CORS preflight.</summary>
    public static TBuilder RequireJson<TBuilder>(this TBuilder b) where TBuilder : IEndpointConventionBuilder =>
        b.AddEndpointFilter(async (fctx, next) =>
            fctx.HttpContext.Request.HasJsonContentType()
                ? await next(fctx)
                : Results.Json(new { error = "JSON_REQUIRED" }, statusCode: 415));
}
