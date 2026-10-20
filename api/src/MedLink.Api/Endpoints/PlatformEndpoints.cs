using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Hospitals;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>
/// Company-wide settings (System settings tab) and per-hospital booking-rule overrides.
/// Everything here is edited from the company console only.
/// </summary>
public static class PlatformEndpoints
{
    public sealed record SettingsRequest(string? DefaultTimezone, int? BookingWindowDays, int? MinNoticeMin, bool? PatientCanCancel, int? PerPhoneDailyLimit);
    /// <summary>Both fields are always applied; null means "use the company-wide value".</summary>
    public sealed record BookingRulesRequest(int? BookingWindowDays, int? MinNoticeMin);

    public sealed class SettingsRow
    {
        public string DefaultTimezone { get; set; } = "";
        public int BookingWindowDays { get; set; }
        public int MinNoticeMin { get; set; }
        public bool PatientCanCancel { get; set; }
        public int PerPhoneDailyLimit { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    public const int MaxWindowDays = 365, MaxNoticeMin = 1440, MaxPerPhone = 50;

    public static Task<SettingsRow> GetAsync(NpgsqlConnection c, NpgsqlTransaction t) =>
        c.QuerySingleAsync<SettingsRow>("""
            SELECT default_timezone, booking_window_days, min_notice_min, patient_can_cancel, per_phone_daily_limit, updated_at
            FROM platform_settings WHERE id
            """, transaction: t);

    public static Task<string> DefaultTimezoneAsync(NpgsqlConnection c, NpgsqlTransaction t) =>
        c.QuerySingleAsync<string>("SELECT default_timezone FROM platform_settings WHERE id", transaction: t);

    /// <summary>The rules that apply to one hospital: its override, otherwise the company-wide value.</summary>
    public static Task<(int WindowDays, int MinNoticeMin, bool Overridden)> EffectiveRulesAsync(NpgsqlConnection c, NpgsqlTransaction t, string hospitalId) =>
        c.QuerySingleAsync<(int, int, bool)>("""
            SELECT coalesce(h.booking_window_days, p.booking_window_days), coalesce(h.min_notice_min, p.min_notice_min),
                   (h.booking_window_days IS NOT NULL OR h.min_notice_min IS NOT NULL)
            FROM hospitals h CROSS JOIN platform_settings p WHERE h.id = @hospitalId AND p.id
            """, new { hospitalId }, t);

    private static object Dto(SettingsRow s) => new
    {
        defaultTimezone = s.DefaultTimezone, bookingWindowDays = s.BookingWindowDays, minNoticeMin = s.MinNoticeMin,
        patientCanCancel = s.PatientCanCancel, perPhoneDailyLimit = s.PerPhoneDailyLimit,
        updatedAt = DateTime.SpecifyKind(s.UpdatedAt, DateTimeKind.Utc),
    };

    private static IResult Error(string code, int status) => Results.Json(new { error = code }, statusCode: status);

    public static void MapPlatform(this WebApplication app)
    {
        app.MapGet("/admin/settings", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return Results.Json(Dto(await db.RunAsync(p.DbScope, GetAsync)));
        }).Require(Permission.ViewReports);

        app.MapPatch("/admin/settings", async (SettingsRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (req.DefaultTimezone is not null && !Timezones.IsValid(req.DefaultTimezone)) return Error("TIMEZONE_INVALID", 422);
            if (req.BookingWindowDays is { } w && w is < 1 or > MaxWindowDays) return Error("WINDOW_INVALID", 422);
            if (req.MinNoticeMin is { } n && n is < 0 or > MaxNoticeMin) return Error("NOTICE_INVALID", 422);
            if (req.PerPhoneDailyLimit is { } l && l is < 0 or > MaxPerPhone) return Error("LIMIT_INVALID", 422);
            var row = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                await c.ExecuteAsync("""
                    UPDATE platform_settings SET
                      default_timezone = coalesce(@tz, default_timezone),
                      booking_window_days = coalesce(@w, booking_window_days),
                      min_notice_min = coalesce(@n, min_notice_min),
                      patient_can_cancel = coalesce(@cancel, patient_can_cancel),
                      per_phone_daily_limit = coalesce(@limit, per_phone_daily_limit),
                      updated_at = now(), updated_by = @by
                    WHERE id
                    """, new { tz = req.DefaultTimezone, w = req.BookingWindowDays, n = req.MinNoticeMin, cancel = req.PatientCanCancel, limit = req.PerPhoneDailyLimit, by = p.UserId }, t);
                await AuditLog.WriteAsync(c, t, p.UserId, null, "platform_settings", "platform", req);
                return await GetAsync(c, t);
            });
            return Results.Json(Dto(row));
        }).Require(Permission.PlatformSettings).RequireJson();

        app.MapPut("/admin/hospitals/{id}/booking-rules", async (string id, BookingRulesRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            if (req.BookingWindowDays is { } w && w is < 1 or > MaxWindowDays) return Error("WINDOW_INVALID", 422);
            if (req.MinNoticeMin is { } n && n is < 0 or > MaxNoticeMin) return Error("NOTICE_INVALID", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var changed = await c.ExecuteAsync("""
                    UPDATE hospitals SET booking_window_days = @w, min_notice_min = @n, updated_at = now() WHERE id = @id
                    """, new { id, w = req.BookingWindowDays, n = req.MinNoticeMin }, t);
                if (changed == 0) return Error("NOT_FOUND", 404);
                await AuditLog.WriteAsync(c, t, p.UserId, id, "booking_rules", id, req);
                var eff = await EffectiveRulesAsync(c, t, id);
                return Results.Json(new { bookingWindowDays = eff.WindowDays, minNoticeMin = eff.MinNoticeMin, overridden = eff.Overridden });
            });
        }).Require(Permission.HospitalsCreateEdit).RequireJson();
    }
}
