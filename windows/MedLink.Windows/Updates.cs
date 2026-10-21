using System.IO;
using System.Reflection;
using Windows.Management.Deployment;
using MedLink.App;

namespace MedLink.Windows;

/// <summary>Registers a downloaded, verified MSIX with Windows; it is applied when MEDLINK is not running.</summary>
public sealed class PackageInstaller : IPackageInstaller
{
    public bool IsPackaged
    {
        get
        {
            try { return global::Windows.ApplicationModel.Package.Current is not null; }
            catch (InvalidOperationException) { return false; } // not running as a package (development build)
        }
    }

    public async Task InstallOnNextStartAsync(string msixPath, CancellationToken ct)
    {
        // Windows also checks that the package is signed by the same publisher (the hospital-trusted certificate).
        var result = await new PackageManager().AddPackageByUriAsync(new Uri(msixPath),
            new AddPackageOptions { DeferRegistrationWhenPackagesAreInUse = true }).AsTask(ct);
        if (result.ExtendedErrorCode is not null) throw new IOException(result.ErrorText, result.ExtendedErrorCode);
    }
}

internal static class UpdateConfig
{
    private static string? Meta(string key) =>
        Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == key)?.Value;

    /// <summary>The updater with the built-in public key; feedOverride is only for tests (the signature still decides).</summary>
    public static Updater Create(string version, string? feedOverride)
    {
        byte[]? key = null;
        try { if (Meta("UpdatePublicKey") is { Length: > 0 } k) key = Convert.FromBase64String(k); }
        catch (FormatException) { }
        var feed = feedOverride ?? Meta("UpdateFeed");
        var temp = Path.Combine(Path.GetTempPath(), "MEDLINK-update");
        return new Updater(feed is { Length: > 0 } ? new Uri(feed.EndsWith('/') ? feed : feed + "/") : null, key, version, new PackageInstaller(), temp);
    }
}
