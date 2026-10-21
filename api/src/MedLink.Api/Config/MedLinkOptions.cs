using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace MedLink.Api.Config;

/// <summary>
/// All runtime configuration, read from environment variables (see /.env.example).
/// Secrets are never given defaults: the process refuses to start if one is missing.
/// </summary>
public sealed class MedLinkOptions
{
    public required string AppConnectionString { get; init; }
    public required string OwnerConnectionString { get; init; }
    public required string? AppDbPassword { get; init; }

    /// <summary>HKDF-derived key for CSRF tokens and other HMACs.</summary>
    public required byte[] SessionSigningKey { get; init; }
    /// <summary>HKDF-derived AES-256 key for TOTP secrets at rest.</summary>
    public required byte[] TotpEncryptionKey { get; init; }
    public string? DataProtectionKeysPath { get; init; }

    public required string SmtpHost { get; init; }
    public int SmtpPort { get; init; }
    public string? SmtpUser { get; init; }
    public string? SmtpPassword { get; init; }
    public string SmtpTls { get; init; } = "none";
    public required string EmailFrom { get; init; }

    public required string AdminWebUrl { get; init; }
    public required string HospitalWebUrl { get; init; }
    public string[] CorsOrigins { get; init; } = [];
    public string[] TrustedProxies { get; init; } = [];
    public bool CookieSecure { get; init; } = true;
    public int AuthRatePerIp { get; init; } = 20;
    public int AuthRatePerNet24 { get; init; } = 60;
    public int BookingRatePerIp { get; init; } = 10;
    public int BookingRatePerHospital { get; init; } = 120;
    public int ScanRatePerIp { get; init; } = 60;
    /// <summary>Background jobs (no-show, cleanup, retention). Tests switch them off and call them directly.</summary>
    public bool JobsEnabled { get; init; } = true;

    public static MedLinkOptions FromConfiguration(IConfiguration c, bool requireApp = true, bool requireOwner = false)
    {
        var errors = new List<string>();
        string Req(string key)
        {
            var v = c[key];
            if (string.IsNullOrWhiteSpace(v)) { errors.Add(key); return ""; }
            return v;
        }
        string Opt(string key, string fallback) => string.IsNullOrWhiteSpace(c[key]) ? fallback : c[key]!;

        var host = Opt("DB_HOST", "localhost");
        var port = int.Parse(Opt("DB_PORT", "5432"));
        var db = Opt("DB_NAME", "medlink");
        var ownerUser = Opt("DB_OWNER_USER", "medlink_owner");
        var appPassword = requireApp ? Req("DB_APP_PASSWORD") : c["DB_APP_PASSWORD"];
        var ownerPassword = requireOwner ? Req("DB_PASSWORD") : c["DB_PASSWORD"];

        string Cs(string user, string? pw) => new NpgsqlConnectionStringBuilder
        {
            Host = host, Port = port, Database = db, Username = user, Password = pw,
            SslMode = Enum.Parse<SslMode>(Opt("DB_SSLMODE", "Disable"), true),
            MaxPoolSize = 30,
        }.ConnectionString;

        byte[] DeriveKey(string key, string info)
        {
            var raw = c[key];
            if (string.IsNullOrWhiteSpace(raw)) { errors.Add(key); return []; }
            byte[] material;
            try { material = Convert.FromBase64String(raw); }
            catch (FormatException) { errors.Add(key + " (must be base64)"); return []; }
            if (material.Length < 32) { errors.Add(key + " (needs at least 32 random bytes)"); return []; }
            return HKDF.DeriveKey(HashAlgorithmName.SHA256, material, 32, info: Encoding.UTF8.GetBytes(info));
        }

        var signing = requireApp ? DeriveKey("SESSION_SIGNING_KEY", "medlink/session-signing/v1") : [];
        var totp = requireApp ? DeriveKey("TOTP_ENC_KEY", "medlink/totp-at-rest/v1") : [];

        var opts = new MedLinkOptions
        {
            AppConnectionString = Cs("medlink_app", appPassword),
            OwnerConnectionString = Cs(ownerUser, ownerPassword),
            AppDbPassword = appPassword,
            SessionSigningKey = signing,
            TotpEncryptionKey = totp,
            DataProtectionKeysPath = c["DATA_PROTECTION_KEYS_PATH"],
            SmtpHost = requireApp ? Req("SMTP_HOST") : Opt("SMTP_HOST", ""),
            SmtpPort = int.Parse(Opt("SMTP_PORT", "1025")),
            SmtpUser = c["SMTP_USER"],
            SmtpPassword = c["EMAIL_API_KEY"],
            SmtpTls = Opt("SMTP_TLS", "none").ToLowerInvariant(),
            EmailFrom = requireApp ? Req("EMAIL_FROM") : Opt("EMAIL_FROM", ""),
            AdminWebUrl = requireApp ? Req("ADMIN_WEB_URL").TrimEnd('/') : Opt("ADMIN_WEB_URL", "").TrimEnd('/'),
            HospitalWebUrl = requireApp ? Req("HOSPITAL_WEB_URL").TrimEnd('/') : Opt("HOSPITAL_WEB_URL", "").TrimEnd('/'),
            CorsOrigins = Split(c["CORS_ORIGINS"]),
            TrustedProxies = Split(c["TRUSTED_PROXIES"]),
            CookieSecure = !string.Equals(c["COOKIE_SECURE"], "false", StringComparison.OrdinalIgnoreCase),
            AuthRatePerIp = int.Parse(Opt("AUTH_RATE_PER_IP_PER_MIN", "20")),
            AuthRatePerNet24 = int.Parse(Opt("AUTH_RATE_PER_NET24_PER_MIN", "60")),
            BookingRatePerIp = int.Parse(Opt("BOOKING_RATE_PER_IP_PER_MIN", "10")),
            BookingRatePerHospital = int.Parse(Opt("BOOKING_RATE_PER_HOSPITAL_PER_MIN", "120")),
            ScanRatePerIp = int.Parse(Opt("SCAN_RATE_PER_IP_PER_MIN", "60")),
            JobsEnabled = !string.Equals(Opt("JOBS_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase),
        };

        if (errors.Count > 0)
            throw new InvalidOperationException(
                "Missing or invalid configuration: " + string.Join(", ", errors) +
                ". See .env.example; generate secrets locally with `openssl rand -base64 48`.");
        return opts;
    }

    private static string[] Split(string? v) =>
        string.IsNullOrWhiteSpace(v) ? [] : v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
