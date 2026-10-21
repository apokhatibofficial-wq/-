using Dapper;
using MedLink.Api.Attendance;
using MedLink.Api.Audit;
using MedLink.Api.Auth;
using MedLink.Api.Bookings;
using MedLink.Api.Data;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>
/// Windows-app sync (BACKEND-SPEC §5): devices pull booking changes after a sequence number and push
/// attendance events from a local outbox. Events carry a client_event_id, so a retried push never applies
/// twice. The local database is never trusted for permissions: every pushed event is re-checked here.
/// </summary>
public static class SyncEndpoints
{
    public const int MaxActiveDevices = 25, PullPageSize = 500, MaxPushEvents = 200;
    /// <summary>Corrections need a reason of at least 5 characters (SCREENS.md, Windows detail panel).</summary>
    public const int MinReason = 5;

    public sealed record RegisterRequest(string? Name);
    public sealed record PushEvent(Guid? ClientEventId, string? BookingId, string? Ref, string? Type, string? Source, DateTimeOffset? At, string? Reason);
    public sealed record PushRequest(string? DeviceId, PushEvent[]? Events);
    public sealed record AttendanceRequest(string? Type, string? Reason);

    private static IResult Error(string code, int status) => Results.Json(new { error = code }, statusCode: status);

    private sealed class SyncBooking
    {
        public string Id { get; set; } = "";
        public string Ref { get; set; } = "";
        public string DepartmentId { get; set; } = "";
        public DateTime SlotStart { get; set; }
        public string? PatientName { get; set; }
        public string? Phone { get; set; }
        public string Status { get; set; } = "";
        public DateTime? ArrivedAt { get; set; }
        public bool NeedsReview { get; set; }
        public long SyncSeq { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    private static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);

    /// <summary>The device must belong to the caller's hospital and not be revoked.</summary>
    private static Task<bool> DeviceOkAsync(NpgsqlConnection c, NpgsqlTransaction t, string? deviceId, string hospitalId) =>
        c.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM devices WHERE id = @deviceId AND hospital_id = @hospitalId AND revoked_at IS NULL)",
            new { deviceId, hospitalId }, t);

    public static void MapSync(this WebApplication app)
    {
        // ---------------------------------------------------------------- devices
        app.MapPost("/sync/devices", async (RegisterRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var name = req.Name?.Trim();
            if (string.IsNullOrEmpty(name) || name.Length > 80) return Error("NAME_REQUIRED", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                await c.ExecuteAsync("SELECT pg_advisory_xact_lock(7240200, hashtext(@h))", new { h = p.HospitalId }, t);
                var active = await c.ExecuteScalarAsync<int>("SELECT count(*) FROM devices WHERE hospital_id = @h AND revoked_at IS NULL", new { h = p.HospitalId }, t);
                if (active >= MaxActiveDevices) return Error("DEVICE_LIMIT", 409);
                var id = "dev_" + Ulid.NewUlid();
                await c.ExecuteAsync("INSERT INTO devices (id, hospital_id, name, registered_by) VALUES (@id, @h, @name, @by)",
                    new { id, h = p.HospitalId, name, by = p.UserId }, t);
                await AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "device_register", id);
                return Results.Json(new { deviceId = id }, statusCode: 201);
            });
        }).Require(Permission.HospitalRead).RequireJson();

        app.MapGet("/hospital/devices", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var rows = await db.RunAsync(p.DbScope, (c, t) => c.QueryAsync<(string Id, string Name, string RegisteredBy, DateTime CreatedAt, DateTime? LastSeenAt, DateTime? RevokedAt)>("""
                SELECT d.id, d.name, u.email::text, d.created_at, d.last_seen_at, d.revoked_at
                FROM devices d JOIN users u ON u.id = d.registered_by WHERE d.hospital_id = @h ORDER BY d.revoked_at NULLS FIRST, d.created_at
                """, new { h = p.HospitalId }, t));
            return Results.Json(new
            {
                devices = rows.Select(d => new
                {
                    id = d.Id, name = d.Name, registeredBy = d.RegisteredBy, createdAt = Utc(d.CreatedAt),
                    lastSeenAt = d.LastSeenAt is { } l ? Utc(l) : (DateTime?)null, revoked = d.RevokedAt is not null,
                }),
                maxActive = MaxActiveDevices,
            });
        }).Require(Permission.HospitalSettings);

        app.MapPost("/hospital/devices/{id}/revoke", async (string id, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var n = await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var n = await c.ExecuteAsync("UPDATE devices SET revoked_at = now() WHERE id = @id AND hospital_id = @h AND revoked_at IS NULL", new { id, h = p.HospitalId }, t);
                if (n > 0) await AuditLog.WriteAsync(c, t, p.UserId, p.HospitalId, "device_revoke", id);
                return n;
            });
            return n == 0 ? Error("NOT_FOUND", 404) : Results.Json(new { status = "ok" });
        }).Require(Permission.HospitalSettings).RequireJson();

        // ---------------------------------------------------------------- pull
        // Bookings from yesterday to +30 days (hospital time) that changed after `since`. With `wait`, the call
        // holds for up to 25 s until something changes (long-poll), so a QR check-in shows up without a refresh.
        app.MapGet("/sync/pull", async (string? deviceId, long? since, int? wait, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var canSeeAll = p.Has(Permission.BookingsView);
            if (!canSeeAll && !p.Has(Permission.BookingsViewOwnDepartment)) return Error("FORBIDDEN", 403);
            var after = Math.Max(0, since ?? 0);
            var deadline = clock.GetUtcNow().AddSeconds(Math.Clamp(wait ?? 0, 0, 25));
            while (true)
            {
                var result = await db.RunAsync(p.DbScope, async (c, t) =>
                {
                    if (!await DeviceOkAsync(c, t, deviceId, p.HospitalId!)) return (Done: true, Body: (IResult)Error("DEVICE_REVOKED", 403));
                    var h = await c.QuerySingleAsync<(string NameAr, string NameEn, string? NameTr, string Timezone, int Grace)>(
                        "SELECT name_ar, name_en, name_tr, timezone, no_show_grace_min FROM hospitals WHERE id = @h", new { h = p.HospitalId }, t);
                    var tz = BookingService.Zone(h.Timezone);
                    var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz).DateTime);
                    var from = TimeZoneInfo.ConvertTimeToUtc(today.AddDays(-1).ToDateTime(TimeOnly.MinValue), tz);
                    var to = TimeZoneInfo.ConvertTimeToUtc(today.AddDays(31).ToDateTime(TimeOnly.MinValue), tz);
                    var rows = (await c.QueryAsync<SyncBooking>($"""
                        SELECT b.id, b.ref, b.department_id, b.slot_start, b.patient_name, b.phone, b.status, b.arrived_at, b.needs_review, b.sync_seq, b.created_at
                        FROM bookings b
                        WHERE b.hospital_id = @h AND b.sync_seq > @after AND b.slot_start >= @from AND b.slot_start < @to
                        {(canSeeAll ? "" : "AND b.department_id IN (SELECT department_id FROM doctor_departments WHERE user_id = @user)")}
                        ORDER BY b.sync_seq LIMIT @limit
                        """, new { h = p.HospitalId, after, from, to, user = p.UserId, limit = PullPageSize + 1 }, t)).ToList();
                    var more = rows.Count > PullPageSize;
                    if (more) rows.RemoveAt(rows.Count - 1);
                    if (rows.Count == 0 && clock.GetUtcNow() < deadline) return (Done: false, Body: (IResult)Results.Empty);
                    var cursor = rows.Count > 0 ? rows[^1].SyncSeq : after;
                    await c.ExecuteAsync("UPDATE devices SET last_seen_at = now(), last_seq = greatest(last_seq, @cursor) WHERE id = @deviceId",
                        new { deviceId, cursor }, t);
                    // The attendance history of each booking, for the detail panel (also offline). Doctors get no reasons.
                    var ids = rows.Select(r => r.Id).ToArray();
                    var history = (await c.QueryAsync<(string BookingId, string Type, string Source, DateTime At, string? Reason)>(
                        "SELECT booking_id, type, source, at, reason FROM attendance_events WHERE booking_id = ANY(@ids) ORDER BY received_at",
                        new { ids }, t)).ToLookup(e => e.BookingId);
                    var deps = await c.QueryAsync<(string Id, string NameAr, string? NameEn, string? NameTr, bool Active)>(
                        "SELECT id, name_ar, name_en, name_tr, active FROM departments WHERE hospital_id = @h ORDER BY sort", new { h = p.HospitalId }, t);
                    return (Done: true, Body: Results.Json(new
                    {
                        cursor,
                        hasMore = more,
                        hospital = new { name = new { ar = h.NameAr, en = h.NameEn, tr = h.NameTr }, timezone = h.Timezone, noShowGraceMin = h.Grace },
                        departments = deps.Select(d => new { id = d.Id, name = new { ar = d.NameAr, en = d.NameEn, tr = d.NameTr }, active = d.Active }),
                        bookings = rows.Select(b =>
                        {
                            var local = TimeZoneInfo.ConvertTime(new DateTimeOffset(Utc(b.SlotStart)), tz);
                            return new
                            {
                                id = b.Id, @ref = b.Ref, departmentId = b.DepartmentId, slotStart = Utc(b.SlotStart),
                                localDate = local.ToString("yyyy-MM-dd"), localTime = local.ToString("HH:mm"),
                                patientName = b.PatientName,
                                // Doctors' PCs never receive phone numbers (owner's decision: least personal data).
                                phone = canSeeAll ? b.Phone : null,
                                status = b.Status, arrivedAt = b.ArrivedAt is { } a ? Utc(a) : (DateTime?)null,
                                needsReview = b.NeedsReview, seq = b.SyncSeq, bookedAt = Utc(b.CreatedAt),
                                events = history[b.Id].Select(e => new { type = e.Type, source = e.Source, at = Utc(e.At), reason = canSeeAll ? e.Reason : null }),
                            };
                        }),
                    }));
                });
                if (result.Done) return result.Body;
                await Task.Delay(1000, ctx.RequestAborted);
            }
        }).RequireSignedIn();

        // ---------------------------------------------------------------- push
        app.MapPost("/sync/push", async (PushRequest req, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var events = req.Events ?? [];
            if (events.Length > MaxPushEvents) return Error("TOO_MANY_EVENTS", 422);
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                if (!await DeviceOkAsync(c, t, req.DeviceId, p.HospitalId!)) return Error("DEVICE_REVOKED", 403);
                var results = new List<object>();
                foreach (var e in events)
                {
                    var r = await PushOneAsync(c, t, p, req.DeviceId!, e, clock.GetUtcNow());
                    results.Add(new
                    {
                        clientEventId = e.ClientEventId, outcome = r.Outcome, code = r.Code, @ref = r.Ref,
                        status = r.State?.Status, arrivedAt = r.State?.ArrivedAt, needsReview = r.State?.NeedsReview,
                    });
                }
                await c.ExecuteAsync("UPDATE devices SET last_seen_at = now() WHERE id = @d", new { d = req.DeviceId }, t);
                return Results.Json(new { results });
            });
        }).Require(Permission.HospitalRead).RequireJson(); // hospital accounts only; each event is then checked against the caller's permissions

        // ---------------------------------------------------------------- web: check in / correct
        app.MapPost("/hospital/bookings/{id}/attendance", async (string id, AttendanceRequest req, HttpContext ctx, Db db, TimeProvider clock) =>
        {
            var p = ctx.RequirePrincipal();
            var correction = req.Reason is not null;
            if (correction ? !p.Has(Permission.AttendanceCorrect) : !p.Has(Permission.CheckIn)) return Error("FORBIDDEN", 403);
            if (req.Type is not ("arrived" or "no_show" or "waiting") || (!correction && req.Type != "arrived")) return Error("TYPE_INVALID", 422);
            if (correction && req.Reason!.Trim().Length is < MinReason or > 300) return Error("REASON_REQUIRED", 422);
            var r = await db.RunAsync(p.DbScope, (c, t) => AttendanceService.RecordAsync(c, t, new RecordRequest(
                p.HospitalId!, id, req.Type!, correction ? "correction" : "reception", clock.GetUtcNow(), p.UserId, null, null, req.Reason?.Trim()), clock.GetUtcNow()));
            return r.Outcome == "rejected"
                ? Error(r.Code!, r.Code == "NOT_FOUND" ? 404 : 409)
                : Results.Json(new { status = r.State!.Status, arrivedAt = r.State.ArrivedAt, needsReview = r.State.NeedsReview });
        }).RequireSignedIn().RequireJson();
    }

    private static async Task<RecordResult> PushOneAsync(NpgsqlConnection c, NpgsqlTransaction t, Principal p, string deviceId, PushEvent e, DateTimeOffset now)
    {
        if (e.ClientEventId is null || e.At is null) return new RecordResult("rejected", "INVALID", null);
        var source = e.Source ?? "reception";
        if (source is not ("reception" or "correction")) return new RecordResult("rejected", "SOURCE_INVALID", null);
        // Permissions come from the server-side session, never from the device's local copy.
        if (source == "reception" && (e.Type != "arrived" || !p.Has(Permission.CheckIn))) return new RecordResult("rejected", "FORBIDDEN", null);
        if (source == "correction")
        {
            if (!p.Has(Permission.AttendanceCorrect)) return new RecordResult("rejected", "FORBIDDEN", null);
            if (e.Type is not ("arrived" or "no_show" or "waiting")) return new RecordResult("rejected", "TYPE_INVALID", null);
            if (e.Reason is null || e.Reason.Trim().Length is < MinReason or > 300) return new RecordResult("rejected", "REASON_REQUIRED", null);
        }
        // Offline check-in is by booking number only (owner's decision); the device may send the id when it has it.
        var bookingId = e.BookingId ?? (e.Ref is null ? null : await c.ExecuteScalarAsync<string?>(
            "SELECT id FROM bookings WHERE hospital_id = @h AND ref = @r", new { h = p.HospitalId, r = e.Ref.Trim().ToUpperInvariant() }, t));
        if (bookingId is null) return new RecordResult("rejected", "NOT_FOUND", null);
        return await AttendanceService.RecordAsync(c, t, new RecordRequest(p.HospitalId!, bookingId, e.Type!, source, e.At.Value,
            p.UserId, deviceId, e.ClientEventId, source == "correction" ? e.Reason!.Trim() : null), now);
    }
}
