using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class SyncTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    /// <summary>Books a slot, then moves it to today (hospital time) at 00:00 + minutes so check-ins are on the right day.</summary>
    private async Task<(string Id, string Ref)> TodayBookingAsync(BookingHospital h, int minutes, string? departmentId = null)
    {
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var r = await BookingSetup.BookAsync(api, h with { DepartmentId = departmentId ?? h.DepartmentId }, slot, phone: "+963944000111");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var reference = r.Body.GetProperty("ref").GetString()!;
        await using var db = await fx.OwnerAsync();
        var id = await db.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @reference", new { reference });
        await db.ExecuteAsync("""
            UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(mins => @minutes)) AT TIME ZONE h.timezone
            FROM hospitals h WHERE h.id = b.hospital_id AND b.id = @id
            """, new { id, minutes });
        return (id!, reference);
    }

    private static async Task<string> DeviceAsync(ApiClient c, string name = "Reception PC 1")
    {
        var r = await c.Post("/sync/devices", new { name });
        Assert.Equal(HttpStatusCode.Created, r.Status);
        return r.Body.GetProperty("deviceId").GetString()!;
    }

    private static object Ev(string type, string? @ref = null, string? bookingId = null, DateTimeOffset? at = null, string source = "reception", string? reason = null, Guid? id = null) =>
        new { clientEventId = id ?? Guid.NewGuid(), bookingId, @ref, type, source, at = at ?? DateTimeOffset.UtcNow, reason };

    private static JsonElement[] Bookings(JsonElement pull) => pull.GetProperty("bookings").EnumerateArray().ToArray();

    [Fact(DisplayName = "Sync: pull after a cursor, push check-in by booking number; a retried push is applied once")]
    public async Task PullPushDedupe()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (bid, reference) = await TodayBookingAsync(h, 600);
        var dev = await DeviceAsync(reception);

        var first = await reception.Get($"/sync/pull?deviceId={dev}&since=0");
        Assert.Equal(HttpStatusCode.OK, first.Status);
        var b = Assert.Single(Bookings(first.Body));
        Assert.Equal((bid, "waiting", "+963944000111"), (b.GetProperty("id").GetString(), b.GetProperty("status").GetString(), b.GetProperty("phone").GetString()));
        Assert.Equal("Asia/Damascus", first.Body.GetProperty("hospital").GetProperty("timezone").GetString());
        var cursor = first.Body.GetProperty("cursor").GetInt64();
        Assert.Empty(Bookings((await reception.Get($"/sync/pull?deviceId={dev}&since={cursor}")).Body));

        var evId = Guid.NewGuid();
        var push = new { deviceId = dev, events = new[] { Ev("arrived", @ref: reference.ToLowerInvariant(), id: evId) } };
        var p1 = await reception.Post("/sync/push", push);
        Assert.Equal(HttpStatusCode.OK, p1.Status);
        var r1 = p1.Body.GetProperty("results")[0];
        Assert.Equal(("applied", "arrived"), (r1.GetProperty("outcome").GetString(), r1.GetProperty("status").GetString()));
        var p2 = await reception.Post("/sync/push", push);
        Assert.Equal(("duplicate", "arrived"), (p2.Body.GetProperty("results")[0].GetProperty("outcome").GetString(), p2.Body.GetProperty("results")[0].GetProperty("status").GetString()));

        await using (var db = await fx.OwnerAsync())
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE booking_id = @bid", new { bid }));

        // The change is pulled after the old cursor; the device's last-seen is recorded.
        var after = await reception.Get($"/sync/pull?deviceId={dev}&since={cursor}");
        var changed = Assert.Single(Bookings(after.Body));
        Assert.Equal("arrived", changed.GetProperty("status").GetString());
        // The history travels with the booking, so the Windows detail panel works offline.
        var ev = Assert.Single(changed.GetProperty("events").EnumerateArray());
        Assert.Equal(("arrived", "reception"), (ev.GetProperty("type").GetString(), ev.GetProperty("source").GetString()));
        Assert.NotEqual(JsonValueKind.Null, changed.GetProperty("bookedAt").ValueKind);
        var devices = await h.Admin.Get("/hospital/devices");
        var d = Assert.Single(devices.Body.GetProperty("devices").EnumerateArray());
        Assert.NotEqual(JsonValueKind.Null, d.GetProperty("lastSeenAt").ValueKind);
    }

    [Fact(DisplayName = "Sync: an offline check-in received after the automatic no-show wins; the earliest arrival time is kept")]
    public async Task OfflineArrivedAfterAutoNoShow()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (bid, reference) = await TodayBookingAsync(h, 1);
        var dev = await DeviceAsync(reception);
        await using (var db = await fx.OwnerAsync())
        {
            await db.ExecuteAsync("""
                INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at) VALUES (@id, @h, @bid, 'no_show', 'auto', now());
                UPDATE bookings SET status = 'no_show' WHERE id = @bid;
                """, new { id = "att_" + Ulid.NewUlid(), h = h.HospitalId, bid });
        }
        var early = DateTimeOffset.UtcNow.AddMinutes(-2);
        var late = DateTimeOffset.UtcNow.AddMinutes(-1);
        var r = await reception.Post("/sync/push", new { deviceId = dev, events = new[] { Ev("arrived", @ref: reference, at: late), Ev("arrived", bookingId: bid, at: early) } });
        var res = r.Body.GetProperty("results");
        Assert.All(res.EnumerateArray(), e => Assert.Equal("applied", e.GetProperty("outcome").GetString()));
        await using var db2 = await fx.OwnerAsync();
        var row = await db2.QuerySingleAsync<(string Status, DateTime ArrivedAt)>("SELECT status, arrived_at FROM bookings WHERE id = @bid", new { bid });
        Assert.Equal("arrived", row.Status);
        Assert.Equal(early.UtcDateTime, row.ArrivedAt, TimeSpan.FromMilliseconds(1));
        Assert.Equal(3, await db2.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE booking_id = @bid", new { bid }));
    }

    [Fact(DisplayName = "Sync: corrections win; conflicting corrections flag the booking for review; reasons are required")]
    public async Task Corrections()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (bid, _) = await TodayBookingAsync(h, 60);

        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{bid}/attendance", new { type = "arrived" })).Status);
        var noReason = await reception.Post($"/hospital/bookings/{bid}/attendance", new { type = "no_show", reason = "" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noReason.Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await reception.Post($"/hospital/bookings/{bid}/attendance", new { type = "no_show", reason = "قصير" })).Status);
        var c1 = await reception.Post($"/hospital/bookings/{bid}/attendance", new { type = "no_show", reason = "غادر قبل الدخول" });
        Assert.Equal(("no_show", false), (c1.Body.GetProperty("status").GetString(), c1.Body.GetProperty("needsReview").GetBoolean()));
        var c2 = await h.Admin.Post($"/hospital/bookings/{bid}/attendance", new { type = "arrived", reason = "عاد ودخل" });
        Assert.Equal(("arrived", true), (c2.Body.GetProperty("status").GetString(), c2.Body.GetProperty("needsReview").GetBoolean()));
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(2, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_log WHERE action = 'attendance_correct' AND target = @bid", new { bid }));
        var listed = await reception.Get($"/hospital/bookings/{bid}");
        Assert.True(listed.Body.GetProperty("booking").GetProperty("needsReview").GetBoolean());

        // A pushed correction without a reason is rejected, not applied.
        var dev = await DeviceAsync(reception);
        var r = await reception.Post("/sync/push", new { deviceId = dev, events = new[] { Ev("waiting", bookingId: bid, source: "correction") } });
        Assert.Equal(("rejected", "REASON_REQUIRED"), (r.Body.GetProperty("results")[0].GetProperty("outcome").GetString(), r.Body.GetProperty("results")[0].GetProperty("code").GetString()));
    }

    [Fact(DisplayName = "Sync: cancelled bookings, other-day check-ins and implausible times are rejected")]
    public async Task Rejections()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var dev = await DeviceAsync(reception);
        var (cancelled, _) = await TodayBookingAsync(h, 30);
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{cancelled}/cancel", new { reason = "طلب المريض" })).Status);
        var tomorrowSlot = await BookingSetup.SlotAsync(api.Anonymous(), h, dayIndex: 2);
        var tomorrowRef = (await BookingSetup.BookAsync(api, h, tomorrowSlot)).Body.GetProperty("ref").GetString()!;
        string tomorrow;
        await using (var db0 = await fx.OwnerAsync())
            tomorrow = (await db0.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @tomorrowRef", new { tomorrowRef }))!;
        var (today, _) = await TodayBookingAsync(h, 90);

        var r = await reception.Post("/sync/push", new
        {
            deviceId = dev,
            events = new[]
            {
                Ev("arrived", bookingId: cancelled), Ev("arrived", bookingId: tomorrow), Ev("arrived", @ref: "ML-ZZZZZZ"),
                Ev("arrived", bookingId: today, at: DateTimeOffset.UtcNow.AddHours(1)), Ev("arrived", bookingId: today, at: DateTimeOffset.UtcNow.AddDays(-8)),
                Ev("no_show", bookingId: today), Ev("arrived", bookingId: today, source: "auto"),
            },
        });
        var codes = r.Body.GetProperty("results").EnumerateArray().Select(e => e.GetProperty("code").GetString()).ToArray();
        Assert.Equal(new string?[] { "CANCELLED", "OTHER_DAY", "NOT_FOUND", "BAD_TIME", "BAD_TIME", "FORBIDDEN", "SOURCE_INVALID" }, codes);
        await using var db = await fx.OwnerAsync();
        Assert.Equal(0, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE hospital_id = @h", new { h = h.HospitalId }));
    }

    [Fact(DisplayName = "Sync: a doctor pulls only their own department's bookings, without phone numbers, and cannot check in")]
    public async Task DoctorOwnDepartment()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var dep2 = (await h.Admin.Post("/hospital/departments", new { nameAr = "العظمية" })).Body.GetProperty("id").GetString()!;
        var blocks = Enumerable.Range(0, 7).Select(w => new { weekday = w, start = "00:00", end = "24:00", slotMinutes = 30, capacity = 1 }).ToArray();
        await h.Admin.Put($"/hospital/departments/{dep2}/schedules", new { blocks });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await h.Admin.Post("/hospital/users", new { email = TestApi.NewEmail("doc"), role = Roles.Doctor })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await h.Admin.Post("/hospital/users", new { email = TestApi.NewEmail("rec"), role = Roles.Reception, departmentIds = new[] { dep2 } })).Status);
        var email = TestApi.NewEmail("doctor");
        var inv = await h.Admin.Post("/hospital/users", new { email, role = Roles.Doctor, departmentIds = new[] { h.DepartmentId } });
        Assert.Equal(HttpStatusCode.Created, inv.Status);
        var (password, secret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(fx.Email.LastTo(email)));
        var doctor = await api.SignInAsync(new TestUser(inv.Body.GetProperty("id").GetString()!, email, password, secret));

        var (mine, myRef) = await TodayBookingAsync(h, 120);
        var (other, _) = await TodayBookingAsync(h, 150, dep2);
        var dev = await DeviceAsync(doctor, "Doctor PC");
        var pull = await doctor.Get($"/sync/pull?deviceId={dev}&since=0");
        Assert.Equal(HttpStatusCode.OK, pull.Status);
        var b = Assert.Single(Bookings(pull.Body));
        Assert.Equal(mine, b.GetProperty("id").GetString());
        Assert.Equal(JsonValueKind.Null, b.GetProperty("phone").ValueKind);
        Assert.DoesNotContain("+963944000111", pull.Body.GetRawText());
        Assert.DoesNotContain(other, pull.Body.GetRawText());

        Assert.Equal(HttpStatusCode.Forbidden, (await doctor.Get("/hospital/bookings")).Status);
        var push = await doctor.Post("/sync/push", new { deviceId = dev, events = new[] { Ev("arrived", @ref: myRef) } });
        Assert.Equal("FORBIDDEN", push.Body.GetProperty("results")[0].GetProperty("code").GetString());

        // Moving the doctor to the other department changes what they see on the next pull.
        var docId = inv.Body.GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Patch($"/hospital/users/{docId}", new { departmentIds = new[] { dep2 } })).Status);
        var pull2 = await doctor.Get($"/sync/pull?deviceId={dev}&since=0");
        Assert.Equal(other, Assert.Single(Bookings(pull2.Body)).GetProperty("id").GetString());
    }

    [Fact(DisplayName = "Sync: Windows bearer token; revoked devices are refused; 25 active devices per hospital; scanner cannot pull")]
    public async Task DevicesAndBearer()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (_, recUser) = await api.StaffAsync(h.Admin, Roles.Reception);
        await api.AllowNextTotpAsync(recUser.Email);
        var login = await api.Anonymous().Post("/auth/login", new { email = recUser.Email, password = recUser.Password, client = "windows" }, csrf: false);
        Assert.Equal(HttpStatusCode.OK, login.Status);
        var token = login.Body.GetProperty("token").GetString()!;
        fx.Secrets.Add(token);
        using var win = api.Factory.CreateClient();
        win.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var reg = await win.PostAsJsonAsync("/sync/devices", new { name = "Reception PC" });
        Assert.Equal(HttpStatusCode.Created, reg.StatusCode);
        var dev = (await reg.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("deviceId").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await win.GetAsync($"/sync/pull?deviceId={dev}&since=0")).StatusCode);
        // The company console shows the hospital's last sync.
        var hosp = await owner.Get($"/admin/hospitals/{h.HospitalId}");
        Assert.NotEqual(JsonValueKind.Null, hosp.Body.GetProperty("hospital").GetProperty("lastSyncAt").ValueKind);

        // Reception cannot manage devices; the admin revokes it and the device is refused from then on.
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Post($"/hospital/devices/{dev}/revoke", new { })).Status);
        var refused = await win.GetAsync($"/sync/pull?deviceId={dev}&since=0");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Contains("DEVICE_REVOKED", await refused.Content.ReadAsStringAsync());
        var pushRefused = await win.PostAsJsonAsync("/sync/push", new { deviceId = dev, events = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.Forbidden, pushRefused.StatusCode);
        // The console still shows when the hospital last synced, even after the device was revoked.
        Assert.NotEqual(JsonValueKind.Null, (await owner.Get($"/admin/hospitals/{h.HospitalId}")).Body.GetProperty("hospital").GetProperty("lastSyncAt").ValueKind);

        // Another hospital's device id is refused too.
        var other = await BookingSetup.CreateAsync(api, owner);
        var otherDev = await DeviceAsync(other.Admin);
        Assert.Equal(HttpStatusCode.Forbidden, (await win.GetAsync($"/sync/pull?deviceId={otherDev}&since=0")).StatusCode);

        // The revoked device no longer counts: 25 more can be registered, the 26th active one is refused.
        for (var i = 0; i < 25; i++) await DeviceAsync(h.Admin, "PC " + i);
        Assert.Equal(HttpStatusCode.Conflict, (await h.Admin.Post("/sync/devices", new { name = "PC 26" })).Status);

        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        Assert.Equal(HttpStatusCode.Forbidden, (await scanner.Get($"/sync/pull?deviceId={dev}&since=0")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await scanner.Get("/hospital/devices")).Status);
    }

    [Fact(DisplayName = "Sync: RLS keeps devices and attendance events inside their hospital")]
    public async Task Rls()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var a = await BookingSetup.CreateAsync(api, owner);
        var b = await BookingSetup.CreateAsync(api, owner);
        var (bid, _) = await TodayBookingAsync(a, 200);
        await DeviceAsync(a.Admin);
        Assert.Equal(HttpStatusCode.OK, (await a.Admin.Post($"/hospital/bookings/{bid}/attendance", new { type = "arrived" })).Status);

        await using var app = await fx.AppAsync();
        await using var t = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @h, true)", new { h = b.HospitalId }, t);
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM devices WHERE hospital_id = @h", new { h = a.HospitalId }, t));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE booking_id = @bid", new { bid }, t));
        // Events are append-only for the app role.
        await app.ExecuteAsync("SELECT set_config('app.hospital_id', @h, true)", new { h = a.HospitalId }, t);
        var e = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => app.ExecuteAsync("DELETE FROM attendance_events WHERE booking_id = @bid", new { bid }, t));
        Assert.Equal("42501", e.SqlState);
    }
}
