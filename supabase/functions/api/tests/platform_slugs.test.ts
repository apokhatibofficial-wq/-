import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { appSql, hospital, newEmail, ownerSql, test, TestApi } from "./harness.ts";

const ownerDefaults = { defaultTimezone: "Asia/Damascus", bookingWindowDays: 14, minNoticeMin: 30, patientCanCancel: false, perPhoneDailyLimit: 0 };
const newSlug = (p: string) => p + "-" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);

test("System settings start with the owner's values: Syria, 14 days, 30 minutes, no patient cancellation, no per-phone limit", async () => {
  const rows = await ownerSql`SELECT default_timezone, booking_window_days, min_notice_min, patient_can_cancel, per_phone_daily_limit FROM platform_settings`;
  assertEquals(rows.length, 1);
  assertEquals({ ...rows[0] }, { default_timezone: "Asia/Damascus", booking_window_days: 14, min_notice_min: 30, patient_can_cancel: false, per_phone_daily_limit: 0 });
});

test("Only an Owner changes system settings; all company roles can read them; hospitals cannot reach them", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { client: support } = await api.companyUser("support");
  const { client: viewer } = await api.companyUser("viewer");
  const { adminClient: hadmin } = await hospital(api, owner);
  for (const c of [owner, support, viewer]) assertEquals((await c.get("/admin/settings")).status, 200);
  assertEquals((await hadmin.get("/admin/settings")).status, 403);
  for (const c of [support, viewer, hadmin]) assertEquals((await c.patch("/admin/settings", { bookingWindowDays: 30 })).status, 403);
});

test("System settings are validated, audited, and a new default time zone applies to new hospitals", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  try {
    for (const bad of [{ defaultTimezone: "Nowhere/City" }, { bookingWindowDays: 0 }, { bookingWindowDays: 400 }, { minNoticeMin: -1 }, { minNoticeMin: 2000 }, { perPhoneDailyLimit: 51 }]) {
      assertEquals((await owner.patch("/admin/settings", bad)).status, 422);
    }
    const r = await owner.patch("/admin/settings", { defaultTimezone: "Europe/Istanbul", bookingWindowDays: 21, minNoticeMin: 60 });
    assertEquals(r.status, 200);
    assertEquals(r.body.bookingWindowDays, 21);
    assertEquals(r.body.patientCanCancel, false);
    const created = await owner.post("/admin/hospitals", { nameAr: "م", nameEn: "Default zone", adminEmail: newEmail("z"), slug: newSlug("dz") });
    assertEquals((await owner.get(`/admin/hospitals/${created.body.id}`)).body.hospital.timezone, "Europe/Istanbul");
    const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'platform_settings'`;
    assert(n >= 1);
  } finally {
    assertEquals((await owner.patch("/admin/settings", ownerDefaults)).status, 200);
  }
});

test("Per-hospital booking rules: set from the console, shown read-only to the hospital, reset to the company value with null", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { client: support } = await api.companyUser("support");
  const { hospitalId: hid, adminClient: hadmin } = await hospital(api, owner);
  let me = await hadmin.get("/hospital/me");
  assertEquals(me.body.bookingRules, { windowDays: 14, minNoticeMin: 30, overridden: false });
  assertEquals((await support.put(`/admin/hospitals/${hid}/booking-rules`, { bookingWindowDays: 7, minNoticeMin: 120 })).status, 403);
  assertEquals((await hadmin.put(`/admin/hospitals/${hid}/booking-rules`, { bookingWindowDays: 7, minNoticeMin: 120 })).status, 403);
  assertEquals((await owner.put(`/admin/hospitals/${hid}/booking-rules`, { bookingWindowDays: 0, minNoticeMin: null })).status, 422);
  const set = await owner.put(`/admin/hospitals/${hid}/booking-rules`, { bookingWindowDays: 7, minNoticeMin: null });
  assertEquals(set.status, 200);
  assertEquals(set.body, { bookingWindowDays: 7, minNoticeMin: 30, overridden: true });
  me = await hadmin.get("/hospital/me");
  assertEquals(me.body.bookingRules, { windowDays: 7, minNoticeMin: 30, overridden: true });
  assertEquals((await owner.get(`/admin/hospitals/${hid}`)).body.hospital.bookingWindowDays, 7);
  assertEquals((await owner.put(`/admin/hospitals/${hid}/booking-rules`, { bookingWindowDays: null, minNoticeMin: null })).status, 200);
  assertEquals((await hadmin.get("/hospital/me")).body.bookingRules.overridden, false);
  assertEquals((await owner.put("/admin/hospitals/hsp_01ARZ3NDEKTSV4RRFFQ69G5FAV/booking-rules", { bookingWindowDays: 7 })).status, 404);
});

test("The database stops a hospital session from changing company-controlled fields or the system settings", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: hid } = await hospital(api, owner);
  for (const q of [
    "UPDATE hospitals SET booking_window_days = 90 WHERE id = $1",
    "UPDATE hospitals SET status = 'suspended' WHERE id = $1",
    "UPDATE hospitals SET name_en = 'renamed' WHERE id = $1",
  ]) {
    const e = await assertRejects(() =>
      appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${hid}, true)`;
        await tx.unsafe(q, [hid]);
      })
    );
    assertEquals((e as { code: string }).code, "42501", q);
  }
  await assertRejects(() =>
    appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${hid}, true)`;
      assertEquals((await tx`UPDATE hospitals SET no_show_grace_min = 20 WHERE id = ${hid}`).count, 1);
      assertEquals((await tx`UPDATE platform_settings SET booking_window_days = 99`).count, 0);
      throw new Error("rollback");
    }), Error, "rollback");
});

test("Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { slug } = await hospital(api, owner);
  const body = (s: string) => ({ nameAr: "م", nameEn: "Slug Hospital", adminEmail: newEmail("s"), slug: s });
  const dup = await owner.post("/admin/hospitals", body(slug));
  assertEquals(dup.status, 409);
  assertEquals(dup.body, { error: "SLUG_TAKEN", detail: null });
  for (const reserved of ["admin", "api", "book", "www", "medlink"]) assertEquals((await owner.post("/admin/hospitals", body(reserved))).status, 409);
  for (const bad of ["ab", "-abc", "abc-", "Abc", "ab_c", "عربي", "a".repeat(41)]) assertEquals((await owner.post("/admin/hospitals", body(bad))).status, 422);
  assertEquals((await owner.get(`/admin/slugs/check?slug=${slug}`)).body.state, "taken");
  assertEquals((await owner.get("/admin/slugs/check?slug=admin")).body.state, "taken");
  assertEquals((await owner.get("/admin/slugs/check?slug=A")).body.state, "bad");
  assertEquals((await owner.get(`/admin/slugs/check?slug=${newSlug("free")}`)).body.state, "ok");
  const pub = await api.anonymous().get(`/public/book/${slug}`);
  assertEquals(pub.status, 200);
  assertEquals(pub.body.state, "active");
  assertEquals((await api.anonymous().get(`/public/book/${newSlug("nobody")}`)).status, 404);
});

test("Two concurrent creates with the same slug: exactly one wins", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const slug = newSlug("race");
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
    owner.post("/admin/hospitals", { nameAr: "م", nameEn: "Race " + i, adminEmail: newEmail("r"), slug })
  ));
  assertEquals(results.filter((r) => r.status === 201).length, 1);
  for (const r of results.filter((r) => r.status !== 201)) assertEquals(r.status, 409);
});

test("Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: hid, slug: oldSlug } = await hospital(api, owner);
  const renamed = newSlug("renamed");
  assertEquals((await owner.patch(`/admin/hospitals/${hid}`, { nameAr: "مستشفى الاختبار", nameEn: "Test Hospital", slug: renamed })).status, 200);
  const anon = api.anonymous();
  const moved = await anon.get(`/public/book/${oldSlug}`);
  assertEquals(moved.status, 301);
  assertEquals(moved.body, { state: "moved", slug: renamed });
  assertEquals(moved.headers.get("location"), "/public/book/" + renamed);
  assertEquals((await anon.get(`/public/book/${renamed}`)).status, 200);
  const viaApp = await anon.get(`/public/slugs/${oldSlug}`);
  assertEquals([viaApp.status, viaApp.body.state, viaApp.body.slug], [200, "active", renamed]);

  const detail = await owner.get(`/admin/hospitals/${hid}`);
  assertEquals(detail.body.oldSlugs[0].slug, oldSlug);
  const days = (new Date(detail.body.oldSlugs[0].redirectUntil).getTime() - Date.now()) / 86400000;
  assert(days > 89.9 && days < 90.1);
  const tooSoon = await owner.patch(`/admin/hospitals/${hid}`, { nameAr: "م", nameEn: "Test Hospital", slug: newSlug("again") });
  assertEquals(tooSoon.status, 409);
  assertEquals(tooSoon.body.error, "SLUG_CHANGE_TOO_SOON");
  assertEquals(typeof tooSoon.body.detail, "string");
  const steal = await owner.post("/admin/hospitals", { nameAr: "م", nameEn: "Thief", adminEmail: newEmail("t"), slug: oldSlug });
  assertEquals(steal.status, 409);

  await ownerSql`UPDATE hospital_slugs SET retired_at = now() - interval '91 days', redirect_until = now() - interval '1 day' WHERE slug = ${oldSlug}`;
  const gone = await anon.get(`/public/book/${oldSlug}`);
  assertEquals([gone.status, gone.body.error], [410, "LINK_CHANGED"]);
  assertEquals((await anon.get(`/public/slugs/${oldSlug}`)).body.state, "changed");
  assertEquals((await anon.get(`/public/slugs/${newSlug("nobody")}`)).status, 404);

  const back = await owner.patch(`/admin/hospitals/${hid}`, { nameAr: "م", nameEn: "Test Hospital", slug: oldSlug });
  assertEquals(back.status, 200);
  assertEquals((await anon.get(`/public/book/${oldSlug}`)).status, 200);
  assertEquals((await anon.get(`/public/book/${renamed}`)).status, 301);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM hospital_slugs WHERE hospital_id = ${hid}`;
  assertEquals(n, 2);
});
