using System.Net;
using System.Security.Cryptography;
using MedLink.App;

namespace MedLink.Api.Tests;

/// <summary>Windows app updates: only a newer MSIX, described by an update.json signed with the owner's Ed25519 key, is installed.</summary>
public sealed class UpdateTests : IDisposable
{
    private static readonly Uri Feed = new("https://downloads.medlink.test/windows/");
    private readonly string temp = Path.Combine(Path.GetTempPath(), "medlink-update-" + Guid.NewGuid().ToString("N"));
    private readonly (byte[] Priv, byte[] Pub) key = UpdateSigning.Generate();
    private readonly Dictionary<string, byte[]> files = new();
    private readonly FakeInstaller installer = new();
    public void Dispose() { if (Directory.Exists(temp)) Directory.Delete(temp, true); }

    private sealed class FakeInstaller : IPackageInstaller
    {
        public bool IsPackaged { get; set; } = true;
        public List<byte[]> Installed { get; } = [];
        public Task InstallOnNextStartAsync(string msixPath, CancellationToken ct) { Installed.Add(File.ReadAllBytes(msixPath)); return Task.CompletedTask; }
    }

    private sealed class Server(Dictionary<string, byte[]> files) : HttpMessageHandler
    {
        public bool Down { get; set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            if (Down) throw new HttpRequestException("network down");
            return Task.FromResult(files.TryGetValue(r.RequestUri!.AbsolutePath, out var b)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(b) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    /// <summary>Publishes like medlink-update publish: the MSIX, update.json and its signature.</summary>
    private byte[] Publish(string version, byte[]? msix = null, byte[]? signWith = null, Func<UpdateManifest, UpdateManifest>? edit = null)
    {
        msix ??= RandomNumberGenerator.GetBytes(200_000);
        var name = $"MEDLINK-{version}.msix";
        var m = new UpdateManifest("MEDLINK", version, name, msix.Length, Convert.ToHexString(SHA256.HashData(msix)).ToLowerInvariant());
        if (edit is not null) m = edit(m);
        var bytes = m.ToBytes();
        files["/windows/" + name] = msix;
        files["/windows/update.json"] = bytes;
        files["/windows/update.json.sig"] = System.Text.Encoding.ASCII.GetBytes(UpdateSigning.Sign(bytes, signWith ?? key.Priv));
        return msix;
    }

    private Updater Updater(string current = "0.9.0", Uri? feed = null, Server? server = null) =>
        new(feed ?? Feed, key.Pub, current, installer, temp, () => server ?? new Server(files));

    [Fact(DisplayName = "Updates: a newer version signed with the owner's key is downloaded, checked and handed to Windows")]
    public async Task NewerSignedVersionIsInstalled()
    {
        var msix = Publish("0.9.1");
        var u = Updater();
        Assert.Equal(new UpdateResult("ready", "0.9.1"), await u.CheckOnceAsync());
        Assert.Equal("0.9.1", u.ReadyVersion);
        Assert.Equal(msix, Assert.Single(installer.Installed));
        // Once ready, it is not downloaded again.
        Assert.Equal("ready", (await u.CheckOnceAsync()).Outcome);
        Assert.Single(installer.Installed);
    }

    [Fact(DisplayName = "Updates: the same or an older version is never installed (no downgrade)")]
    public async Task NoDowngrade()
    {
        Publish("0.9.0");
        Assert.Equal("none", (await Updater().CheckOnceAsync()).Outcome);
        Publish("0.8.5");
        Assert.Equal("none", (await Updater().CheckOnceAsync()).Outcome);
        Assert.Empty(installer.Installed);
    }

    [Fact(DisplayName = "Updates: a manifest signed with another key, edited after signing, or naming another path is rejected")]
    public async Task ForgedManifestsAreRejected()
    {
        Publish("0.9.1", signWith: UpdateSigning.Generate().PrivateKey);
        Assert.Equal(new UpdateResult("rejected", Reason: "signature"), await Updater().CheckOnceAsync());

        Publish("0.9.1");
        files["/windows/update.json"] = System.Text.Encoding.UTF8.GetBytes(System.Text.Encoding.UTF8.GetString(files["/windows/update.json"]).Replace("0.9.1", "9.9.9"));
        Assert.Equal(new UpdateResult("rejected", Reason: "signature"), await Updater().CheckOnceAsync());

        files["/windows/update.json.sig"] = "not base64 at all"u8.ToArray();
        Assert.Equal(new UpdateResult("rejected", Reason: "signature"), await Updater().CheckOnceAsync());

        // Correctly signed, but not a valid MEDLINK manifest.
        Publish("0.9.1", edit: m => m with { File = "../MEDLINK-0.9.1.msix" });
        Assert.Equal(new UpdateResult("rejected", Reason: "manifest"), await Updater().CheckOnceAsync());
        Publish("0.9.1", edit: m => m with { Product = "OTHER" });
        Assert.Equal(new UpdateResult("rejected", Reason: "manifest"), await Updater().CheckOnceAsync());
        Assert.Empty(installer.Installed);
    }

    [Fact(DisplayName = "Updates: an MSIX that does not match the signed size and SHA-256 is deleted, not installed")]
    public async Task TamperedPackageIsRejected()
    {
        var msix = Publish("0.9.1");
        var tampered = (byte[])msix.Clone();
        tampered[1000] ^= 0xFF;
        files["/windows/MEDLINK-0.9.1.msix"] = tampered;
        Assert.Equal(new UpdateResult("rejected", "0.9.1", "sha256"), await Updater().CheckOnceAsync());
        files["/windows/MEDLINK-0.9.1.msix"] = [.. msix, 1, 2, 3];
        Assert.Equal(new UpdateResult("rejected", "0.9.1", "size"), await Updater().CheckOnceAsync());
        Assert.Empty(installer.Installed);
        Assert.Empty(Directory.Exists(temp) ? Directory.GetFiles(temp) : []);
    }

    [Fact(DisplayName = "Updates: off for development builds, without a public key, or with a plain-HTTP feed; no feed or no network changes nothing")]
    public async Task DisabledAndOffline()
    {
        Publish("0.9.1");
        installer.IsPackaged = false;
        Assert.Equal("disabled", (await Updater().CheckOnceAsync()).Outcome);
        installer.IsPackaged = true;
        Assert.Equal("disabled", (await new Updater(Feed, null, "0.9.0", installer, temp, () => new Server(files)).CheckOnceAsync()).Outcome);
        Assert.Equal("disabled", (await Updater(feed: new Uri("http://downloads.medlink.test/windows/")).CheckOnceAsync()).Outcome);
        Assert.True(Updater(feed: new Uri("http://127.0.0.1:8099/windows/")).Enabled);

        Assert.Equal("error", (await Updater(server: new Server(files) { Down = true }).CheckOnceAsync()).Outcome);
        files.Clear();
        Assert.Equal("none", (await Updater().CheckOnceAsync()).Outcome);
        Assert.Empty(installer.Installed);
    }
}
