// All runtime configuration, read from environment variables (Supabase function secrets; see .env.example).
// Secrets are never given defaults: the function refuses to start if one is missing.

export interface Config {
  /** medlink_app connection string (Supabase pooler, transaction mode). The API never uses the owner account. */
  dbUrl: string;
  /** HKDF-derived key for CSRF tokens and other HMACs. */
  sessionSigningKey: Uint8Array;
  /** HKDF-derived AES-256 key for TOTP secrets at rest. */
  totpEncryptionKey: Uint8Array;
  emailApiKey: string;
  emailFrom: string;
  adminWebUrl: string;
  hospitalWebUrl: string;
  corsOrigins: string[];
  cookieSecure: boolean;
  /**
   * Shared with the Cloudflare proxy in front of the function (api.<domain>). Requests without it are refused, so
   * nobody can reach the function directly and fake the client IP the rate limits use. Empty only in tests.
   */
  proxySecret: string;
  /** Sent by the scheduler (pg_cron) to /internal/jobs. */
  jobsSecret: string;
  authRatePerIp: number;
  authRatePerNet24: number;
  bookingRatePerIp: number;
  bookingRatePerHospital: number;
  scanRatePerIp: number;
  /** The owner's address for server alerts (failed or missing backups). Empty: alerts are only logged. */
  alertEmail: string;
}

export type Env = Record<string, string | undefined>;

async function deriveKey(raw: string | undefined, info: string, name: string, errors: string[]): Promise<Uint8Array> {
  if (!raw || !raw.trim()) {
    errors.push(name);
    return new Uint8Array();
  }
  let material: Uint8Array;
  try {
    material = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  } catch {
    errors.push(name + " (must be base64)");
    return new Uint8Array();
  }
  if (material.length < 32) {
    errors.push(name + " (needs at least 32 random bytes)");
    return new Uint8Array();
  }
  const key = await crypto.subtle.importKey("raw", material as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function loadConfig(env: Env): Promise<Config> {
  const errors: string[] = [];
  const req = (k: string) => {
    const v = env[k];
    if (!v || !v.trim()) {
      errors.push(k);
      return "";
    }
    return v.trim();
  };
  const opt = (k: string, fallback: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : fallback);
  const int = (k: string, fallback: number) => {
    const v = Number.parseInt(opt(k, String(fallback)), 10);
    if (!Number.isFinite(v) || v < 1) errors.push(k);
    return v;
  };
  const split = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const config: Config = {
    dbUrl: req("DB_APP_URL"),
    sessionSigningKey: await deriveKey(env.SESSION_SIGNING_KEY, "medlink/session-signing/v1", "SESSION_SIGNING_KEY", errors),
    totpEncryptionKey: await deriveKey(env.TOTP_ENC_KEY, "medlink/totp-at-rest/v1", "TOTP_ENC_KEY", errors),
    emailApiKey: opt("EMAIL_API_KEY", ""),
    emailFrom: req("EMAIL_FROM"),
    adminWebUrl: req("ADMIN_WEB_URL").replace(/\/+$/, ""),
    hospitalWebUrl: req("HOSPITAL_WEB_URL").replace(/\/+$/, ""),
    corsOrigins: split(env.CORS_ORIGINS),
    cookieSecure: opt("COOKIE_SECURE", "true").toLowerCase() !== "false",
    proxySecret: opt("PROXY_SECRET", ""),
    jobsSecret: opt("JOBS_SECRET", ""),
    authRatePerIp: int("AUTH_RATE_PER_IP_PER_MIN", 20),
    authRatePerNet24: int("AUTH_RATE_PER_NET24_PER_MIN", 60),
    bookingRatePerIp: int("BOOKING_RATE_PER_IP_PER_MIN", 10),
    bookingRatePerHospital: int("BOOKING_RATE_PER_HOSPITAL_PER_MIN", 120),
    scanRatePerIp: int("SCAN_RATE_PER_IP_PER_MIN", 60),
    alertEmail: opt("ALERT_EMAIL", ""),
  };
  if (config.alertEmail && (!config.alertEmail.includes("@") || config.alertEmail.length > 254)) errors.push("ALERT_EMAIL");
  if (config.proxySecret && config.proxySecret.length < 32) errors.push("PROXY_SECRET (at least 32 characters)");
  if (config.jobsSecret && config.jobsSecret.length < 32) errors.push("JOBS_SECRET (at least 32 characters)");
  if (errors.length > 0) {
    throw new Error(
      "Missing or invalid configuration: " + errors.join(", ") +
        ". See .env.example; generate secrets locally with `openssl rand -base64 48`.",
    );
  }
  return config;
}
