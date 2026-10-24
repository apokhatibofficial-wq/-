// Test harness: one freshly migrated database per test process (on the PostgreSQL given by TEST_PG_URL), the real
// API in memory, and helpers that create accounts the real way. Every credential is random and made at runtime.
import postgres from "postgres";
import { assertEquals } from "jsr:@std/assert@1.0.14";
import { migrate } from "../../../scripts/migrate.ts";
import type { Config } from "../src/config.ts";
import { connect, Db } from "../src/db.ts";
import type { EmailMessage, EmailSender } from "../src/email.ts";
import type { AppDeps } from "../src/http.ts";
import { buildApp } from "../src/main.ts";
import { base64Url, fromBase32, randomBytes, Totp, ulid } from "../src/security.ts";

export const secret = () => base64Url(randomBytes(36));

/** Every password and token the tests create, so the log test can look for them. */
export const secrets: string[] = [];

export class CapturingEmail implements EmailSender {
  sent: EmailMessage[] = [];
  send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
    return Promise.resolve();
  }
  lastTo(to: string): EmailMessage {
    const m = this.sent.filter((x) => x.to.toLowerCase() === to.toLowerCase()).at(-1);
    if (!m) throw new Error("no email to " + to);
    return m;
  }
  static tokenFrom(m: EmailMessage): string {
    const url = m.textBody.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("https://"));
    if (url.length !== 1) throw new Error("expected one link");
    return url[0].slice(url[0].indexOf("#t=") + 3);
  }
}

const baseUrl = Deno.env.get("TEST_PG_URL");
if (!baseUrl) throw new Error("set TEST_PG_URL to a PostgreSQL superuser connection string (a throw-away test server)");

async function createDatabase(): Promise<{ ownerUrl: string; appUrl: string }> {
  const dbName = "mlt_" + ulid().toLowerCase();
  const admin = postgres(baseUrl!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const owner = new URL(baseUrl!);
  owner.pathname = "/" + dbName;
  const appPassword = secret();
  secrets.push(appPassword);
  await migrate(owner.toString(), appPassword);
  const app = new URL(owner.toString());
  app.username = "medlink_app";
  app.password = encodeURIComponent(appPassword);
  return { ownerUrl: owner.toString(), appUrl: app.toString() };
}

const urls = await createDatabase();
export const ownerSql = postgres(urls.ownerUrl, { max: 2, onnotice: () => {} });

async function key(info: string): Promise<Uint8Array> {
  const material = randomBytes(48);
  const k = await crypto.subtle.importKey("raw", material as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode(info) }, k, 256));
}

export interface ApiOptions {
  authRate?: number;
  scanRate?: number;
  bookingRate?: number;
  now?: () => Date;
}

export async function testConfig(o: ApiOptions = {}): Promise<Config> {
  const rate = o.authRate ?? 10_000;
  return {
    dbUrl: urls.appUrl,
    sessionSigningKey: await key("medlink/session-signing/v1"),
    totpEncryptionKey: await key("medlink/totp-at-rest/v1"),
    emailApiKey: "",
    emailFrom: "MEDLINK <no-reply@medlink.website>",
    adminWebUrl: "https://admin.medlink.website",
    hospitalWebUrl: "https://app.medlink.website",
    corsOrigins: ["https://admin.medlink.website", "https://app.medlink.website", "https://medlink.website"],
    cookieSecure: true,
    proxySecret: "",
    jobsSecret: secret(),
    authRatePerIp: rate,
    authRatePerNet24: rate,
    bookingRatePerIp: o.bookingRate ?? rate,
    bookingRatePerHospital: o.bookingRate ?? rate,
    scanRatePerIp: o.scanRate ?? 10_000,
    alertEmail: "",
  };
}

const appSql = connect(urls.appUrl, 4);

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

/** A browser-like client: carries the session cookie and the CSRF header by hand. */
export class Client {
  sessionToken: string | null = null;
  csrf: string | null = null;
  lastSetCookie: string | null = null;
  ip = "203.0.113.10";

  constructor(private readonly api: TestApi) {}

  async send(method: string, path: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers = new Headers(opts.headers ?? {});
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.sessionToken !== null) headers.set("cookie", "__Host-medlink_session=" + this.sessionToken);
    if ((opts.csrf ?? true) && this.csrf !== null) headers.set("X-CSRF-Token", this.csrf);
    if (!headers.has("x-medlink-client-ip")) headers.set("x-medlink-client-ip", this.ip);
    const res = await this.api.fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = res.headers.getSetCookie();
    if (cookies.length > 0) {
      this.lastSetCookie = cookies.join("\n");
      for (const c of cookies) {
        const first = c.split(";")[0];
        if (first.startsWith("__Host-medlink_session=")) {
          const v = first.slice("__Host-medlink_session=".length);
          this.sessionToken = v.length === 0 ? null : v;
        }
      }
    }
    const text = await res.text();
    return { status: res.status, body: text.length === 0 ? null : JSON.parse(text), headers: res.headers };
  }

  get = (path: string) => this.send("GET", path);
  post = (path: string, body: unknown, csrf = true) => this.send("POST", path, body, { csrf });
  patch = (path: string, body: unknown) => this.send("PATCH", path, body);
  put = (path: string, body: unknown) => this.send("PUT", path, body);
  delete = (path: string) => this.send("DELETE", path);

  async login(email: string, password: string, totpSecretBase32: string | null, extra: Record<string, unknown> = {}): Promise<Res> {
    const code = totpSecretBase32 === null ? null : await totpNow(totpSecretBase32);
    const r = await this.post("/auth/login", { email, password, totp: code, ...extra }, false);
    if (r.status === 200 && typeof r.body?.csrf === "string") this.csrf = r.body.csrf;
    return r;
  }
}

export async function totpNow(secretBase32: string): Promise<string> {
  return await Totp.code(fromBase32(secretBase32), Math.floor(Date.now() / 1000 / 30));
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  totpSecret: string | null;
}

export const newEmail = (prefix: string) => `${prefix}-${crypto.randomUUID().replaceAll("-", "")}@test.invalid`;

/** A running API over the shared test database. */
export class TestApi {
  readonly email = new CapturingEmail();
  readonly deps: AppDeps;
  private readonly app: ReturnType<typeof buildApp>;

  private constructor(config: Config, now: () => Date) {
    this.deps = { config, db: new Db(appSql), email: this.email, now };
    this.app = buildApp(this.deps);
  }

  static async create(o: ApiOptions = {}): Promise<TestApi> {
    return new TestApi(await testConfig(o), o.now ?? (() => new Date()));
  }

  fetch(path: string, init: RequestInit): Promise<Response> {
    return Promise.resolve(this.app.fetch(new Request("https://api.medlink.website" + path, init)));
  }

  anonymous(): Client {
    return new Client(this);
  }

  /** Completes a one-time link the way a person would: inspect, enrol TOTP, set a password. */
  async completeLink(token: string): Promise<{ password: string; totpSecret: string | null }> {
    secrets.push(token);
    const anon = this.anonymous();
    const inspect = await anon.post("/auth/link/inspect", { token }, false);
    assertEquals(inspect.status, 200);
    const s: string | null = inspect.body.totpRequired ? inspect.body.totpSecret : null;
    if (s) secrets.push(s);
    const password = secret();
    secrets.push(password);
    const done = await anon.post("/auth/link/complete", { token, password, totp: s ? await totpNow(s) : null }, false);
    assertEquals(done.status, 200, JSON.stringify(done.body));
    return { password, totpSecret: s };
  }

  /** The server rejects a TOTP code whose time step was already used; tests sign in several times per 30 s. */
  async allowNextTotp(email: string) {
    await ownerSql`UPDATE users SET totp_last_step = NULL WHERE email = ${email}`;
  }

  async signIn(u: TestUser): Promise<Client> {
    await this.allowNextTotp(u.email);
    const c = this.anonymous();
    const r = await c.login(u.email, u.password, u.totpSecret);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    secrets.push(c.sessionToken!);
    return c;
  }

  /** A company user created like a colleague would be: a row with no password plus a setup link. */
  async companyUser(role: string): Promise<{ client: Client; user: TestUser }> {
    const email = newEmail(role);
    const id = "usr_" + ulid();
    await ownerSql`INSERT INTO users (id, scope, email) VALUES (${id}, 'company', ${email})`;
    await ownerSql`INSERT INTO user_roles (user_id, role) VALUES (${id}, ${role})`;
    const url = await ownerSql<{ url: string }[]>`SELECT medlink_issue_link(${id}, 'setup', 'https://admin.medlink.website') AS url`;
    const token = url[0].url.slice(url[0].url.indexOf("#t=") + 3);
    const { password, totpSecret } = await this.completeLink(token);
    const user = { id, email, password, totpSecret };
    return { client: await this.signIn(user), user };
  }
}

/** Deno.test without the resource checks (the database pool stays open between tests). */
export function test(name: string, fn: () => Promise<void>) {
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
}
