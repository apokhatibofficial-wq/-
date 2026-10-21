using System.Diagnostics;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using MedLink.App;
using MedLink.Sync;

namespace MedLink.Windows;

public partial class App : Application
{
    private readonly CancellationTokenSource _stop = new();

    protected override void OnExit(ExitEventArgs e)
    {
        _stop.Cancel();
        base.OnExit(e);
    }

    /// <summary>`MEDLINK.exe --update-check &lt;file&gt; [--update-feed &lt;url&gt;]`: one update check without a window (CI), result written to the file.</summary>
    private async Task UpdateCheckAsync(Updater updater, string resultFile)
    {
        UpdateResult r;
        try { r = await updater.CheckOnceAsync(); }
        catch (Exception ex) { r = new UpdateResult("error", Reason: ex.GetType().Name + ": " + ex.Message); }
        System.IO.File.WriteAllText(resultFile, $"{r.Outcome} {r.Version} {r.Reason} packaged={new PackageInstaller().IsPackaged} version={Version}".Trim());
        Shutdown(r.Outcome == "ready" ? 0 : 1);
    }

    public static string Version => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        string? server = null, smoke = null, feed = null, updateCheck = null;
        for (var i = 0; i < e.Args.Length - 1; i++)
        {
            if (e.Args[i] == "--server") server = e.Args[i + 1];
            if (e.Args[i] == "--smoke") smoke = e.Args[i + 1];
            if (e.Args[i] == "--update-feed") feed = e.Args[i + 1];
            if (e.Args[i] == "--update-check") updateCheck = e.Args[i + 1];
        }
        if (smoke is not null) { _ = Smoke.RunAsync(this, smoke); return; }
        var updater = UpdateConfig.Create(Version, feed);
        if (updateCheck is not null) { _ = UpdateCheckAsync(updater, updateCheck); return; }
        _ = updater.RunAsync(TimeProvider.System, _stop.Token);

        var root = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MEDLINK");
        var app = new AppController(new AppPaths(root), new DpapiKeyProtector(), new WpfUi(Dispatcher), new ShellLauncher(), TimeProvider.System,
            Version, serverOverride: server) { Updater = updater, Quit = Shutdown };
        var window = new MainWindow(app);
        MainWindow = window;
        window.Show();
    }
}

/// <summary>Posts view-model updates from the sync thread to the UI thread.</summary>
public sealed class WpfUi(Dispatcher dispatcher) : IUi
{
    public void Post(Action a)
    {
        if (dispatcher.CheckAccess()) a();
        else dispatcher.BeginInvoke(a);
    }
}

/// <summary>Opens https links (WhatsApp) in the default browser. Nothing else is ever launched.</summary>
public sealed class ShellLauncher : ILauncher
{
    public void Open(string url)
    {
        if (!url.StartsWith("https://wa.me/", StringComparison.Ordinal)) return;
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
