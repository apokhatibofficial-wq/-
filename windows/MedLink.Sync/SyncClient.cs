using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MedLink.Sync;

public enum CheckInResult { PendingSync, NotInLocalCopy, Cancelled, AlreadyArrived, NotToday }

public enum CorrectionResult { PendingSync, NotInLocalCopy, Cancelled, ReasonRequired, TypeInvalid }

public sealed record PushSummary(int Sent, int Applied, int Duplicate, int Rejected, bool Offline);

/// <summary>Thrown when the server no longer accepts this device or session; the app must sign in or re-register.</summary>
public sealed class SyncRefusedException(HttpStatusCode status, string? code) : Exception($"Sync refused: {(int)status} {code}")
{
    public HttpStatusCode Status { get; } = status;
    public string? Code { get; } = code;
}

/// <summary>
/// Talks to the MEDLINK server for the Windows app. The <see cref="HttpClient"/> carries the signed-in user's bearer
/// token; what the user may do is always decided by the server. Pulls booking changes after the stored cursor and
/// pushes the local outbox; network failures leave events queued with exponential backoff.
/// </summary>
public sealed class SyncClient(HttpClient http, LocalStore store, TimeProvider clock)
{
    public const int PushBatch = 200;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public string? DeviceId => store.Get("device_id") is { Length: > 0 } d ? d : null;

    /// <summary>Bookings the last pull turned into "arrived" by the phone QR scanner (for the live notice).</summary>
    public IReadOnlyList<LocalBooking> LastLiveCheckIns { get; private set; } = [];

    /// <summary>Check-ins the last push sent where the server kept an earlier arrival time (approved policy): ref and the time kept.</summary>
    public IReadOnlyList<(string Ref, DateTimeOffset KeptAt)> LastConflicts { get; private set; } = [];

    /// <summary>The PC already has a device id (shared by every user of this PC): use it instead of registering again.</summary>
    public void UseDevice(string deviceId) => store.Set("device_id", deviceId);

    /// <summary>Forget the device id, e.g. after the hospital admin revoked it; the next sign-in registers again.</summary>
    public void ForgetDevice() => store.Set("device_id", "");

    public async Task<string> RegisterAsync(string deviceName, CancellationToken ct = default)
    {
        if (DeviceId is { } existing) return existing;
        var r = await http.PostAsJsonAsync("/sync/devices", new { name = deviceName }, Json, ct);
        await EnsureAsync(r, ct);
        var id = (await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct)).GetProperty("deviceId").GetString()!;
        store.Set("device_id", id);
        return id;
    }

    private static async Task EnsureAsync(HttpResponseMessage r, CancellationToken ct)
    {
        if (r.IsSuccessStatusCode) return;
        string? code = null;
        try { code = (await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct)).GetProperty("error").GetString(); } catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException) { }
        throw new SyncRefusedException(r.StatusCode, code);
    }

    /// <summary>Pulls every change after the stored cursor (following hasMore), then prunes the cache window.</summary>
    public async Task<int> PullAsync(int waitSeconds = 0, CancellationToken ct = default)
    {
        var device = DeviceId ?? throw new InvalidOperationException("Device not registered.");
        var total = 0;
        var live = new List<LocalBooking>();
        while (true)
        {
            var r = await http.GetAsync($"/sync/pull?deviceId={Uri.EscapeDataString(device)}&since={store.Cursor}&wait={waitSeconds}", ct);
            await EnsureAsync(r, ct);
            var body = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            var hosp = body.GetProperty("hospital");
            store.Set("timezone", hosp.GetProperty("timezone").GetString()!);
            store.Set("no_show_grace_min", hosp.GetProperty("noShowGraceMin").GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture));
            var hn = hosp.GetProperty("name");
            store.Set("hospital_name_ar", Str(hn, "ar") ?? "");
            store.Set("hospital_name_en", Str(hn, "en") ?? Str(hn, "ar") ?? "");
            store.Set("hospital_name_tr", Str(hn, "tr") ?? Str(hn, "en") ?? Str(hn, "ar") ?? "");
            foreach (var d in body.GetProperty("departments").EnumerateArray())
            {
                var n = d.GetProperty("name");
                store.UpsertDepartment(d.GetProperty("id").GetString()!, n.GetProperty("ar").GetString()!, Str(n, "en"), Str(n, "tr"), d.GetProperty("active").GetBoolean());
            }
            foreach (var b in body.GetProperty("bookings").EnumerateArray())
            {
                var before = store.ById(b.GetProperty("id").GetString()!);
                store.UpsertBooking(new LocalBooking(b.GetProperty("id").GetString()!, b.GetProperty("ref").GetString()!, b.GetProperty("departmentId").GetString()!,
                    b.GetProperty("slotStart").GetDateTimeOffset(), b.GetProperty("localDate").GetString()!, b.GetProperty("localTime").GetString()!,
                    Str(b, "patientName"), Str(b, "phone"), b.GetProperty("status").GetString()!,
                    b.GetProperty("arrivedAt").ValueKind == JsonValueKind.Null ? null : b.GetProperty("arrivedAt").GetDateTimeOffset(),
                    b.GetProperty("needsReview").GetBoolean(), false,
                    b.TryGetProperty("events", out var evs) ? evs.EnumerateArray().Select(e => new LocalEvent(e.GetProperty("type").GetString()!,
                        e.GetProperty("source").GetString()!, e.GetProperty("at").GetDateTimeOffset(), Str(e, "reason"))).ToList() : null,
                    b.TryGetProperty("bookedAt", out var ba) && ba.ValueKind == JsonValueKind.String ? ba.GetDateTimeOffset() : null),
                    b.GetProperty("seq").GetInt64());
                total++;
                if (before is { Status: not "arrived" } && store.ById(before.Id) is { Status: "arrived" } after && after.StatusSource == "qr") live.Add(after);
            }
            store.Cursor = body.GetProperty("cursor").GetInt64();
            store.Set("last_pull_at", clock.GetUtcNow().ToString("O"));
            if (!body.GetProperty("hasMore").GetBoolean()) break;
            waitSeconds = 0;
        }
        var (from, to) = Window();
        store.Prune(from, to);
        LastLiveCheckIns = live;
        return total;
    }

    private static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>The local cache window: from the start of yesterday to +31 days, in hospital time.</summary>
    public (DateTimeOffset From, DateTimeOffset To) Window()
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(store.Get("timezone") ?? "Asia/Damascus");
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz).DateTime);
        DateTimeOffset At(DateOnly d) => new(TimeZoneInfo.ConvertTimeToUtc(d.ToDateTime(TimeOnly.MinValue), tz), TimeSpan.Zero);
        return (At(today.AddDays(-1)), At(today.AddDays(31)));
    }

    /// <summary>
    /// Offline check-in by booking number (owner's decision). It is stored locally as "pending sync" and sent on the next
    /// push; the server re-checks everything (permission, day, cancellation) and may still reject it.
    /// </summary>
    public CheckInResult CheckInByRef(string reference)
    {
        var b = store.ByRef(reference.Trim().ToUpperInvariant());
        if (b is null) return CheckInResult.NotInLocalCopy;
        if (b.Status == "cancelled") return CheckInResult.Cancelled;
        if (b.Status == "arrived") return CheckInResult.AlreadyArrived;
        if (b.LocalDate != Today()) return CheckInResult.NotToday;
        store.Enqueue(Guid.NewGuid(), b.Id, b.Ref, "arrived", "reception", clock.GetUtcNow(), null);
        return CheckInResult.PendingSync;
    }

    /// <summary>Today's date in the hospital's time zone (yyyy-MM-dd).</summary>
    public string Today()
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(store.Get("timezone") ?? "Asia/Damascus");
        return TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Minimum length of a correction reason (the server enforces the same rule).</summary>
    public const int MinReason = 5;

    /// <summary>A status correction with a reason, queued like a check-in (works offline; the server re-checks the permission).</summary>
    public CorrectionResult Correct(string bookingId, string type, string reason)
    {
        if (type is not ("arrived" or "no_show" or "waiting")) return CorrectionResult.TypeInvalid;
        var text = reason.Trim();
        if (text.Length < MinReason || text.Length > 300) return CorrectionResult.ReasonRequired;
        var b = store.ById(bookingId);
        if (b is null) return CorrectionResult.NotInLocalCopy;
        if (b.Status == "cancelled") return CorrectionResult.Cancelled;
        store.Enqueue(Guid.NewGuid(), b.Id, b.Ref, type, "correction", clock.GetUtcNow(), text);
        return CorrectionResult.PendingSync;
    }

    /// <summary>Sends due outbox events. Returns Offline=true (and backs off) if the server could not be reached.</summary>
    public async Task<PushSummary> PushAsync(CancellationToken ct = default)
    {
        var device = DeviceId ?? throw new InvalidOperationException("Device not registered.");
        int sent = 0, applied = 0, dup = 0, rejected = 0;
        var conflicts = new List<(string, DateTimeOffset)>();
        while (true)
        {
            var due = store.DueEvents(clock.GetUtcNow(), PushBatch);
            if (due.Count == 0) break;
            HttpResponseMessage r;
            try
            {
                r = await http.PostAsJsonAsync("/sync/push", new
                {
                    deviceId = device,
                    events = due.Select(e => new { clientEventId = e.ClientEventId, bookingId = e.BookingId, @ref = e.Ref, type = e.Type, source = e.Source, at = e.At, reason = e.Reason }),
                }, Json, ct);
            }
            catch (HttpRequestException)
            {
                store.Backoff(due.Select(e => e.ClientEventId), clock.GetUtcNow());
                return new PushSummary(sent, applied, dup, rejected, true);
            }
            if ((int)r.StatusCode >= 500)
            {
                store.Backoff(due.Select(e => e.ClientEventId), clock.GetUtcNow());
                return new PushSummary(sent, applied, dup, rejected, true);
            }
            await EnsureAsync(r, ct);
            var body = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            foreach (var res in body.GetProperty("results").EnumerateArray())
            {
                var id = res.GetProperty("clientEventId").GetGuid();
                var outcome = res.GetProperty("outcome").GetString()!;
                var mine = due.FirstOrDefault(e => e.ClientEventId == id);
                if (outcome == "applied" && mine is { Type: "arrived", Source: "reception" } && res.TryGetProperty("arrivedAt", out var kept)
                    && kept.ValueKind == JsonValueKind.String && kept.GetDateTimeOffset() < mine.At.AddSeconds(-1))
                    conflicts.Add((Str(res, "ref") ?? mine.Ref ?? "", kept.GetDateTimeOffset()));
                store.Resolve(id, outcome, Str(res, "code"));
                sent++;
                if (outcome == "applied") applied++; else if (outcome == "duplicate") dup++; else rejected++;
            }
        }
        if (sent > 0) store.Set("last_push_at", clock.GetUtcNow().ToString("O"));
        LastConflicts = conflicts;
        return new PushSummary(sent, applied, dup, rejected, false);
    }

    /// <summary>One sync round: push first (so the pull brings back the server's verdict), then pull.</summary>
    public async Task<(PushSummary Push, int Pulled)> SyncAsync(CancellationToken ct = default)
    {
        var push = await PushAsync(ct);
        if (push.Offline) return (push, 0);
        try { return (push, await PullAsync(0, ct)); }
        catch (HttpRequestException) { return (push with { Offline = true }, 0); }
    }
}
