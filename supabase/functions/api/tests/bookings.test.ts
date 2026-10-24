import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import { tokenHash } from "../src/security.ts";
import { localDate } from "../src/tz.ts";
import { appSql, availability, book, bookingHospital, ownerSql, secrets, slot, staff, test, TestApi } from "./harness.ts";
import { first, note, visit } from "./form_fixtures.ts";

test("Acceptance 5/8: book an available slot; the QR is an opaque 128-bit token, stored only as a hash", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const s = await slot(api, h);
  const r = await book(api, h, s, { phone: "+963 944 123-456" });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  const reference: string = r.body.ref, qr: string = r.body.qr;
  assertMatch(reference, /^ML-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assertMatch(qr, /^MLK1\.[A-Za-z0-9_-]{22}$/);
  assertEquals(r.body.department.ar, "الباطنية");
  assertEquals(r.body.hospital.en, "Test Hospital");
  assertEquals(new Date(r.body.slotStart).getTime(), new Date(s).getTime());
  assertEquals(r.body.localDate, localDate(new Date(s), "Asia/Damascus"));
  secrets.push(qr);
  const [row] = await ownerSql<{ h: Uint8Array; phone: string; status: string; seat: number }[]>`
    SELECT qr_token_hash AS h, phone, status, seat_no AS seat FROM bookings WHERE ref = ${reference}`;
  assertEquals([...row.h], [...await tokenHash(qr)]);
  assertEquals([row.phone, row.status, row.seat], ["+963944123456", "waiting", 1]);
  const dump = (await ownerSql<{ t: string }[]>`SELECT row_to_json(b)::text AS t FROM bookings b`).map((x) => x.t).join("\n");
  assert(!dump.includes(qr) && !dump.includes(qr.slice(5)));

  const found = await h.adminClient.get(`/hospital/bookings?ref=${reference.toLowerCase()}`);
  assertEquals(found.body.bookings[0].patientName, "مريض اختبار");
  const av = await availability(api, h);
  assert(!av.days[1].slots.some((x: any) => x.start === s));
});

test("Acceptance 6: the same seat cannot be booked twice at the same time (10 parallel requests, capacity 1 and 2)", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  for (const capacity of [1, 2]) {
    const h = await bookingHospital(api, owner, capacity);
    const s = await slot(api, h);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => book(api, h, s, { name: "مريض " + i })));
    assertEquals(results.filter((r) => r.status === 201).length, capacity);
    for (const r of results.filter((r) => r.status !== 201)) assertEquals([r.status, r.body.error], [409, "SLOT_FULL"]);
    const seats = (await ownerSql<{ s: number }[]>`SELECT seat_no AS s FROM bookings WHERE hospital_id = ${h.hospitalId} ORDER BY seat_no`).map((x) => x.s);
    assertEquals(seats, Array.from({ length: capacity }, (_, i) => i + 1));
  }
});

test("Acceptance 7: re-sending the same request returns the original booking, never a duplicate", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner, 5);
  const s = await slot(api, h);
  const key = crypto.randomUUID().replaceAll("-", "");
  const firstR = await book(api, h, s, { key });
  const again = await Promise.all([0, 1, 2, 3, 4].map(() => book(api, h, s, { key })));
  assertEquals(firstR.status, 201);
  for (const r of again) {
    assertEquals(r.status, 200);
    assertEquals([r.body.ref, r.body.qr], [firstR.body.ref, firstR.body.qr]);
  }
  secrets.push(firstR.body.qr);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE hospital_id = ${h.hospitalId}`;
  assertEquals(n, 1);
  assertEquals((await book(api, h, s, { key, name: "شخص آخر" })).body.error, "IDEMPOTENCY_MISMATCH");
  const noKey = await api.anonymous().post(`/public/hospitals/${h.slug}/bookings`, { departmentId: h.departmentId, slotStart: s, patientName: "x y" }, false);
  assertEquals([noKey.status, noKey.body.error], [400, "IDEMPOTENCY_KEY_REQUIRED"]);
  // A replay more than 24 hours later is refused.
  await ownerSql`UPDATE bookings SET created_at = now() - interval '25 hours' WHERE hospital_id = ${h.hospitalId}`;
  assertEquals((await book(api, h, s, { key })).body.error, "IDEMPOTENCY_EXPIRED");
});

test("Acceptance 13: required and optional answers are checked on the server against the published version", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner, 20);
  await h.adminClient.put("/hospital/form/draft", { questions: [visit(), note(), first()] });
  await h.adminClient.post("/hospital/form/publish", {});
  const fv = (await api.anonymous().get(`/public/hospitals/${h.slug}/form`)).body.form.versionId;
  const s = await slot(api, h);
  const tryIt = async (answers: unknown) => {
    const r = await book(api, h, s, { answers, formVersionId: fv });
    return [r.status, r.status === 201 ? null : r.body.error];
  };
  assertEquals(await tryIt({ visit: "new" }), [422, "ANSWER_REQUIRED"]);
  assertEquals(await tryIt({ visit: "other", first: "yes" }), [422, "ANSWER_INVALID"]);
  assertEquals(await tryIt({ visit: "new", first: "maybe" }), [422, "ANSWER_INVALID"]);
  assertEquals(await tryIt({ visit: "new", first: "no", diagnosis: "x" }), [422, "ANSWER_UNKNOWN_QUESTION"]);
  assertEquals(await tryIt({ visit: "new", first: "no", note: "a".repeat(121) }), [422, "ANSWER_INVALID"]);
  assertEquals(await tryIt({ visit: "fu", first: "no" }), [201, null]);
  assertEquals(await tryIt({ visit: "new", first: "yes", note: "  كرسي متحرك  " }), [201, null]);
  const detail = await book(api, h, s, { answers: { visit: "new" }, formVersionId: fv });
  assertEquals(detail.body, { error: "ANSWER_REQUIRED", detail: { questionId: "first" } });
  const stored = await ownerSql<{ v: string }[]>`SELECT value_json::text AS v FROM booking_answers WHERE hospital_id = ${h.hospitalId} AND question_id = 'note'`;
  assertEquals(stored.map((x) => x.v), ['"كرسي متحرك"']);
  const noForm = await book(api, h, s, { answers: { visit: "new", first: "yes" } });
  assertEquals(noForm.body.error, "FORM_UPDATED");
});

test("Acceptance 18: a form opened before a publish is accepted for 2 hours, then the patient must reload", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner, 20);
  await h.adminClient.put("/hospital/form/draft", { questions: [visit()] });
  await h.adminClient.post("/hospital/form/publish", {});
  const v1 = (await api.anonymous().get(`/public/hospitals/${h.slug}/form`)).body.form.versionId;
  await h.adminClient.put("/hospital/form/draft", { questions: [visit(), first()] });
  await h.adminClient.post("/hospital/form/publish", {});
  const s = await slot(api, h);
  assertEquals((await book(api, h, s, { answers: { visit: "new" }, formVersionId: v1 })).status, 201);
  await ownerSql`UPDATE form_versions SET published_at = now() - interval '121 minutes' WHERE hospital_id = ${h.hospitalId} AND version = 2`;
  const late = await book(api, h, s, { answers: { visit: "new" }, formVersionId: v1 });
  assertEquals([late.status, late.body.error], [409, "FORM_UPDATED"]);
  const v2 = (await api.anonymous().get(`/public/hospitals/${h.slug}/form`)).body.form.versionId;
  assertEquals(late.body.detail.currentVersionId, v2);
});

test("Availability follows the rules: 14-day window, 30-minute notice, closures, hospital time zone", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const av = await availability(api, h);
  assertEquals(av.timezone, "Asia/Damascus");
  assertEquals([av.windowDays, av.minNoticeMin], [14, 30]);
  const days = av.days;
  assertEquals(days.length, 14);
  const now = Date.now();
  const all: number[] = days.flatMap((d: any) => d.slots.map((x: any) => new Date(x.start).getTime()));
  for (const x of all) assert(x >= now + 29.5 * 60000);
  assertEquals(days[1].slots.length, 48);
  assertEquals(days[1].status, "open");
  assertEquals(days[1].open, 48);
  assertEquals(days[1].slots[0].time, "00:00");
  assertEquals(days[1].weekday, new Date(days[1].date + "T00:00:00Z").getUTCDay());

  const lastDayFirst = new Date(days[13].slots[0].start).getTime();
  assertEquals((await book(api, h, new Date(lastDayFirst + 86400000).toISOString())).body.error, "SLOT_UNAVAILABLE");
  assertEquals((await book(api, h, new Date(lastDayFirst + 7 * 60000).toISOString())).body.error, "SLOT_UNAVAILABLE");
  const soon = Math.min(...all) - 30 * 60000;
  if (soon > now) assertEquals((await book(api, h, new Date(soon).toISOString())).body.error, "SLOT_UNAVAILABLE");
  // .NET's round-trip format ("o", 7 decimals and an offset) is understood too.
  const dotnet = new Date(days[2].slots[0].start).toISOString().replace("Z", "0000+00:00").replace(".000", ".000");
  assertEquals((await book(api, h, dotnet)).status, 201);

  const tomorrow = days[1].date;
  assertEquals((await h.adminClient.post("/hospital/closures", { date: tomorrow })).status, 201);
  const closed = (await availability(api, h)).days[1];
  assertEquals(closed.status, "closed");
  assertEquals((await book(api, h, days[1].slots[0].start)).body.error, "SLOT_UNAVAILABLE");

  await owner.put(`/admin/hospitals/${h.hospitalId}/booking-rules`, { bookingWindowDays: 3, minNoticeMin: 1440 });
  const av2 = await availability(api, h);
  assertEquals(av2.days.length, 3);
  for (const d of av2.days) for (const x of d.slots) assert(new Date(x.start).getTime() >= now + 1439 * 60000);
  assertEquals(av2.days[0].status, "closed"); // nothing left today with a 24-hour notice
});

test("Reception cancels with a reason and the seat becomes free; scanners and other hospitals cannot", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const other = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  const s = await slot(api, h);
  const b = await book(api, h, s);
  const reference = b.body.ref;
  const id = (await reception.get(`/hospital/bookings?ref=${reference}`)).body.bookings[0].id;
  assertEquals((await scanner.post(`/hospital/bookings/${id}/cancel`, { reason: "test" })).status, 403);
  assertEquals((await scanner.get(`/hospital/bookings?ref=${reference}`)).status, 403);
  assertEquals((await other.adminClient.post(`/hospital/bookings/${id}/cancel`, { reason: "test" })).status, 404);
  assertEquals((await other.adminClient.get(`/hospital/bookings?ref=${reference}`)).body.bookings, []);
  assertEquals((await reception.post(`/hospital/bookings/${id}/cancel`, { reason: "" })).status, 422);
  assertEquals((await book(api, h, s)).status, 409);
  assertEquals((await reception.post(`/hospital/bookings/${id}/cancel`, { reason: "طلب المريض بالهاتف" })).status, 200);
  assertEquals((await reception.post(`/hospital/bookings/${id}/cancel`, { reason: "again" })).status, 409);
  assertEquals((await book(api, h, s)).status, 201);
  const day = await reception.get(`/hospital/bookings?date=${localDate(new Date(s), "Asia/Damascus")}`);
  assertEquals(day.body.bookings.map((x: any) => x.status).sort(), ["cancelled", "waiting"]);
  const cancelled = day.body.bookings.find((x: any) => x.status === "cancelled");
  assertEquals(cancelled.cancelReason, "طلب المريض بالهاتف");
  assertEquals((await reception.get("/hospital/bookings?date=2026-02-30")).status, 422);
  const detail = await reception.get(`/hospital/bookings/${id}`);
  assertEquals([detail.body.booking.status, detail.body.answers, detail.body.questions, detail.body.events], ["cancelled", {}, [], []]);
});

test("Suspended hospitals take no bookings; the per-phone limit applies only when set in System settings", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner, 10);
  const s = await slot(api, h);
  assertEquals((await book(api, h, s, { phone: "0944000111" })).status, 201);
  assertEquals((await book(api, h, s, { phone: "0944000111" })).status, 201);
  assertEquals((await book(api, h, s, { phone: "12ab" })).status, 422);
  assertEquals((await book(api, h, s, { phone: "٠٩٤٤٠٠٠١١١" })).status, 422); // only ASCII digits are stored
  try {
    await owner.patch("/admin/settings", { perPhoneDailyLimit: 2 });
    const third = await book(api, h, s, { phone: "0944 000 111" });
    assertEquals([third.status, third.body.error], [429, "PHONE_LIMIT"]);
  } finally {
    await owner.patch("/admin/settings", { perPhoneDailyLimit: 0 });
  }
  await owner.post(`/admin/hospitals/${h.hospitalId}/suspend`, { reason: "test suspension" });
  assertEquals((await book(api, h, s)).body.error, "NOT_ACCEPTING");
  assertEquals((await availability(api, h)).days, []);
});

test("Bad booking requests: unknown hospital or department, bad names and times, wrong JSON types", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const s = await slot(api, h);
  assertEquals((await book(api, h, s, { name: "x" })).body.error, "NAME_INVALID");
  assertEquals((await book(api, { ...h, departmentId: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, s)).body.error, "DEPARTMENT_INVALID");
  assertEquals((await book(api, { ...h, slug: "no-such-hospital" }, s)).status, 404);
  assertEquals((await book(api, h, "tomorrow")).status, 400);
  const r = await api.anonymous().send("POST", `/public/hospitals/${h.slug}/bookings`, { departmentId: h.departmentId, slotStart: s, patientName: 5 },
    { headers: { "Idempotency-Key": "abcdefgh12" } });
  assertEquals(r.status, 400);
  assertEquals((await api.anonymous().get(`/public/hospitals/${h.slug}/availability`)).status, 404);
  assertEquals((await api.anonymous().get(`/public/hospitals/${h.slug}/availability?departmentId=dep_x`)).body.error, "DEPARTMENT_INVALID");
  assertEquals((await api.anonymous().get(`/public/hospitals/no-such-hospital/form`)).status, 404);
});

test("RLS isolates bookings and answers between hospitals", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const a = await bookingHospital(api, owner);
  const b = await bookingHospital(api, owner);
  await book(api, b, await slot(api, b));
  await appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${a.hospitalId}, true)`;
    for (const table of ["bookings", "booking_answers", "form_versions", "form_drafts", "hospital_active_form"]) {
      const [{ n }] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE hospital_id = $1`, [b.hospitalId]);
      assertEquals(n, 0, table);
    }
    assertEquals((await tx`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE hospital_id = ${b.hospitalId}`).count, 0);
  });
});
