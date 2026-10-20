using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace MedLink.Sync;

/// <summary>Protects the local database key at rest. On Windows this is DPAPI, bound to the signed-in Windows user.</summary>
public interface IKeyProtector
{
    byte[] Protect(byte[] plain);
    byte[] Unprotect(byte[] protectedBytes);
}

[SupportedOSPlatform("windows")]
public sealed class DpapiKeyProtector : IKeyProtector
{
    private static readonly byte[] Entropy = "medlink/local-db/v1"u8.ToArray();
    public byte[] Protect(byte[] plain) => ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] protectedBytes) => ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
}
