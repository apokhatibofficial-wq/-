using System.Globalization;
using MedLink.Sync;

namespace MedLink.App;

/// <summary>The signed-in window: left nav (Appointments, Find booking, Sync with a pending badge, Settings), the sync pill and banner, and notices.</summary>
public sealed class MainViewModel : Observable
{
    private readonly AppController _app;
    private SyncEngine? _engine;
    private int _page;
    private string _toast = "";
    private int _toastId;
    private bool _signOutWarning;

    public UserInfo User { get; }
    public string Token { get; }
    public LocalStore Store { get; }
    public SyncClient Sync { get; }
    public DashboardViewModel Dashboard { get; }
    public FindViewModel Find { get; }
    public SyncPageViewModel SyncPage { get; }
    public SettingsViewModel SettingsPage { get; }

    internal MainViewModel(AppController app, UserInfo user, string token, LocalStore store, SyncClient sync)
    {
        _app = app; User = user; Token = token; Store = store; Sync = sync;
        Dashboard = new DashboardViewModel(this);
        Find = new FindViewModel(this);
        SyncPage = new SyncPageViewModel(this);
        SettingsPage = new SettingsViewModel(this);
        NavCommand = new Command(p => Page = Convert.ToInt32(p, CultureInfo.InvariantCulture));
        SignOutCommand = new Command(() => _ = SignOutAsync());
        CancelSignOutCommand = new Command(() => SignOutWarning = false);
    }

    internal AppController App => _app;
    public Strings S => _app.S;
    public string[] Nav => S.Nav;
    public int Page { get => _page; set => Set(ref _page, value); }
    public string Email => User.Email;
    public string RoleLabel => S.RoleLabel(User.Roles);
    public bool CanCheckIn => User.Can("CheckIn");
    public bool CanCorrect => User.Can("AttendanceCorrect");
    public bool IsDoctor => !User.Can("BookingsView");
    public Connection Connection => _engine?.State ?? Connection.Syncing;
    public int PendingCount => Store.PendingCount();
    public bool HasPending => PendingCount > 0;
    public string PillText => Connection switch
    {
        Connection.Syncing => S.Syncing,
        Connection.Offline => PendingCount > 0 ? S.PendingN(PendingCount) : S.PillOffline,
        _ => S.PillOnline,
    };
    public bool OfflineBanner => Connection == Connection.Offline;
    public string Toast { get => _toast; private set => Set(ref _toast, value); }
    /// <summary>Increments with every notice, so the view can restart its hide timer.</summary>
    public int ToastId { get => _toastId; private set => Set(ref _toastId, value); }
    public bool SignOutWarning { get => _signOutWarning; private set => Set(ref _signOutWarning, value); }
    public string HospitalName { get; private set; } = "";

    public Command NavCommand { get; }
    public Command SignOutCommand { get; }
    public Command CancelSignOutCommand { get; }

    public void Notify(string text) { Toast = text; ToastId++; }

    internal void LanguageChanged()
    {
        HospitalName = LocalHospitalName() ?? HospitalName;
        RaiseAll();
        Dashboard.Reload();
        Find.LanguageChanged();
        SyncPage.Reload();
        SettingsPage.LanguageChanged();
    }

    internal async Task StartAsync()
    {
        HospitalName = LocalHospitalName() ?? _app.Settings.LastHospital ?? "";
        Dashboard.Reload();
        _engine = new SyncEngine(Sync, Store, _app.Clock) { LongPollSeconds = _app.LongPollSeconds, RetryDelay = _app.RetryDelay };
        _engine.Changed += () => _app.Ui.Post(Refresh);
        _engine.SyncedAfterOffline += n => _app.Ui.Post(() => Notify(S.Synced(n)));
        _engine.LiveCheckIns += list => _app.Ui.Post(() => { foreach (var b in list) Notify(S.Live(b.PatientName ?? b.Ref)); });
        _engine.Conflicts += list => _app.Ui.Post(() =>
        {
            foreach (var (reference, kept) in list)
                Notify(S.Conflict(Store.ByRef(reference)?.PatientName ?? reference, Dashboard.Clock(kept)));
        });
        _engine.Refused += e => _app.Ui.Post(() => _ = RefusedAsync(e));
        // Register this PC once (shared by every user of the PC); the server checks it on every pull and push.
        try
        {
            if (Sync.DeviceId is null)
            {
                var name = _app.Settings.DeviceName ?? AppController.DefaultDeviceName();
                _app.RememberDevice(await Sync.RegisterAsync(name));
            }
        }
        catch (HttpRequestException) { /* offline: registers on the next start */ }
        catch (SyncRefusedException e) { await RefusedAsync(e); return; }
        if (Sync.DeviceId is not null) _engine.Start();
        Refresh();
    }

    private async Task RefusedAsync(SyncRefusedException e)
    {
        if (e.Code == "DEVICE_REVOKED")
        {
            Sync.ForgetDevice();
            _app.ForgetDevice();
            await _app.SignOutAsync(S.DeviceRevoked);
        }
        else await _app.SignOutAsync(S.SessionEnded);
    }

    /// <summary>A local change (check-in, correction): show it now and push it at once.</summary>
    internal void LocalChange()
    {
        Refresh();
        _engine?.Nudge();
    }

    internal void Refresh()
    {
        if (LocalHospitalName() is { Length: > 0 } h && h != HospitalName)
        {
            HospitalName = h;
            _app.RememberHospital(h, User, Token);
            Raise(nameof(HospitalName));
        }
        Raise(nameof(Connection)); Raise(nameof(PillText)); Raise(nameof(OfflineBanner)); Raise(nameof(PendingCount)); Raise(nameof(HasPending));
        Dashboard.Reload();
        SyncPage.Reload();
    }

    internal async Task<bool> SyncNowAsync()
    {
        if (_engine is null) return false;
        try { return await _engine.RoundAsync(0, CancellationToken.None); }
        catch (HttpRequestException) { return false; }
        catch (SyncRefusedException e) { await RefusedAsync(e); return false; }
        finally { Refresh(); }
    }

    internal DateTimeOffset? LastSyncAt => _engine?.LastSyncAt;

    private string? LocalHospitalName() => Store.Get(_app.Lang switch { Lang.En => "hospital_name_en", Lang.Tr => "hospital_name_tr", _ => "hospital_name_ar" }) is { Length: > 0 } n ? n : null;

    public async Task StopAsync()
    {
        if (_engine is not null) { await _engine.DisposeAsync(); _engine = null; }
    }

    /// <summary>First click warns if check-ins are still waiting; the second signs out (they stay on this PC, encrypted).</summary>
    public async Task SignOutAsync()
    {
        if (PendingCount > 0 && Connection != Connection.Offline) await SyncNowAsync();
        if (PendingCount > 0 && !SignOutWarning) { SignOutWarning = true; return; }
        SignOutWarning = false;
        await _app.SignOutAsync();
    }
}

/// <summary>Find booking: by the full booking number only (no name search here), in the local copy.</summary>
public sealed class FindViewModel : Observable
{
    private readonly MainViewModel _m;
    private string _query = "", _message = "";

    internal FindViewModel(MainViewModel m)
    {
        _m = m;
        FindCommand = new Command(Run);
    }

    public string Query { get => _query; set => Set(ref _query, value); }
    public string Message { get => _message; private set => Set(ref _message, value); }
    public Command FindCommand { get; }

    internal void LanguageChanged() { Message = ""; RaiseAll(); }

    public void Run()
    {
        var q = Query.Trim().ToUpperInvariant();
        if (!System.Text.RegularExpressions.Regex.IsMatch(q, "^ML-[A-Z0-9]{6}$")) { Message = _m.S.FindFormat; return; }
        var b = _m.Store.ByRef(q);
        if (b is null) { Message = _m.S.FindNone; return; }
        Message = "";
        // Opens the booking on the appointments page, on its own day.
        _m.Dashboard.Open(b);
        _m.Page = 0;
    }
}

public sealed record RejectedRow(string Ref, string Reason);

public sealed class SyncPageViewModel : Observable
{
    private readonly MainViewModel _m;
    private bool _busy;

    internal SyncPageViewModel(MainViewModel m)
    {
        _m = m;
        SyncNowCommand = new Command(() => _ = RunAsync(), () => !_busy);
    }

    public Command SyncNowCommand { get; }
    public int Pending => _m.Store.PendingCount();
    public string LastSync => _m.LastSyncAt is { } t ? _m.Dashboard.DateTime(t) : _m.S.Never;
    public bool HasNoRejected => Rejected.Count == 0;
    public IReadOnlyList<RejectedRow> Rejected => _m.Store.Rejected()
        .Select(r => new RejectedRow(r.Ref ?? "—", _m.S.RejectCodes.GetValueOrDefault(r.Code, r.Code))).ToList();

    internal void Reload() => RaiseAll();

    private async Task RunAsync()
    {
        _busy = true; SyncNowCommand.Refresh();
        try { await _m.SyncNowAsync(); }
        finally { _busy = false; _m.App.Ui.Post(() => { SyncNowCommand.Refresh(); Reload(); }); }
    }
}

public sealed class SettingsViewModel : Observable
{
    private readonly MainViewModel _m;

    internal SettingsViewModel(MainViewModel m)
    {
        _m = m;
        LanguageCommand = new Command(p => _m.App.SetLanguage(Enum.Parse<Lang>(Convert.ToString(p, CultureInfo.InvariantCulture)!)));
    }

    public Command LanguageCommand { get; }
    public Lang Language => _m.App.Lang;
    public string DeviceName => _m.App.Settings.DeviceName ?? AppController.DefaultDeviceName();
    public string DeviceId => _m.Sync.DeviceId ?? "—";
    public string Server => _m.App.Settings.Server;
    public string Version => _m.App.Version;

    internal void LanguageChanged() => RaiseAll();
}
