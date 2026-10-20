using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MedLink.Sync;

public enum CheckInResult { PendingSync, NotInLocalCopy, Cancelled, AlreadyArrived }

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

    public string? DeviceId => store.Get("device_id");

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
        while (true)
        {
            var r = await http.GetAsync($"/sync/pull?deviceId={Uri.EscapeDataString(device)}&since={store.Cursor}&wait={waitSeconds}", ct);
            await EnsureAsync(r, ct);
            var body = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            store.Set("timezone", body.GetProperty("hospital").GetProperty("timezone").GetString()!);
            foreach (var d in body.GetProperty("departments").EnumerateArray())
            {
                var n = d.GetProperty("name");
                store.UpsertDepartment(d.GetProperty("id").GetString()!, n.GetProperty("ar").GetString()!, Str(n, "en"), Str(n, "tr"), d.GetProperty("active").GetBoolean());
            }
            foreach (var b in body.GetProperty("bookings").EnumerateArray())
            {
                store.UpsertBooking(new LocalBooking(b.GetProperty("id").GetString()!, b.GetProperty("ref").GetString()!, b.GetProperty("departmentId").GetString()!,
                    b.GetProperty("slotStart").GetDateTimeOffset(), b.GetProperty("localDate").GetString()!, b.GetProperty("localTime").GetString()!,
                    Str(b, "patientName"), Str(b, "phone"), b.GetProperty("status").GetString()!,
                    b.GetProperty("arrivedAt").ValueKind == JsonValueKind.Null ? null : b.GetProperty("arrivedAt").GetDateTimeOffset(),
                    b.GetProperty("needsReview").GetBoolean(), false), b.GetProperty("seq").GetInt64());
                total++;
            }
            store.Cursor = body.GetProperty("cursor").GetInt64();
            store.Set("last_pull_at", clock.GetUtcNow().ToString("O"));
            if (!body.GetProperty("hasMore").GetBoolean()) break;
            waitSeconds = 0;
        }
        var (from, to) = Window();
        store.Prune(from, to);
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
        store.Enqueue(Guid.NewGuid(), b.Id, b.Ref, "arrived", "reception", clock.GetUtcNow(), null);
        return CheckInResult.PendingSync;
    }

    /// <summary>Sends due outbox events. Returns Offline=true (and backs off) if the server could not be reached.</summary>
    public async Task<PushSummary> PushAsync(CancellationToken ct = default)
    {
        var device = DeviceId ?? throw new InvalidOperationException("Device not registered.");
        int sent = 0, applied = 0, dup = 0, rejected = 0;
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
                store.Resolve(id, outcome, Str(res, "code"));
                sent++;
                if (outcome == "applied") applied++; else if (outcome == "duplicate") dup++; else rejected++;
            }
        }
        if (sent > 0) store.Set("last_push_at", clock.GetUtcNow().ToString("O"));
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
