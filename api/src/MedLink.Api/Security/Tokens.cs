using System.Security.Cryptography;
using System.Text;

namespace MedLink.Api.Security;

public static class Tokens
{
    /// <summary>A 256-bit random token, base64url without padding (43 chars).</summary>
    public static string NewToken() => Base64Url(RandomNumberGenerator.GetBytes(32));

    public static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    public static string Base64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static string Hmac(byte[] key, string message) =>
        Base64Url(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(message)));

    public static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}

public static class Ids
{
    public static string Hospital() => "hsp_" + Ulid.NewUlid();
    public static string User() => "usr_" + Ulid.NewUlid();
    public static string Session() => "ses_" + Ulid.NewUlid();
    public static string Link() => "otl_" + Ulid.NewUlid();
}
