using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Email;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>Company staff (Owner, Support, Viewer). Owner only. At least one active Owner always remains.</summary>
public static class TeamEndpoints
{
    public sealed record InviteRequest(string? Email, string? Role);
    public sealed record ChangeRequest(string? Role, bool? Disabled);

    private static IResult Error(string code, int status) => Results.Json(new { error = code }, statusCode: status);

    public static void MapTeam(this WebApplication app)
    {
        var g = app.MapGroup("/admin/team");

        g.MapGet("", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var users = await db.RunAsync(p.DbScope, (c, t) => UserAdmin.ListAsync(c, t, null));
            return Results.Json(new { users = users.Select(UserAdmin.Dto) });
        }).Require(Permission.ManageTeam);

        g.MapPost("", async (InviteRequest req, HttpContext ctx, Db db, AuthService auth, IEmailSender email, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            if (!UserAdmin.IsEmail(req.Email)) return Error("EMAIL_INVALID", 422);
            if (req.Role is null || !Roles.Company.Contains(req.Role)) return Error("ROLE_INVALID", 422);
            try
            {
                var r = await db.RunAsync(p.DbScope, (c, t) => UserAdmin.InviteAsync(c, t, auth, null, req.Email!.Trim(), req.Role, p));
                if (r.Error is not null) return Error(r.Error, 409);
                return Results.Json(new { id = r.UserId, emailSent = await UserAdmin.TrySendAsync(email, r.Mail!, log) }, statusCode: 201);
            }
            catch (PostgresException e) when (e.IsUniqueViolation()) { return Error("EMAIL_TAKEN", 409); }
        }).Require(Permission.ManageTeam).RequireJson();

        g.MapPatch("/{id}", async (string id, ChangeRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (id == p.UserId) return Error("CANNOT_CHANGE_SELF", 409);
            if (req.Role is not null && !Roles.Company.Contains(req.Role)) return Error("ROLE_INVALID", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                // Serialise owner changes so two requests cannot remove the last two owners at once.
                await c.ExecuteAsync("SELECT pg_advisory_xact_lock(7240003)", transaction: t);
                var u = await UserAdmin.GetAsync(c, t, id, null);
                if (u is null) return Error("NOT_FOUND", 404);
                var losesOwner = u.Roles.Contains(Roles.Owner) && u.Status == "active"
                    && ((req.Role is not null && req.Role != Roles.Owner) || req.Disabled == true);
                if (losesOwner)
                {
                    var others = await c.ExecuteScalarAsync<int>("""
                        SELECT count(*) FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'owner'
                        WHERE u.scope = 'company' AND u.status = 'active' AND u.id <> @id
                        """, new { id }, t);
                    if (others == 0) return Error("LAST_OWNER", 409);
                }
                await UserAdmin.ChangeAsync(c, t, u, req.Role, req.Disabled, null, p);
                return Results.Json(new { status = "ok" });
            });
        }).Require(Permission.ManageTeam).RequireJson();

        g.MapPost("/{id}/send-link", async (string id, HttpContext ctx, Db db, AuthService auth, IEmailSender email, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            if (id == p.UserId) return Error("CANNOT_CHANGE_SELF", 409);
            var mail = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var u = await UserAdmin.GetAsync(c, t, id, null);
                if (u is null || u.Status == "disabled") return null;
                return await UserAdmin.SendLinkAsync(c, t, auth, u, null, p);
            });
            if (mail is null) return Error("NOT_FOUND", 404);
            return Results.Json(new { status = "ok", emailSent = await UserAdmin.TrySendAsync(email, mail, log) });
        }).Require(Permission.ManageTeam).RequireJson();
    }
}
