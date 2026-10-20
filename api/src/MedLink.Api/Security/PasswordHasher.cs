using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace MedLink.Api.Security;

/// <summary>
/// Argon2id password hashing in PHC string format:
/// <c>$argon2id$v=19$m=65536,t=3,p=1$&lt;salt&gt;$&lt;hash&gt;</c>.
/// </summary>
public sealed class PasswordHasher
{
    public const int MinLength = 10;
    public const int MaxLength = 128;

    // BACKEND-SPEC §3: memory >= 64 MiB, iterations >= 3, parallelism 1-2.
    public int MemoryKiB { get; init; } = 65536;
    public int Iterations { get; init; } = 3;
    public int Parallelism { get; init; } = 1;
    private const int SaltBytes = 16, HashBytes = 32;

    private readonly Lazy<string> _dummy;

    public PasswordHasher()
    {
        _dummy = new Lazy<string>(() => Hash(Tokens.NewToken()));
    }

    public string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Compute(password, salt, MemoryKiB, Iterations, Parallelism, HashBytes);
        return $"$argon2id$v=19$m={MemoryKiB},t={Iterations},p={Parallelism}${B64(salt)}${B64(hash)}";
    }

    public bool Verify(string password, string? phc, out bool needsRehash)
    {
        needsRehash = false;
        if (phc is null)
        {
            // Spend the same time as a real check so unknown users are not distinguishable by timing.
            Verify(password, _dummy.Value, out _);
            return false;
        }
        var parts = phc.Split('$');
        if (parts.Length != 6 || parts[1] != "argon2id" || parts[2] != "v=19") return false;
        int m = 0, t = 0, p = 0;
        foreach (var kv in parts[3].Split(','))
        {
            var (k, v) = (kv[..1], int.Parse(kv[2..]));
            if (k == "m") m = v; else if (k == "t") t = v; else if (k == "p") p = v;
        }
        var salt = UnB64(parts[4]);
        var expected = UnB64(parts[5]);
        var actual = Compute(password, salt, m, t, p, expected.Length);
        var ok = CryptographicOperations.FixedTimeEquals(actual, expected);
        needsRehash = ok && (m != MemoryKiB || t != Iterations || p != Parallelism);
        return ok;
    }

    /// <summary>Returns an error code, or null if the password is acceptable.</summary>
    public static string? Validate(string? password, string email)
    {
        if (password is null || password.Length < MinLength) return "PASSWORD_TOO_SHORT";
        if (password.Length > MaxLength) return "PASSWORD_TOO_LONG";
        if (password.Contains(email.Split('@')[0], StringComparison.OrdinalIgnoreCase) && email.Split('@')[0].Length >= 4)
            return "PASSWORD_CONTAINS_EMAIL";
        if (password.Distinct().Count() < 4) return "PASSWORD_TOO_SIMPLE";
        return null;
    }

    private static byte[] Compute(string password, byte[] salt, int m, int t, int p, int len)
    {
        using var a = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt, MemorySize = m, Iterations = t, DegreeOfParallelism = p,
        };
        return a.GetBytes(len);
    }

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=');
    private static byte[] UnB64(string s) => Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
}
