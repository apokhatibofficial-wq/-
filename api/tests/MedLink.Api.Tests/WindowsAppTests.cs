using System.Net;
using System.Reflection;
using System.Text;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using MedLink.App;
using Microsoft.Data.Sqlite;
using OtpNet;

namespace MedLink.Api.Tests;

internal sealed class RecordingLauncher : ILauncher
{
    public List<string> Opened { get; } = [];
    public void Open(string url) => Opened.Add(url);
}

/// <summary>The Windows app's logic (MedLink.App.Core) driven like the WPF window drives it, against the real API.</summary>
[Collection("medlink")]
public sealed class WindowsAppTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    private readonly string dir = Directory.CreateTempSubdirectory("medlink-app-").FullName;
    private readonly TestKeyProtector protector = new();
    public void Dispose() { api.Dispose(); SqliteConnection.ClearAllPools(); Directory.Delete(dir, true); }

    private (AppController App, Network Net, RecordingLauncher Launcher) NewApp(string? root = null)
    {
        var net = new Network(api.Factory.Server.CreateHandler());
        var launcher = new RecordingLauncher();
        var app = new AppController(new AppPaths(root ?? dir), protector, new InlineUi(), launcher, TimeProvider.System, "1.0.0-test",
            () => net, "http://localhost") { LongPollSeconds = 1, RetryDelay = TimeSpan.FromMilliseconds(200) };
        return (app, net, launcher);
    }

    private static async Task Eventually(Func<bool> condition, string what, int seconds = 15)
    {
        for (var until = DateTime.UtcNow.AddSeconds(seconds); DateTime.UtcNow < until; await Task.Delay(100))
            if (condition()) return;
        Assert.Fail("timed out waiting for: " + what);
    }

    private async Task<(string Id, string Ref)> TodayBookingAsync(BookingHospital h, int minutes, string name, string? departmentId = null)
    {
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h with { DepartmentId = departmentId ?? h.DepartmentId });
        var r = await BookingSetup.BookAsync(api, h with { DepartmentId = departmentId ?? h.DepartmentId }, slot, name: name, phone: "+963944000444");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var reference = r.Body.GetProperty("ref").GetString()!;
        await using var db = await fx.OwnerAsync();
        await db.ExecuteAsync("""
            UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(mins => @minutes)) AT TIME ZONE h.timezone
            FROM hospitals h WHERE h.id = b.hospital_id AND b.ref = @reference
            """, new { reference, minutes });
        return ((await db.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @reference", new { reference }))!, reference);
    }

    private static async Task SignInAsync(AppController app, TestUser u)
    {
        await app.SplashDoneAsync();
        Assert.Equal(Screen.SignIn, app.Screen);
        app.SignIn.Email = u.Email;
        app.SignIn.Password = u.Password;
        await app.SignIn.SubmitAsync();
        if (app.SignIn.NeedTotp)
        {
            app.SignIn.Totp = new Totp(Base32Encoding.ToBytes(u.TotpSecret!)).ComputeTotp(DateTime.UtcNow);
            await app.SignIn.SubmitAsync();
        }
        Assert.Equal("", app.SignIn.Error);
        Assert.Equal(Screen.Main, app.Screen);
    }

    [Fact(DisplayName = "Windows app: splash timings follow SCREENS.md, with the reduced-motion variant")]
    public void Splash()
    {
        var n = SplashTimeline.Normal;
        Assert.Equal((80, 520, 700, 1250, 1650, 2700, 420, 3150), (n.KhatibInMs, n.KhatibFadeMs, n.KhatibRiseMs, n.KhatibOutMs, n.MedlinkInMs, n.FadeOutMs, n.FadeOutDurationMs, n.RemoveMs));
        Assert.Equal([(80, 0.28), (1250, 0.62), (1650, 1.0)], n.Bar);
        Assert.Equal((10, 0.96, -14, 1.02, 14), (n.KhatibFromY, n.KhatibFromScale, n.KhatibOutY, n.KhatibOutScale, n.MedlinkFromY));
        var r = SplashTimeline.For(animationsOn: false);
        Assert.Equal((50, 700, 1150, false), (r.MedlinkInMs, r.FadeOutMs, r.RemoveMs, r.Moves));
        Assert.Equal(-1, r.KhatibInMs);
    }

    [Fact(DisplayName = "Windows app: every string exists in Arabic, English and Turkish")]
    public void StringsComplete()
    {
        foreach (var s in new[] { Strings.Ar, Strings.En, Strings.Tr })
            foreach (var f in typeof(Strings).GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                var v = f.GetValue(s);
                Assert.NotNull(v);
                if (v is string str) Assert.False(string.IsNullOrWhiteSpace(str), f.Name);
                if (v is string[] arr) Assert.Equal(4, arr.Length);
            }
        Assert.Equal(Strings.Ar.Src.Keys.Order(), Strings.En.Src.Keys.Order());
        Assert.Equal(Strings.Ar.RejectCodes.Keys.Order(), Strings.Tr.RejectCodes.Keys.Order());
    }

    [Fact(DisplayName = "Windows app sign-in: generic errors, 2FA step, lockout, offline disables sign-in, QR-scanner accounts refused")]
    public async Task SignInRules()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (app, net, _) = NewApp();
        await app.SplashDoneAsync();
        var vm = app.SignIn;
        Assert.True(vm.Online);
        Assert.Equal(Strings.Ar.Online, vm.ConnectionText);

        // Unknown email and wrong password give the same message.
        vm.Email = "nobody-" + Guid.NewGuid().ToString("N") + "@test.invalid"; vm.Password = "x";
        await vm.SubmitAsync();
        var unknown = vm.Error;
        vm.Email = h.AdminUser.Email; vm.Password = "wrong-" + Guid.NewGuid().ToString("N");
        await vm.SubmitAsync();
        Assert.Equal(unknown, vm.Error);
        Assert.Equal(Strings.Ar.ErrBad, vm.Error);

        // The hospital admin has 2FA: the code step appears after the password.
        await api.AllowNextTotpAsync(h.AdminUser.Email);
        vm.Password = h.AdminUser.Password;
        await vm.SubmitAsync();
        Assert.True(vm.NeedTotp);
        Assert.Equal(Strings.Ar.Verify, vm.SubmitText);
        vm.Totp = "12a34567";
        Assert.Equal("123456", vm.Totp);
        vm.Totp = new Totp(Base32Encoding.ToBytes(h.AdminUser.TotpSecret!)).ComputeTotp(DateTime.UtcNow);
        await vm.SubmitAsync();
        Assert.Equal(Screen.Main, app.Screen);
        await app.Main!.SignOutAsync();
        Assert.Equal(Screen.SignIn, app.Screen);

        // A QR-scanner account has nothing to show in the Windows app; its new session is ended at once.
        var (_, scanner) = await api.StaffAsync(h.Admin, Roles.Scanner);
        await api.AllowNextTotpAsync(scanner.Email);
        vm.Email = scanner.Email; vm.Password = scanner.Password;
        await vm.SubmitAsync();
        Assert.Equal(Strings.Ar.NotForWindows, vm.Error);
        Assert.Equal(Screen.SignIn, app.Screen);
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(0, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM sessions WHERE user_id = @id AND client = 'windows' AND revoked_at IS NULL", new { id = scanner.Id }));

        // Offline: the pill turns amber and sign-in is disabled.
        net.Offline = true;
        await vm.CheckConnectionAsync();
        Assert.False(vm.Online);
        vm.Email = h.AdminUser.Email; vm.Password = "anything";
        Assert.False(vm.CanSubmit);
        Assert.False(vm.SubmitCommand.CanExecute(null));
        net.Offline = false;
        await vm.CheckConnectionAsync();

        // Five wrong passwords lock the account (server rule); the app shows the lockout message.
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        vm.Email = rec.Email;
        for (var i = 0; i < 6; i++) { vm.Password = "bad-" + i; await vm.SubmitAsync(); }
        Assert.Equal(Strings.Ar.ErrLocked, vm.Error);
    }

    [Fact(DisplayName = "Windows app: the session is kept (protected), reopened without a password, refused when revoked, and works offline")]
    public async Task SavedSession()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (_, reference) = await TodayBookingAsync(h, 600, "مريض تجريبي للجلسة");
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (app, _, _) = NewApp();
        await SignInAsync(app, rec);
        await Eventually(() => app.Main!.Dashboard.Rows.Any(r => r.Ref == reference), "first pull");
        var token = app.Main!.Token;
        fx.Secrets.Add(token);
        await app.Main.StopAsync();
        app.Main.Store.Dispose();
        SqliteConnection.ClearAllPools();

        // The saved file holds neither the token nor the email in clear.
        var file = File.ReadAllBytes(Path.Combine(dir, "session.bin"));
        Assert.DoesNotContain(token, Encoding.Latin1.GetString(file));
        Assert.DoesNotContain(rec.Email, Encoding.Latin1.GetString(file));

        // Next start: straight to the dashboard.
        var (again, net, _) = NewApp();
        await again.SplashDoneAsync();
        Assert.Equal(Screen.Main, again.Screen);
        Assert.Equal(rec.Email, again.Main!.Email);
        await again.Main.StopAsync(); again.Main.Store.Dispose(); SqliteConnection.ClearAllPools();

        // Offline start: the local copy opens with the saved user and the offline banner.
        var (offline, net2, _) = NewApp();
        net2.Offline = true;
        await offline.SplashDoneAsync();
        Assert.Equal(Screen.Main, offline.Screen);
        await Eventually(() => offline.Main!.OfflineBanner, "offline banner");
        Assert.Contains(offline.Main!.Dashboard.Rows, r => r.Ref == reference);
        await offline.Main.StopAsync(); offline.Main.Store.Dispose(); SqliteConnection.ClearAllPools();

        // The server revokes the session: the next start goes to sign-in with a notice.
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync("UPDATE sessions SET revoked_at = now(), revoke_reason = 'test' WHERE user_id = @id", new { id = rec.Id });
        var (revoked, _, _) = NewApp();
        await revoked.SplashDoneAsync();
        Assert.Equal(Screen.SignIn, revoked.Screen);
        Assert.Equal(Strings.Ar.SessionEnded, revoked.SignIn.Info);
        Assert.False(File.Exists(Path.Combine(dir, "session.bin")));
        _ = net;
    }

    [Fact(DisplayName = "Windows app dashboard: filters and counts, check-in and correction (offline too), history, live QR check-in")]
    public async Task Dashboard()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (bid1, ref1) = await TodayBookingAsync(h, 540, "سلمى تجريبية");
        var (bid2, ref2) = await TodayBookingAsync(h, 570, "خالد تجريبي");
        var (bid3, _) = await TodayBookingAsync(h, 600, "ريم تجريبية");
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (app, net, _) = NewApp();
        await SignInAsync(app, rec);
        var m = app.Main!;
        var d = m.Dashboard;
        await Eventually(() => d.Rows.Count == 3, "three bookings");
        Assert.True(d.IsToday);
        Assert.Equal(app.S.PillOnline, m.PillText);
        Assert.Equal([3, 3, 0, 0], d.Chips.Select(c => c.Count));
        Assert.Equal(Strings.Ar.Grace(30), d.GraceNote);

        // Search filters the day's list by name or booking number.
        d.Search = "خالد";
        Assert.Equal(ref2, Assert.Single(d.Rows).Ref);
        d.Search = ref1[3..];
        Assert.Equal(ref1, Assert.Single(d.Rows).Ref);
        d.Search = "";

        // Check in from the table: shown at once as arrived, then sent to the server.
        var row = d.Rows.First(r => r.Id == bid1);
        Assert.True(row.CanCheckIn);
        d.CheckInCommand.Execute(row);
        Assert.Equal(Strings.Ar.CheckedIn, m.Toast);
        await Eventually(() => Status(bid1) == "arrived", "server arrived");
        await Eventually(() => d.Rows.First(r => r.Id == bid1) is { Status: "arrived", Pending: false }, "row synced");

        // Offline check-in: pending in the pill and the row, then "n updates synced" when the network returns.
        net.Offline = true;
        await Eventually(() => m.Connection == Connection.Offline, "offline");
        d.CheckInCommand.Execute(d.Rows.First(r => r.Id == bid2));
        Assert.Equal(Strings.Ar.PendingN(1), m.PillText);
        Assert.True(m.OfflineBanner);
        Assert.True(d.Rows.First(r => r.Id == bid2).Pending);
        Assert.Equal("waiting", Status(bid2));
        net.Offline = false;
        await Eventually(() => Status(bid2) == "arrived", "offline check-in synced");
        await Eventually(() => m.Toast == Strings.Ar.Synced(1), "synced notice");
        Assert.Equal([3, 1, 2, 0], d.Chips.Select(c => c.Count));
        d.FilterCommand.Execute("arrived");
        Assert.Equal(2, d.Rows.Count);
        d.FilterCommand.Execute("all");

        // Correction: reason of at least 5 characters, then history shows booked, reception check-in and the correction.
        d.SelectCommand.Execute(d.Rows.First(r => r.Id == bid1));
        Assert.Equal(Strings.Ar.Src["reception"], d.DSource);
        Assert.Contains(d.DFacts, f => f.Label == Strings.Ar.Phone && f.Value == "+963944000444");
        Assert.True(d.DCanCorrect);
        Assert.False(d.DCanCheckIn);
        Assert.Equal("no_show", d.Target);
        d.Reason = "قصير";
        d.SaveCorrectionCommand.Execute(null);
        Assert.Equal(Strings.Ar.ReasonMin, d.ReasonError);
        d.Reason = "غادر قبل الدخول إلى الطبيب";
        d.SaveCorrectionCommand.Execute(null);
        Assert.Equal(Strings.Ar.CorrSaved, m.Toast);
        await Eventually(() => Status(bid1) == "no_show", "correction applied");
        await Eventually(() => d.DHistory.Count == 3 && !d.DHistory.Any(x => x.Pending), "history synced");
        Assert.Equal([Strings.Ar.HBooked, Strings.Ar.HRec, Strings.Ar.HCorr(Strings.Ar.NoShow, "غادر قبل الدخول إلى الطبيب")], d.DHistory.Select(x => x.Text));
        Assert.Equal(Strings.Ar.Src["correction"], d.DSource);

        // A QR check-in made elsewhere (the phone scanner, phase 9) appears through the long-poll with a notice.
        await using (var db = await fx.OwnerAsync())
        {
            var actor = await db.ExecuteScalarAsync<string>("SELECT id FROM users WHERE email = @e", new { e = rec.Email });
            await db.ExecuteAsync("""
                INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at, actor_id) VALUES (@id, @h, @b, 'arrived', 'qr', now(), @actor);
                UPDATE bookings SET status = 'arrived', arrived_at = now() WHERE id = @b;
                """, new { id = "att_" + Ulid.NewUlid(), h = h.HospitalId, b = bid3, actor });
        }
        await Eventually(() => m.Toast == Strings.Ar.Live("ريم تجريبية"), "live QR notice");
        Assert.Equal("arrived", d.Rows.First(r => r.Id == bid3).Status);

        // Language switch re-labels everything.
        app.SetLanguage(Lang.En);
        Assert.Equal("Arrived", d.Rows.First(r => r.Id == bid3).StatusLabel);
        Assert.Equal(Strings.En.Nav, m.Nav);
        Assert.False(app.Rtl);
        await m.StopAsync();
    }

    private string Status(string bookingId)
    {
        using var db = new Npgsql.NpgsqlConnection(fx.OwnerConnectionString);
        return db.ExecuteScalar<string>("SELECT status FROM bookings WHERE id = @bookingId", new { bookingId })!;
    }

    [Fact(DisplayName = "Windows app: a doctor sees only their department, without phones, read-only; users of one PC share the device but not the data")]
    public async Task DoctorAndSharedPc()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var dep2 = (await h.Admin.Post("/hospital/departments", new { nameAr = "العظمية" })).Body.GetProperty("id").GetString()!;
        var blocks = Enumerable.Range(0, 7).Select(w => new { weekday = w, start = "00:00", end = "24:00", slotMinutes = 30, capacity = 1 }).ToArray();
        await h.Admin.Put($"/hospital/departments/{dep2}/schedules", new { blocks });
        await TodayBookingAsync(h, 300, "مريض الباطنية");
        await TodayBookingAsync(h, 330, "مريض العظمية", dep2);
        var email = TestApi.NewEmail("doctor");
        var inv = await h.Admin.Post("/hospital/users", new { email, role = Roles.Doctor, departmentIds = new[] { h.DepartmentId } });
        var (password, secret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(fx.Email.LastTo(email)));
        var doctor = new TestUser(inv.Body.GetProperty("id").GetString()!, email, password, secret);
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);

        // Reception first, then signs out with nothing pending: the local copy is deleted.
        var (app, _, _) = NewApp();
        await SignInAsync(app, rec);
        await Eventually(() => app.Main!.Dashboard.Rows.Count == 2, "reception sees both");
        var recDb = new AppPaths(dir).Database(rec.Id);
        Assert.True(File.Exists(recDb));
        var deviceId = app.Settings.DeviceId;
        Assert.NotNull(deviceId);
        await app.Main!.SignOutAsync();
        Assert.False(File.Exists(recDb));

        // The doctor on the same PC: same device, own department only, no phone, no buttons.
        await SignInAsync(app, doctor);
        var d = app.Main!.Dashboard;
        await Eventually(() => d.Rows.Count == 1, "doctor sees one");
        Assert.Equal("مريض الباطنية", d.Rows[0].Patient);
        Assert.True(d.ShowReadOnlyNote);
        Assert.False(d.Rows[0].CanCheckIn);
        d.SelectCommand.Execute(d.Rows[0]);
        Assert.DoesNotContain(d.DFacts, f => f.Label == Strings.Ar.Phone);
        Assert.False(d.DCanCheckIn);
        Assert.False(d.DCanCorrect);
        Assert.Equal(Strings.Ar.RoleDoctor, app.Main.RoleLabel);
        Assert.Equal(deviceId, app.Main.Sync.DeviceId);
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM devices WHERE hospital_id = @h", new { h = h.HospitalId }));
        await app.Main.StopAsync();
    }

    [Fact(DisplayName = "Windows app: sign-out keeps unsent check-ins (after a warning); a revoked device signs the user out")]
    public async Task SignOutAndRevoke()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (bid, _) = await TodayBookingAsync(h, 420, "مريض تجريبي للخروج");
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (app, net, _) = NewApp();
        await SignInAsync(app, rec);
        var m = app.Main!;
        await Eventually(() => m.Dashboard.Rows.Count == 1, "pulled");
        net.Offline = true;
        await Eventually(() => m.Connection == Connection.Offline, "offline");
        m.Dashboard.CheckInCommand.Execute(m.Dashboard.Rows[0]);
        await m.SignOutAsync();
        Assert.True(m.SignOutWarning);
        Assert.Equal(Screen.Main, app.Screen);
        await m.SignOutAsync();
        Assert.Equal(Screen.SignIn, app.Screen);
        var db = new AppPaths(dir).Database(rec.Id);
        Assert.True(File.Exists(db));

        // Signing in again sends the kept check-in.
        net.Offline = false;
        await app.SignIn.CheckConnectionAsync();
        await api.AllowNextTotpAsync(rec.Email);
        app.SignIn.Email = rec.Email; app.SignIn.Password = rec.Password;
        await app.SignIn.SubmitAsync();
        Assert.Equal(Screen.Main, app.Screen);
        await Eventually(() => Status(bid) == "arrived", "kept check-in sent");

        // The hospital admin revokes this PC: the app signs out with a notice and forgets the device.
        var dev = app.Settings.DeviceId!;
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Post($"/hospital/devices/{dev}/revoke", new { })).Status);
        await Eventually(() => app.Screen == Screen.SignIn, "signed out after revoke");
        Assert.Equal(Strings.Ar.DeviceRevoked, app.SignIn.Info);
        Assert.Null(app.Settings.DeviceId);
    }

    [Fact(DisplayName = "Windows app: forgot password opens WhatsApp to support with username and hospital only")]
    public async Task ForgotPassword()
    {
        var (app, _, launcher) = NewApp();
        app.Settings.LastHospital = "مستشفى الاختبار";
        await app.SplashDoneAsync();
        app.SignIn.Email = "reception@test.invalid";
        app.SignIn.Password = "a-password-that-must-not-leak";
        app.SignIn.ForgotCommand.Execute(null);
        Assert.True(app.SignIn.ForgotOpen);
        app.SignIn.OpenWhatsAppCommand.Execute(null);
        var url = Assert.Single(launcher.Opened);
        Assert.StartsWith("https://wa.me/4368181700732?text=", url);
        var text = Uri.UnescapeDataString(url[(url.IndexOf('=') + 1)..]);
        Assert.Equal(Strings.Ar.WaMsg("reception@test.invalid", "مستشفى الاختبار"), text);
        Assert.DoesNotContain("a-password-that-must-not-leak", url);
    }
}
