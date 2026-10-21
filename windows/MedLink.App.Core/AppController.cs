using System.Security.Cryptography;
using System.Text;
using MedLink.Sync;

namespace MedLink.App;

public enum Screen { Splash, SignIn, Main }

/// <summary>Where this PC keeps MEDLINK's files (%LOCALAPPDATA%\MEDLINK on Windows).</summary>
public sealed class AppPaths(string root)
{
    public string Root => root;
    public string Settings => Path.Combine(root, "settings.json");
    public string Session => Path.Combine(root, "session.bin");
    /// <summary>One encrypted database per MEDLINK user, so one user never sees another user's cached data (e.g. a doctor after reception).</summary>
    public string Database(string userId) =>
        Path.Combine(root, "local-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId)))[..16].ToLowerInvariant() + ".db");
}

/// <summary>
/// The app's top level: splash → sign-in → main screen; the saved session; one local database per user; sign-out.
/// The WPF window binds to this object and to the view models it exposes.
/// </summary>
public sealed class AppController : Observable
{
    private readonly AppPaths _paths;
    private readonly IKeyProtector _protector;
    private readonly IUi _ui;
    private readonly TimeProvider _clock;
    private readonly SessionVault _vault;
    private readonly Func<HttpMessageHandler> _handler;
    private Screen _screen = Screen.Splash;
    private MainViewModel? _main;

    /// <summary>Long-poll length and offline retry delay (shorter in tests).</summary>
    public int LongPollSeconds { get; init; } = 25;
    public TimeSpan RetryDelay { get; init; } = TimeSpan.FromSeconds(5);

    public AppSettings Settings { get; }
    public ILauncher Launcher { get; }
    public string Version { get; }
    public HttpClient Http { get; }
    public AuthClient Auth { get; }
    public SignInViewModel SignIn { get; }

    public AppController(AppPaths paths, IKeyProtector protector, IUi ui, ILauncher launcher, TimeProvider clock, string version,
        Func<HttpMessageHandler>? handler = null, string? serverOverride = null)
    {
        _paths = paths; _protector = protector; _ui = ui; _clock = clock; Launcher = launcher; Version = version;
        _handler = handler ?? (() => new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) });
        Settings = AppSettings.Load(paths.Settings);
        if (serverOverride is not null) { Settings.Server = serverOverride; SaveSettings(); }
        _vault = new SessionVault(paths.Session, protector);
        // Longer than the 25-second long-poll.
        Http = new HttpClient(_handler(), disposeHandler: true) { BaseAddress = new Uri(Settings.Server), Timeout = TimeSpan.FromSeconds(40) };
        Auth = new AuthClient(Http);
        SignIn = new SignInViewModel(this);
    }

    public Screen Screen { get => _screen; private set => Set(ref _screen, value); }
    public MainViewModel? Main { get => _main; private set => Set(ref _main, value); }
    public Lang Lang => Settings.Language;
    public Strings S => Strings.For(Settings.Language);
    public bool Rtl => Settings.Language == Lang.Ar;
    public TimeProvider Clock => _clock;
    public IUi Ui => _ui;

    public void SetLanguage(Lang l)
    {
        if (Settings.Language == l) return;
        Settings.Language = l;
        SaveSettings();
        RaiseAll();
        SignIn.LanguageChanged();
        Main?.LanguageChanged();
    }

    internal void SaveSettings() => Settings.Save(_paths.Settings);

    /// <summary>Called when the splash finishes: reopen a saved session, or show sign-in.</summary>
    public async Task SplashDoneAsync()
    {
        var saved = _vault.Load();
        if (saved is null) { await ShowSignInAsync(null); return; }
        var (user, offline) = await Auth.MeAsync(saved.Token);
        if (user is not null) { await OpenAsync(saved.Token, user, saved.HospitalName); return; }
        if (offline)
        {
            // Offline start: open the local copy with the saved user. Buttons follow the saved permissions; the server re-checks every event.
            await OpenAsync(saved.Token, saved.User, saved.HospitalName);
            return;
        }
        _vault.Clear();
        await ShowSignInAsync(S.SessionEnded);
    }

    internal async Task ShowSignInAsync(string? message)
    {
        Screen = Screen.SignIn;
        SignIn.Reset(message);
        await SignIn.CheckConnectionAsync();
    }

    /// <summary>A successful sign-in (or a restored session): open this user's local database and start syncing.</summary>
    internal async Task<string?> OpenAsync(string token, UserInfo user, string? hospitalName)
    {
        if (!user.CanUseWindowsApp) { await Auth.LogoutAsync(token); _vault.Clear(); return S.NotForWindows; }
        Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var store = LocalStore.Open(_paths.Database(user.Id), _protector);
        var sync = new SyncClient(Http, store, _clock);
        if (Settings.DeviceId is { Length: > 0 } dev && sync.DeviceId is null) sync.UseDevice(dev);
        Settings.LastEmail = user.Email;
        SaveSettings();
        _vault.Save(new SessionVault.Saved(token, user, hospitalName));
        var main = new MainViewModel(this, user, token, store, sync);
        Main = main;
        Screen = Screen.Main;
        await main.StartAsync();
        return null;
    }

    internal void RememberDevice(string deviceId)
    {
        Settings.DeviceId = deviceId;
        Settings.DeviceName ??= DefaultDeviceName();
        SaveSettings();
    }

    internal void ForgetDevice()
    {
        Settings.DeviceId = null;
        SaveSettings();
    }

    internal void RememberHospital(string name, UserInfo user, string token)
    {
        if (Settings.LastHospital == name) return;
        Settings.LastHospital = name;
        SaveSettings();
        _vault.Save(new SessionVault.Saved(token, user, name));
    }

    public static string DefaultDeviceName()
    {
        var n = Environment.MachineName;
        return n.Length > 80 ? n[..80] : n;
    }

    /// <summary>
    /// Sign out: send what is pending if possible, end the server session, and delete this user's local copy when nothing
    /// is left to send. If check-ins are still waiting (offline), the encrypted copy stays and is sent at the next sign-in.
    /// </summary>
    internal async Task SignOutAsync(string? message = null)
    {
        var main = Main;
        if (main is not null)
        {
            await main.StopAsync();
            await Auth.LogoutAsync(main.Token);
            var pending = main.Store.PendingCount();
            main.Store.Dispose();
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            if (pending == 0) DeleteDatabase(main.User.Id);
        }
        Http.DefaultRequestHeaders.Authorization = null;
        _vault.Clear();
        Main = null;
        await ShowSignInAsync(message);
    }

    private void DeleteDatabase(string userId)
    {
        var db = _paths.Database(userId);
        foreach (var f in new[] { db, db + ".key", db + "-wal", db + "-shm" })
            if (File.Exists(f)) File.Delete(f);
    }
}
