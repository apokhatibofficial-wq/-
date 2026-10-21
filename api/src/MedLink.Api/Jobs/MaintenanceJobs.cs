using Dapper;
using MedLink.Api.Attendance;
using MedLink.Api.Audit;
using MedLink.Api.Bookings;
using MedLink.Api.Config;
using MedLink.Api.Data;
using Npgsql;

namespace MedLink.Api.Jobs;

/// <summary>
/// The server's background jobs (BACKEND-SPEC §2): automatic no-show every minute, cleanup of expired links and old
/// sessions every hour, and the nightly retention purge. Each job takes a transaction-level advisory lock, so several
/// API instances never run the same job at once. The Windows app never marks no-shows itself.
/// </summary>
public static class MaintenanceJobs
{
    private const long LockBase = 7240300;
    public const int Batch = 500;
    /// <summary>Bookings older than this are not marked any more (e.g. after a long outage): the day is long over.</summary>
    public static readonly TimeSpan NoShowLookBack = TimeSpan.FromDays(6);

    private sealed class Due
    {
        public string Id { get; set; } = "";
        public string HospitalId { get; set; } = "";
        public DateTime DueAt { get; set; }
    }

    /// <summary>
    /// Waiting bookings whose slot + the hospital's grace has passed become no-show, with an "auto" event at that time.
    /// Skipped: bookings with any correction (a person decided) and bookings already marked. Returns how many were marked.
    /// </summary>
    public static Task<int> NoShowAsync(Db db, DateTimeOffset now) =>
        db.RunAsync(DbScope.System, async (c, t) =>
        {
            if (!await c.ExecuteScalarAsync<bool>("SELECT pg_try_advisory_xact_lock(@k)", new { k = LockBase + 1 }, t)) return 0;
            var due = (await c.QueryAsync<Due>("""
                SELECT b.id, b.hospital_id, b.slot_start + make_interval(mins => h.no_show_grace_min) AS due_at
                FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
                WHERE b.status = 'waiting' AND b.anonymized_at IS NULL
                  AND b.slot_start + make_interval(mins => h.no_show_grace_min) < @now
                  AND b.slot_start > @from
                  AND NOT EXISTS (SELECT 1 FROM attendance_events e WHERE e.booking_id = b.id AND e.source IN ('auto', 'correction'))
                ORDER BY b.slot_start
                LIMIT @batch
                """, new { now = now.UtcDateTime, from = (now - NoShowLookBack).UtcDateTime, batch = Batch }, t)).ToList();
            var marked = 0;
            foreach (var b in due)
            {
                var r = await AttendanceService.RecordAsync(c, t, new RecordRequest(b.HospitalId, b.Id, "no_show", "auto",
                    new DateTimeOffset(DateTime.SpecifyKind(b.DueAt, DateTimeKind.Utc)), null, null, null, null), now);
                if (r.Outcome == "applied") marked++;
            }
            await RecordRunAsync(c, t, "no_show", now, marked);
            return marked;
        });

    /// <summary>Deletes one-time links used or expired more than 7 days ago, and sessions ended more than 30 days ago.</summary>
    public static Task<int> CleanupAsync(Db db, DateTimeOffset now) =>
        db.RunAsync(DbScope.System, async (c, t) =>
        {
            if (!await c.ExecuteScalarAsync<bool>("SELECT pg_try_advisory_xact_lock(@k)", new { k = LockBase + 2 }, t)) return 0;
            var links = await c.ExecuteAsync("""
                DELETE FROM one_time_links WHERE greatest(coalesce(used_at, expires_at), expires_at) < @cutoff
                """, new { cutoff = (now - TimeSpan.FromDays(7)).UtcDateTime }, t);
            var sessions = await c.ExecuteAsync("""
                DELETE FROM sessions WHERE least(coalesce(revoked_at, absolute_expires_at), absolute_expires_at, expires_at) < @cutoff
                """, new { cutoff = (now - TimeSpan.FromDays(30)).UtcDateTime }, t);
            await RecordRunAsync(c, t, "cleanup", now, links + sessions);
            return links + sessions;
        });

    /// <summary>
    /// Bookings older than their hospital's retention period (default 24 months) are anonymised: name, phone, cancel
    /// reason and form answers are removed, correction reasons are cleared; status and times stay for the reports.
    /// </summary>
    public static Task<int> RetentionAsync(Db db, DateTimeOffset now) =>
        db.RunAsync(DbScope.System, async (c, t) =>
        {
            if (!await c.ExecuteScalarAsync<bool>("SELECT pg_try_advisory_xact_lock(@k)", new { k = LockBase + 3 }, t)) return 0;
            var total = 0;
            while (true)
            {
                var ids = (await c.QueryAsync<string>("""
                    SELECT b.id FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
                    WHERE b.anonymized_at IS NULL AND b.slot_start < @now - make_interval(months => h.retention_months)
                    ORDER BY b.slot_start LIMIT @batch
                    """, new { now = now.UtcDateTime, batch = Batch }, t)).ToArray();
                if (ids.Length == 0) break;
                await c.ExecuteAsync("DELETE FROM booking_answers WHERE booking_id = ANY(@ids)", new { ids }, t);
                await c.ExecuteAsync("""
                    UPDATE attendance_events SET reason = NULL, redacted_at = @now
                    WHERE booking_id = ANY(@ids) AND reason IS NOT NULL AND redacted_at IS NULL
                    """, new { ids, now = now.UtcDateTime }, t);
                await c.ExecuteAsync("""
                    UPDATE bookings SET patient_name = NULL, phone = NULL, cancel_reason = NULL, anonymized_at = @now WHERE id = ANY(@ids)
                    """, new { ids, now = now.UtcDateTime }, t);
                total += ids.Length;
            }
            if (total > 0) await AuditLog.WriteAsync(c, t, null, null, "retention_purge", "bookings", new { count = total });
            await RecordRunAsync(c, t, "retention", now, total);
            return total;
        });

    private static Task RecordRunAsync(NpgsqlConnection c, NpgsqlTransaction t, string job, DateTimeOffset now, int count) =>
        c.ExecuteAsync("""
            INSERT INTO job_runs (job, last_run_at, last_count) VALUES (@job, @now, @count)
            ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at, last_count = excluded.last_count
            """, new { job, now = now.UtcDateTime, count }, t);

    /// <summary>The retention purge runs once a day, after 03:00 in Syria (quiet hours), or at the first tick after that if the server was down.</summary>
    public static async Task<bool> RetentionDueAsync(Db db, DateTimeOffset now)
    {
        var last = await db.RunAsync(DbScope.System, (c, t) =>
            c.ExecuteScalarAsync<DateTime?>("SELECT last_run_at FROM job_runs WHERE job = 'retention'", transaction: t));
        var tz = BookingService.Zone("Asia/Damascus");
        var local = TimeZoneInfo.ConvertTime(now, tz);
        var todayAt3 = new DateTimeOffset(local.Date.AddHours(3), local.Offset);
        if (local < todayAt3) return false;
        return last is null || new DateTimeOffset(DateTime.SpecifyKind(last.Value, DateTimeKind.Utc)) < todayAt3;
    }
}

/// <summary>Runs the jobs: no-show every minute, cleanup every hour, retention nightly. Disabled with JOBS_ENABLED=false.</summary>
public sealed class MaintenanceService(Db db, TimeProvider clock, MedLinkOptions options, ILogger<MaintenanceService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!options.JobsEnabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1), clock);
        var lastCleanup = DateTimeOffset.MinValue;
        do
        {
            var now = clock.GetUtcNow();
            await RunAsync("no_show", () => MaintenanceJobs.NoShowAsync(db, now));
            if (now - lastCleanup >= TimeSpan.FromHours(1))
            {
                await RunAsync("cleanup", () => MaintenanceJobs.CleanupAsync(db, now));
                lastCleanup = now;
            }
            if (await Safe(() => MaintenanceJobs.RetentionDueAsync(db, now)))
                await RunAsync("retention", () => MaintenanceJobs.RetentionAsync(db, now));
        }
        while (await timer.WaitForNextTickAsync(stop).ConfigureAwait(false));
    }

    private async Task RunAsync(string job, Func<Task<int>> run)
    {
        try
        {
            var n = await run();
            if (n > 0) log.LogInformation("job {Job}: {Count}", job, n);
        }
        // A failed run is retried at the next tick; the counts only (no personal data) are logged.
        catch (Exception e) when (e is NpgsqlException or TimeoutException or InvalidOperationException)
        {
            log.LogError("job {Job} failed: {Error}", job, e.GetType().Name);
        }
    }

    private async Task<bool> Safe(Func<Task<bool>> check)
    {
        try { return await check(); }
        catch (Exception e) when (e is NpgsqlException or TimeoutException) { log.LogError("job check failed: {Error}", e.GetType().Name); return false; }
    }
}
