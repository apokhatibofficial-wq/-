using System.Diagnostics;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using MedLink.App;
using MedLink.Sync;

namespace MedLink.Windows;

public partial class App : Application
{
    public static string Version => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        string? server = null, smoke = null;
        for (var i = 0; i < e.Args.Length - 1; i++)
        {
            if (e.Args[i] == "--server") server = e.Args[i + 1];
            if (e.Args[i] == "--smoke") smoke = e.Args[i + 1];
        }
        if (smoke is not null) { _ = Smoke.RunAsync(this, smoke); return; }

        var root = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MEDLINK");
        var app = new AppController(new AppPaths(root), new DpapiKeyProtector(), new WpfUi(Dispatcher), new ShellLauncher(), TimeProvider.System,
            Version, serverOverride: server);
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
