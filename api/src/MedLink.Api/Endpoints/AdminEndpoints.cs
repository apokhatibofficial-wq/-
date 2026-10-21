using System.Net.Mail;
using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Auth;
using MedLink.Api.Config;
using MedLink.Api.Data;
using MedLink.Api.Email;
using MedLink.Api.Hospitals;
using MedLink.Api.Security;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>Company console API (admin.medlink.website). Every route requires a company-scope permission.</summary>
public static class AdminEndpoints
{
    public sealed record CreateHospitalRequest(string? NameAr, string? NameEn, string? NameTr, string? AdminEmail, string? Slug, string? Timezone);
    public sealed record EditHospitalRequest(string? NameAr, string? NameEn, string? NameTr, string? Slug, string? Timezone);
    public sealed record ReasonRequest(string? Reason);
    public sealed record RecoverRequest(bool[]? Checks);

    private sealed class HospitalRow
    {
        public string Id { get; set; } = "";
        public string NameAr { get; set; } = "";
        public string NameEn { get; set; } = "";
        public string? NameTr { get; set; }
        public string Status { get; set; } = "";
        public string? Slug { get; set; }
        public int Users { get; set; }
        public DateTime CreatedAt { get; set; }
        public string Timezone { get; set; } = "";
        public int? BookingWindowDays { get; set; }
        public int? MinNoticeMin { get; set; }
        public DateTime? LastSyncAt { get; set; }
        public int Bookings30d { get; set; }
    }

    private const string HospitalSelect = """
        SELECT h.id, h.name_ar, h.name_en, h.name_tr, h.status, h.created_at, h.timezone, h.booking_window_days, h.min_notice_min,
               (SELECT slug FROM hospital_slugs s WHERE s.hospital_id = h.id AND s.is_primary) AS slug,
               (SELECT count(*)::int FROM users u WHERE u.hospital_id = h.id AND u.status <> 'disabled') AS users,
               (SELECT max(d.last_seen_at) FROM devices d WHERE d.hospital_id = h.id) AS last_sync_at,
               (SELECT count(*)::int FROM bookings b WHERE b.hospital_id = h.id AND b.created_at > now() - interval '30 days') AS bookings30d
        FROM hospitals h
        """;

    private static object Dto(HospitalRow h) => new
    {
        id = h.Id,
        name = new { ar = h.NameAr, en = h.NameEn, tr = h.NameTr },
        status = h.Status,
        slug = h.Slug,
        users = h.Users,
        createdAt = DateTime.SpecifyKind(h.CreatedAt, DateTimeKind.Utc),
        timezone = h.Timezone,
        // Per-hospital overrides; null = the company-wide value from System settings.
        bookingWindowDays = h.BookingWindowDays,
        minNoticeMin = h.MinNoticeMin,
        // Latest pull or push from any Windows device (revoked ones included); null means no PC has ever connected.
        lastSyncAt = h.LastSyncAt is { } l ? DateTime.SpecifyKind(l, DateTimeKind.Utc) : (DateTime?)null,
        bookings30d = h.Bookings30d,
    };

    private static string? Clean(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > max ? null : s.Trim();

    private static bool IsEmail(string? s)
    {
        if (string.IsNullOrWhiteSpace(s) || s.Length > 254) return false;
        try { return new MailAddress(s).Address == s.Trim() && s.Contains('.'); }
        catch (FormatException) { return false; }
    }

    private static IResult Error(string code, int status = 400, object? extra = null) =>
        Results.Json(new Dictionary<string, object?> { ["error"] = code, ["detail"] = extra }, statusCode: status);

    private static async Task<bool> TrySendAsync(IEmailSender email, EmailMessage msg, ILogger log)
    {
        try { await email.SendAsync(msg); return true; }
        catch (Exception e)
        {
            log.LogError("email delivery failed: {Kind} {Error}", msg.Kind, e.GetType().Name);
            return false;
        }
    }

    public static void MapAdmin(this WebApplication app)
    {
        var g = app.MapGroup("/admin");

        g.MapGet("/hospitals", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var rows = await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<HospitalRow>(HospitalSelect + " ORDER BY h.created_at DESC", transaction: t));
            return Results.Json(new { hospitals = rows.Select(Dto) });
        }).Require(Permission.ViewReports);

        g.MapGet("/hospitals/{id}", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var result = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var h = await c.QuerySingleOrDefaultAsync<HospitalRow>(HospitalSelect + " WHERE h.id = @id", new { id }, t);
                if (h is null) return null;
                var old = await c.QueryAsync<(string Slug, DateTime RetiredAt, DateTime RedirectUntil)>(
                    "SELECT slug, retired_at, redirect_until FROM hospital_slugs WHERE hospital_id = @id AND NOT is_primary ORDER BY retired_at DESC",
                    new { id }, t);
                var lastChange = old.Select(o => (DateTime?)o.RetiredAt).FirstOrDefault();
                return new
                {
                    hospital = Dto(h),
                    oldSlugs = old.Select(o => new { slug = o.Slug, retiredAt = DateTime.SpecifyKind(o.RetiredAt, DateTimeKind.Utc), redirectUntil = DateTime.SpecifyKind(o.RedirectUntil, DateTimeKind.Utc) }),
                    nextSlugChangeAt = lastChange is { } lc ? DateTime.SpecifyKind(lc, DateTimeKind.Utc) + SlugPolicy.MinChangeInterval : (DateTime?)null,
                };
            });
            return result is null ? Error("NOT_FOUND", 404) : Results.Json(result);
        }).Require(Permission.ViewReports);

        g.MapGet("/slugs/check", async (string? slug, string? hospitalId, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var state = await db.RunAsync(p.DbScope, (c, t) => SlugPolicy.CheckAsync(c, t, slug, hospitalId));
            return Results.Json(new { state });
        }).Require(Permission.HospitalsCreateEdit);

        g.MapPost("/hospitals", async (CreateHospitalRequest req, HttpContext ctx, Db db, AuthService auth, IEmailSender email,
            MedLinkOptions o, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            var nameAr = Clean(req.NameAr, 200);
            var nameEn = Clean(req.NameEn, 200);
            var nameTr = Clean(req.NameTr, 200);
            if (nameAr is null || nameEn is null) return Error("NAME_REQUIRED", 422);
            if (!IsEmail(req.AdminEmail)) return Error("EMAIL_INVALID", 422);
            if (!SlugPolicy.IsValidFormat(req.Slug)) return Error("SLUG_INVALID", 422);
            if (req.Timezone is not null && !Timezones.IsValid(req.Timezone)) return Error("TIMEZONE_INVALID", 422);
            var adminEmail = req.AdminEmail!.Trim();

            try
            {
                var created = await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    if (await SlugPolicy.CheckAsync(c, t, req.Slug, null) != "ok") return ((string?)null, (IssuedLink?)null, "SLUG_TAKEN");
                    if (await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM users WHERE email = @adminEmail)", new { adminEmail }, t))
                        return (null, null, "EMAIL_TAKEN");
                    var id = Ids.Hospital();
                    // No zone given → the company-wide default from System settings.
                    var timezone = req.Timezone ?? await PlatformEndpoints.DefaultTimezoneAsync(c, t);
                    await c.ExecuteAsync("""
                        INSERT INTO hospitals (id, name_ar, name_en, name_tr, timezone) VALUES (@id, @nameAr, @nameEn, @nameTr, @tz)
                        """, new { id, nameAr, nameEn, nameTr, tz = timezone }, t);
                    await c.ExecuteAsync("INSERT INTO hospital_slugs (slug, hospital_id, is_primary) VALUES (@slug, @id, true)",
                        new { slug = req.Slug, id }, t);
                    var userId = Ids.User();
                    await c.ExecuteAsync("INSERT INTO users (id, scope, hospital_id, email) VALUES (@userId, 'hospital', @id, @adminEmail)",
                        new { userId, id, adminEmail }, t);
                    await c.ExecuteAsync("INSERT INTO user_roles (user_id, role) VALUES (@userId, 'hosp_admin')", new { userId }, t);
                    var link = await auth.IssueLinkAsync(c, t, userId, "activation", p.UserId);
                    await AuditLog.WriteAsync(c, t, p.UserId, id, "hospital_create", id, new { slug = req.Slug });
                    return (id, link, (string?)null);
                });
                if (created.Item3 is { } err) return Error(err, 409);
                var sent = await TrySendAsync(email, created.Item2!.Mail, log);
                return Results.Json(new { id = created.Item1, slug = req.Slug, emailSent = sent }, statusCode: 201);
            }
            catch (PostgresException e) when (e.IsUniqueViolation())
            {
                // A concurrent request claimed the slug or email between the check and the insert.
                return Error(e.ConstraintName?.Contains("email") == true ? "EMAIL_TAKEN" : "SLUG_TAKEN", 409);
            }
        }).Require(Permission.HospitalsCreateEdit).RequireJson();

        g.MapPatch("/hospitals/{id}", async (string id, EditHospitalRequest req, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var nameAr = Clean(req.NameAr, 200);
            var nameEn = Clean(req.NameEn, 200);
            if (nameAr is null || nameEn is null) return Error("NAME_REQUIRED", 422);
            if (req.Timezone is not null && !Timezones.IsValid(req.Timezone)) return Error("TIMEZONE_INVALID", 422);
            try
            {
                return await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    var cur = await c.QuerySingleOrDefaultAsync<HospitalRow>(HospitalSelect + " WHERE h.id = @id FOR UPDATE OF h", new { id }, t);
                    if (cur is null) return Error("NOT_FOUND", 404);
                    SlugPolicy.ChangeResult? change = null;
                    if (req.Slug is not null && req.Slug != cur.Slug)
                    {
                        change = await SlugPolicy.ChangeAsync(c, t, id, req.Slug, clock.GetUtcNow());
                        // ChangeAsync validates before it writes, so nothing has changed when it reports an error.
                        if (change.Error is { } err)
                            return Error(err, err == "SLUG_INVALID" ? 422 : 409, change.NextChangeAt);
                    }
                    var nameTr = Clean(req.NameTr, 200);
                    await c.ExecuteAsync("""
                        UPDATE hospitals SET name_ar = @nameAr, name_en = @nameEn, name_tr = @nameTr,
                               timezone = coalesce(@tz, timezone), updated_at = now() WHERE id = @id
                        """, new { id, nameAr, nameEn, nameTr, tz = req.Timezone }, t);
                    await AuditLog.WriteAsync(c, t, p.UserId, id, "hospital_edit", id, new
                    {
                        names = nameAr != cur.NameAr || nameEn != cur.NameEn || nameTr != cur.NameTr,
                        timezone = req.Timezone is not null && req.Timezone != cur.Timezone ? req.Timezone : null,
                        oldSlug = change?.OldSlug,
                        newSlug = change?.OldSlug is null ? null : req.Slug,
                    });
                    return Results.Json(new { status = "ok" });
                });
            }
            catch (PostgresException e) when (e.IsUniqueViolation())
            {
                return Error("SLUG_TAKEN", 409);
            }
        }).Require(Permission.HospitalsCreateEdit).RequireJson();

        g.MapPost("/hospitals/{id}/suspend", (string id, ReasonRequest req, HttpContext ctx, Db db) =>
            SetSuspended(id, req, ctx, db, suspend: true)).Require(Permission.HospitalsSuspend).RequireJson();

        g.MapPost("/hospitals/{id}/reactivate", (string id, ReasonRequest req, HttpContext ctx, Db db) =>
            SetSuspended(id, req, ctx, db, suspend: false)).Require(Permission.HospitalsSuspend).RequireJson();

        g.MapPost("/hospitals/{id}/recover-admin", async (string id, RecoverRequest req, HttpContext ctx, Db db, AuthService auth,
            IEmailSender email, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            // The identity checklist (3 items) must be fully confirmed. A WhatsApp message alone never changes a password.
            if (req.Checks is not { Length: 3 } || !req.Checks.All(x => x)) return Error("IDENTITY_CHECKS_INCOMPLETE", 422);
            var result = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                if (!await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM hospitals WHERE id = @id)", new { id }, t)) return null;
                var admins = (await c.QueryAsync<(string Id, string Status)>("""
                    SELECT u.id, u.status FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'hosp_admin'
                    WHERE u.hospital_id = @id AND u.status <> 'disabled'
                    """, new { id }, t)).ToList();
                var mails = new List<EmailMessage>();
                foreach (var a in admins)
                {
                    await AuthService.RevokeUserSessionsAsync(c, t, a.Id, "admin_recovery");
                    // An admin who never activated gets a fresh activation link instead of a reset link.
                    var link = await auth.IssueLinkAsync(c, t, a.Id, a.Status == "pending" ? "activation" : "reset", p.UserId);
                    mails.Add(link.Mail);
                }
                await AuditLog.WriteAsync(c, t, p.UserId, id, "admin_recover", id, new { admins = admins.Count, identityChecks = 3 });
                return mails;
            });
            if (result is null) return Error("NOT_FOUND", 404);
            if (result.Count == 0) return Error("NO_ADMIN", 409);
            var sent = true;
            foreach (var m in result) sent &= await TrySendAsync(email, m, log);
            return Results.Json(new { status = "ok", emailSent = sent });
        }).Require(Permission.RecoverAdminAccess).RequireJson();

        g.MapGet("/audit", async (HttpContext ctx, Db db, int? limit) =>
        {
            var p = ctx.RequirePrincipal();
            var full = p.Has(Permission.ViewAuditFull);
            if (!full && !p.Has(Permission.ViewAuditHospitalOnly)) return Error("FORBIDDEN", 403);
            var rows = await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<(DateTime At, string Action, string Target, string? HospitalId, string? Actor, string Meta)>($"""
                SELECT a.at, a.action, a.target, a.hospital_id, u.email::text AS actor, a.meta_json::text AS meta
                FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                {(full ? "" : "WHERE a.hospital_id IS NOT NULL")}
                ORDER BY a.at DESC, a.id DESC LIMIT @limit
                """, new { limit = Math.Clamp(limit ?? 200, 1, 500) }, t));
            return Results.Json(new
            {
                entries = rows.Select(r => new
                {
                    at = DateTime.SpecifyKind(r.At, DateTimeKind.Utc), action = r.Action, target = r.Target,
                    hospitalId = r.HospitalId, actor = r.Actor, meta = System.Text.Json.JsonDocument.Parse(r.Meta).RootElement,
                }),
                scope = full ? "full" : "hospital",
            });
        }).RequireSignedIn();

        g.MapGet("/reports", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var rows = (await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<HospitalRow>(HospitalSelect + " ORDER BY h.name_en", transaction: t))).ToList();
            // Aggregates only, never patient data. Booking tables arrive in phase 6, so counts are zero until then.
            return Results.Json(new
            {
                totalBookings = 0,
                averageAttendance = (double?)null,
                activeHospitals = rows.Count(r => r.Status == "active"),
                hospitals = rows.Select(r => new { id = r.Id, name = new { ar = r.NameAr, en = r.NameEn, tr = r.NameTr }, bookings = 0, attendance = (double?)null, noShow = (double?)null }),
            });
        }).Require(Permission.ViewReports);
    }

    private static async Task<IResult> SetSuspended(string id, ReasonRequest req, HttpContext ctx, Db db, bool suspend)
    {
        var p = ctx.RequirePrincipal();
        var reason = req.Reason?.Trim();
        if (reason is null || reason.Length < 5 || reason.Length > 500) return Error("REASON_REQUIRED", 422);
        return await db.RunAsync(p.DbScope, async (c, t) =>
        {
            var status = await c.ExecuteScalarAsync<string?>("SELECT status FROM hospitals WHERE id = @id FOR UPDATE", new { id }, t);
            if (status is null) return Error("NOT_FOUND", 404);
            if (suspend == (status == "suspended")) return Error(suspend ? "ALREADY_SUSPENDED" : "NOT_SUSPENDED", 409);
            if (suspend)
            {
                await c.ExecuteAsync("UPDATE hospitals SET status = 'suspended', updated_at = now() WHERE id = @id", new { id }, t);
                await AuthService.RevokeHospitalSessionsAsync(c, t, id, "hospital_suspended");
            }
            else
            {
                // Back to "active" if an admin has activated their account, otherwise still awaiting activation.
                await c.ExecuteAsync("""
                    UPDATE hospitals SET updated_at = now(), status = CASE WHEN EXISTS (
                        SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'hosp_admin'
                        WHERE u.hospital_id = @id AND u.status = 'active') THEN 'active' ELSE 'pending' END
                    WHERE id = @id
                    """, new { id }, t);
            }
            // The reason is operator-written free text kept for the audit trail.
            await AuditLog.WriteAsync(c, t, p.UserId, id, suspend ? "hospital_suspend" : "hospital_reactivate", id, new { reason });
            return Results.Json(new { status = "ok" });
        });
    }
}
