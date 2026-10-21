using System.Text.RegularExpressions;
using Dapper;
using MedLink.Api.Attendance;
using MedLink.Api.Auth;
using MedLink.Api.Bookings;
using MedLink.Api.Data;
using MedLink.Api.Security;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>
/// The phone scanner (SCREENS.md §4), for every role with the check-in permission (QR scanner, reception, hospital
/// admin — owner's decision). A scanned code is verified and checked in at once; a booking number is looked up first,
/// and the staff member confirms the patient's identity before checking in. Results follow the design's table: details
/// are shown only for this hospital's bookings, never for another hospital's or an unknown code.
/// </summary>
public static partial class ScanEndpoints
{
    public sealed record QrRequest(string? Code, Guid? ClientEventId);
    public sealed record CheckInRequest(string? BookingId, Guid? ClientEventId);

    [GeneratedRegex("^MLK1\\.[A-Za-z0-9_-]{22}$")]
    private static partial Regex QrFormat();

    [GeneratedRegex("^ML-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$")]
    private static partial Regex RefFormat();

    private sealed class Row
    {
        public string Id { get; set; } = "";
        public string Ref { get; set; } = "";
        public string? PatientName { get; set; }
        public DateTime SlotStart { get; set; }
        public string Status { get; set; } = "";
        public DateTime? ArrivedAt { get; set; }
        public DateTime? AnonymizedAt { get; set; }
        public string DepAr { get; set; } = "";
        public string? DepEn { get; set; }
        public string? DepTr { get; set; }
        public string Timezone { get; set; } = "";
    }

    private const string Select = """
        SELECT b.id, b.ref, b.patient_name, b.slot_start, b.status, b.arrived_at, b.anonymized_at,
               d.name_ar AS dep_ar, d.name_en AS dep_en, d.name_tr AS dep_tr, h.timezone
        FROM bookings b JOIN departments d ON d.id = b.department_id JOIN hospitals h ON h.id = b.hospital_id
        """;

    private static DateTimeOffset Utc(DateTime d) => new(DateTime.SpecifyKind(d, DateTimeKind.Utc));

    /// <summary>The result card: kind (design table) and, for this hospital's bookings only, the facts.</summary>
    private static IResult Card(string kind, Row? b = null, string? bookingId = null)
    {
        if (b is null) return Results.Json(new { kind });
        var tz = BookingService.Zone(b.Timezone);
        var local = TimeZoneInfo.ConvertTime(Utc(b.SlotStart), tz);
        return Results.Json(new
        {
            kind,
            bookingId,
            booking = new
            {
                @ref = b.Ref, patientName = b.PatientName,
                date = local.ToString("yyyy-MM-dd"), time = local.ToString("HH:mm"),
                department = new { ar = b.DepAr, en = b.DepEn, tr = b.DepTr },
                arrivedAt = b.ArrivedAt is { } a ? TimeZoneInfo.ConvertTime(Utc(a), tz).ToString("HH:mm") : null,
            },
        });
    }

    /// <summary>Classifies a booking of this hospital before any check-in: cancelled, other day, already in, or ready.</summary>
    private static string Classify(Row b, DateTimeOffset now)
    {
        if (b.Status == "cancelled") return "cancelled";
        var tz = BookingService.Zone(b.Timezone);
        var slotDay = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(Utc(b.SlotStart), tz).DateTime);
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, tz).DateTime);
        if (slotDay != today) return "otherday";
        if (b.Status == "arrived") return "already";
        return "ready";
    }

    public static void MapScan(this WebApplication app)
    {
        var g = app.MapGroup("/scan");

        // Scan: verify the code, then check in at once (source "qr"). A repeated clientEventId is applied once.
        g.MapPost("/qr", async (QrRequest req, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var code = req.Code?.Trim() ?? "";
            if (!QrFormat().IsMatch(code)) return Card("bad");
            var hash = Tokens.Hash(code);
            var now = clock.GetUtcNow();
            var result = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var b = await c.QuerySingleOrDefaultAsync<Row>(Select + " WHERE b.qr_token_hash = @hash AND b.hospital_id = @h FOR UPDATE OF b",
                    new { hash, h = p.HospitalId }, t);
                if (b is null) return ((IResult?)null, false);
                // Anonymised after the retention period: the code is no longer valid.
                if (b.AnonymizedAt is not null) return (Card("bad"), false);
                var kind = Classify(b, now);
                if (kind != "ready") return (Card(kind, b), false);
                var r = await AttendanceService.RecordAsync(c, t, new RecordRequest(p.HospitalId!, b.Id, "arrived", "qr", now, p.UserId, null, req.ClientEventId, null), now);
                var after = await c.QuerySingleAsync<Row>(Select + " WHERE b.id = @id", new { id = b.Id }, t);
                // A manual correction outranks a scan (approved policy): the scan is recorded, the status stays as corrected.
                return (Card(after.Status == "arrived" ? (r.Outcome == "duplicate" ? "already" : "ok") : "corrected", after), true);
            });
            if (result.Item1 is not null) return result.Item1;
            // Not this hospital's: say whether it is another hospital's booking, without any detail.
            var elsewhere = await db.RunAsync(DbScope.System, (c, t) =>
                c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM bookings WHERE qr_token_hash = @hash AND anonymized_at IS NULL)", new { hash }, t));
            return Card(elsewhere ? "other" : "bad");
        }).Require(Permission.CheckIn).RequireJson();

        // Manual: by the full booking number of this hospital only (another hospital's number is simply "not found").
        g.MapGet("/lookup", async (string? @ref, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var q = @ref?.Trim().ToUpperInvariant() ?? "";
            if (!RefFormat().IsMatch(q)) return Card("notfound");
            var b = await db.RunAsync(p.DbScope, (c, t) =>
                c.QuerySingleOrDefaultAsync<Row>(Select + " WHERE b.ref = @q AND b.hospital_id = @h AND b.anonymized_at IS NULL", new { q, h = p.HospitalId }, t));
            if (b is null) return Card("notfound");
            var kind = Classify(b, clock.GetUtcNow());
            return Card(kind == "ready" ? "found" : kind, b, kind == "ready" ? b.Id : null);
        }).Require(Permission.CheckIn);

        // Manual check-in after the identity check (source "reception": a person checked it, not a scanned code).
        g.MapPost("/checkin", async (CheckInRequest req, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            if (string.IsNullOrEmpty(req.BookingId)) return Card("notfound");
            var now = clock.GetUtcNow();
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var b = await c.QuerySingleOrDefaultAsync<Row>(Select + " WHERE b.id = @id AND b.hospital_id = @h AND b.anonymized_at IS NULL FOR UPDATE OF b",
                    new { id = req.BookingId, h = p.HospitalId }, t);
                if (b is null) return Card("notfound");
                var kind = Classify(b, now);
                if (kind != "ready") return Card(kind, b);
                var r = await AttendanceService.RecordAsync(c, t, new RecordRequest(p.HospitalId!, b.Id, "arrived", "reception", now, p.UserId, null, req.ClientEventId, null), now);
                var after = await c.QuerySingleAsync<Row>(Select + " WHERE b.id = @id", new { id = b.Id }, t);
                return Card(after.Status == "arrived" ? (r.Outcome == "duplicate" ? "already" : "ok") : "corrected", after);
            });
        }).Require(Permission.CheckIn).RequireJson();
    }
}
