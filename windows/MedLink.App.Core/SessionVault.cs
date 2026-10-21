using System.Text.Json;
using MedLink.Sync;

namespace MedLink.App;

/// <summary>
/// The saved session (owner's decision: stay signed in within the server's limits — 12 h idle, 7 days at most).
/// The bearer token and the user it belongs to are stored in one file, protected by DPAPI for the Windows user.
/// The server stays the authority: the token is checked again at every start.
/// </summary>
public sealed class SessionVault(string path, IKeyProtector protector)
{
    public sealed record Saved(string Token, UserInfo User, string? HospitalName);

    public Saved? Load()
    {
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<Saved>(protector.Unprotect(File.ReadAllBytes(path))); }
        catch (Exception e) when (e is JsonException or System.Security.Cryptography.CryptographicException or IOException) { Clear(); return null; }
    }

    public void Save(Saved s)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, protector.Protect(JsonSerializer.SerializeToUtf8Bytes(s)));
    }

    public void Clear() { if (File.Exists(path)) File.Delete(path); }
}
