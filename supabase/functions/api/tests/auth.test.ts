import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { hashPassword, tokenHash, verifyPassword } from "../src/security.ts";
import { newEmail, ownerSql, secrets, test, TestApi, totpNow } from "./harness.ts";

test("5 failed sign-ins lock the account for 15 minutes, even for the right password", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  const c = api.anonymous();
  for (let i = 0; i < 4; i++) assertEquals((await c.login(user.email, "wrong-password-" + i, null)).status, 401);
  assertEquals((await c.login(user.email, "wrong-password-5", null)).status, 423);
  await api.allowNextTotp(user.email);
  const right = await c.login(user.email, user.password, user.totpSecret);
  assertEquals(right.status, 423);
  assertEquals(right.body.error, "ACCOUNT_LOCKED");
  assertEquals(c.sessionToken, null);

  const [{ until }] = await ownerSql<{ until: Date }[]>`SELECT locked_until AS until FROM users WHERE id = ${user.id}`;
  const minutes = (until.getTime() - Date.now()) / 60000;
  assert(minutes > 14 && minutes <= 15.1, String(minutes));

  // When the lock has passed, the right password works again.
  await ownerSql`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = ${user.id}`;
  await api.allowNextTotp(user.email);
  assertEquals((await c.login(user.email, user.password, user.totpSecret)).status, 200);
});

test("A wrong TOTP code counts as a failed attempt and a used code cannot be replayed", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  const c = api.anonymous();
  await api.allowNextTotp(user.email);
  const bad = await c.post("/auth/login", { email: user.email, password: user.password, totp: "123456" }, false);
  assertEquals(bad.status, 401);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT failed_attempts AS n FROM users WHERE id = ${user.id}`;
  assertEquals(n, 1);

  const code = await totpNow(user.totpSecret!);
  assertEquals((await c.post("/auth/login", { email: user.email, password: user.password, totp: code }, false)).status, 200);
  const replay = await api.anonymous().post("/auth/login", { email: user.email, password: user.password, totp: code }, false);
  assertEquals(replay.status, 401);
});

test("Without a code, a 2FA account answers mfa_required and no session is created", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  const c = api.anonymous();
  const r = await c.login(user.email, user.password, null);
  assertEquals(r.status, 200);
  assertEquals(r.body.status, "mfa_required");
  assertEquals(c.sessionToken, null);
});

test("The session cookie is __Host-, HttpOnly, Secure and SameSite=Strict; the web never sees the token", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  await api.allowNextTotp(user.email);
  const c = api.anonymous();
  const ok = await c.login(user.email, user.password, user.totpSecret);
  assertEquals(ok.status, 200);
  const cookie = c.lastSetCookie!.toLowerCase();
  assertStringIncludes(c.lastSetCookie!, "__Host-medlink_session=");
  assertStringIncludes(cookie, "httponly");
  assertStringIncludes(cookie, "secure");
  assertStringIncludes(cookie, "samesite=strict");
  assertStringIncludes(cookie, "path=/");
  assertEquals(ok.body.token, null);
  assertEquals(typeof ok.body.csrf, "string");
  assertEquals(ok.body.user.email, user.email);
  assertEquals(ok.body.user.scope, "company");
  assertEquals(ok.body.user.permissions, ["ViewReports"]);
});

test("Logout revokes the session on the server", async () => {
  const api = await TestApi.create();
  const { client, user } = await api.companyUser("viewer");
  const token = client.sessionToken!;
  assertEquals((await client.get("/auth/me")).status, 200);
  assertEquals((await client.post("/auth/logout", {})).status, 200);
  assertEquals(client.sessionToken, null);

  const reused = api.anonymous();
  reused.sessionToken = token;
  assertEquals((await reused.get("/auth/me")).status, 401);

  const [row] = await ownerSql<{ token_hash: Uint8Array; reason: string }[]>`
    SELECT token_hash, revoke_reason AS reason FROM sessions WHERE user_id = ${user.id} AND revoked_at IS NOT NULL`;
  assertEquals([...row.token_hash], [...await tokenHash(token)]);
  assertEquals(row.reason, "logout");
});

test("Unsafe cookie requests need the CSRF token; bearer (Windows) requests do not", async () => {
  const api = await TestApi.create();
  const { client } = await api.companyUser("viewer");
  const noCsrf = await client.send("POST", "/auth/logout", {}, { csrf: false });
  assertEquals(noCsrf.status, 403);
  assertEquals(noCsrf.body.error, "CSRF_INVALID");
  const wrong = await client.send("POST", "/auth/logout", {}, { csrf: false, headers: { "X-CSRF-Token": "x".repeat(43) } });
  assertEquals(wrong.status, 403);
  assertEquals((await client.get("/auth/me")).status, 200);
});

test("Windows clients get a bearer token instead of a cookie", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  await api.allowNextTotp(user.email);
  const c = api.anonymous();
  const r = await c.login(user.email, user.password, user.totpSecret, { client: "windows" });
  assertEquals(r.status, 200);
  assertEquals(c.sessionToken, null);
  assertEquals(r.body.csrf, null);
  const token: string = r.body.token;
  secrets.push(token);
  const me = await api.fetch("/auth/me", { headers: { authorization: "Bearer " + token } });
  assertEquals(me.status, 200);
  assertEquals((await me.json()).csrf, null);
  // A bearer request needs no CSRF token.
  const out = await api.fetch("/auth/logout", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" });
  assertEquals(out.status, 200);
  await out.body?.cancel();
});

test("Password storage: Argon2id with the required parameters, salted, never plaintext", async () => {
  const api = await TestApi.create();
  const { user } = await api.companyUser("viewer");
  const [{ hash }] = await ownerSql<{ hash: string }[]>`SELECT password_hash AS hash FROM users WHERE id = ${user.id}`;
  assert(hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$"), hash);
  assert(!hash.includes(user.password));

  const h1 = await hashPassword(user.password);
  const h2 = await hashPassword(user.password);
  assertNotEquals(h1, h2);
  assertEquals(await verifyPassword(user.password, h1), { ok: true, needsRehash: false });
  assertEquals((await verifyPassword(user.password + "x", h1)).ok, false);

  // The plaintext appears nowhere in the database.
  const dump = (await ownerSql<{ t: string }[]>`
    SELECT row_to_json(t)::text AS t FROM users t UNION ALL SELECT row_to_json(t)::text FROM sessions t
    UNION ALL SELECT row_to_json(t)::text FROM one_time_links t UNION ALL SELECT row_to_json(t)::text FROM audit_log t`)
    .map((r) => r.t).join("\n");
  for (const s of secrets) assert(!dump.includes(s), "a secret is stored in the database");

  // The database itself refuses anything that is not an Argon2id hash.
  const e = await assertRejects(() => ownerSql`UPDATE users SET password_hash = 'plaintext' WHERE id = ${user.id}`);
  assertEquals((e as { code: string }).code, "23514");
});

test("Unknown accounts and wrong passwords get the same answer", async () => {
  const api = await TestApi.create();
  const c = api.anonymous();
  const unknown = await c.login(newEmail("nobody"), "some-password-123", null);
  assertEquals(unknown.status, 401);
  assertEquals(unknown.body, { error: "INVALID_CREDENTIALS" });
  const empty = await c.post("/auth/login", { email: "", password: "" }, false);
  assertEquals(empty.status, 401);
  const notJson = await c.send("POST", "/auth/login", undefined, { headers: { "content-type": "text/plain" } });
  assertEquals(notJson.status, 415);
  const badJson = await api.fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assertEquals(badJson.status, 400);
  await badJson.body?.cancel();
  const wrongType = await c.post("/auth/login", { email: 5, password: "x" }, false);
  assertEquals(wrongType.status, 400);
});

test("A one-time link works once and expires; a weak password or wrong code leaves it usable", async () => {
  const api = await TestApi.create();
  const id = "usr_" + crypto.randomUUID().replaceAll("-", "").toUpperCase().slice(0, 26).replace(/[ILOU]/g, "0");
  const email = newEmail("viewer");
  await ownerSql`INSERT INTO users (id, scope, email) VALUES (${id}, 'company', ${email})`;
  await ownerSql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'viewer')`;
  const [{ url }] = await ownerSql<{ url: string }[]>`SELECT medlink_issue_link(${id}, 'setup', 'https://admin.medlink.website') AS url`;
  const token = url.slice(url.indexOf("#t=") + 3);
  secrets.push(token);
  const anon = api.anonymous();

  const inspect = await anon.post("/auth/link/inspect", { token }, false);
  assertEquals(inspect.status, 200);
  assertEquals(inspect.body.purpose, "setup");
  assertEquals(inspect.body.email, email);
  assertEquals(inspect.body.totpRequired, true);
  assertEquals(inspect.body.passwordMinLength, 10);
  assertMatch(inspect.body.totpSecret, /^[A-Z2-7]{32}$/);
  assertStringIncludes(inspect.body.totpUri, "otpauth://totp/MEDLINK:");
  // The pending secret stays the same when the link is opened again.
  assertEquals((await anon.post("/auth/link/inspect", { token }, false)).body.totpSecret, inspect.body.totpSecret);

  const weak = await anon.post("/auth/link/complete", { token, password: "short", totp: "000000" }, false);
  assertEquals(weak.status, 422);
  assertEquals(weak.body.error, "PASSWORD_WEAK");
  const badCode = await anon.post("/auth/link/complete", { token, password: crypto.randomUUID(), totp: "000000" }, false);
  assertEquals(badCode.status, 422);
  assertEquals(badCode.body.error, "TOTP_INVALID");
  assertEquals((await anon.post("/auth/link/inspect", { token }, false)).status, 200);

  await api.completeLink(token);
  assertEquals((await anon.post("/auth/link/inspect", { token }, false)).status, 410);
  assertEquals((await anon.post("/auth/link/complete", { token, password: crypto.randomUUID() }, false)).status, 410);

  // An expired link is refused.
  const [{ url: url2 }] = await ownerSql<{ url: string }[]>`SELECT medlink_issue_link(${id}, 'reset', 'https://admin.medlink.website') AS url`;
  const token2 = url2.slice(url2.indexOf("#t=") + 3);
  secrets.push(token2);
  await ownerSql`UPDATE one_time_links SET expires_at = now() - interval '1 second' WHERE token_hash = ${await tokenHash(token2)}`;
  assertEquals((await anon.post("/auth/link/inspect", { token: token2 }, false)).status, 410);
});

test("bootstrap-admin (SQL editor) creates one owner with a 30-minute setup link and refuses to run twice", async () => {
  // A separate, freshly migrated database, so the shared one (which already has company users) is untouched.
  const { migrate } = await import("../../../scripts/migrate.ts");
  const postgres = (await import("postgres")).default;
  const base = new URL(Deno.env.get("TEST_PG_URL")!);
  const dbName = "boot_" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  base.pathname = "/" + dbName;
  await migrate(base.toString(), null);
  const sql = postgres(base.toString(), { max: 1, onnotice: () => {} });
  try {
    const email = newEmail("owner");
    const [{ url }] = await sql<{ url: string }[]>`SELECT medlink_bootstrap_admin(${email}) AS url`;
    assert(url.startsWith("https://admin.medlink.website/link#t="), url);
    const token = url.slice(url.indexOf("#t=") + 3);
    assertMatch(token, /^[A-Za-z0-9_-]{43}$/);
    secrets.push(token);
    const [u] = await sql<{ password_hash: string | null; role: string; expires_at: Date; id: string; lid: string; th: Uint8Array }[]>`
      SELECT u.id, u.password_hash, r.role, l.expires_at, l.id AS lid, l.token_hash AS th FROM users u JOIN user_roles r ON r.user_id = u.id
      JOIN one_time_links l ON l.user_id = u.id WHERE u.email = ${email}`;
    assertEquals(u.password_hash, null);
    assertEquals(u.role, "owner");
    assertMatch(u.id, /^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    assertMatch(u.lid, /^otl_[0-9A-HJKMNP-TV-Z]{26}$/);
    assertEquals([...u.th], [...await tokenHash(token)]);
    const minutes = (u.expires_at.getTime() - Date.now()) / 60000;
    assert(minutes > 29 && minutes <= 30.1, String(minutes));
    const again = await assertRejects(() => sql`SELECT medlink_bootstrap_admin(${newEmail("owner2")})`);
    assertStringIncludes((again as Error).message, "already exists");
    // Nobody but the database owner can call it: the API's role cannot.
    const [{ ok }] = await sql<{ ok: boolean }[]>`SELECT has_function_privilege('medlink_app', 'medlink_bootstrap_admin(text, text)', 'EXECUTE') AS ok`;
    assertEquals(ok, false);

    // Recovery: a new reset link, the old one stops working.
    const [{ url: reset }] = await sql<{ url: string }[]>`SELECT medlink_reset_company_user(${email}) AS url`;
    secrets.push(reset.slice(reset.indexOf("#t=") + 3));
    const links = await sql<{ purpose: string; live: boolean }[]>`
      SELECT purpose, expires_at > now() AS live FROM one_time_links WHERE user_id = ${u.id} ORDER BY created_at`;
    assertEquals(links.map((l) => [l.purpose, l.live]), [["setup", false], ["setup", true]]);
  } finally {
    await sql.end();
  }
});

test("Health answers ok; unknown paths are 404; security headers are on every response", async () => {
  const api = await TestApi.create();
  const r = await api.anonymous().get("/health");
  assertEquals(r.status, 200);
  assertEquals(r.body, { status: "ok" });
  for (const [h, v] of [["x-content-type-options", "nosniff"], ["referrer-policy", "no-referrer"], ["cache-control", "no-store"], ["x-frame-options", "DENY"]]) {
    assertEquals(r.headers.get(h), v);
  }
  const nf = await api.anonymous().get("/nope");
  assertEquals(nf.status, 404);
  assertEquals(nf.headers.get("x-frame-options"), "DENY");
  const unauth = await api.anonymous().get("/auth/me");
  assertEquals(unauth.status, 401);
  assertEquals(unauth.body, { error: "UNAUTHENTICATED" });
});

test("CORS: the three sites may call with credentials; other origins get no CORS headers", async () => {
  const api = await TestApi.create();
  const pre = await api.fetch("/auth/login", {
    method: "OPTIONS",
    headers: { origin: "https://app.medlink.website", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-csrf-token" },
  });
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), "https://app.medlink.website");
  assertEquals(pre.headers.get("access-control-allow-credentials"), "true");
  await pre.body?.cancel();
  const evil = await api.fetch("/health", { headers: { origin: "https://evil.example" } });
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
  await evil.body?.cancel();
});

test("Sign-in attempts are limited per IP and per /24 network", async () => {
  const api = await TestApi.create({ authRate: 3 });
  const a = api.anonymous();
  a.ip = "198.51.100." + (1 + Math.floor(Math.random() * 50));
  const email = newEmail("nobody");
  for (let i = 0; i < 3; i++) assertEquals((await a.login(email, "wrong-password-x", null)).status, 401);
  const limited = await a.login(email, "wrong-password-x", null);
  assertEquals(limited.status, 429);
  assertEquals(limited.body, { error: "RATE_LIMITED" });
  // Another address in the same /24 is limited too (the network limit is also 3 here); another network is not.
  const b = api.anonymous();
  b.ip = a.ip.replace(/\.\d+$/, ".200");
  assertEquals((await b.login(email, "wrong-password-x", null)).status, 429);
  const other = api.anonymous();
  other.ip = "192.0.2." + (1 + Math.floor(Math.random() * 200));
  assertEquals((await other.login(email, "wrong-password-x", null)).status, 401);
  // GET /auth/me is not limited.
  assertEquals((await a.get("/auth/me")).status, 401);
});

test("With PROXY_SECRET set, only the proxy can call the API", async () => {
  const api = await TestApi.create();
  api.deps.config.proxySecret = "p".repeat(40);
  const direct = await api.fetch("/health", {});
  assertEquals(direct.status, 403);
  await direct.body?.cancel();
  const wrong = await api.fetch("/health", { headers: { "x-medlink-proxy": "q".repeat(40) } });
  assertEquals(wrong.status, 403);
  await wrong.body?.cancel();
  const ok = await api.fetch("/health", { headers: { "x-medlink-proxy": "p".repeat(40) } });
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});
