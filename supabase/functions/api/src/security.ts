// Tokens, IDs, password hashing (Argon2id), TOTP (RFC 6238) and AES-256-GCM for TOTP secrets at rest.
import { Buffer } from "node:buffer";
import { argon2id } from "hash-wasm";

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

function unB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** A 256-bit random token, base64url without padding (43 chars). */
export function newToken(): string {
  return base64Url(randomBytes(32));
}

/** SHA-256 of a token, as stored in the database (bytea). */
export async function tokenHash(token: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(token)));
}

export async function hmac(key: Uint8Array, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message))));
}

export function fixedTimeEquals(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === "string" ? enc.encode(a) : a;
  const y = typeof b === "string" ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------------------------------------------------------------- IDs (ULID, Crockford base32)
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i] % 32];
  return time + rand;
}

export const Ids = {
  hospital: () => "hsp_" + ulid(),
  user: () => "usr_" + ulid(),
  session: () => "ses_" + ulid(),
  link: () => "otl_" + ulid(),
  department: () => "dep_" + ulid(),
  schedule: () => "sch_" + ulid(),
  closure: () => "clo_" + ulid(),
  form: () => "frm_" + ulid(),
  booking: () => "bkg_" + ulid(),
  device: () => "dev_" + ulid(),
  attendance: () => "att_" + ulid(),
};

// ---------------------------------------------------------------- passwords
/**
 * Argon2id password hashing in PHC string format: $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>
 * (BACKEND-SPEC §3: memory >= 64 MiB, iterations >= 3, parallelism 1-2).
 */
export const Passwords = {
  minLength: 10,
  maxLength: 128,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
};

async function argon(password: string, salt: Uint8Array, m: number, t: number, p: number, len: number): Promise<Uint8Array> {
  return await argon2id({
    password,
    salt,
    memorySize: m,
    iterations: t,
    parallelism: p,
    hashLength: len,
    outputType: "binary",
  });
}

export async function hashPassword(password: string): Promise<string> {
  const { memoryKiB: m, iterations: t, parallelism: p } = Passwords;
  const salt = randomBytes(16);
  const hash = await argon(password, salt, m, t, p, 32);
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
}

let dummyHash: Promise<string> | null = null;

/** Verifies a password. With no stored hash it spends the same time, so unknown users are not distinguishable. */
export async function verifyPassword(password: string, phc: string | null): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (phc === null) {
    dummyHash ??= hashPassword(newToken());
    await verifyPassword(password, await dummyHash);
    return { ok: false, needsRehash: false };
  }
  const parts = phc.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return { ok: false, needsRehash: false };
  let m = 0, t = 0, p = 0;
  for (const kv of parts[3].split(",")) {
    const v = Number.parseInt(kv.slice(2), 10);
    if (kv[0] === "m") m = v;
    else if (kv[0] === "t") t = v;
    else if (kv[0] === "p") p = v;
  }
  const salt = unB64(parts[4]);
  const expected = unB64(parts[5]);
  const actual = await argon(password, salt, m, t, p, expected.length);
  const ok = fixedTimeEquals(actual, expected);
  return { ok, needsRehash: ok && (m !== Passwords.memoryKiB || t !== Passwords.iterations || p !== Passwords.parallelism) };
}

/** Returns an error code, or null if the password is acceptable. */
export function validatePassword(password: string | null | undefined, email: string): string | null {
  if (password == null || password.length < Passwords.minLength) return "PASSWORD_TOO_SHORT";
  if (password.length > Passwords.maxLength) return "PASSWORD_TOO_LONG";
  const local = email.split("@")[0];
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) return "PASSWORD_CONTAINS_EMAIL";
  if (new Set(password).size < 4) return "PASSWORD_TOO_SIMPLE";
  return null;
}

// ---------------------------------------------------------------- TOTP (SHA-1, 6 digits, 30 s)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const Totp = {
  issuer: "MEDLINK",

  newSecret(): Uint8Array {
    return randomBytes(20);
  },

  provisioningUri(secret: Uint8Array, account: string): string {
    const issuer = encodeURIComponent(Totp.issuer);
    return `otpauth://totp/${issuer}:${encodeURIComponent(account)}?secret=${base32(secret)}&issuer=${issuer}`;
  },

  async code(secret: Uint8Array, step: number): Promise<string> {
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(step));
    const k = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, counter));
    const o = h[h.length - 1] & 15;
    const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 1_000_000).padStart(6, "0");
  },

  /** Returns the matched time step, or null. One step either side is accepted; steps <= lastStep are rejected (no replay). */
  async verify(secret: Uint8Array, code: string | null | undefined, lastStep: number | null, now = Date.now()): Promise<number | null> {
    if (code == null) return null;
    code = code.replaceAll(" ", "");
    if (!/^[0-9]{6}$/.test(code)) return null;
    const current = Math.floor(now / 1000 / 30);
    for (const step of [current - 1, current, current + 1]) {
      if (fixedTimeEquals(await Totp.code(secret, step), code)) {
        if (lastStep !== null && step <= lastStep) return null;
        return step;
      }
    }
    return null;
  },
};

// ---------------------------------------------------------------- AES-256-GCM for TOTP secrets: [1][nonce 12][tag 16][cipher]
export async function encryptSecret(key: Uint8Array, secret: Uint8Array): Promise<Buffer> {
  const nonce = randomBytes(12);
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, k, secret as BufferSource));
  const cipher = out.subarray(0, out.length - 16);
  const tag = out.subarray(out.length - 16);
  return Buffer.concat([Buffer.from([1]), nonce, tag, cipher]);
}

export async function decryptSecret(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 29 || blob[0] !== 1) throw new Error("unknown TOTP blob version");
  const nonce = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const cipher = blob.subarray(29);
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
  const joined = new Uint8Array(cipher.length + 16);
  joined.set(cipher);
  joined.set(tag, cipher.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, k, joined));
}
