using System.Security.Cryptography;
using MedLink.App;

// medlink-update keygen <private-key-file>
//   Creates the key pair. Keep the private key file offline (with the backup key); put the printed public key in
//   .env as UPDATE_SIGNING_PUBLIC_KEY and pass it to build-msix.ps1.
// medlink-update publish <MEDLINK-x.y.z.msix> <version> <private-key-file> <feed-dir>
//   Copies the MSIX into the feed folder and writes update.json and update.json.sig next to it.
// medlink-update verify <feed-dir> <public-key-base64>
//   Checks a feed folder as the app would (signature, manifest, size, SHA-256).
try
{
    return args switch
    {
        ["keygen", var keyFile] => KeyGen(keyFile),
        ["publish", var msix, var version, var keyFile, var feed] => Publish(msix, version, keyFile, feed),
        ["verify", var feed, var publicKey] => Verify(feed, publicKey),
        _ => Usage(),
    };
}
catch (Exception e) when (e is IOException or UnauthorizedAccessException or FormatException or ArgumentException)
{
    Console.Error.WriteLine("error: " + e.Message);
    return 1;
}

static int Usage()
{
    Console.Error.WriteLine("usage: medlink-update keygen <key-file> | publish <msix> <version> <key-file> <feed-dir> | verify <feed-dir> <public-key>");
    return 2;
}

static int KeyGen(string keyFile)
{
    if (File.Exists(keyFile)) { Console.Error.WriteLine($"{keyFile} exists already: refusing to overwrite a signing key"); return 1; }
    var (priv, pub) = UpdateSigning.Generate();
    var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
    if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite; // readable by the owner only
    using (var w = new StreamWriter(keyFile, options))
        w.Write(Convert.ToBase64String(priv));
    Console.WriteLine("private key written to " + keyFile + " (keep it offline; never on the server or in the repository)");
    Console.WriteLine("UPDATE_SIGNING_PUBLIC_KEY=" + Convert.ToBase64String(pub));
    return 0;
}

static byte[] ReadKey(string keyFile)
{
    var key = Convert.FromBase64String(File.ReadAllText(keyFile).Trim());
    if (key.Length != 32) throw new FormatException("not an Ed25519 private key");
    return key;
}

static int Publish(string msix, string version, string keyFile, string feed)
{
    if (!Version.TryParse(version, out var v) || v.Build < 0 || v.Revision >= 0) { Console.Error.WriteLine("version must be x.y.z"); return 1; }
    var key = ReadKey(keyFile);
    Directory.CreateDirectory(feed);
    var name = $"MEDLINK-{version}.msix";
    var target = Path.Combine(feed, name);
    File.Copy(msix, target, overwrite: true);
    byte[] hash;
    using (var s = File.OpenRead(target)) hash = SHA256.HashData(s);
    var manifest = new UpdateManifest("MEDLINK", version, name, new FileInfo(target).Length, Convert.ToHexString(hash).ToLowerInvariant());
    var bytes = manifest.ToBytes();
    File.WriteAllBytes(Path.Combine(feed, "update.json"), bytes);
    File.WriteAllText(Path.Combine(feed, "update.json.sig"), UpdateSigning.Sign(bytes, key));
    Console.WriteLine($"published {name} ({manifest.Size} bytes, sha256 {manifest.Sha256}); public key {Convert.ToBase64String(UpdateSigning.PublicKeyOf(key))}");
    return 0;
}

static int Verify(string feed, string publicKey)
{
    var bytes = File.ReadAllBytes(Path.Combine(feed, "update.json"));
    if (!UpdateSigning.Verify(bytes, File.ReadAllText(Path.Combine(feed, "update.json.sig")), Convert.FromBase64String(publicKey)))
    { Console.Error.WriteLine("signature does NOT match this public key"); return 1; }
    var m = UpdateManifest.Parse(bytes);
    if (m is null) { Console.Error.WriteLine("update.json is not a valid MEDLINK manifest"); return 1; }
    var file = Path.Combine(feed, m.File);
    byte[] hash;
    using (var s = File.OpenRead(file)) hash = SHA256.HashData(s);
    if (new FileInfo(file).Length != m.Size || !Convert.ToHexString(hash).Equals(m.Sha256, StringComparison.OrdinalIgnoreCase))
    { Console.Error.WriteLine($"{m.File} does not match update.json"); return 1; }
    Console.WriteLine($"OK: MEDLINK {m.Version}, {m.File}, signature and checksum valid");
    return 0;
}
