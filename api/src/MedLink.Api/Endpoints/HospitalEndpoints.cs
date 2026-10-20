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
    public sealed record SettingsRequest(int? NoShowGraceMin, int? RetentionMonths, string? Timezone, bool? StaffTotpRequired);
    public sealed record StaffInviteRequest(string? Email, string? Role);
    public sealed record StaffChangeRequest(string? Role, bool? Disabled);
    public sealed record DepartmentRequest(string? NameAr, string? NameEn, string? NameTr, bool? Active, int? Sort);
    public sealed record ScheduleBlock(int Weekday, string? Start, string? End, int SlotMinutes, int Capacity);
    public sealed record SchedulesRequest(ScheduleBlock[]? Blocks);
    public sealed record ClosureRequest(string? Date, string? DepartmentId, string? Reason);

    /// <summary>Roles a hospital admin may give. Hospital admins themselves are managed by the company.</summary>
    private static readonly string[] StaffRoles = [Roles.Reception, Roles.Scanner];

    private static IResult Error(string code, int status = 400, object? detail = null) =>
        Results.Json(new Dictionary<string, object?> { ["error"] = code, ["detail"] = detail }, statusCode: status);

    private sealed class DepartmentRow
    {
        public string Id { get; set; } = "";
        public string NameAr { get; set; } = "";
        public string? NameEn { get; set; }
        public string? NameTr { get; set; }
        public bool Active { get; set; }
        public int Sort { get; set; }
    }

    private sealed class ScheduleRow
    {
        public string Id { get; set; } = "";
        public string DepartmentId { get; set; } = "";
        public short Weekday { get; set; }
        public int StartMin { get; set; }
        public int EndMin { get; set; }
        public int SlotMinutes { get; set; }
        public int Capacity { get; set; }
    }

    public static string Hhmm(int min) => $"{min / 60:00}:{min % 60:00}";

    public static int? ParseHhmm(string? s)
    {
        if (s is null || s.Length != 5 || s[2] != ':' || !int.TryParse(s[..2], out var h) || !int.TryParse(s[3..], out var m)) return null;
        if (h == 24 && m == 0) return 1440;
        return h is >= 0 and <= 23 && m is >= 0 and <= 59 ? h * 60 + m : null;
    }

    private static async Task<List<object>> DepartmentsAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction t, string hospitalId)
    {
        var deps = await c.QueryAsync<DepartmentRow>(
            "SELECT id, name_ar, name_en, name_tr, active, sort FROM departments WHERE hospital_id = @hospitalId ORDER BY sort, created_at",
            new { hospitalId }, t);
        var sch = (await c.QueryAsync<ScheduleRow>(
            "SELECT id, department_id, weekday, start_min, end_min, slot_minutes, capacity FROM schedules WHERE hospital_id = @hospitalId ORDER BY weekday, start_min",
            new { hospitalId }, t)).ToLookup(x => x.DepartmentId);
        return deps.Select(d => (object)new
        {
            id = d.Id, name = new { ar = d.NameAr, en = d.NameEn, tr = d.NameTr }, active = d.Active, sort = d.Sort,
            schedules = sch[d.Id].Select(x => new { weekday = x.Weekday, start = Hhmm(x.StartMin), end = Hhmm(x.EndMin), slotMinutes = x.SlotMinutes, capacity = x.Capacity }),
        }).ToList();
    }

    private static string? Clean(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) || s.Trim().Length > max ? null : s.Trim();

    public static void MapHospital(this WebApplication app)
    {
        var g = app.MapGroup("/hospital");

        g.MapGet("/me", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var h = await db.RunAsync(p.DbScope, (c, t) => c.QuerySingleAsync<(string Id, string NameAr, string NameEn, string? NameTr, string Status, string Timezone, int NoShowGraceMin, int RetentionMonths, bool StaffTotpRequired, string? Slug)>("""
                SELECT h.id, h.name_ar, h.name_en, h.name_tr, h.status, h.timezone, h.no_show_grace_min, h.retention_months, h.staff_totp_required,
                       (SELECT slug FROM hospital_slugs s WHERE s.hospital_id = h.id AND s.is_primary) AS slug
                FROM hospitals h WHERE h.id = @id
                """, new { id = p.HospitalId }, t));
            return Results.Json(new
            {
                id = h.Id, name = new { ar = h.NameAr, en = h.NameEn, tr = h.NameTr }, status = h.Status,
                timezone = h.Timezone, noShowGraceMin = h.NoShowGraceMin, retentionMonths = h.RetentionMonths,
                staffTotpRequired = h.StaffTotpRequired, slug = h.Slug,
            });
        }).Require(Permission.HospitalRead);

        g.MapPatch("/settings", async (SettingsRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (req.NoShowGraceMin is { } gm && gm is < 0 or > 240) return Error("GRACE_INVALID", 422);
            if (req.RetentionMonths is { } rm && rm is < 1 or > 120) return Error("RETENTION_INVALID", 422);
            if (req.Timezone is not null && !Timezones.IsValid(req.Timezone)) return Error("TIMEZONE_INVALID", 422);
            await db.RunAsync(p.DbScope, async (c, t) =>
            {
                await c.ExecuteAsync("""
                    UPDATE hospitals SET no_show_grace_min = coalesce(@g, no_show_grace_min),
                           retention_months = coalesce(@r, retention_months), timezone = coalesce(@tz, timezone),
                           staff_totp_required = coalesce(@totp, staff_totp_required), updated_at = now()
                    WHERE id = @id
                    """, new { id = p.HospitalId, g = req.NoShowGraceMin, r = req.RetentionMonths, tz = req.Timezone, totp = req.StaffTotpRequired }, t);
                await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "hospital_settings", p.HospitalId!, new
                {
                    noShowGraceMin = req.NoShowGraceMin, retentionMonths = req.RetentionMonths, timezone = req.Timezone, staffTotpRequired = req.StaffTotpRequired,
                });
            });
            return Results.Json(new { status = "ok" });
        }).Require(Permission.HospitalSettings).RequireJson();

        // ---------------------------------------------------------------- staff
        g.MapGet("/users", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var users = await db.RunAsync(p.DbScope, (c, t) => UserAdmin.ListAsync(c, t, p.HospitalId));
            return Results.Json(new { users = users.Select(UserAdmin.Dto) });
        }).Require(Permission.HospitalUsersManage);

        // Deliberately filtered by RLS alone (no hospital_id condition): proves the database layer on its own.
        g.MapGet("/users/{id}", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var u = await db.RunAsync(p.DbScope, (c, t) => c.QuerySingleOrDefaultAsync<(string Id, string Email, string Status)?>(
                "SELECT id, email::text AS email, status FROM users WHERE id = @id", new { id }, t));
            return u is null
                ? Error("NOT_FOUND", 404)
                : Results.Json(new { id = u.Value.Id, email = u.Value.Email, status = u.Value.Status });
        }).Require(Permission.HospitalUsersManage);

        g.MapPost("/users", async (StaffInviteRequest req, HttpContext ctx, Db db, AuthService auth, MedLink.Api.Email.IEmailSender email, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            if (!UserAdmin.IsEmail(req.Email)) return Error("EMAIL_INVALID", 422);
            if (req.Role is null || !StaffRoles.Contains(req.Role)) return Error("ROLE_INVALID", 422);
            try
            {
                var r = await db.RunAsync(p.DbScope, (c, t) => UserAdmin.InviteAsync(c, t, auth, p.HospitalId, req.Email!.Trim(), req.Role, p));
                if (r.Error is not null) return Error(r.Error, 409);
                return Results.Json(new { id = r.UserId, emailSent = await UserAdmin.TrySendAsync(email, r.Mail!, log) }, statusCode: 201);
            }
            catch (Npgsql.PostgresException e) when (e.IsUniqueViolation()) { return Error("EMAIL_TAKEN", 409); }
        }).Require(Permission.HospitalUsersManage).RequireJson();

        g.MapPatch("/users/{id}", async (string id, StaffChangeRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (id == p.UserId) return Error("CANNOT_CHANGE_SELF", 409);
            if (req.Role is not null && !StaffRoles.Contains(req.Role)) return Error("ROLE_INVALID", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var u = await UserAdmin.GetAsync(c, t, id, p.HospitalId);
                if (u is null) return Error("NOT_FOUND", 404);
                if (u.Roles.Contains(Roles.HospAdmin)) return Error("ADMIN_MANAGED_BY_COMPANY", 409);
                await UserAdmin.ChangeAsync(c, t, u, req.Role, req.Disabled, p.HospitalId, p);
                return Results.Json(new { status = "ok" });
            });
        }).Require(Permission.HospitalUsersManage).RequireJson();

        g.MapPost("/users/{id}/send-link", async (string id, HttpContext ctx, Db db, AuthService auth, MedLink.Api.Email.IEmailSender email, ILogger<Program> log) =>
        {
            var p = ctx.RequirePrincipal();
            if (id == p.UserId) return Error("CANNOT_CHANGE_SELF", 409);
            var r = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var u = await UserAdmin.GetAsync(c, t, id, p.HospitalId);
                if (u is null || u.Status == "disabled") return ("NOT_FOUND", (MedLink.Api.Email.EmailMessage?)null);
                if (u.Roles.Contains(Roles.HospAdmin)) return ("ADMIN_MANAGED_BY_COMPANY", null);
                return ((string?)null, await UserAdmin.SendLinkAsync(c, t, auth, u, p.HospitalId, p));
            });
            if (r.Item1 is { } err) return Error(err, err == "NOT_FOUND" ? 404 : 409);
            return Results.Json(new { status = "ok", emailSent = await UserAdmin.TrySendAsync(email, r.Item2!, log) });
        }).Require(Permission.HospitalUsersManage).RequireJson();

        // ---------------------------------------------------------------- departments & schedules
        g.MapGet("/departments", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return Results.Json(new { departments = await db.RunAsync(p.DbScope, (c, t) => DepartmentsAsync(c, t, p.HospitalId!)) });
        }).Require(Permission.HospitalRead);

        g.MapPost("/departments", async (DepartmentRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var ar = Clean(req.NameAr, 120);
            if (ar is null) return Error("NAME_REQUIRED", 422);
            try
            {
                var id = await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    var id = "dep_" + Ulid.NewUlid();
                    var sort = req.Sort ?? await c.ExecuteScalarAsync<int>("SELECT coalesce(max(sort), 0) + 10 FROM departments WHERE hospital_id = @h", new { h = p.HospitalId }, t);
                    await c.ExecuteAsync("""
                        INSERT INTO departments (id, hospital_id, name_ar, name_en, name_tr, active, sort)
                        VALUES (@id, @h, @ar, @en, @tr, @active, @sort)
                        """, new { id, h = p.HospitalId, ar, en = Clean(req.NameEn, 120), tr = Clean(req.NameTr, 120), active = req.Active ?? true, sort }, t);
                    await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "department_create", id);
                    return id;
                });
                return Results.Json(new { id }, statusCode: 201);
            }
            catch (Npgsql.PostgresException e) when (e.IsUniqueViolation()) { return Error("NAME_TAKEN", 409); }
        }).Require(Permission.HospitalSettings).RequireJson();

        g.MapPatch("/departments/{id}", async (string id, DepartmentRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var ar = req.NameAr is null ? null : Clean(req.NameAr, 120);
            if (req.NameAr is not null && ar is null) return Error("NAME_REQUIRED", 422);
            try
            {
                var n = await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    var n = await c.ExecuteAsync("""
                        UPDATE departments SET name_ar = coalesce(@ar, name_ar),
                               name_en = CASE WHEN @setNames THEN @en ELSE name_en END,
                               name_tr = CASE WHEN @setNames THEN @tr ELSE name_tr END,
                               active = coalesce(@active, active), sort = coalesce(@sort, sort), updated_at = now()
                        WHERE id = @id AND hospital_id = @h
                        """, new { id, h = p.HospitalId, ar, setNames = req.NameAr is not null, en = Clean(req.NameEn, 120), tr = Clean(req.NameTr, 120), active = req.Active, sort = req.Sort }, t);
                    if (n > 0) await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "department_edit", id, new { active = req.Active });
                    return n;
                });
                return n == 0 ? Error("NOT_FOUND", 404) : Results.Json(new { status = "ok" });
            }
            catch (Npgsql.PostgresException e) when (e.IsUniqueViolation()) { return Error("NAME_TAKEN", 409); }
        }).Require(Permission.HospitalSettings).RequireJson();

        // Replaces the department's whole weekly timetable in one transaction.
        g.MapPut("/departments/{id}/schedules", async (string id, SchedulesRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var blocks = req.Blocks ?? [];
            if (blocks.Length > 70) return Error("TOO_MANY_BLOCKS", 422);
            var rows = new List<(int W, int S, int E, int Slot, int Cap)>();
            for (var i = 0; i < blocks.Length; i++)
            {
                var b = blocks[i];
                var st = ParseHhmm(b.Start);
                var en = ParseHhmm(b.End);
                if (b.Weekday is < 0 or > 6 || st is null || en is null || st >= 1440 || en <= st
                    || b.SlotMinutes is < 5 or > 240 || b.Capacity is < 1 or > 100 || en - st < b.SlotMinutes)
                    return Error("SCHEDULE_INVALID", 422, i);
                rows.Add((b.Weekday, st.Value, en.Value, b.SlotMinutes, b.Capacity));
            }
            try
            {
                return await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    if (!await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM departments WHERE id = @id AND hospital_id = @h)", new { id, h = p.HospitalId }, t))
                        return Error("NOT_FOUND", 404);
                    await c.ExecuteAsync("DELETE FROM schedules WHERE department_id = @id", new { id }, t);
                    foreach (var r in rows)
                        await c.ExecuteAsync("""
                            INSERT INTO schedules (id, hospital_id, department_id, weekday, start_min, end_min, slot_minutes, capacity)
                            VALUES (@sid, @h, @id, @w, @s, @e, @slot, @cap)
                            """, new { sid = "sch_" + Ulid.NewUlid(), h = p.HospitalId, id, w = (short)r.W, s = r.S, e = r.E, slot = r.Slot, cap = r.Cap }, t);
                    await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "schedule_edit", id, new { blocks = rows.Count });
                    return Results.Json(new { status = "ok" });
                });
            }
            catch (Npgsql.PostgresException e) when (e.SqlState == Npgsql.PostgresErrorCodes.ExclusionViolation)
            {
                return Error("SCHEDULE_OVERLAP", 409);
            }
        }).Require(Permission.HospitalSettings).RequireJson();

        // ---------------------------------------------------------------- closures
        g.MapGet("/closures", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var rows = await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<(string Id, DateTime Date, string? DepartmentId, string? Reason)>(
                "SELECT id, date, department_id, reason FROM closures WHERE hospital_id = @h AND date >= current_date - 1 ORDER BY date",
                new { h = p.HospitalId }, t));
            return Results.Json(new { closures = rows.Select(r => new { id = r.Id, date = r.Date.ToString("yyyy-MM-dd"), departmentId = r.DepartmentId, reason = r.Reason }) });
        }).Require(Permission.HospitalRead);

        g.MapPost("/closures", async (ClosureRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (!DateOnly.TryParseExact(req.Date, "yyyy-MM-dd", out var date)) return Error("DATE_INVALID", 422);
            if (req.Reason is { Length: > 200 }) return Error("REASON_TOO_LONG", 422);
            try
            {
                return await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    if (req.DepartmentId is not null && !await c.ExecuteScalarAsync<bool>(
                            "SELECT EXISTS (SELECT 1 FROM departments WHERE id = @d AND hospital_id = @h)", new { d = req.DepartmentId, h = p.HospitalId }, t))
                        return Error("NOT_FOUND", 404);
                    var id = "clo_" + Ulid.NewUlid();
                    await c.ExecuteAsync("""
                        INSERT INTO closures (id, hospital_id, department_id, date, reason, created_by)
                        VALUES (@id, @h, @d, @date, @reason, @by)
                        """, new { id, h = p.HospitalId, d = req.DepartmentId, date = date.ToDateTime(TimeOnly.MinValue), reason = Clean(req.Reason, 200), by = p.UserId }, t);
                    await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "closure_add", id, new { date = req.Date });
                    return Results.Json(new { id }, statusCode: 201);
                });
            }
            catch (Npgsql.PostgresException e) when (e.IsUniqueViolation()) { return Error("CLOSURE_EXISTS", 409); }
        }).Require(Permission.HospitalSettings).RequireJson();

        g.MapDelete("/closures/{id}", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var n = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var n = await c.ExecuteAsync("DELETE FROM closures WHERE id = @id AND hospital_id = @h", new { id, h = p.HospitalId }, t);
                if (n > 0) await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "closure_remove", id);
                return n;
            });
            return n == 0 ? Error("NOT_FOUND", 404) : Results.Json(new { status = "ok" });
        }).Require(Permission.HospitalSettings);
    }

    /// <summary>
    /// Public booking-link resolution. Active slug → 200. Retired slug within 90 days → 301 to the new slug.
    /// After that → 410 LINK_CHANGED. Unknown → 404. Only display fields are returned.
    /// </summary>
    private sealed record SlugInfo(string HospitalId, bool IsPrimary, DateTime? RedirectUntil, string NameAr, string NameEn, string? NameTr, string Status, string? Current);

    private static Task<SlugInfo?> ResolveAsync(Db db, string slug) =>
        db.RunAsync(DbScope.System, (c, t) => c.QuerySingleOrDefaultAsync<SlugInfo>("""
            SELECT s.hospital_id, s.is_primary, s.redirect_until, h.name_ar, h.name_en, h.name_tr, h.status,
                   (SELECT p.slug FROM hospital_slugs p WHERE p.hospital_id = s.hospital_id AND p.is_primary) AS current
            FROM hospital_slugs s JOIN hospitals h ON h.id = s.hospital_id WHERE s.slug = @slug
            """, new { slug }, t));

    private static bool StillRedirecting(SlugInfo x, TimeProvider clock) =>
        x.Current is not null && x.RedirectUntil is { } ru && DateTime.SpecifyKind(ru, DateTimeKind.Utc) > clock.GetUtcNow().UtcDateTime;

    private static async Task<object> ActiveBody(Db db, SlugInfo x, string slug)
    {
        var deps = await db.RunAsync(DbScope.System, (c, t) => c.QueryAsync<(string Id, string NameAr, string? NameEn, string? NameTr)>(
            "SELECT id, name_ar, name_en, name_tr FROM departments WHERE hospital_id = @h AND active ORDER BY sort, created_at",
            new { h = x.HospitalId }, t));
        return new
        {
            state = "active",
            slug,
            name = new { ar = x.NameAr, en = x.NameEn, tr = x.NameTr },
            acceptingBookings = x.Status == "active",
            departments = deps.Select(d => new { id = d.Id, name = new { ar = d.NameAr, en = d.NameEn, tr = d.NameTr } }),
        };
    }

    public static void MapPublic(this WebApplication app)
    {
        // HTTP semantics, for crawlers and the Cloudflare Pages Function: 200 / 301 / 410 / 404.
        app.MapGet("/public/book/{slug}", async (string slug, Db db, TimeProvider clock) =>
        {
            if (!SlugPolicy.IsValidFormat(slug)) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            if (await ResolveAsync(db, slug) is not { } x) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            if (!x.IsPrimary)
                return StillRedirecting(x, clock)
                    ? new RedirectJson("/public/book/" + x.Current, x.Current!)
                    : Results.Json(new { error = "LINK_CHANGED" }, statusCode: 410);
            return Results.Json(await ActiveBody(db, x, slug));
        });

        // For the booking app: never redirects, so it works the same behind any proxy.
        // A renamed link (within 90 days) answers with the current hospital page and its current slug.
        app.MapGet("/public/slugs/{slug}", async (string slug, Db db, TimeProvider clock) =>
        {
            if (!SlugPolicy.IsValidFormat(slug)) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            if (await ResolveAsync(db, slug) is not { } x) return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
            if (!x.IsPrimary && !StillRedirecting(x, clock)) return Results.Json(new { state = "changed" });
            return Results.Json(await ActiveBody(db, x, x.IsPrimary ? slug : x.Current!));
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
