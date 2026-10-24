import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { newToken, tokenHash } from "../src/security.ts";
import { CapturingEmail, hospital, newEmail, ownerSql, secrets, test, TestApi } from "./harness.ts";

const rnd = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

test("Acceptance 2/25: anonymous callers are refused by the server on every protected route", async () => {
  const api = await TestApi.create();
  const anon = api.anonymous();
  for (const path of ["/admin/hospitals", "/admin/reports", "/admin/audit", "/hospital/me", "/hospital/users", "/auth/me"]) {
    assertEquals((await anon.get(path)).status, 401, path);
  }
  assertEquals((await anon.post("/admin/hospitals", { nameAr: "x", nameEn: "x", adminEmail: "a@b.co", slug: "abc" })).status, 401);
  anon.sessionToken = newToken();
  assertEquals((await anon.get("/admin/hospitals")).status, 401);
});

test("Acceptance 25: each company role can do only what the matrix allows", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { client: support } = await api.companyUser("support");
  const { client: viewer } = await api.companyUser("viewer");
  const { hospitalId: hid } = await hospital(api, owner);
  const newHospital = () => ({ nameAr: "م", nameEn: "Matrix Hospital", adminEmail: newEmail("m"), slug: "mx-" + rnd() });
  assertEquals((await support.post("/admin/hospitals", newHospital())).status, 403);
  assertEquals((await viewer.post("/admin/hospitals", newHospital())).status, 403);
  assertEquals((await support.patch(`/admin/hospitals/${hid}`, { nameAr: "x", nameEn: "y" })).status, 403);
  assertEquals((await support.post(`/admin/hospitals/${hid}/suspend`, { reason: "testing roles" })).status, 403);
  assertEquals((await viewer.post(`/admin/hospitals/${hid}/suspend`, { reason: "testing roles" })).status, 403);
  const checks = { checks: [true, true, true] };
  assertEquals((await viewer.post(`/admin/hospitals/${hid}/recover-admin`, checks)).status, 403);
  assertEquals((await support.post(`/admin/hospitals/${hid}/recover-admin`, checks)).status, 200);
  for (const c of [owner, support, viewer]) assertEquals((await c.get("/admin/reports")).status, 200);
  const ownerAudit = await owner.get("/admin/audit");
  assertEquals(ownerAudit.body.scope, "full");
  assert(ownerAudit.body.entries.length > 0);
  const supportAudit = await support.get("/admin/audit?limit=50");
  assertEquals(supportAudit.body.scope, "hospital");
  assert(supportAudit.body.entries.length <= 50);
  for (const e of supportAudit.body.entries) assert(e.hospitalId !== null);
  assertEquals((await viewer.get("/admin/audit")).status, 403);
  assertEquals((await owner.get("/admin/audit?limit=abc")).status, 400);
});

test("Hospital users cannot reach the company console, and company users cannot use hospital routes", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: hadmin } = await hospital(api, owner);
  for (const path of ["/admin/hospitals", "/admin/reports", "/admin/audit"]) assertEquals((await hadmin.get(path)).status, 403, path);
  assertEquals((await hadmin.post("/admin/hospitals", { nameAr: "x", nameEn: "x", adminEmail: "a@b.co", slug: "zzz" })).status, 403);
  assertEquals((await owner.get("/hospital/me")).status, 403);
  assertEquals((await owner.get("/hospital/users")).status, 403);
});

test("Cookie requests that change state need the CSRF token", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const body = { nameAr: "م", nameEn: "Csrf Hospital", adminEmail: newEmail("c"), slug: "csrf-" + rnd() };
  const noToken = await owner.post("/admin/hospitals", body, false);
  assertEquals([noToken.status, noToken.body.error], [403, "CSRF_INVALID"]);
  const saved = owner.csrf;
  owner.csrf = "forged";
  assertEquals((await owner.post("/admin/hospitals", body)).status, 403);
  owner.csrf = saved;
  assertEquals((await owner.post("/admin/hospitals", body)).status, 201);
});

test("A browser that is already signed in can still open one-time links and sign in again (anonymous routes ignore the cookie)", async () => {
  const api = await TestApi.create();
  const { client: owner, user: ownerUser } = await api.companyUser("owner");
  const adminEmail = newEmail("hadmin");
  await owner.post("/admin/hospitals", { nameAr: "م", nameEn: "Cookie Hospital", adminEmail, slug: "ck-" + rnd() });
  const token = CapturingEmail.tokenFrom(api.email.lastTo(adminEmail));
  secrets.push(token);
  assertEquals((await owner.post("/auth/link/inspect", { token }, false)).status, 200);
  await api.allowNextTotp(ownerUser.email);
  assertEquals((await owner.login(ownerUser.email, ownerUser.password, ownerUser.totpSecret)).status, 200);
  assertEquals((await owner.post("/admin/hospitals", { nameAr: "x", nameEn: "x", adminEmail: "a@b.co", slug: "zz-zz" }, false)).status, 403);
});

test("Suspending a hospital revokes its sessions and blocks sign-in; reactivating restores it", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: hid, slug, admin, adminClient } = await hospital(api, owner);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/suspend`, { reason: "" })).status, 422);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/suspend`, { reason: "Contract paused by management" })).status, 200);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/suspend`, { reason: "Contract paused by management" })).body.error, "ALREADY_SUSPENDED");
  assertEquals((await adminClient.get("/hospital/me")).status, 401);
  await api.allowNextTotp(admin.email);
  const login = await api.anonymous().login(admin.email, admin.password, admin.totpSecret);
  assertEquals([login.status, login.body.error], [403, "HOSPITAL_SUSPENDED"]);
  assertEquals((await api.anonymous().get(`/public/book/${slug}`)).body.acceptingBookings, false);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/reactivate`, { reason: "Contract renewed" })).status, 200);
  const again = await api.signIn(admin);
  assertEquals((await again.get("/hospital/me")).body.status, "active");
  const actions = (await ownerSql<{ action: string }[]>`SELECT action FROM audit_log WHERE hospital_id = ${hid} ORDER BY id`).map((r) => r.action);
  assert(actions.includes("hospital_suspend") && actions.includes("hospital_reactivate"));
});

test("Recovering admin access needs all 3 identity checks, revokes sessions and emails a 1-hour reset link", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: hid, admin, adminClient } = await hospital(api, owner);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/recover-admin`, { checks: [true, true, false] })).status, 422);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/recover-admin`, { checks: [true] })).status, 422);
  assertEquals((await owner.post(`/admin/hospitals/${hid}/recover-admin`, {})).status, 422);
  const before = api.email.sent.length;
  const ok = await owner.post(`/admin/hospitals/${hid}/recover-admin`, { checks: [true, true, true] });
  assertEquals(ok.body, { status: "ok", emailSent: true });
  assert(api.email.sent.length > before);
  const mail = api.email.lastTo(admin.email);
  assertEquals(mail.kind, "reset");
  assertEquals((await adminClient.get("/hospital/me")).status, 401);
  const [{ exp }] = await ownerSql<{ exp: Date }[]>`SELECT expires_at AS exp FROM one_time_links WHERE token_hash = ${await tokenHash(CapturingEmail.tokenFrom(mail))}`;
  const minutes = (exp.getTime() - Date.now()) / 60000;
  assert(minutes > 59 && minutes <= 60.1);
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(mail));
  await api.allowNextTotp(admin.email);
  assertEquals((await api.anonymous().login(admin.email, admin.password, totpSecret)).status, 401);
  await api.signIn({ ...admin, password, totpSecret });
  assertEquals((await owner.post("/admin/hospitals/hsp_01ARZ3NDEKTSV4RRFFQ69G5FAV/recover-admin", { checks: [true, true, true] })).status, 404);
});
