using Dapper;
using MedLink.Api.Bookings;
using Npgsql;

namespace MedLink.Api.Attendance;

public sealed record RecordRequest(string HospitalId, string BookingId, string Type, string Source, DateTimeOffset At,
    string? ActorId, string? DeviceId, Guid? ClientEventId, string? Reason);

/// <summary>"applied", "duplicate" (same client_event_id seen before) or "rejected" with a code.</summary>
public sealed record RecordResult(string Outcome, string? Code, AttendanceState? State, string? Ref = null);

public static class AttendanceService
{
    /// <summary>Offline events may be up to 7 days old; device clocks may run up to 5 minutes fast.</summary>
    public static readonly TimeSpan MaxEventAge = TimeSpan.FromDays(7), MaxClockSkew = TimeSpan.FromMinutes(5);

    private sealed class BookingRow
    {
        public string Id { get; set; } = "";
        public string Ref { get; set; } = "";
        public string Status { get; set; } = "";
        public DateTime SlotStart { get; set; }
        public string Timezone { get; set; } = "";
    }

    public static async Task<RecordResult> RecordAsync(NpgsqlConnection c, NpgsqlTransaction t, RecordRequest r, DateTimeOffset now)
    {
        if (r.ClientEventId is { } ce)
        {
            var seen = await c.ExecuteScalarAsync<string?>("SELECT booking_id FROM attendance_events WHERE client_event_id = @ce", new { ce }, t);
            if (seen is not null) return new RecordResult("duplicate", null, await CurrentAsync(c, t, seen));
        }
        // Lock the booking so concurrent events for it are applied one at a time.
        var b = await c.QuerySingleOrDefaultAsync<BookingRow>("""
            SELECT b.id, b.ref, b.status, b.slot_start, h.timezone FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
            WHERE b.id = @id AND b.hospital_id = @h FOR UPDATE OF b
            """, new { id = r.BookingId, h = r.HospitalId }, t);
        if (b is null) return new RecordResult("rejected", "NOT_FOUND", null);
        if (b.Status == "cancelled") return new RecordResult("rejected", "CANCELLED", null, b.Ref);
        if (r.At > now + MaxClockSkew || r.At < now - MaxEventAge) return new RecordResult("rejected", "BAD_TIME", null, b.Ref);

        // A check-in must happen on the appointment's own day (in hospital time). Corrections may be made later.
        if (r.Source is "qr" or "reception")
        {
            var tz = BookingService.Zone(b.Timezone);
            var slotDay = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(new DateTimeOffset(DateTime.SpecifyKind(b.SlotStart, DateTimeKind.Utc)), tz).DateTime);
            var eventDay = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(r.At, tz).DateTime);
            if (slotDay != eventDay) return new RecordResult("rejected", "OTHER_DAY", null, b.Ref);
        }

        try
        {
            await c.ExecuteAsync("SAVEPOINT att", transaction: t);
            await c.ExecuteAsync("""
                INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at, actor_id, device_id, client_event_id, reason)
                VALUES (@id, @h, @b, @type, @source, @at, @actor, @device, @ce, @reason)
                """, new { id = "att_" + Ulid.NewUlid(), h = r.HospitalId, b = r.BookingId, type = r.Type, source = r.Source,
                    at = r.At.UtcDateTime, actor = r.ActorId, device = r.DeviceId, ce = r.ClientEventId, reason = r.Reason }, t);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            // The same client event arrived twice at the same moment.
            await c.ExecuteAsync("ROLLBACK TO SAVEPOINT att", transaction: t);
            return new RecordResult("duplicate", null, await CurrentAsync(c, t, r.BookingId), b.Ref);
        }
        // Corrections also go to the audit log (who, when, what); the reason itself stays with the event.
        if (r.Source == "correction")
            await MedLink.Api.Audit.AuditLog.WriteAsync(c, t, r.ActorId, r.HospitalId, "attendance_correct", r.BookingId, new { type = r.Type });
        var state = await RecomputeAsync(c, t, r.BookingId);
        return new RecordResult("applied", null, state, b.Ref);
    }

    /// <summary>Re-derives the booking's status from all of its events and stores it (bumping the sync sequence if it changed).</summary>
    public static async Task<AttendanceState> RecomputeAsync(NpgsqlConnection c, NpgsqlTransaction t, string bookingId)
    {
        var events = (await c.QueryAsync<(string Type, string Source, DateTime At, DateTime ReceivedAt)>(
            "SELECT type, source, at, received_at FROM attendance_events WHERE booking_id = @bookingId", new { bookingId }, t))
            .Select(e => new AttendanceEvent(e.Type, e.Source, Utc(e.At), Utc(e.ReceivedAt))).ToList();
        var s = AttendancePolicy.Derive(events);
        await c.ExecuteAsync("""
            UPDATE bookings SET status = @status, arrived_at = @arrived, needs_review = @review
            WHERE id = @bookingId AND status <> 'cancelled'
              AND (status IS DISTINCT FROM @status OR arrived_at IS DISTINCT FROM @arrived::timestamptz OR needs_review IS DISTINCT FROM @review)
            """, new { bookingId, status = s.Status, arrived = s.ArrivedAt?.UtcDateTime, review = s.NeedsReview }, t);
        return s;
    }

    private static async Task<AttendanceState?> CurrentAsync(NpgsqlConnection c, NpgsqlTransaction t, string bookingId)
    {
        var row = await c.QuerySingleOrDefaultAsync<(string Status, DateTime? ArrivedAt, bool NeedsReview)?>(
            "SELECT status, arrived_at, needs_review FROM bookings WHERE id = @bookingId", new { bookingId }, t);
        return row is { } x ? new AttendanceState(x.Status, x.ArrivedAt is { } a ? Utc(a) : null, x.NeedsReview) : null;
    }

    private static DateTimeOffset Utc(DateTime d) => new(DateTime.SpecifyKind(d, DateTimeKind.Utc));
}
