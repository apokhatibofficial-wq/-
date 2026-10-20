using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Hospitals;

namespace MedLink.Api.Endpoints;

/// <summary>
/// Hospital-scope API. The hospital is always the one in the caller's session; any hospital ID in the
/// query string or body is ignored. RLS enforces the same rule again inside PostgreSQL.
/// </summary>
public static class HospitalEndpoints
{
    public static void MapHospital(this WebApplication app)
    {
        var g = app.MapGroup("/hospital");

        g.MapGet("/me", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (!p.IsHospital) return Results.Json(new { error = "FORBIDDEN" }, statusCode: 403);
            var h = await db.RunAsync(p.DbScope, (c, t) => c.QuerySingleAsync<(string Id, string NameAr, string NameEn, string? NameTr, string Status, string Timezone, int NoShowGraceMin, string? Slug)>("""
                SELECT h.id, h.name_ar, h.name_en, h.name_tr, h.status, h.timezone, h.no_show_grace_min,
                       (SELECT slug FROM hospital_slugs s WHERE s.hospital_id = h.id AND s.is_primary) AS slug
                FROM hospitals h WHERE h.id = @id
                """, new { id = p.HospitalId }, t));
            return Results.Json(new
            {
                id = h.Id, name = new { ar = h.NameAr, en = h.NameEn, tr = h.NameTr }, status = h.Status,
                timezone = h.Timezone, noShowGraceMin = h.NoShowGraceMin, slug = h.Slug,
            });
        }).RequireSignedIn();

        g.MapGet("/users", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            // No WHERE hospital_id = … from the request: RLS restricts the rows to the session's hospital.
            var users = await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<(string Id, string Email, string Status, string[] Roles)>("""
                SELECT u.id, u.email::text AS email, u.status, array(SELECT role FROM user_roles r WHERE r.user_id = u.id) AS roles
                FROM users u WHERE u.hospital_id = @hid ORDER BY u.created_at
                """, new { hid = p.HospitalId }, t));
            return Results.Json(new { users = users.Select(u => new { id = u.Id, email = u.Email, status = u.Status, roles = u.Roles }) });
        }).Require(Permission.HospitalUsersManage);

        g.MapGet("/users/{id}", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var u = await db.RunAsync(p.DbScope, (c, t) => c.QuerySingleOrDefaultAsync<(string Id, string Email, string Status)?>(
                "SELECT id, email::text AS email, status FROM users WHERE id = @id", new { id }, t));
            return u is null
                ? Results.Json(new { error = "NOT_FOUND" }, statusCode: 404)
                : Results.Json(new { id = u.Value.Id, email = u.Value.Email, status = u.Value.Status });
        }).Require(Permission.HospitalUsersManage);
    }

    /// <summary>
    /// Public booking-link resolution. Active slug → 200. Retired slug within 90 days → 301 to the new slug.
    /// After that → 410 LINK_CHANGED. Unknown → 404. Only display fields are returned.
    /// </summary>
    public static void MapPublic(this WebApplication app)
    {
        app.MapGet("/public/book/{slug}", async (string slug, Db db, TimeProvider clock) =>
        {
            if (!SlugPolicy.IsValidFormat(slug)) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            var r = await db.RunAsync(DbScope.System, (c, t) => c.QuerySingleOrDefaultAsync<(string HospitalId, bool IsPrimary, DateTime? RedirectUntil, string NameAr, string NameEn, string? NameTr, string Status, string? Current)?>("""
                SELECT s.hospital_id, s.is_primary, s.redirect_until, h.name_ar, h.name_en, h.name_tr, h.status,
                       (SELECT p.slug FROM hospital_slugs p WHERE p.hospital_id = s.hospital_id AND p.is_primary) AS current
                FROM hospital_slugs s JOIN hospitals h ON h.id = s.hospital_id WHERE s.slug = @slug
                """, new { slug }, t));
            if (r is not { } x) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            if (!x.IsPrimary)
            {
                var stillRedirecting = x.RedirectUntil is { } ru && DateTime.SpecifyKind(ru, DateTimeKind.Utc) > clock.GetUtcNow().UtcDateTime;
                if (stillRedirecting && x.Current is not null)
                    return new RedirectJson("/public/book/" + x.Current, x.Current);
                return Results.Json(new { error = "LINK_CHANGED" }, statusCode: 410);
            }
            return Results.Json(new
            {
                state = "active",
                slug,
                name = new { ar = x.NameAr, en = x.NameEn, tr = x.NameTr },
                acceptingBookings = x.Status == "active",
            });
        });
    }

    /// <summary>A 301 with a Location header and a small JSON body.</summary>
    private sealed class RedirectJson(string location, string slug) : IResult
    {
        public Task ExecuteAsync(HttpContext ctx)
        {
            ctx.Response.StatusCode = StatusCodes.Status301MovedPermanently;
            ctx.Response.Headers.Location = location;
            return ctx.Response.WriteAsJsonAsync(new { state = "moved", slug });
        }
    }
}
