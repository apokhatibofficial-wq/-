import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { isAnonymousPath } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { routeGuards } from "../src/http.ts";
import { has } from "../src/permissions.ts";
import { appSql, bookingHospital, CapturingEmail, type Client, newEmail, ownerSql, secrets, slot, staff, test, TestApi } from "./harness.ts";

interface Ep {
  method: string;
  pattern: string;
  path: string;
  rule: string;
}

function endpoints(): Ep[] {
  const seen = new Map<string, Ep>();
  for (const r of routeGuards) {
    const pattern = r.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const rule = r.guard.kind === "permission" ? r.guard.permission : r.guard.kind === "signedIn" ? "signin" : r.guard.kind;
    seen.set(r.method + " " + pattern, { method: r.method, pattern, path: r.path.replace(/:[a-zA-Z]+/g, "1"), rule });
  }
  return [...seen.values()];
}

/** The only endpoints anyone may call without signing in. A new public endpoint fails this test until it is reviewed and added. */
const Public = [
  "GET /health",
  "POST /auth/login", "POST /auth/link/inspect", "POST /auth/link/complete",
  "GET /public/book/{slug}", "GET /public/slugs/{slug}",
  "GET /public/hospitals/{slug}/form", "GET /public/hospitals/{slug}/availability", "POST /public/hospitals/{slug}/bookings",
];

/** The approved access rule of every other endpoint: the same table as the .NET API, plus the scheduler's endpoint. */
const Expected: Record<string, string> = {
  "GET /admin/audit": "signin",
  "GET /admin/hospitals": "ViewReports",
  "POST /admin/hospitals": "HospitalsCreateEdit",
  "GET /admin/hospitals/{id}": "ViewReports",
  "PATCH /admin/hospitals/{id}": "HospitalsCreateEdit",
  "PUT /admin/hospitals/{id}/booking-rules": "HospitalsCreateEdit",
  "POST /admin/hospitals/{id}/reactivate": "HospitalsSuspend",
  "POST /admin/hospitals/{id}/recover-admin": "RecoverAdminAccess",
  "POST /admin/hospitals/{id}/suspend": "HospitalsSuspend",
  "GET /admin/reports": "ViewReports",
  "GET /admin/settings": "ViewReports",
  "PATCH /admin/settings": "PlatformSettings",
  "GET /admin/slugs/check": "HospitalsCreateEdit",
  "GET /admin/team": "ManageTeam",
  "POST /admin/team": "ManageTeam",
  "PATCH /admin/team/{id}": "ManageTeam",
  "POST /admin/team/{id}/send-link": "ManageTeam",
  "POST /auth/logout": "signin",
  "GET /auth/me": "signin",
  "GET /hospital/bookings": "signin",
  "GET /hospital/bookings/{id}": "signin",
  "POST /hospital/bookings/{id}/attendance": "signin",
  "POST /hospital/bookings/{id}/cancel": "AttendanceCorrect",
  "GET /hospital/closures": "HospitalRead",
  "POST /hospital/closures": "HospitalSettings",
  "DELETE /hospital/closures/{id}": "HospitalSettings",
  "GET /hospital/departments": "HospitalRead",
  "POST /hospital/departments": "HospitalSettings",
  "PATCH /hospital/departments/{id}": "HospitalSettings",
  "PUT /hospital/departments/{id}/schedules": "HospitalSettings",
  "GET /hospital/devices": "HospitalSettings",
  "POST /hospital/devices/{id}/revoke": "HospitalSettings",
  "GET /hospital/form": "FormEditPublish",
  "PUT /hospital/form/draft": "FormEditPublish",
  "DELETE /hospital/form/draft": "FormEditPublish",
  "POST /hospital/form/publish": "FormEditPublish",
  "GET /hospital/form/versions": "FormEditPublish",
  "GET /hospital/form/versions/{version}": "FormEditPublish",
  "POST /hospital/form/versions/{version}/restore": "FormEditPublish",
  "GET /hospital/me": "HospitalRead",
  "PATCH /hospital/settings": "HospitalSettings",
  "GET /hospital/users": "HospitalUsersManage",
  "POST /hospital/users": "HospitalUsersManage",
  "GET /hospital/users/{id}": "HospitalUsersManage",
  "PATCH /hospital/users/{id}": "HospitalUsersManage",
  "POST /hospital/users/{id}/send-link": "HospitalUsersManage",
  "POST /scan/checkin": "CheckIn",
  "GET /scan/lookup": "CheckIn",
  "POST /scan/qr": "CheckIn",
  "POST /sync/devices": "HospitalRead",
  "GET /sync/pull": "signin",
  "POST /sync/push": "HospitalRead",
  "POST /internal/jobs": "jobs",
};

const key = (e: Ep) => e.method + " " + e.pattern;
const call = (c: Client, e: Ep, body?: unknown) => c.send(e.method, e.path, ["POST", "PUT", "PATCH"].includes(e.method) ? body ?? {} : undefined);
const auditCount = async () => (await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`)[0].n;

test("Acceptance 25: every endpoint declares who may call it; only the reviewed public ones are open", async () => {
  await TestApi.create();
  const eps = endpoints();
  assertEquals(eps.length, 62);
  for (const e of eps) {
    const isPublic = Public.includes(key(e));
    assert(isPublic || e.rule !== "anonymous", `${key(e)} has no access rule`);
    // The session middleware skips public paths, so a rule there would never see a user, and vice versa.
    if (e.rule !== "jobs") assertEquals(isPublic, isAnonymousPath(e.path), `${key(e)}: public list and middleware disagree`);
  }
  assertEquals(eps.filter((e) => Public.includes(key(e))).map(key).sort(), [...Public].sort());
  const actual = Object.fromEntries(eps.filter((e) => !Public.includes(key(e))).map((e) => [key(e), e.rule]));
  assertEquals(actual, Expected);
});

test("Acceptance 2: without signing in, every non-public endpoint answers 401 and does nothing", async () => {
  const api = await TestApi.create();
  const anon = api.anonymous();
  const before = await auditCount();
  let n = 0;
  for (const e of endpoints().filter((e) => !Public.includes(key(e)) && e.rule !== "jobs")) {
    const r = await call(anon, e);
    assertEquals(r.status, 401, `${key(e)} answered ${r.status} without a session`);
    n++;
  }
  assertEquals(n, 52);
  // The scheduler's endpoint wants its own secret.
  assertEquals((await call(anon, endpoints().find((e) => e.rule === "jobs")!)).status, 403);
  assertEquals(await auditCount(), before);
});

test("Acceptance 25: every role is refused (403) on every endpoint whose permission it lacks, company and hospital alike", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const clients: Record<string, Client> = { owner };
  for (const role of ["support", "viewer"]) clients[role] = (await api.companyUser(role)).client;
  const h = await bookingHospital(api, owner);
  clients.hosp_admin = h.adminClient;
  for (const role of ["reception", "scanner"]) clients[role] = (await staff(api, h.adminClient, role)).client;
  const docEmail = newEmail("doc");
  const inv = await h.adminClient.post("/hospital/users", { email: docEmail, role: "doctor", departmentIds: [h.departmentId] });
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(api.email.lastTo(docEmail)));
  clients.doctor = await api.signIn({ id: inv.body.id, email: docEmail, password, totpSecret });
  const scannerDevice = (await clients.scanner.post("/sync/devices", { name: "هاتف الماسح" })).body.deviceId;
  const before = await auditCount();
  const all = endpoints();
  let refused = 0;
  for (const e of all.filter((e) => !["anonymous", "signin", "jobs"].includes(e.rule))) {
    for (const [role, client] of Object.entries(clients)) {
      if (has([role], e.rule as never)) continue;
      const r = await call(client, e);
      assert(r.status === 403 && r.body?.error === "FORBIDDEN", `${role} on ${key(e)} (needs ${e.rule}) answered ${r.status} ${r.body?.error}`);
      refused++;
    }
  }
  const company = ["owner", "support", "viewer"];
  const inside: [string, unknown, string[]][] = [
    ["GET /admin/audit", undefined, ["viewer", "hosp_admin", "reception", "scanner", "doctor"]],
    ["POST /hospital/bookings/{id}/attendance", { type: "arrived" }, [...company, "doctor"]],
    ["POST /hospital/bookings/{id}/attendance", { type: "arrived", reason: "تصحيح للاختبار" }, [...company, "scanner", "doctor"]],
    ["GET /sync/pull", undefined, [...company, "scanner"]],
    ["GET /hospital/bookings", undefined, [...company, "scanner"]],
    ["GET /hospital/bookings/{id}", undefined, [...company, "scanner"]],
  ];
  for (const [k, body, roles] of inside) {
    let e = all.find((x) => key(x) === k)!;
    assertEquals(e.rule, "signin");
    if (k === "GET /sync/pull") e = { ...e, path: "/sync/pull?deviceId=" + scannerDevice };
    for (const role of roles) {
      const r = await call(clients[role], e, body);
      assert(r.status === 403 && r.body?.error === "FORBIDDEN", `${role} on ${k} answered ${r.status} ${r.body?.error}`);
      refused++;
    }
  }
  console.log(`refused ${refused} calls`);
  assert(refused > 200, `only ${refused} refusals checked`);
  assertEquals(await auditCount(), before);
});

test("Bad input: a NUL byte in a query or JSON field is refused with 400, never a server error", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const anon = api.anonymous();
  const s = await slot(api, h);
  const calls: [string, Promise<{ status: number; body: any }>][] = [
    ["availability query", anon.get(`/public/hospitals/${h.slug}/availability?departmentId=%00`)],
    ["booking name", anon.send("POST", `/public/hospitals/${h.slug}/bookings`, { departmentId: h.departmentId, slotStart: s, patientName: "مريض\u0000تجريبي", phone: "+963944000888" }, { headers: { "Idempotency-Key": crypto.randomUUID() } })],
    ["sign-in email", anon.post("/auth/login", { email: "a\u0000@x.invalid", password: "x" }, false)],
    ["link token", anon.post("/auth/link/inspect", { token: "\u0000" }, false)],
    ["staff search", h.adminClient.get("/hospital/bookings?ref=ML-%00")],
    ["department name", h.adminClient.post("/hospital/departments", { nameAr: "قسم\u0000", nameEn: "Dept", nameTr: "Bolum" })],
  ];
  for (const [what, p] of calls) {
    const r = await p;
    assert(r.status >= 400 && r.status < 500, `${what}: ${r.status} ${r.body?.error}`);
  }
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE hospital_id = ${h.hospitalId}`;
  assertEquals(n, 0);
});

test("Acceptance 3: hospital A cannot read hospital B through the API, even with tampered IDs", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const a = await bookingHospital(api, owner);
  const b = await bookingHospital(api, owner);
  assertEquals((await a.adminClient.get(`/hospital/me?hospitalId=${b.hospitalId}`)).body.id, a.hospitalId);
  const users = await a.adminClient.get(`/hospital/users?hospitalId=${b.hospitalId}&hospital_id=${b.hospitalId}`);
  const emails = users.body.users.map((u: any) => u.email);
  assert(emails.includes(a.admin.email) && !emails.includes(b.admin.email));
  assertEquals((await a.adminClient.get(`/hospital/users/${b.admin.id}`)).status, 404);
  assertEquals((await a.adminClient.get(`/hospital/users/${a.admin.id}`)).status, 200);
  assertEquals((await a.adminClient.get(`/admin/hospitals/${b.hospitalId}`)).status, 403);
});

test("Acceptance 3: row-level security stops hospital A's context from seeing or changing B's rows; no context, no rows", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const a = await bookingHospital(api, owner);
  const b = await bookingHospital(api, owner);
  await appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${a.hospitalId}, true)`;
    const zero = async (q: string, p: unknown[]) => assertEquals((await tx.unsafe(q, p as never[])).length, 0, q);
    await zero("SELECT 1 FROM hospitals WHERE id = $1", [b.hospitalId]);
    await zero("SELECT 1 FROM users WHERE hospital_id = $1", [b.hospitalId]);
    await zero("SELECT 1 FROM users WHERE id = $1", [b.admin.id]);
    await zero("SELECT 1 FROM hospital_slugs WHERE slug = $1", [b.slug]);
    await zero("SELECT 1 FROM sessions WHERE user_id = $1", [b.admin.id]);
    await zero("SELECT 1 FROM user_roles WHERE user_id = $1", [b.admin.id]);
    await zero("SELECT 1 FROM audit_log WHERE hospital_id = $1", [b.hospitalId]);
    assertEquals((await tx`SELECT 1 FROM hospitals`).length, 1);
    assertEquals((await tx`UPDATE hospitals SET name_en = 'pwned' WHERE id = ${b.hospitalId}`).count, 0);
    assertEquals((await tx`UPDATE users SET status = 'disabled' WHERE id = ${b.admin.id}`).count, 0);
    let code = "";
    try {
      await tx.savepoint((sp) => sp`INSERT INTO audit_log (hospital_id, action, target) VALUES (${b.hospitalId}, 'x', 'x')`);
    } catch (e) {
      code = (e as { code: string }).code;
    }
    assertEquals(code, "42501");
  });
  for (const table of ["hospitals", "hospital_slugs", "users", "user_roles", "sessions", "one_time_links", "audit_log", "bookings"]) {
    const [{ n }] = await appSql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
    assertEquals(n, 0, table);
  }
});

test("The application role cannot bypass RLS, edit or delete the audit log, or delete slugs", async () => {
  const [{ x }] = await appSql<{ x: boolean }[]>`SELECT rolbypassrls OR rolsuper AS x FROM pg_roles WHERE rolname = current_user`;
  assertEquals(x, false);
  for (const q of [
    "UPDATE audit_log SET action = 'x'",
    "DELETE FROM audit_log",
    "DELETE FROM hospital_slugs",
    "DELETE FROM users",
    "ALTER TABLE users DISABLE ROW LEVEL SECURITY",
  ]) {
    let code = "";
    try {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.scope', 'system', true)`;
        await tx.unsafe(q);
      });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    assertEquals(code, "42501", q);
  }
  let code = "";
  try {
    await appSql.begin(async (tx) => {
      await tx`SET LOCAL row_security = off`;
      await tx`SELECT count(*) FROM users`;
    });
  } catch (e) {
    code = (e as { code: string }).code;
  }
  assertEquals(code, "42501");
});

test("Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const api = await TestApi.create();
  // Email delivery that fails, and an endpoint that fails: both are logged.
  const failing = { send: () => Promise.reject(new TypeError("network down")) };
  let owner, ownerUser, h;
  try {
    ({ client: owner, user: ownerUser } = await api.companyUser("owner"));
    h = await bookingHospital(api, owner);
    await api.anonymous().login(h.admin.email, "definitely-wrong-password", null);
    (api.deps as { email: unknown }).email = failing;
    await owner.post(`/admin/hospitals/${h.hospitalId}/recover-admin`, { checks: [true, true, true] });
    await h.adminClient.post("/auth/logout", {});
    await owner.post("/auth/logout", {});
    await ownerSql.unsafe("CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
    await ownerSql.unsafe("CREATE TRIGGER test_fail BEFORE INSERT ON closures FOR EACH ROW EXECUTE FUNCTION test_fail()");
    const again = await api.signIn(h.admin);
    assertEquals((await again.post("/hospital/closures", { date: "2030-01-01" })).status, 500);
  } finally {
    await ownerSql.unsafe("DROP TRIGGER IF EXISTS test_fail ON closures; DROP FUNCTION IF EXISTS test_fail()");
    Object.assign(console, orig);
  }
  const all = lines.join("\n");
  assert(all.includes("email delivery failed") && all.includes("unhandled"), all);
  for (const s of secrets) assert(!all.includes(s), "a secret is in the logs");
  for (const e of [ownerUser!.email, h!.admin.email]) assert(!all.toLowerCase().includes(e.toLowerCase()));
  assert(!all.includes("#t=") && !all.includes("definitely-wrong-password"));
  for (const m of api.email.sent) assert(!all.includes(CapturingEmail.tokenFrom(m)));
});

test("Startup refuses missing or weak secrets", async () => {
  let message = "";
  try {
    await loadConfig({ SESSION_SIGNING_KEY: btoa("x".repeat(8)), PROXY_SECRET: "short" });
  } catch (e) {
    message = (e as Error).message;
  }
  for (const part of ["DB_APP_URL", "SESSION_SIGNING_KEY (needs at least 32 random bytes)", "TOTP_ENC_KEY", "EMAIL_FROM", "PROXY_SECRET (at least 32 characters)"]) {
    assert(message.includes(part), message);
  }
});
