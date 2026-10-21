using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace MedLink.App;

/// <summary>
/// Ed25519 signatures for app updates (BACKEND-SPEC §2). The owner keeps the private key offline and signs each
/// release's update.json with MedLink.UpdateTool; the app carries only the public key.
/// </summary>
public static class UpdateSigning
{
    public static (byte[] PrivateKey, byte[] PublicKey) Generate()
    {
        var priv = new Ed25519PrivateKeyParameters(new SecureRandom());
        return (priv.GetEncoded(), priv.GeneratePublicKey().GetEncoded());
    }

    public static byte[] PublicKeyOf(byte[] privateKey) => new Ed25519PrivateKeyParameters(privateKey).GeneratePublicKey().GetEncoded();

    public static string Sign(byte[] data, byte[] privateKey)
    {
        var s = new Ed25519Signer();
        s.Init(true, new Ed25519PrivateKeyParameters(privateKey));
        s.BlockUpdate(data, 0, data.Length);
        return Convert.ToBase64String(s.GenerateSignature());
    }

    public static bool Verify(byte[] data, string signatureBase64, byte[] publicKey)
    {
        byte[] sig;
        try { sig = Convert.FromBase64String(signatureBase64.Trim()); }
        catch (FormatException) { return false; }
        if (sig.Length != 64 || publicKey.Length != 32) return false;
        var v = new Ed25519Signer();
        v.Init(false, new Ed25519PublicKeyParameters(publicKey));
        v.BlockUpdate(data, 0, data.Length);
        return v.VerifySignature(sig);
    }
}

/// <summary>update.json, published next to the MSIX with its signature in update.json.sig.</summary>
public sealed record UpdateManifest(string Product, string Version, string File, long Size, string Sha256)
{
    public const long MaxSize = 500L * 1024 * 1024;
    private static readonly Regex FileName = new(@"^MEDLINK-[0-9]+\.[0-9]+\.[0-9]+\.msix$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    public byte[] ToBytes() => JsonSerializer.SerializeToUtf8Bytes(this, Json);

    /// <summary>Null when anything is off: another product, a file name with a path in it, an odd size or hash.</summary>
    public static UpdateManifest? Parse(byte[] bytes)
    {
        UpdateManifest? m;
        try { m = JsonSerializer.Deserialize<UpdateManifest>(bytes, Json); }
        catch (JsonException) { return null; }
        if (m is null || m.Product != "MEDLINK" || !System.Version.TryParse(m.Version, out _) || !FileName.IsMatch(m.File)
            || m.Size <= 0 || m.Size > MaxSize || m.Sha256.Length != 64 || !m.Sha256.All(Uri.IsHexDigit)) return null;
        return m;
    }
}

/// <summary>Installs a downloaded MSIX (Windows' PackageManager in the real app).</summary>
public interface IPackageInstaller
{
    /// <summary>True when MEDLINK runs as an installed package; a development build never updates itself.</summary>
    bool IsPackaged { get; }
    /// <summary>Registers the package; Windows applies it when MEDLINK is not running (next start).</summary>
    Task InstallOnNextStartAsync(string msixPath, CancellationToken ct);
}

public sealed record UpdateResult(string Outcome, string? Version = null, string? Reason = null)
{
    // Outcomes: "disabled", "none" (up to date), "ready", "rejected" (failed a check: nothing installed), "error" (network).
}

/// <summary>
/// Checks the signed update feed: verifies update.json against the built-in public key, takes only a newer version,
/// downloads the MSIX and checks its size and SHA-256 before handing it to Windows (which also checks the package's
/// certificate). Any failed check means nothing is installed.
/// </summary>
public sealed class Updater(Uri? feed, byte[]? publicKey, string currentVersion, IPackageInstaller installer, string tempDir,
    Func<HttpMessageHandler>? handler = null) : Observable
{
    private string? _readyVersion;

    public string? ReadyVersion { get => _readyVersion; private set => Set(ref _readyVersion, value); }
    public bool Enabled => feed is not null && publicKey is { Length: 32 } && installer.IsPackaged && SafeFeed(feed);

    /// <summary>HTTPS only; plain HTTP is accepted for this machine's own address (tests).</summary>
    private static bool SafeFeed(Uri u) => u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && u.IsLoopback);

    public async Task<UpdateResult> CheckOnceAsync(CancellationToken ct = default)
    {
        if (!Enabled) return new("disabled");
        if (ReadyVersion is not null) return new("ready", ReadyVersion);
        using var http = new HttpClient(handler?.Invoke() ?? new SocketsHttpHandler(), disposeHandler: true) { Timeout = TimeSpan.FromMinutes(10) };
        byte[] manifestBytes; string signature;
        try
        {
            manifestBytes = await http.GetByteArrayAsync(new Uri(feed!, "update.json"), ct);
            signature = await http.GetStringAsync(new Uri(feed!, "update.json.sig"), ct);
        }
        catch (HttpRequestException e) when (e.StatusCode == HttpStatusCode.NotFound) { return new("none"); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return new("error", Reason: e.GetType().Name); }

        if (manifestBytes.Length > 16 * 1024 || !UpdateSigning.Verify(manifestBytes, signature, publicKey!)) return new("rejected", Reason: "signature");
        var m = UpdateManifest.Parse(manifestBytes);
        if (m is null) return new("rejected", Reason: "manifest");
        if (System.Version.Parse(m.Version) <= System.Version.Parse(currentVersion)) return new("none", m.Version);

        Directory.CreateDirectory(tempDir);
        var path = Path.Combine(tempDir, m.File);
        try
        {
            using (var res = await http.GetAsync(new Uri(feed!, m.File), HttpCompletionOption.ResponseHeadersRead, ct))
            {
                res.EnsureSuccessStatusCode();
                await using var input = await res.Content.ReadAsStreamAsync(ct);
                await using var output = File.Create(path);
                using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[81920];
                long total = 0;
                int n;
                while ((n = await input.ReadAsync(buffer, ct)) > 0)
                {
                    total += n;
                    if (total > m.Size) { output.Close(); File.Delete(path); return new("rejected", m.Version, "size"); }
                    sha.AppendData(buffer, 0, n);
                    await output.WriteAsync(buffer.AsMemory(0, n), ct);
                }
                if (total != m.Size || !Convert.ToHexString(sha.GetHashAndReset()).Equals(m.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    output.Close(); File.Delete(path);
                    return new("rejected", m.Version, total != m.Size ? "size" : "sha256");
                }
            }
            await installer.InstallOnNextStartAsync(path, ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException)
        {
            if (File.Exists(path)) File.Delete(path);
            return new("error", m.Version, e.GetType().Name);
        }
        ReadyVersion = m.Version;
        return new("ready", m.Version);
    }

    /// <summary>Checks a minute after start, then every 6 hours, until an update is ready.</summary>
    public async Task RunAsync(TimeProvider clock, CancellationToken ct)
    {
        if (!Enabled) return;
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), clock, ct);
            while (ReadyVersion is null)
            {
                await CheckOnceAsync(ct);
                if (ReadyVersion is null) await Task.Delay(TimeSpan.FromHours(6), clock, ct);
            }
        }
        catch (OperationCanceledException) { }
    }
}
