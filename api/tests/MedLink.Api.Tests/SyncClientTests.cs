using System.Net;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using MedLink.Sync;
using Microsoft.Data.Sqlite;

namespace MedLink.Api.Tests;

/// <summary>Test stand-in for DPAPI (which exists only on Windows): XOR with a per-test pad.</summary>
internal sealed class TestKeyProtector : IKeyProtector
{
    private readonly byte[] _pad = RandomNumberGenerator.GetBytes(64);
    public byte[] Protect(byte[] plain) => plain.Select((b, i) => (byte)(b ^ _pad[i % _pad.Length])).ToArray();
    public byte[] Unprotect(byte[] p) => Protect(p);
}

/// <summary>Lets a test cut the network, or let a request reach the server but lose the response.</summary>
internal sealed class Network(HttpMessageHandler inner) : DelegatingHandler(inner)
{
    public bool Offline { get; set; }
    public bool LoseNextResponse { get; set; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (Offline) throw new HttpRequestException("offline (test)");
        var r = await base.SendAsync(request, ct);
        if (LoseNextResponse) { LoseNextResponse = false; r.Dispose(); throw new HttpRequestException("connection reset (test)"); }
        return r;
    }
}

internal sealed class ShiftedClock : TimeProvider
{
    public TimeSpan Offset { get; set; }
    public override DateTimeOffset GetUtcNow() => base.GetUtcNow() + Offset;
}

[Collection("medlink")]
public sealed class SyncClientTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    private readonly string dir = Directory.CreateTempSubdirectory("medlink-sync-").FullName;
    public void Dispose() { api.Dispose(); SqliteConnection.ClearAllPools(); Directory.Delete(dir, true); }

    private async Task<(string Id, string Ref)> TodayBookingAsync(BookingHospital h, int minutes, string name = "مريض اختبار")
    {
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var r = await BookingSetup.BookAsync(api, h, slot, name: name, phone: "+963944000222");
        var reference = r.Body.GetProperty("ref").GetString()!;
        await using var db = await fx.OwnerAsync();
        await db.ExecuteAsync("""
            UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(mins => @minutes)) AT TIME ZONE h.timezone
            FROM hospitals h WHERE h.id = b.hospital_id AND b.ref = @reference
            """, new { reference, minutes });
        return ((await db.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @reference", new { reference }))!, reference);
    }

    /// <summary>A reception user signed in the way the Windows app signs in (bearer token), behind a switchable network.</summary>
    private async Task<(HttpClient Http, Network Net)> WindowsClientAsync(BookingHospital h)
    {
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        await api.AllowNextTotpAsync(rec.Email);
        var login = await api.Anonymous().Post("/auth/login", new { email = rec.Email, password = rec.Password, client = "windows" }, csrf: false);
        var token = login.Body.GetProperty("token").GetString()!;
        fx.Secrets.Add(token);
        var net = new Network(api.Factory.Server.CreateHandler());
        var http = new HttpClient(net) { BaseAddress = api.Factory.Server.BaseAddress };
        http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return (http, net);
    }

    [Fact(DisplayName = "Windows sync: the local database is encrypted; the wrong key cannot open it; no plaintext in the file")]
    public void LocalDatabaseEncrypted()
    {
        var path = Path.Combine(dir, "local.db");
        var protector = new TestKeyProtector();
        const string name = "اسم تجريبي للتشفير", phone = "+963900111222";
        using (var s = LocalStore.Open(path, protector))
        {
            s.UpsertBooking(new LocalBooking("bkg_1", "ML-ABCDEF", "dep_1", DateTimeOffset.UtcNow, "2026-10-20", "10:00", name, phone, "waiting", null, false, false), 1);
            s.Enqueue(Guid.NewGuid(), "bkg_1", "ML-ABCDEF", "arrived", "reception", DateTimeOffset.UtcNow, null);
        }
        SqliteConnection.ClearAllPools();
        var bytes = File.ReadAllBytes(path).Concat(File.Exists(path + "-wal") ? File.ReadAllBytes(path + "-wal") : []).ToArray();
        var text = Encoding.Latin1.GetString(bytes);
        Assert.DoesNotContain("SQLite format 3", text);
        Assert.DoesNotContain(Encoding.Latin1.GetString(Encoding.UTF8.GetBytes(name)), text);
        Assert.DoesNotContain(phone, text);
        Assert.DoesNotContain("ML-ABCDEF", text);
        // The key file is protected, not the raw key.
        Assert.Equal(32, File.ReadAllBytes(path + ".key").Length);

        Assert.ThrowsAny<SqliteException>(() => LocalStore.OpenWithKey(path, RandomNumberGenerator.GetBytes(32)).Dispose());
        Assert.ThrowsAny<Exception>(() => LocalStore.Open(path, new TestKeyProtector()).Dispose());
        using var again = LocalStore.Open(path, protector);
        Assert.Equal(name, again.ByRef("ML-ABCDEF")!.PatientName);
        Assert.True(again.ByRef("ML-ABCDEF")!.PendingSync);
    }

    [Fact(DisplayName = "Windows sync: offline check-in is kept as pending, backs off, then syncs once the network returns")]
    public async Task OfflineCheckIn()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (bid, reference) = await TodayBookingAsync(h, 300);
        var (http, net) = await WindowsClientAsync(h);
        var clock = new ShiftedClock();
        using var store = LocalStore.Open(Path.Combine(dir, "a.db"), new TestKeyProtector());
        var sync = new SyncClient(http, store, clock);
        await sync.RegisterAsync("Reception PC");
        Assert.Equal(1, await sync.PullAsync());
        var local = store.ByRef(reference)!;
        Assert.Equal(("waiting", "+963944000222"), (local.Status, local.Phone));

        net.Offline = true;
        Assert.Equal(CheckInResult.NotInLocalCopy, sync.CheckInByRef("ML-ZZZZZZ"));
        Assert.Equal(CheckInResult.PendingSync, sync.CheckInByRef(reference.ToLowerInvariant()));
        Assert.Equal(CheckInResult.AlreadyArrived, sync.CheckInByRef(reference));
        var shown = Assert.Single(store.Day(local.LocalDate));
        Assert.Equal(("arrived", true), (shown.Status, shown.PendingSync));
        var r1 = await sync.SyncAsync();
        Assert.True(r1.Push.Offline);
        // Backoff: right after a failure nothing is due.
        net.Offline = false;
        Assert.Equal(0, (await sync.PushAsync()).Sent);
        await using (var db = await fx.OwnerAsync())
            Assert.Equal("waiting", await db.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE id = @bid", new { bid }));

        clock.Offset = TimeSpan.FromSeconds(10);
        var r2 = await sync.SyncAsync();
        Assert.Equal((1, 1, false), (r2.Push.Sent, r2.Push.Applied, r2.Push.Offline));
        Assert.Equal(0, store.PendingCount());
        var synced = store.ByRef(reference)!;
        Assert.Equal(("arrived", false), (synced.Status, synced.PendingSync));
        Assert.NotNull(synced.ArrivedAt);
        await using (var db = await fx.OwnerAsync())
        {
            var row = await db.QuerySingleAsync<(string Status, string? DeviceId)>(
                "SELECT b.status, e.device_id FROM bookings b JOIN attendance_events e ON e.booking_id = b.id WHERE b.id = @bid", new { bid });
            Assert.Equal(("arrived", sync.DeviceId), (row.Status, row.DeviceId));
        }
    }

    [Fact(DisplayName = "Windows sync: a lost response is retried and applied once; a check-in the server rejects is reported, not kept")]
    public async Task LostResponseAndRejection()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (bid, reference) = await TodayBookingAsync(h, 400);
        var (cancelledId, cancelledRef) = await TodayBookingAsync(h, 430);
        var (http, net) = await WindowsClientAsync(h);
        var clock = new ShiftedClock();
        using var store = LocalStore.Open(Path.Combine(dir, "b.db"), new TestKeyProtector());
        var sync = new SyncClient(http, store, clock);
        await sync.RegisterAsync("Reception PC 2");
        await sync.PullAsync();

        Assert.Equal(CheckInResult.PendingSync, sync.CheckInByRef(reference));
        net.LoseNextResponse = true;
        Assert.True((await sync.PushAsync()).Offline);
        clock.Offset = TimeSpan.FromSeconds(10);
        var retry = await sync.PushAsync();
        Assert.Equal((1, 0, 1), (retry.Sent, retry.Applied, retry.Duplicate));
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE booking_id = @bid", new { bid }));

        // Cancelled on the server while this PC was offline: the server rejects the check-in, and the next pull shows the truth.
        net.Offline = true;
        Assert.Equal(CheckInResult.PendingSync, sync.CheckInByRef(cancelledRef));
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Post($"/hospital/bookings/{cancelledId}/cancel", new { reason = "طلب المريض" })).Status);
        net.Offline = false;
        clock.Offset = TimeSpan.FromSeconds(20);
        var r = await sync.SyncAsync();
        Assert.Equal(1, r.Push.Rejected);
        Assert.Equal((cancelledRef, "CANCELLED"), (Assert.Single(store.Rejected()).Ref, store.Rejected()[0].Code));
        var shown = store.ByRef(cancelledRef)!;
        Assert.Equal(("cancelled", false), (shown.Status, shown.PendingSync));
    }

    [Fact(DisplayName = "Windows sync: the local copy keeps only yesterday to +30 days")]
    public async Task CacheWindow()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        await TodayBookingAsync(h, 500);
        var (http, _) = await WindowsClientAsync(h);
        using var store = LocalStore.Open(Path.Combine(dir, "c.db"), new TestKeyProtector());
        var sync = new SyncClient(http, store, TimeProvider.System);
        await sync.RegisterAsync("PC");
        var old = DateTimeOffset.UtcNow.AddDays(-3);
        store.UpsertBooking(new LocalBooking("bkg_old", "ML-OLDOLD", "dep", old, "x", "x", "قديم", null, "arrived", old, false, false), 1);
        store.UpsertBooking(new LocalBooking("bkg_far", "ML-FARFAR", "dep", DateTimeOffset.UtcNow.AddDays(40), "x", "x", "بعيد", null, "waiting", null, false, false), 1);
        Assert.Equal(2, store.BookingCount());
        await sync.PullAsync();
        Assert.Null(store.ByRef("ML-OLDOLD"));
        Assert.Null(store.ByRef("ML-FARFAR"));
        Assert.Equal(1, store.BookingCount());
    }
}
