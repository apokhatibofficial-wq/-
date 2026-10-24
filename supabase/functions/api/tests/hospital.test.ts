import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1.0.14";
import { appSql, CapturingEmail, hospital, newEmail, ownerSql, secrets, staff, test, TestApi } from "./harness.ts";

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test("Acceptance 1: create a hospital account, the admin activates it and signs in", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const adminEmail = newEmail("hadmin");
  const slug = "al-noor-" + crypto.randomUUID().slice(0, 6);
  const create = await owner.post("/admin/hospitals", { nameAr: "مستشفى النور", nameEn: "Al Noor Hospital", nameTr: "", adminEmail, slug });
  assertEquals(create.status, 201);
  const id: string = create.body.id;
  assertMatch(id, /^hsp_[0-9A-HJKMNP-TV-Z]{26}$/);
  assertEquals(create.body.emailSent, true);

  // No password exists yet; the hospital waits for activation.
  const [row] = await ownerSql<{ password_hash: string | null; status: string; hstatus: string }[]>`
    SELECT u.password_hash, u.status, h.status AS hstatus FROM users u JOIN hospitals h ON h.id = u.hospital_id WHERE u.email = ${adminEmail}`;
  assertEquals([row.password_hash, row.status, row.hstatus], [null, "pending", "pending"]);

  const mail = api.email.lastTo(adminEmail);
  assertEquals(mail.kind, "activation");
  assert(mail.textBody.includes("https://app.medlink.website/link#t="));
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(mail));
  assert(totpSecret !== null); // TOTP is mandatory for hospital admins

  const admin = api.anonymous();
  await api.allowNextTotp(adminEmail);
  const noCode = await admin.login(adminEmail, password, null);
  assertEquals(noCode.body.status, "mfa_required");
  const ok = await admin.login(adminEmail, password, totpSecret);
  assertEquals(ok.status, 200);
  const me = await admin.get("/hospital/me");
  assertEquals(me.status, 200);
  assertEquals(me.body.id, id);
  assertEquals(me.body.status, "active");
  assertEquals(me.body.slug, slug);
  assertEquals(me.body.name, { ar: "مستشفى النور", en: "Al Noor Hospital", tr: null });
  assertEquals(me.body.timezone, "Asia/Damascus");
  assertEquals(me.body.bookingRules, { windowDays: 14, minNoticeMin: 30, overridden: false });
});

test("Hospital admin invites reception and scanner staff; they activate without 2FA by default and get only their permissions", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: admin } = await hospital(api, owner);
  const { client: reception, user: recUser } = await staff(api, admin, "reception");
  const { client: scanner } = await staff(api, admin, "scanner");
  assertEquals(recUser.totpSecret, null);

  for (const role of ["hosp_admin", "owner", "superuser"]) {
    assertEquals((await admin.post("/hospital/users", { email: newEmail("x"), role })).status, 422);
  }
  for (const c of [reception, scanner]) {
    assertEquals((await c.get("/hospital/me")).status, 200);
    assertEquals((await c.get("/hospital/departments")).status, 200);
    assertEquals((await c.patch("/hospital/settings", { noShowGraceMin: 10 })).status, 403);
    assertEquals((await c.post("/hospital/departments", { nameAr: "قسم" })).status, 403);
    assertEquals((await c.get("/hospital/users")).status, 403);
    assertEquals((await c.post("/hospital/users", { email: newEmail("y"), role: "scanner" })).status, 403);
  }
  const list = await admin.get("/hospital/users");
  assertEquals(list.body.users.length, 3);
});

test("Changing a staff role or disabling the account revokes sessions; admins cannot change themselves or other admins", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { admin: adminUser, adminClient: admin } = await hospital(api, owner);
  const { client: reception, user: recUser } = await staff(api, admin, "reception");

  assertEquals((await admin.patch(`/hospital/users/${recUser.id}`, { role: "scanner" })).status, 200);
  assertEquals((await reception.get("/hospital/me")).status, 401);
  const again = await api.signIn(recUser);
  assertEquals((await again.get("/auth/me")).body.user.roles[0], "scanner");

  assertEquals((await admin.patch(`/hospital/users/${recUser.id}`, { disabled: true })).status, 200);
  assertEquals((await again.get("/hospital/me")).status, 401);
  assertEquals((await api.anonymous().login(recUser.email, recUser.password, null)).status, 401);
  assertEquals((await admin.patch(`/hospital/users/${recUser.id}`, { disabled: false })).status, 200);
  await api.signIn(recUser);

  assertEquals((await admin.patch(`/hospital/users/${adminUser.id}`, { disabled: true })).status, 409);
  const other = await hospital(api, owner);
  assertEquals((await admin.patch(`/hospital/users/${other.admin.id}`, { disabled: true })).status, 404);
  assertEquals((await admin.post(`/hospital/users/${other.admin.id}/send-link`, {})).status, 404);
});

test("Send-link gives a pending user a new activation link and an active user a reset link", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: admin } = await hospital(api, owner);
  const email = newEmail("pending");
  const inv = await admin.post("/hospital/users", { email, role: "scanner" });
  const id = inv.body.id;
  const first = CapturingEmail.tokenFrom(api.email.lastTo(email));
  secrets.push(first);
  assertEquals((await admin.post(`/hospital/users/${id}/send-link`, {})).status, 200);
  const mail = api.email.lastTo(email);
  assertEquals(mail.kind, "activation");
  assertEquals((await api.anonymous().post("/auth/link/inspect", { token: first }, false)).status, 410);
  await api.completeLink(CapturingEmail.tokenFrom(mail));
  assertEquals((await admin.post(`/hospital/users/${id}/send-link`, {})).status, 200);
  assertEquals(api.email.lastTo(email).kind, "reset");
  // JSON-only, like every endpoint that changes something.
  assertEquals((await admin.send("POST", `/hospital/users/${id}/send-link`, undefined, { headers: { "content-type": "text/plain" } })).status, 415);
});

test("When the hospital requires staff 2FA, new staff must enrol and staff without 2FA are told to get a reset link", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: admin } = await hospital(api, owner);
  const { user: before } = await staff(api, admin, "reception");
  assertEquals((await admin.patch("/hospital/settings", { staffTotpRequired: true })).status, 200);
  const login = await api.anonymous().login(before.email, before.password, null);
  assertEquals(login.status, 403);
  assertEquals(login.body.error, "MFA_NOT_ENROLLED");
  const { user: after } = await staff(api, admin, "scanner");
  assert(after.totpSecret !== null);
});

test("Hospital settings: validated ranges and real IANA time zones, recorded in the audit log", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId, adminClient: admin } = await hospital(api, owner);
  assertEquals((await admin.patch("/hospital/settings", { noShowGraceMin: 999 })).status, 422);
  assertEquals((await admin.patch("/hospital/settings", { retentionMonths: 0 })).status, 422);
  assertEquals((await admin.patch("/hospital/settings", { timezone: "Mars/Olympus" })).status, 422);
  assertEquals((await admin.patch("/hospital/settings", { noShowGraceMin: "ten" })).status, 400);
  assertEquals((await admin.patch("/hospital/settings", { noShowGraceMin: 45, retentionMonths: 36, timezone: "Africa/Tripoli" })).status, 200);
  const me = await admin.get("/hospital/me");
  assertEquals([me.body.noShowGraceMin, me.body.retentionMonths, me.body.timezone], [45, 36, "Africa/Tripoli"]);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE hospital_id = ${hospitalId} AND action = 'hospital_settings'`;
  assertEquals(n, 1);
});

test("Departments and weekly schedules: validation, overlap rejected by the database, deactivate instead of delete", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { slug, adminClient: admin } = await hospital(api, owner);
  assertEquals((await admin.post("/hospital/departments", { nameAr: "  " })).status, 422);
  const dep = await admin.post("/hospital/departments", { nameAr: "الباطنية", nameEn: "Internal medicine", nameTr: "Dahiliye" });
  assertEquals(dep.status, 201);
  const depId = dep.body.id;
  assertEquals((await admin.post("/hospital/departments", { nameAr: "الباطنية " })).status, 409);
  const dep2 = (await admin.post("/hospital/departments", { nameAr: "الأطفال", nameEn: "Paediatrics" })).body.id;

  const ok = await admin.put(`/hospital/departments/${depId}/schedules`, {
    blocks: [
      { weekday: 0, start: "08:00", end: "12:00", slotMinutes: 15, capacity: 2 },
      { weekday: 0, start: "13:00", end: "16:00", slotMinutes: 20, capacity: 1 },
      { weekday: 2, start: "09:00", end: "24:00", slotMinutes: 30, capacity: 3 },
    ],
  });
  assertEquals(ok.status, 200);
  const overlap = await admin.put(`/hospital/departments/${depId}/schedules`, {
    blocks: [
      { weekday: 1, start: "08:00", end: "12:00", slotMinutes: 15, capacity: 2 },
      { weekday: 1, start: "11:30", end: "14:00", slotMinutes: 15, capacity: 2 },
    ],
  });
  assertEquals(overlap.status, 409);
  assertEquals(overlap.body.error, "SCHEDULE_OVERLAP");
  for (const bad of [
    { weekday: 7, start: "08:00", end: "12:00", slotMinutes: 15, capacity: 1 },
    { weekday: 1, start: "12:00", end: "08:00", slotMinutes: 15, capacity: 1 },
    { weekday: 1, start: "8:00", end: "12:00", slotMinutes: 15, capacity: 1 },
    { weekday: 1, start: "08:00", end: "08:10", slotMinutes: 15, capacity: 1 },
    { weekday: 1, start: "08:00", end: "12:00", slotMinutes: 15, capacity: 0 },
  ]) {
    const r = await admin.put(`/hospital/departments/${depId}/schedules`, { blocks: [bad] });
    assertEquals(r.status, 422);
    assertEquals(r.body, { error: "SCHEDULE_INVALID", detail: 0 });
  }
  const list = await admin.get("/hospital/departments");
  const d = list.body.departments.find((x: any) => x.id === depId);
  assertEquals(d.schedules.length, 3);
  assertEquals(d.schedules[2].end, "24:00");
  assertEquals(d.schedules[0], { weekday: 0, start: "08:00", end: "12:00", slotMinutes: 15, capacity: 2 });
  assertEquals(d.name, { ar: "الباطنية", en: "Internal medicine", tr: "Dahiliye" });

  assertEquals((await admin.patch(`/hospital/departments/${dep2}`, { active: false })).status, 200);
  const pub = await api.anonymous().get(`/public/book/${slug}`);
  assertEquals(pub.body.departments.map((x: any) => x.name.ar), ["الباطنية"]);
  assertEquals(pub.body.state, "active");
  assertEquals(pub.body.acceptingBookings, true);
});

test("Closures: one per day per department (or whole hospital), and only for the session's hospital", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: a } = await hospital(api, owner);
  const { adminClient: b } = await hospital(api, owner);
  const bDep = (await b.post("/hospital/departments", { nameAr: "قسم ب" })).body.id;
  const date = day(10);
  const c1 = await a.post("/hospital/closures", { date, reason: "عطلة رسمية" });
  assertEquals(c1.status, 201);
  assertEquals((await a.post("/hospital/closures", { date })).status, 409);
  assertEquals((await a.post("/hospital/closures", { date: "2026-13-40" })).status, 422);
  assertEquals((await a.post("/hospital/closures", { date, departmentId: bDep })).status, 404);
  const bClosure = (await b.post("/hospital/closures", { date })).body.id;
  assertEquals((await a.delete(`/hospital/closures/${bClosure}`)).status, 404);
  const list = (await a.get("/hospital/closures")).body.closures;
  assertEquals(list.length, 1);
  assertEquals(list[0].date, date);
  assertEquals(list[0].reason, "عطلة رسمية");
  assertEquals((await a.delete(`/hospital/closures/${c1.body.id}`)).status, 200);
});

test("RLS also isolates departments, schedules and closures, and the DB rejects cross-hospital links", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: aId } = await hospital(api, owner);
  const { hospitalId: bId, adminClient: b } = await hospital(api, owner);
  const bDep = (await b.post("/hospital/departments", { nameAr: "قسم ب" })).body.id;
  await b.put(`/hospital/departments/${bDep}/schedules`, { blocks: [{ weekday: 1, start: "08:00", end: "10:00", slotMinutes: 30, capacity: 1 }] });
  await b.post("/hospital/closures", { date: day(3) });

  await appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${aId}, true)`;
    for (const table of ["departments", "schedules", "closures"]) {
      const [{ n }] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE hospital_id = $1`, [bId]);
      assertEquals(n, 0, table);
    }
    const e = await assertRejects(() => tx.savepoint((sp) => sp`INSERT INTO departments (id, hospital_id, name_ar) VALUES ('dep_01ARZ3NDEKTSV4RRFFQ69G5FAV', ${bId}, 'x')`));
    assertEquals((e as { code: string }).code, "42501");
    // A schedule in A pointing at B's department is refused by the trigger.
    const e2 = await assertRejects(() => tx.savepoint((sp) => sp`
      INSERT INTO schedules (id, hospital_id, department_id, weekday, start_min, end_min, slot_minutes, capacity)
      VALUES ('sch_01ARZ3NDEKTSV4RRFFQ69G5FAV', ${aId}, ${bDep}, 1, 600, 700, 30, 1)`));
    assertEquals((e2 as { code: string }).code, "23503");
  });
});
