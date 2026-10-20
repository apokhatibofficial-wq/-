using System.Text.Json;
using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Auth;
using MedLink.Api.Bookings;
using MedLink.Api.Data;
using MedLink.Api.Hospitals;

namespace MedLink.Api.Endpoints;

public static class BookingEndpoints
{
    public sealed record CancelRequest(string? Reason);

    private static IResult Error(string code, int status, object? detail = null) =>
        Results.Json(new Dictionary<string, object?> { ["error"] = code, ["detail"] = detail }, statusCode: status);

    /// <summary>Public endpoints used by the booking site. They return only what a patient needs to book.</summary>
    public static void MapPublicBooking(this WebApplication app)
    {
        var g = app.MapGroup("/public/hospitals/{slug}");

        g.MapGet("/form", async (string slug, Db db) =>
        {
            if (!SlugPolicy.IsValidFormat(slug)) return Error("NOT_FOUND", 404);
            var r = await db.RunAsync(DbScope.System, async (c, t) =>
            {
                var h = await BookingService.ResolveAsync(c, t, slug);
                if (h is null) return (Found: false, Form: (object?)null);
                var v = await c.QuerySingleOrDefaultAsync<(string Id, int Version, string Schema)?>("""
                    SELECT v.id, v.version, v.schema_json::text FROM hospital_active_form a JOIN form_versions v ON v.id = a.form_version_id
                    WHERE a.hospital_id = @h
                    """, new { h = h.Id }, t);
                return (true, v is null ? null : new { versionId = v.Value.Id, version = v.Value.Version, questions = FormEndpoints.Parse(v.Value.Schema).Questions });
            });
            return r.Found ? Results.Json(new { form = r.Form }) : Error("NOT_FOUND", 404);
        });

        g.MapGet("/availability", async (string slug, string? departmentId, Db db, TimeProvider clock) =>
        {
            if (!SlugPolicy.IsValidFormat(slug) || departmentId is null) return Error("NOT_FOUND", 404);
            return await db.RunAsync(DbScope.System, async (c, t) =>
            {
                var h = await BookingService.ResolveAsync(c, t, slug);
                if (h is null) return Error("NOT_FOUND", 404);
                if (!await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM departments WHERE id = @d AND hospital_id = @h AND active)", new { d = departmentId, h = h.Id }, t))
                    return Error("DEPARTMENT_INVALID", 404);
                var now = clock.GetUtcNow();
                var tz = BookingService.Zone(h.Timezone);
                var (blocks, closed, booked) = await BookingService.LoadDepartmentAsync(c, t, h.Id, departmentId, now.AddDays(-1), now.AddDays(h.WindowDays + 2));
                var days = h.Status == "active" ? Availability.Compute(tz, now, h.WindowDays, h.MinNoticeMin, blocks, closed, booked) : [];
                return Results.Json(new
                {
                    timezone = h.Timezone,
                    windowDays = h.WindowDays,
                    minNoticeMin = h.MinNoticeMin,
                    days = days.Select(d => new
                    {
                        date = d.Date.ToString("yyyy-MM-dd"), weekday = (int)d.Date.DayOfWeek, status = d.Status, open = d.Open,
                        // Only bookable slots are listed, and never how many people booked them.
                        slots = d.Slots.Select(s => new { start = s.StartUtc, time = s.LocalTime }),
                    }),
                });
            });
        });

        g.MapPost("/bookings", async (string slug, BookingRequest req, HttpContext ctx, BookingService bookings) =>
        {
            if (!SlugPolicy.IsValidFormat(slug)) return Error("NOT_FOUND", 404);
            var key = ctx.Request.Headers["Idempotency-Key"].ToString();
            var r = await bookings.CreateAsync(slug, string.IsNullOrEmpty(key) ? null : key, req, ctx.RequestAborted);
            return r.Error is null ? Results.Json(r.Body, statusCode: r.Status) : Error(r.Error, r.Status, r.Body);
        }).RequireJson();
    }

    private sealed class BookingRow
    {
        public string Id { get; set; } = "";
        public string Ref { get; set; } = "";
        public DateTime SlotStart { get; set; }
        public string DepartmentId { get; set; } = "";
        public string DepNameAr { get; set; } = "";
        public string? DepNameEn { get; set; }
        public string? DepNameTr { get; set; }
        public string? PatientName { get; set; }
        public string? Phone { get; set; }
        public string Status { get; set; } = "";
        public int? FormVersion { get; set; }
        public DateTime CreatedAt { get; set; }
        public string? CancelReason { get; set; }
    }

    private const string BookingSelect = """
        SELECT b.id, b.ref, b.slot_start, b.department_id, d.name_ar AS dep_name_ar, d.name_en AS dep_name_en, d.name_tr AS dep_name_tr,
               b.patient_name, b.phone, b.status, v.version AS form_version, b.created_at, b.cancel_reason
        FROM bookings b JOIN departments d ON d.id = b.department_id LEFT JOIN form_versions v ON v.id = b.form_version_id
        """;

    private static object Dto(BookingRow b, TimeZoneInfo tz)
    {
        var local = TimeZoneInfo.ConvertTime(new DateTimeOffset(DateTime.SpecifyKind(b.SlotStart, DateTimeKind.Utc)), tz);
        return new
        {
            id = b.Id, @ref = b.Ref, slotStart = DateTime.SpecifyKind(b.SlotStart, DateTimeKind.Utc),
            localDate = local.ToString("yyyy-MM-dd"), localTime = local.ToString("HH:mm"),
            department = new { id = b.DepartmentId, ar = b.DepNameAr, en = b.DepNameEn, tr = b.DepNameTr },
            patientName = b.PatientName, phone = b.Phone, status = b.Status, formVersion = b.FormVersion,
            createdAt = DateTime.SpecifyKind(b.CreatedAt, DateTimeKind.Utc), cancelReason = b.CancelReason,
        };
    }

    /// <summary>Hospital staff: the day's bookings, lookup by full booking number, and cancellation by reception.</summary>
    public static void MapHospitalBookings(this WebApplication app)
    {
        var g = app.MapGroup("/hospital/bookings");

        g.MapGet("", async (string? date, string? @ref, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var tzId = await c.ExecuteScalarAsync<string>("SELECT timezone FROM hospitals WHERE id = @h", new { h = p.HospitalId }, t);
                var tz = BookingService.Zone(tzId!);
                if (!string.IsNullOrWhiteSpace(@ref))
                {
                    // Full booking number only: no name search (SCREENS.md §4).
                    var one = await c.QueryAsync<BookingRow>(BookingSelect + " WHERE b.hospital_id = @h AND b.ref = @r", new { h = p.HospitalId, r = @ref.Trim().ToUpperInvariant() }, t);
                    return Results.Json(new { bookings = one.Select(b => Dto(b, tz)) });
                }
                DateOnly day;
                if (date is null) day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz).DateTime);
                else if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", out day)) return Error("DATE_INVALID", 422);
                var from = TimeZoneInfo.ConvertTimeToUtc(day.ToDateTime(TimeOnly.MinValue), tz);
                var to = TimeZoneInfo.ConvertTimeToUtc(day.AddDays(1).ToDateTime(TimeOnly.MinValue), tz);
                var rows = await c.QueryAsync<BookingRow>(BookingSelect + " WHERE b.hospital_id = @h AND b.slot_start >= @from AND b.slot_start < @to ORDER BY b.slot_start, b.seat_no",
                    new { h = p.HospitalId, from, to }, t);
                return Results.Json(new { date = day.ToString("yyyy-MM-dd"), bookings = rows.Select(b => Dto(b, tz)) });
            });
        }).Require(Permission.BookingsView);

        g.MapGet("/{id}", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var b = await c.QuerySingleOrDefaultAsync<BookingRow>(BookingSelect + " WHERE b.id = @id AND b.hospital_id = @h", new { id, h = p.HospitalId }, t);
                if (b is null) return Error("NOT_FOUND", 404);
                var tz = BookingService.Zone((await c.ExecuteScalarAsync<string>("SELECT timezone FROM hospitals WHERE id = @h", new { h = p.HospitalId }, t))!);
                var answers = await c.QueryAsync<(string QuestionId, string Value)>("SELECT question_id, value_json::text FROM booking_answers WHERE booking_id = @id", new { id }, t);
                var schema = await c.ExecuteScalarAsync<string?>("SELECT v.schema_json::text FROM bookings b JOIN form_versions v ON v.id = b.form_version_id WHERE b.id = @id", new { id }, t);
                return Results.Json(new
                {
                    booking = Dto(b, tz),
                    answers = answers.ToDictionary(a => a.QuestionId, a => JsonDocument.Parse(a.Value).RootElement),
                    questions = schema is null ? [] : FormEndpoints.Parse(schema).Questions,
                });
            });
        }).Require(Permission.BookingsView);

        // Patients cannot cancel online (owner's decision); reception and the hospital admin can, with a reason.
        g.MapPost("/{id}/cancel", async (string id, CancelRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var reason = req.Reason?.Trim();
            if (reason is null || reason.Length is < 3 or > 300) return Error("REASON_REQUIRED", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var n = await c.ExecuteAsync("""
                    UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = @by, cancel_reason = @reason
                    WHERE id = @id AND hospital_id = @h AND status = 'waiting'
                    """, new { id, h = p.HospitalId, by = p.UserId, reason }, t);
                if (n == 0)
                    return await c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM bookings WHERE id = @id AND hospital_id = @h)", new { id, h = p.HospitalId }, t)
                        ? Error("NOT_CANCELLABLE", 409) : Error("NOT_FOUND", 404);
                // The reason is staff-written; no patient data goes into the audit log.
                await AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "booking_cancel", id);
                return Results.Json(new { status = "ok" });
            });
        }).Require(Permission.AttendanceCorrect).RequireJson();
    }
}
