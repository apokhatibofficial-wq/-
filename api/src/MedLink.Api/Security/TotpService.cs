using System.Security.Cryptography;
using MedLink.Api.Config;
using OtpNet;

namespace MedLink.Api.Security;

/// <summary>
/// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with secrets encrypted at rest using AES-256-GCM.
/// A code's time step is remembered so the same code cannot be replayed.
/// </summary>
public sealed class TotpService(MedLinkOptions options)
{
    public const string Issuer = "MEDLINK";

    public byte[] NewSecret() => KeyGeneration.GenerateRandomKey(20);

    public string ProvisioningUri(byte[] secret, string account) =>
        new OtpUri(OtpType.Totp, secret, account, Issuer).ToString();

    public static string Base32(byte[] secret) => Base32Encoding.ToString(secret);

    /// <summary>Returns the matched time step, or null. Rejects steps &lt;= <paramref name="lastStep"/>.</summary>
    public long? Verify(byte[] secret, string? code, long? lastStep)
    {
        if (code is null) return null;
        code = code.Replace(" ", "");
        if (code.Length != 6 || !code.All(char.IsAsciiDigit)) return null;
        var totp = new Totp(secret);
        if (!totp.VerifyTotp(code, out var step, new VerificationWindow(previous: 1, future: 1))) return null;
        if (lastStep is not null && step <= lastStep) return null;
        return step;
    }

    public byte[] Encrypt(byte[] secret)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[secret.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(options.TotpEncryptionKey, 16);
        aes.Encrypt(nonce, secret, cipher, tag);
        return [1, .. nonce, .. tag, .. cipher];
    }

    public byte[] Decrypt(byte[] blob)
    {
        if (blob.Length < 29 || blob[0] != 1) throw new CryptographicException("unknown TOTP blob version");
        var nonce = blob.AsSpan(1, 12);
        var tag = blob.AsSpan(13, 16);
        var cipher = blob.AsSpan(29);
        var plain = new byte[cipher.Length];
        using var aes = new AesGcm(options.TotpEncryptionKey, 16);
        aes.Decrypt(nonce, cipher, tag, plain);
        return plain;
    }
}
