import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { CapturingEmail, newEmail, ownerSql, secrets, test, TestApi } from "./harness.ts";

test("Team: only an Owner invites company staff, by an emailed 24-hour activation link", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { client: support } = await api.companyUser("support");
  const email = newEmail("support");
  assertEquals((await support.get("/admin/team")).status, 403);
  assertEquals((await support.post("/admin/team", { email, role: "viewer" })).status, 403);
  assertEquals((await owner.post("/admin/team", { email, role: "hosp_admin" })).status, 422);
  assertEquals((await owner.post("/admin/team", { email: "not an email", role: "viewer" })).body, { error: "EMAIL_INVALID" });
  const r = await owner.post("/admin/team", { email, role: "support" });
  assertEquals(r.status, 201);
  const mail = api.email.lastTo(email);
  assertEquals(mail.kind, "activation");
  assertStringIncludes(mail.textBody, "https://admin.medlink.website/link#t=");
  const [{ hours }] = await ownerSql<{ hours: number }[]>`
    SELECT extract(epoch FROM l.expires_at - l.created_at)::int / 3600 AS hours FROM one_time_links l WHERE l.user_id = ${r.body.id}`;
  assertEquals(hours, 24);
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(mail));
  assert(totpSecret !== null);
  const c = await api.signIn({ id: r.body.id, email, password, totpSecret });
  assertEquals((await c.get("/admin/reports")).status, 200);
  assertEquals((await owner.post("/admin/team", { email, role: "viewer" })).status, 409);
  const list = (await owner.get("/admin/team")).body.users;
  const me = list.find((u: any) => u.email === email);
  assertEquals([me.status, me.roles, me.has2fa, me.departmentIds], ["active", ["support"], true, []]);
});

test("Team: role changes revoke sessions; nobody can change themselves; two Owners demoting each other at once leave one Owner", async () => {
  const api = await TestApi.create();
  const { client: a, user: aUser } = await api.companyUser("owner");
  const { client: viewer, user: viewerUser } = await api.companyUser("viewer");
  assertEquals((await a.patch(`/admin/team/${aUser.id}`, { role: "viewer" })).status, 409);
  assertEquals((await a.patch(`/admin/team/${viewerUser.id}`, { role: "support" })).status, 200);
  assertEquals((await viewer.get("/admin/reports")).status, 401);

  const { client: b, user: bUser } = await api.companyUser("owner");
  const parked = (await ownerSql<{ id: string }[]>`
    UPDATE users SET status = 'disabled' WHERE scope = 'company' AND status = 'active' AND id NOT IN (${aUser.id}, ${bUser.id})
      AND id IN (SELECT user_id FROM user_roles WHERE role = 'owner') RETURNING id`).map((r) => r.id);
  try {
    const results = await Promise.all([
      a.patch(`/admin/team/${bUser.id}`, { role: "viewer" }),
      b.patch(`/admin/team/${aUser.id}`, { role: "viewer" }),
    ]);
    assertEquals(results.filter((r) => r.status === 200).length, 1);
    for (const r of results.filter((r) => r.status !== 200)) assert([409, 401].includes(r.status), String(r.status));
    const [{ n }] = await ownerSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'owner'
      WHERE u.id IN (${aUser.id}, ${bUser.id}) AND u.status = 'active'`;
    assertEquals(n, 1);
  } finally {
    await ownerSql`UPDATE users SET status = 'active' WHERE id = ANY(${parked}::text[])`;
  }
});

test("reset-company-user (SQL editor): revokes sessions and issues a 1-hour reset link", async () => {
  const api = await TestApi.create();
  const { client, user } = await api.companyUser("owner");
  const [{ url }] = await ownerSql<{ url: string }[]>`SELECT medlink_reset_company_user(${user.email}) AS url`;
  assert(url.startsWith("https://admin.medlink.website/link#t="));
  const token = url.slice(url.indexOf("#t=") + 3);
  secrets.push(token);
  assertEquals((await client.get("/auth/me")).status, 401);
  const inspect = await api.anonymous().post("/auth/link/inspect", { token }, false);
  assertEquals(inspect.body.purpose, "reset");
  let message = "";
  try {
    await ownerSql`SELECT medlink_reset_company_user(${newEmail("nobody")})`;
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "No company user");
});

test("A session ends 7 days after sign-in even if it is used all the time", async () => {
  const api = await TestApi.create();
  const { client, user } = await api.companyUser("viewer");
  assertEquals((await client.get("/auth/me")).status, 200);
  const [{ ok }] = await ownerSql<{ ok: boolean }[]>`
    SELECT bool_and(absolute_expires_at - created_at BETWEEN interval '6 days 23 hours' AND interval '7 days 1 minute') AS ok FROM sessions WHERE user_id = ${user.id}`;
  assert(ok);
  await ownerSql`UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() + interval '1 hour' WHERE user_id = ${user.id}`;
  assertEquals((await client.get("/auth/me")).status, 401);
});

test("Hospital time zone: defaults to Asia/Damascus, can be chosen at creation and edited; unknown zones are refused", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const slug = () => "tz-" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const body = (tz: string) => ({ nameAr: "م", nameEn: "Tz Hospital", adminEmail: newEmail("tz"), slug: slug(), timezone: tz });
  assertEquals((await owner.post("/admin/hospitals", body("Not/AZone"))).status, 422);
  const plain = await owner.post("/admin/hospitals", { nameAr: "م", nameEn: "Default Tz", adminEmail: newEmail("tz"), slug: slug() });
  assertEquals(plain.status, 201);
  assertEquals((await owner.get(`/admin/hospitals/${plain.body.id}`)).body.hospital.timezone, "Asia/Damascus");
  const r = await owner.post("/admin/hospitals", body("Europe/Istanbul"));
  assertEquals(r.status, 201);
  const id = r.body.id;
  assertEquals((await owner.get(`/admin/hospitals/${id}`)).body.hospital.timezone, "Europe/Istanbul");
  assertEquals((await owner.patch(`/admin/hospitals/${id}`, { nameAr: "م", nameEn: "Tz Hospital", timezone: "Africa/Tripoli" })).status, 200);
  assertEquals((await owner.get(`/admin/hospitals/${id}`)).body.hospital.timezone, "Africa/Tripoli");
  assertEquals((await owner.patch(`/admin/hospitals/${id}`, { nameAr: "م", nameEn: "Tz", timezone: "Nowhere" })).status, 422);
});
