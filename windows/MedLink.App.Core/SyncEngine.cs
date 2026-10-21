using System.Net;
using MedLink.Sync;

namespace MedLink.App;

public enum Connection { Online, Offline, Syncing }

/// <summary>
/// Keeps the local copy current while a user is signed in: push the outbox, then long-poll the server (25 s) so a QR
/// check-in from a phone appears without a refresh. <see cref="Nudge"/> ends the wait at once after a local change.
/// Network errors switch to Offline and retry; the outbox keeps every event until the server answers.
/// </summary>
public sealed class SyncEngine(SyncClient sync, LocalStore store, TimeProvider clock) : IAsyncDisposable
{
    public int LongPollSeconds { get; init; } = 25;
    public TimeSpan RetryDelay { get; init; } = TimeSpan.FromSeconds(5);

    public Connection State { get; private set; } = Connection.Syncing;
    public DateTimeOffset? LastSyncAt { get; private set; }

    /// <summary>Raised (on the sync thread) after every round or state change.</summary>
    public event Action? Changed;
    /// <summary>n updates sent after being offline.</summary>
    public event Action<int>? SyncedAfterOffline;
    public event Action<IReadOnlyList<LocalBooking>>? LiveCheckIns;
    public event Action<IReadOnlyList<(string Ref, DateTimeOffset KeptAt)>>? Conflicts;
    /// <summary>The server refused the session (401) or the device (403 DEVICE_REVOKED). Sync stops.</summary>
    public event Action<SyncRefusedException>? Refused;

    private CancellationTokenSource? _stop, _wait;
    private Task? _loop;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _round = new(1, 1);

    public void Start()
    {
        _stop = new CancellationTokenSource();
        _loop = Task.Run(() => LoopAsync(_stop.Token));
    }

    /// <summary>Something changed locally (check-in, correction): push now instead of waiting for the long-poll.</summary>
    public void Nudge()
    {
        lock (_gate) _wait?.Cancel();
    }

    /// <summary>One push + pull right now (the "Sync now" button and tests).</summary>
    public async Task<bool> RoundAsync(int waitSeconds, CancellationToken ct)
    {
        await _round.WaitAsync(ct);
        try { return await RoundCoreAsync(waitSeconds, ct); }
        finally { _round.Release(); }
    }

    private async Task<bool> RoundCoreAsync(int waitSeconds, CancellationToken ct)
    {
        var wasOffline = State == Connection.Offline;
        SetState(Connection.Syncing);
        var push = await sync.PushAsync(ct);
        if (push.Offline) { SetState(Connection.Offline); return false; }
        if (sync.LastConflicts.Count > 0) Conflicts?.Invoke(sync.LastConflicts);
        if (wasOffline && push.Sent > 0) SyncedAfterOffline?.Invoke(push.Applied + push.Duplicate + push.Rejected);
        SetState(Connection.Online);
        LastSyncAt = clock.GetUtcNow();
        Changed?.Invoke();
        await sync.PullAsync(store.PendingCount() > 0 ? 0 : waitSeconds, ct);
        if (sync.LastLiveCheckIns.Count > 0) LiveCheckIns?.Invoke(sync.LastLiveCheckIns);
        LastSyncAt = clock.GetUtcNow();
        Changed?.Invoke();
        return true;
    }

    private async Task LoopAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            CancellationTokenSource wait;
            lock (_gate) { _wait = wait = CancellationTokenSource.CreateLinkedTokenSource(stop); }
            try
            {
                await RoundAsync(LongPollSeconds, wait.Token);
                if (State == Connection.Offline) await Task.Delay(RetryDelay, wait.Token);
            }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested)
            {
                // Nudged (or the HTTP timeout): go round again at once.
                if (!wait.IsCancellationRequested) SetState(Connection.Offline);
            }
            catch (OperationCanceledException) { break; }
            catch (HttpRequestException)
            {
                SetState(Connection.Offline);
                try { await Task.Delay(RetryDelay, stop); } catch (OperationCanceledException) { break; }
            }
            catch (SyncRefusedException e) when (e.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                SetState(Connection.Offline);
                Refused?.Invoke(e);
                break;
            }
            catch (SyncRefusedException)
            {
                // 4xx other than auth (should not happen) or 5xx: treat as a temporary outage.
                SetState(Connection.Offline);
                try { await Task.Delay(RetryDelay, stop); } catch (OperationCanceledException) { break; }
            }
            finally { wait.Dispose(); }
        }
    }

    private void SetState(Connection c)
    {
        if (State == c) return;
        State = c;
        Changed?.Invoke();
    }

    public async ValueTask DisposeAsync()
    {
        _stop?.Cancel();
        if (_loop is not null) { try { await _loop; } catch (OperationCanceledException) { } }
        _stop?.Dispose();
        _round.Dispose();
    }
}
