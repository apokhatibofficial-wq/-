using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MedLink.App;
using MedLink.Sync;
using MedLink.Windows.Views;

namespace MedLink.Windows;

/// <summary>
/// `MEDLINK.exe --smoke &lt;dir&gt;` (run by CI on Windows): drives the real window against a local fake server that holds
/// fictional data only, checks DPAPI, SQLCipher, sign-in, sync and offline check-in on Windows, and saves a screenshot of
/// every screen. Writes smoke.txt and exits with the number of failed checks.
/// </summary>
internal static class Smoke
{
    private static readonly List<string> Report = [];
    private static int _failures;
    private static readonly BindingErrors Bindings = new();

    /// <summary>Collects WPF binding errors (a broken binding shows an empty label instead of failing).</summary>
    private sealed class BindingErrors : TraceListener
    {
        public List<string> Errors { get; } = [];
        public override void Write(string? message) { }
        public override void WriteLine(string? message) { if (message is not null) lock (Errors) Errors.Add(message); }
    }

    /// <summary>Every text shown on screen (TextBlock and its runs), to check that labels are really there.</summary>
    private static List<string> Texts(DependencyObject root)
    {
        var list = new List<string>();
        void Walk(DependencyObject d)
        {
            if (d is TextBlock { IsVisible: true } t && !string.IsNullOrEmpty(t.Text)) list.Add(t.Text);
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(d); i++) Walk(VisualTreeHelper.GetChild(d, i));
        }
        Walk(root);
        return list;
    }

    private static void Shows(Window w, string screen, params string[] expected)
    {
        var texts = Texts(w);
        var missing = expected.Where(e => !texts.Contains(e)).ToList();
        Check(missing.Count == 0, screen + " shows its labels" + (missing.Count > 0 ? " — missing: " + string.Join(" | ", missing) : ""));
    }

    /// <summary>Every visible logo lies fully inside the window (the KHATIB splash logo was once pushed off the top).</summary>
    private static void LogosInside(Window w, string screen)
    {
        var content = (FrameworkElement)w.Content;
        var bad = new List<string>();
        void Walk(DependencyObject d)
        {
            if (d is SharpVectors.Converters.SvgViewbox { IsVisible: true } v && v.ActualWidth > 0)
            {
                var r = v.TransformToAncestor(content).TransformBounds(new Rect(0, 0, v.ActualWidth, v.ActualHeight));
                if (r.Top < 36 - 1 || r.Left < -1 || r.Bottom > content.ActualHeight + 1 || r.Right > content.ActualWidth + 1)
                    bad.Add(v.Source?.ToString() + " at " + r.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(d); i++) Walk(VisualTreeHelper.GetChild(d, i));
        }
        Walk(content);
        Check(bad.Count == 0, screen + ": logos fully inside the window" + (bad.Count > 0 ? " — " + string.Join(" | ", bad) : ""));
    }

    /// <summary>Primary buttons show white text (an app-wide TextBlock style once turned it dark).</summary>
    private static void PrimaryTextWhite(Window w, string screen)
    {
        var primary = (Style)Application.Current.FindResource("Primary");
        var bad = new List<string>();
        void Walk(DependencyObject d, bool inPrimary)
        {
            if (d is Button { IsVisible: true } b) inPrimary = b.Style == primary || b.Style?.BasedOn == primary;
            if (inPrimary && d is TextBlock t && t.Foreground is SolidColorBrush c && c.Color != Colors.White) bad.Add(t.Text);
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(d); i++) Walk(VisualTreeHelper.GetChild(d, i), inPrimary);
        }
        Walk(w, false);
        Check(bad.Count == 0, screen + ": primary buttons have white text" + (bad.Count > 0 ? " — not white: " + string.Join(" | ", bad) : ""));
    }

    /// <summary>Logos are never mirrored: every SVG must be laid out left to right, even in Arabic.</summary>
    private static void LogosNotMirrored(Window w, string screen)
    {
        var bad = 0;
        void Walk(DependencyObject d)
        {
            if (d is SharpVectors.Converters.SvgViewbox { IsVisible: true } v && v.FlowDirection != FlowDirection.LeftToRight) bad++;
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(d); i++) Walk(VisualTreeHelper.GetChild(d, i));
        }
        Walk(w);
        Check(bad == 0, screen + ": logos not mirrored");
    }

    private static void Check(bool ok, string what)
    {
        Report.Add((ok ? "PASS " : "FAIL ") + what);
        if (!ok) _failures++;
    }

    public static async Task RunAsync(Application application, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var root = Path.Combine(Path.GetTempPath(), "medlink-smoke-" + Guid.NewGuid().ToString("N"));
        using var server = new FakeServer();
        PresentationTraceSources.Refresh();
        PresentationTraceSources.DataBindingSource.Listeners.Add(Bindings);
        PresentationTraceSources.DataBindingSource.Switch.Level = SourceLevels.Error;
        try
        {
            server.Start();
            var protector = new DpapiKeyProtector();
            // DPAPI on this Windows user: round trip, and another entropy/user cannot read it.
            var secret = Encoding.UTF8.GetBytes("smoke-" + Guid.NewGuid());
            var sealedBytes = protector.Protect(secret);
            Check(protector.Unprotect(sealedBytes).SequenceEqual(secret) && !sealedBytes.AsSpan().SequenceEqual(secret), "DPAPI protects and restores the local key");

            var app = new AppController(new AppPaths(root), protector, new WpfUi(application.Dispatcher), new NoLauncher(), TimeProvider.System,
                App.Version, serverOverride: server.Url) { LongPollSeconds = 2, RetryDelay = TimeSpan.FromMilliseconds(500) };
            var window = new MainWindow(app, startSplash: false) { Width = 1280, Height = 800, WindowStartupLocation = WindowStartupLocation.Manual, Left = 0, Top = 0 };
            application.MainWindow = window;
            window.Show();

            // Splash: two frames, then the full sequence must hand over to sign-in.
            var splash = new SplashView(app, animations: true);
            window.Host.Content = splash;
            splash.ShowFrame(900); await Shot(window, outDir, "01-splash-khatib");
            LogosInside(window, "splash (KHATIB)");
            splash.ShowFrame(2300); await Shot(window, outDir, "02-splash-medlink");
            LogosInside(window, "splash (MEDLINK)");
            var played = new SplashView(app, animations: true);
            window.Host.Content = played;
            await Until(() => app.Screen == Screen.SignIn, 8);
            Check(app.Screen == Screen.SignIn, "splash plays (3.15 s) and opens sign-in");
            window.ShowScreen();
            await Until(() => app.SignIn.Online, 5);
            Check(app.SignIn.Online, "sign-in shows 'connected to server'");
            await Shot(window, outDir, "03-signin");
            Shows(window, "sign-in", Strings.Ar.WinTitle, Strings.Ar.SignIn, Strings.Ar.SignInSub, Strings.Ar.Email, Strings.Ar.Password, Strings.Ar.BrandLine);
            LogosNotMirrored(window, "sign-in");
            LogosInside(window, "sign-in");
            PrimaryTextWhite(window, "sign-in");

            var vm = app.SignIn;
            vm.Email = FakeServer.Reception; vm.Password = "wrong-password";
            await vm.SubmitAsync();
            Check(vm.Error == Strings.Ar.ErrBad, "wrong password shows the generic error");
            await Shot(window, outDir, "04-signin-error");

            vm.Email = FakeServer.Admin; vm.Password = FakeServer.Password;
            await vm.SubmitAsync();
            Check(vm.NeedTotp, "2FA account asks for the 6-digit code");
            await Shot(window, outDir, "05-signin-code");
            vm.BackCommand.Execute(null);

            vm.ForgotCommand.Execute(null);
            await Shot(window, outDir, "06-forgot-password");
            vm.CloseForgotCommand.Execute(null);

            server.Down = true;
            await vm.CheckConnectionAsync();
            Check(!vm.Online && !vm.CanSubmit, "offline: pill amber, sign-in disabled");
            await Shot(window, outDir, "07-signin-offline");
            server.Down = false;
            await vm.CheckConnectionAsync();

            // Reception signs in: device registered, today's list pulled into the encrypted local copy.
            vm.Email = FakeServer.Reception; vm.Password = FakeServer.Password;
            await vm.SubmitAsync();
            Check(app.Screen == Screen.Main, "reception signs in");
            window.ShowScreen();
            var m = app.Main!;
            await Until(() => m.Dashboard.Rows.Count == FakeServer.BookingCount, 10);
            Check(m.Dashboard.Rows.Count == FakeServer.BookingCount, "today's bookings pulled (" + m.Dashboard.Rows.Count + ")");
            Check(server.DeviceRegistrations == 1, "this PC registered once as a device");
            var dbFile = Directory.GetFiles(root, "local-*").Single(f => f.EndsWith(".db", StringComparison.Ordinal));
            var header = new byte[16];
            using (var f = new FileStream(dbFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) f.ReadExactly(header);
            Check(!Encoding.ASCII.GetString(header).StartsWith("SQLite format 3"), "local database file is encrypted (SQLCipher)");
            var session = File.ReadAllBytes(Path.Combine(root, "session.bin"));
            Check(!Encoding.Latin1.GetString(session).Contains(FakeServer.Token) && !Encoding.Latin1.GetString(session).Contains(FakeServer.Reception),
                "saved session is protected (no token or email in clear)");

            var row = m.Dashboard.Rows.First(r => r.Status == "waiting");
            m.Dashboard.SelectCommand.Execute(row);
            await Shot(window, outDir, "08-dashboard");
            Shows(window, "dashboard", Strings.Ar.CTime, Strings.Ar.CPatient, Strings.Ar.Today, Strings.Ar.MarkArrived, Strings.Ar.Correct, Strings.Ar.SaveCorr,
                Strings.Ar.History, Strings.Ar.SignOut, Strings.Ar.Nav[0], Strings.Ar.HBooked);
            LogosNotMirrored(window, "dashboard");
            PrimaryTextWhite(window, "dashboard");

            // Offline: banner, check-in saved locally with the pending mark; sent when the server is back.
            server.Down = true;
            await Until(() => m.Connection == Connection.Offline, 15);
            m.Dashboard.CheckInCommand.Execute(null);
            Check(m.PendingCount == 1 && m.OfflineBanner, "offline check-in kept locally as pending");
            await Shot(window, outDir, "09-dashboard-offline");
            server.Down = false;
            await Until(() => server.PushedEvents == 1 && m.PendingCount == 0, 15);
            Check(server.PushedEvents == 1 && m.PendingCount == 0, "pending check-in sent when the connection returned");

            m.NavCommand.Execute(2); await Shot(window, outDir, "10-sync");
            m.NavCommand.Execute(3); await Shot(window, outDir, "11-settings");
            m.NavCommand.Execute(1); m.Find.Query = row.Ref; m.Find.FindCommand.Execute(null);
            Check(m.Page == 0 && m.Dashboard.DRef == row.Ref, "find by full booking number opens it");

            app.SetLanguage(Lang.En);
            await Shot(window, outDir, "12-dashboard-en");
            Shows(window, "dashboard (English)", Strings.En.CTime, Strings.En.MarkArrived, Strings.En.Nav[0], Strings.En.AllDepts);
            window.Width = 1024;
            await Shot(window, outDir, "13-dashboard-narrow");
            window.Width = 1280;
            app.SetLanguage(Lang.Ar);

            await m.SignOutAsync();
            Check(app.Screen == Screen.SignIn && !File.Exists(dbFile), "sign-out deletes this user's local copy (nothing pending)");
            window.ShowScreen();

            // A doctor on the same PC: same device, own department, no phone numbers, read-only.
            vm.Email = FakeServer.Doctor; vm.Password = FakeServer.Password;
            await vm.SubmitAsync();
            window.ShowScreen();
            var d = app.Main!;
            await Until(() => d.Dashboard.Rows.Count > 0, 10);
            d.Dashboard.SelectCommand.Execute(d.Dashboard.Rows[0]);
            Check(!d.Dashboard.DCanCheckIn && !d.Dashboard.DCanCorrect && d.Dashboard.DFacts.All(x => x.Label != Strings.Ar.Phone), "doctor: read-only, no phone");
            Check(server.DeviceRegistrations == 1, "second user reuses the PC's device");
            await Shot(window, outDir, "14-doctor");
            await d.StopAsync();
        }
        catch (Exception e)
        {
            Check(false, "unexpected " + e.GetType().Name + ": " + e.Message);
            Report.Add(e.ToString());
        }
        finally
        {
            lock (Bindings.Errors)
            {
                Check(Bindings.Errors.Count == 0, "no WPF binding errors (" + Bindings.Errors.Count + ")");
                Report.AddRange(Bindings.Errors.Distinct().Take(15).Select(e => "  binding: " + e));
            }
            File.WriteAllLines(Path.Combine(outDir, "smoke.txt"), Report);
            try { Directory.Delete(root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            application.Shutdown(_failures);
        }
    }

    private static async Task Until(Func<bool> condition, int seconds)
    {
        for (var until = DateTime.UtcNow.AddSeconds(seconds); DateTime.UtcNow < until && !condition();)
            await Task.Delay(100);
    }

    private static async Task Shot(Window window, string dir, string name)
    {
        await Task.Delay(250);
        await window.Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
        var content = (FrameworkElement)window.Content;
        content.UpdateLayout();
        var dpi = VisualTreeHelper.GetDpi(window);
        var bmp = new RenderTargetBitmap((int)(content.ActualWidth * dpi.DpiScaleX), (int)(content.ActualHeight * dpi.DpiScaleY),
            dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        bmp.Render(content);
        var png = new PngBitmapEncoder();
        png.Frames.Add(BitmapFrame.Create(bmp));
        using var f = File.Create(Path.Combine(dir, name + ".png"));
        png.Save(f);
    }

    private sealed class NoLauncher : ILauncher
    {
        public void Open(string url) { }
    }
}

/// <summary>A local stand-in for the MEDLINK API with fictional data, for the screenshot run only.</summary>
internal sealed class FakeServer : IDisposable
{
    public const string Reception = "reception@example.invalid", Doctor = "doctor@example.invalid", Admin = "admin@example.invalid";
    public const string Password = "smoke-test-password", Token = "smoke-token-0123456789abcdef0123456789abcdef";
    public const int BookingCount = 6;
    private readonly HttpListener _http = new();
    private readonly int _port = 18000 + Random.Shared.Next(1000);
    private string? _user;
    public string Url => "http://localhost:" + _port;
    public volatile bool Down;
    public int DeviceRegistrations, PushedEvents;
    private long _seq = 100;

    public void Start()
    {
        _http.Prefixes.Add(Url + "/");
        _http.Start();
        _ = Task.Run(LoopAsync);
    }

    private async Task LoopAsync()
    {
        while (_http.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = await _http.GetContextAsync(); } catch (Exception) { return; }
            _ = Task.Run(() => HandleAsync(ctx));
        }
    }

    private async Task HandleAsync(HttpListenerContext ctx)
    {
        var res = ctx.Response;
        try
        {
            if (Down) { ctx.Response.Abort(); return; }
            var path = ctx.Request.Url!.AbsolutePath;
            var body = ctx.Request.HasEntityBody ? await new StreamReader(ctx.Request.InputStream).ReadToEndAsync() : "";
            (int Status, object Json) r = path switch
            {
                "/health" => (200, new { status = "ok" }),
                "/auth/login" => Login(body),
                "/auth/me" => (200, new { user = User(_user ?? Reception) }),
                "/auth/logout" => (200, new { status = "ok" }),
                "/sync/devices" => Register(),
                "/sync/pull" => await PullAsync(ctx.Request.QueryString["since"]),
                "/sync/push" => Push(body),
                _ => (404, new { error = "NOT_FOUND" }),
            };
            var bytes = JsonSerializer.SerializeToUtf8Bytes(r.Json);
            res.StatusCode = r.Status;
            res.ContentType = "application/json";
            await res.OutputStream.WriteAsync(bytes);
            res.Close();
        }
        catch (Exception) { try { res.Abort(); } catch (ObjectDisposedException) { } }
    }

    private static object User(string email) => new
    {
        id = "usr_" + email.Split('@')[0], email, scope = "hospital", hospitalId = "hsp_smoke",
        roles = new[] { email == Doctor ? "doctor" : email == Admin ? "hosp_admin" : "reception" },
        permissions = email == Doctor ? new[] { "HospitalRead", "BookingsViewOwnDepartment" } : new[] { "HospitalRead", "BookingsView", "CheckIn", "AttendanceCorrect" },
    };

    private (int, object) Login(string body)
    {
        var j = JsonDocument.Parse(body).RootElement;
        var email = j.GetProperty("email").GetString()!;
        if (j.GetProperty("password").GetString() != Password) return (401, new { error = "INVALID_CREDENTIALS" });
        if (email == Admin && j.TryGetProperty("totp", out var t) && t.ValueKind != JsonValueKind.String) return (200, new { status = "mfa_required" });
        if (email == Admin) return (200, new { status = "mfa_required" });
        _user = email;
        return (200, new { status = "ok", user = User(email), token = Token });
    }

    private (int, object) Register()
    {
        Interlocked.Increment(ref DeviceRegistrations);
        return (201, new { deviceId = "dev_01JSMOKE0000000000000000AA" });
    }

    private async Task<(int, object)> PullAsync(string? since)
    {
        if (since is not "0") { await Task.Delay(1500); return (200, Page([], Interlocked.Read(ref _seq))); }
        var tz = TimeZoneInfo.FindSystemTimeZoneById("Asia/Damascus");
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, tz).Date;
        // Fictional names, no real patients.
        var people = new[] { ("سلمى أحمد", "dep_a"), ("خالد يوسف", "dep_a"), ("ريم حسن", "dep_b"), ("عمر سعيد", "dep_a"), ("ليلى منصور", "dep_b"), ("يزن كريم", "dep_a") };
        var doctor = _user == Doctor;
        var list = people.Select((p, i) =>
        {
            var local = today.AddHours(9).AddMinutes(30 * i);
            var start = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(local, tz));
            var status = i switch { 0 => "arrived", 3 => "no_show", _ => "waiting" };
            var events = i == 0 ? new object[] { new { type = "arrived", source = "qr", at = start.AddMinutes(-5), reason = (string?)null } }
                : i == 3 ? [new { type = "no_show", source = "auto", at = start.AddMinutes(30), reason = (string?)null }] : [];
            return new
            {
                id = "bkg_smoke" + i, @ref = "ML-SMK" + "ABCDEF"[i] + "2" + (i + 3), departmentId = p.Item2, slotStart = start,
                localDate = local.ToString("yyyy-MM-dd"), localTime = local.ToString("HH:mm"), patientName = p.Item1,
                phone = doctor ? null : "+9639440000" + (10 + i), status, arrivedAt = i == 0 ? start.AddMinutes(-5) : (DateTimeOffset?)null,
                needsReview = false, seq = 10 + i, bookedAt = start.AddDays(-2), events,
            };
        }).Where(b => !doctor || b.departmentId == "dep_a").ToArray();
        return (200, Page(list, 20));
    }

    private static object Page(object[] bookings, long cursor) => new
    {
        cursor, hasMore = false,
        hospital = new { name = new { ar = "مستشفى المثال", en = "Example Hospital", tr = "Örnek Hastanesi" }, timezone = "Asia/Damascus", noShowGraceMin = 30 },
        departments = new[]
        {
            new { id = "dep_a", name = new { ar = "الباطنية", en = "Internal medicine", tr = "Dahiliye" }, active = true },
            new { id = "dep_b", name = new { ar = "العظمية", en = "Orthopaedics", tr = "Ortopedi" }, active = true },
        },
        bookings,
    };

    private (int, object) Push(string body)
    {
        var events = JsonDocument.Parse(body).RootElement.GetProperty("events").EnumerateArray().ToList();
        Interlocked.Add(ref PushedEvents, events.Count);
        Interlocked.Increment(ref _seq);
        return (200, new
        {
            results = events.Select(e => new
            {
                clientEventId = e.GetProperty("clientEventId").GetGuid(), outcome = "applied", code = (string?)null,
                @ref = e.TryGetProperty("ref", out var r) ? r.GetString() : null, status = "arrived", arrivedAt = e.GetProperty("at").GetDateTimeOffset(), needsReview = false,
            }),
        });
    }

    public void Dispose()
    {
        try { _http.Stop(); _http.Close(); } catch (ObjectDisposedException) { }
    }
}
