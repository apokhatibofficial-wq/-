import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { derive } from "../src/attendance.ts";
import { ulid } from "../src/security.ts";
import { appSql, book, type BookingHospital, bookingHospital, CapturingEmail, type Client, newEmail, ownerSql, secrets, slot, staff, test, TestApi } from "./harness.ts";

/** Books a slot, then moves it to today (hospital time) at 00:00 + minutes so check-ins are on the right day. */
async function todayBooking(api: TestApi, h: BookingHospital, minutes: number, departmentId?: string): Promise<{ id: string; ref: string }> {
  const r = await book(api, { ...h, departmentId: departmentId ?? h.departmentId }, await slot(api, h), { phone: "+963944000111" });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  const [{ id }] = await ownerSql<{ id: string }[]>`SELECT id FROM bookings WHERE ref = ${r.body.ref}`;
  await ownerSql`
    UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(mins => ${minutes}::int)) AT TIME ZONE h.timezone
    FROM hospitals h WHERE h.id = b.hospital_id AND b.id = ${id}`;
  return { id, ref: r.body.ref };
}

async function device(c: Client, name = "Reception PC 1"): Promise<string> {
  const r = await c.post("/sync/devices", { name });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  return r.body.deviceId;
}

const ev = (type: string, o: { ref?: string; bookingId?: string; at?: Date; source?: string; reason?: string; id?: string } = {}) => ({
  clientEventId: o.id ?? crypto.randomUUID(), bookingId: o.bookingId ?? null, ref: o.ref ?? null, type, source: o.source ?? "reception",
  at: (o.at ?? new Date()).toISOString(), reason: o.reason ?? null,
});

async function doctorWith(api: TestApi, h: BookingHospital, departmentIds: string[]) {
  const email = newEmail("doctor");
  const inv = await h.adminClient.post("/hospital/users", { email, role: "doctor", departmentIds });
  assertEquals(inv.status, 201, JSON.stringify(inv.body));
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(api.email.lastTo(email)));
  return { id: inv.body.id as string, client: await api.signIn({ id: inv.body.id, email, password, totpSecret }) };
}

async function secondDepartment(h: BookingHospital): Promise<string> {
  const dep2 = (await h.adminClient.post("/hospital/departments", { nameAr: "العظمية" })).body.id;
  const blocks = [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, start: "00:00", end: "24:00", slotMinutes: 30, capacity: 1 }));
  await h.adminClient.put(`/hospital/departments/${dep2}/schedules`, { blocks });
  return dep2;
}

test("Sync: pull after a cursor, push check-in by booking number; a retried push is applied once", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const b = await todayBooking(api, h, 600);
  const dev = await device(reception);
  const first = await reception.get(`/sync/pull?deviceId=${dev}&since=0`);
  assertEquals(first.status, 200);
  assertEquals(first.body.bookings.length, 1);
  const x = first.body.bookings[0];
  assertEquals([x.id, x.status, x.phone, x.localTime], [b.id, "waiting", "+963944000111", "10:00"]);
  assertEquals(first.body.hospital.timezone, "Asia/Damascus");
  assertEquals(first.body.hasMore, false);
  assertEquals(first.body.departments.length, 1);
  const cursor = first.body.cursor;
  assertEquals(typeof cursor, "number");
  assertEquals((await reception.get(`/sync/pull?deviceId=${dev}&since=${cursor}`)).body.bookings, []);

  const evId = crypto.randomUUID();
  const push = { deviceId: dev, events: [ev("arrived", { ref: b.ref.toLowerCase(), id: evId })] };
  const p1 = await reception.post("/sync/push", push);
  assertEquals(p1.status, 200);
  assertEquals([p1.body.results[0].outcome, p1.body.results[0].status, p1.body.results[0].clientEventId], ["applied", "arrived", evId]);
  const p2 = await reception.post("/sync/push", push);
  assertEquals([p2.body.results[0].outcome, p2.body.results[0].status], ["duplicate", "arrived"]);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_events WHERE booking_id = ${b.id}`;
  assertEquals(n, 1);

  const after = await reception.get(`/sync/pull?deviceId=${dev}&since=${cursor}`);
  assertEquals(after.body.bookings.length, 1);
  const changed = after.body.bookings[0];
  assertEquals(changed.status, "arrived");
  assertEquals(changed.events.map((e: any) => [e.type, e.source]), [["arrived", "reception"]]);
  assert(changed.bookedAt !== null);
  const devices = (await h.adminClient.get("/hospital/devices")).body;
  assertEquals(devices.devices.length, 1);
  assert(devices.devices[0].lastSeenAt !== null);
  assertEquals(devices.maxActive, 25);
});

test("Sync: a long-poll pull waits for a change and returns it", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const b = await todayBooking(api, h, 600);
  const dev = await device(reception);
  const cursor = (await reception.get(`/sync/pull?deviceId=${dev}&since=0`)).body.cursor;
  const started = Date.now();
  const waiting = reception.get(`/sync/pull?deviceId=${dev}&since=${cursor}&wait=10`);
  await new Promise((r) => setTimeout(r, 1500));
  await h.adminClient.post(`/hospital/bookings/${b.id}/attendance`, { type: "arrived" });
  const r = await waiting;
  const took = Date.now() - started;
  assertEquals(r.body.bookings.map((x: any) => x.status), ["arrived"]);
  assert(took >= 1400 && took < 9000, String(took));
});

test("Sync: an offline check-in received after the automatic no-show wins; the earliest arrival time is kept", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const b = await todayBooking(api, h, 1);
  const dev = await device(reception);
  await ownerSql`INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at) VALUES (${"att_" + ulid()}, ${h.hospitalId}, ${b.id}, 'no_show', 'auto', now())`;
  await ownerSql`UPDATE bookings SET status = 'no_show' WHERE id = ${b.id}`;
  const early = new Date(Date.now() - 2 * 60000), late = new Date(Date.now() - 60000);
  const r = await reception.post("/sync/push", { deviceId: dev, events: [ev("arrived", { ref: b.ref, at: late }), ev("arrived", { bookingId: b.id, at: early })] });
  for (const e of r.body.results) assertEquals(e.outcome, "applied");
  const [row] = await ownerSql<{ status: string; arrived_at: Date }[]>`SELECT status, arrived_at FROM bookings WHERE id = ${b.id}`;
  assertEquals(row.status, "arrived");
  assertEquals(row.arrived_at.getTime(), early.getTime());
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_events WHERE booking_id = ${b.id}`;
  assertEquals(n, 3);
});

test("Sync: corrections win; conflicting corrections flag the booking for review; reasons are required", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const b = await todayBooking(api, h, 60);
  assertEquals((await reception.post(`/hospital/bookings/${b.id}/attendance`, { type: "arrived" })).status, 200);
  assertEquals((await reception.post(`/hospital/bookings/${b.id}/attendance`, { type: "no_show", reason: "" })).status, 422);
  assertEquals((await reception.post(`/hospital/bookings/${b.id}/attendance`, { type: "no_show", reason: "قصير" })).status, 422);
  assertEquals((await reception.post(`/hospital/bookings/${b.id}/attendance`, { type: "no_show" })).body.error, "TYPE_INVALID");
  const c1 = await reception.post(`/hospital/bookings/${b.id}/attendance`, { type: "no_show", reason: "غادر قبل الدخول" });
  assertEquals([c1.body.status, c1.body.needsReview], ["no_show", false]);
  const c2 = await h.adminClient.post(`/hospital/bookings/${b.id}/attendance`, { type: "arrived", reason: "عاد ودخل" });
  assertEquals([c2.body.status, c2.body.needsReview], ["arrived", true]);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'attendance_correct' AND target = ${b.id}`;
  assertEquals(n, 2);
  assertEquals((await reception.get(`/hospital/bookings/${b.id}`)).body.booking.needsReview, true);
  const dev = await device(reception);
  const r = await reception.post("/sync/push", { deviceId: dev, events: [ev("waiting", { bookingId: b.id, source: "correction" })] });
  assertEquals([r.body.results[0].outcome, r.body.results[0].code], ["rejected", "REASON_REQUIRED"]);
  assertEquals((await reception.post("/hospital/bookings/bkg_01ARZ3NDEKTSV4RRFFQ69G5FAV/attendance", { type: "arrived" })).status, 404);
});

test("Sync: cancelled bookings, other-day check-ins and implausible times are rejected", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const dev = await device(reception);
  const cancelled = await todayBooking(api, h, 30);
  assertEquals((await reception.post(`/hospital/bookings/${cancelled.id}/cancel`, { reason: "طلب المريض" })).status, 200);
  const tomorrowRef = (await book(api, h, await slot(api, h, 2))).body.ref;
  const [{ id: tomorrow }] = await ownerSql<{ id: string }[]>`SELECT id FROM bookings WHERE ref = ${tomorrowRef}`;
  const today = await todayBooking(api, h, 90);
  const r = await reception.post("/sync/push", {
    deviceId: dev,
    events: [
      ev("arrived", { bookingId: cancelled.id }), ev("arrived", { bookingId: tomorrow }), ev("arrived", { ref: "ML-ZZZZZZ" }),
      ev("arrived", { bookingId: today.id, at: new Date(Date.now() + 3600_000) }), ev("arrived", { bookingId: today.id, at: new Date(Date.now() - 8 * 86400_000) }),
      ev("no_show", { bookingId: today.id }), ev("arrived", { bookingId: today.id, source: "auto" }),
      { clientEventId: null, bookingId: today.id, type: "arrived", at: new Date().toISOString() },
    ],
  });
  assertEquals(r.body.results.map((e: any) => e.code), ["CANCELLED", "OTHER_DAY", "NOT_FOUND", "BAD_TIME", "BAD_TIME", "FORBIDDEN", "SOURCE_INVALID", "INVALID"]);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_events WHERE hospital_id = ${h.hospitalId}`;
  assertEquals(n, 0);
  assertEquals((await reception.post("/sync/push", { deviceId: dev, events: Array.from({ length: 201 }, () => ev("arrived", { ref: "ML-ZZZZZZ" })) })).status, 422);
});

test("Sync: a doctor pulls only their own department's bookings, without phone numbers, and cannot check in", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const dep2 = await secondDepartment(h);
  assertEquals((await h.adminClient.post("/hospital/users", { email: newEmail("doc"), role: "doctor" })).status, 422);
  assertEquals((await h.adminClient.post("/hospital/users", { email: newEmail("rec"), role: "reception", departmentIds: [dep2] })).status, 422);
  const doc = await doctorWith(api, h, [h.departmentId]);
  const mine = await todayBooking(api, h, 120);
  const other = await todayBooking(api, h, 150, dep2);
  const dev = await device(doc.client, "Doctor PC");
  const pull = await doc.client.get(`/sync/pull?deviceId=${dev}&since=0`);
  assertEquals(pull.status, 200);
  assertEquals(pull.body.bookings.map((x: any) => x.id), [mine.id]);
  assertEquals(pull.body.bookings[0].phone, null);
  const text = JSON.stringify(pull.body);
  assert(!text.includes("+963944000111") && !text.includes(other.id));
  const web = await doc.client.get("/hospital/bookings");
  assertEquals(web.body.bookings.map((x: any) => x.id), [mine.id]);
  const push = await doc.client.post("/sync/push", { deviceId: dev, events: [ev("arrived", { ref: mine.ref })] });
  assertEquals(push.body.results[0].code, "FORBIDDEN");
  assertEquals((await h.adminClient.patch(`/hospital/users/${doc.id}`, { departmentIds: [dep2] })).status, 200);
  const pull2 = await doc.client.get(`/sync/pull?deviceId=${dev}&since=0`);
  assertEquals(pull2.body.bookings.map((x: any) => x.id), [other.id]);
});

test("Hospital web: a doctor reads only their departments, without phones, reasons or form answers; others see the status history", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const dep2 = await secondDepartment(h);
  const doc = await doctorWith(api, h, [h.departmentId]);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const mine = await todayBooking(api, h, 120);
  const other = await todayBooking(api, h, 150, dep2);
  await ownerSql`INSERT INTO booking_answers (booking_id, hospital_id, question_id, value_json) VALUES (${mine.id}, ${h.hospitalId}, 'q1', '"جواب سري"')`;
  assertEquals((await reception.post(`/hospital/bookings/${mine.id}/attendance`, { type: "arrived" })).status, 200);
  assertEquals((await reception.post(`/hospital/bookings/${mine.id}/attendance`, { type: "no_show", reason: "خطأ في التسجيل" })).status, 200);

  assertEquals((await reception.get("/hospital/bookings")).body.bookings.length, 2);
  const full = await reception.get(`/hospital/bookings/${mine.id}`);
  assertEquals(full.body.booking.phone, "+963944000111");
  assertEquals(full.body.answers, { q1: "جواب سري" });
  assertEquals(full.body.events.map((e: any) => e.type + "/" + e.source), ["arrived/reception", "no_show/correction"]);
  assertEquals(full.body.events[1].reason, "خطأ في التسجيل");
  assert(typeof full.body.events[1].actor === "string");

  const list = await doc.client.get("/hospital/bookings");
  assertEquals(list.body.bookings.length, 1);
  assertEquals([list.body.bookings[0].id, list.body.bookings[0].phone], [mine.id, null]);
  const detail = await doc.client.get(`/hospital/bookings/${mine.id}`);
  assertEquals(detail.status, 200);
  assertEquals(detail.body.answers, {});
  for (const e of detail.body.events) assertEquals([e.reason, e.actor], [null, null]);
  const t = JSON.stringify(detail.body);
  assert(!t.includes("+963944000111") && !t.includes("جواب سري") && !t.includes("خطأ في التسجيل"));
  assertEquals((await doc.client.get(`/hospital/bookings/${other.id}`)).status, 404);
  assertEquals((await doc.client.get("/hospital/bookings?ref=" + other.ref)).body.bookings.length, 0);
  assertEquals((await doc.client.get("/hospital/bookings?ref=" + mine.ref)).body.bookings.length, 1);
  assertEquals((await doc.client.post(`/hospital/bookings/${mine.id}/attendance`, { type: "arrived" })).status, 403);
  assertEquals((await doc.client.post(`/hospital/bookings/${mine.id}/cancel`, { reason: "اختبار" })).status, 403);
});

test("Sync: Windows bearer token; revoked devices are refused; 25 active devices per hospital; scanner cannot pull", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { user: recUser } = await staff(api, h.adminClient, "reception");
  await api.allowNextTotp(recUser.email);
  const login = await api.anonymous().post("/auth/login", { email: recUser.email, password: recUser.password, client: "windows" }, false);
  assertEquals(login.status, 200);
  const token: string = login.body.token;
  secrets.push(token);
  const win = async (method: string, path: string, body?: unknown) => {
    const res = await api.fetch(path, {
      method,
      headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const reg = await win("POST", "/sync/devices", { name: "Reception PC" });
  assertEquals(reg.status, 201);
  const dev = reg.body.deviceId;
  assertEquals((await win("GET", `/sync/pull?deviceId=${dev}&since=0`)).status, 200);
  assert((await owner.get(`/admin/hospitals/${h.hospitalId}`)).body.hospital.lastSyncAt !== null);
  assertEquals((await h.adminClient.post(`/hospital/devices/${dev}/revoke`, {})).status, 200);
  const refused = await win("GET", `/sync/pull?deviceId=${dev}&since=0`);
  assertEquals([refused.status, refused.body.error], [403, "DEVICE_REVOKED"]);
  assertEquals((await win("POST", "/sync/push", { deviceId: dev, events: [] })).status, 403);
  assert((await owner.get(`/admin/hospitals/${h.hospitalId}`)).body.hospital.lastSyncAt !== null);
  const other = await bookingHospital(api, owner);
  const otherDev = await device(other.adminClient);
  assertEquals((await win("GET", `/sync/pull?deviceId=${otherDev}&since=0`)).status, 403);
  for (let i = 0; i < 25; i++) await device(h.adminClient, "PC " + i);
  assertEquals((await h.adminClient.post("/sync/devices", { name: "PC 26" })).status, 409);
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  assertEquals((await scanner.get(`/sync/pull?deviceId=${dev}&since=0`)).status, 403);
  assertEquals((await scanner.get("/hospital/devices")).status, 403);
  assertEquals((await h.adminClient.post("/sync/devices", { name: " " })).status, 422);
});

test("Sync: RLS keeps devices and attendance events inside their hospital", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const a = await bookingHospital(api, owner);
  const b = await bookingHospital(api, owner);
  const bk = await todayBooking(api, a, 200);
  await device(a.adminClient);
  assertEquals((await a.adminClient.post(`/hospital/bookings/${bk.id}/attendance`, { type: "arrived" })).status, 200);
  let code = "";
  try {
    await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${b.hospitalId}, true)`;
      assertEquals((await tx`SELECT 1 FROM devices WHERE hospital_id = ${a.hospitalId}`).length, 0);
      assertEquals((await tx`SELECT 1 FROM attendance_events WHERE booking_id = ${bk.id}`).length, 0);
      await tx`SELECT set_config('app.hospital_id', ${a.hospitalId}, true)`;
      await tx`DELETE FROM attendance_events WHERE booking_id = ${bk.id}`;
    });
  } catch (e) {
    code = (e as { code: string }).code;
  }
  assertEquals(code, "42501");
});

// ---------------------------------------------------------------- the conflict policy (no database)
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const E = (type: string, source: string, atMin: number, receivedMin: number) =>
  ({ type, source, at: new Date(T0 + atMin * 60000), receivedAt: new Date(T0 + receivedMin * 60000) });

Deno.test("Policy: no events = waiting; the earliest arrival wins; arrival beats the automatic no-show", () => {
  assertEquals(derive([]), { status: "waiting", arrivedAt: null, needsReview: false });
  assertEquals(derive([E("arrived", "qr", 10, 11), E("arrived", "reception", 3, 40), E("arrived", "reception", 7, 12)]),
    { status: "arrived", arrivedAt: new Date(T0 + 3 * 60000), needsReview: false });
  assertEquals(derive([E("no_show", "auto", 30, 30), E("arrived", "reception", 5, 90)]), { status: "arrived", arrivedAt: new Date(T0 + 5 * 60000), needsReview: false });
  assertEquals(derive([E("no_show", "auto", 30, 30)]).status, "no_show");
});

Deno.test("Policy: a correction beats everything; conflicting corrections — the latest received wins and needs review", () => {
  assertEquals(derive([E("arrived", "qr", 1, 1), E("no_show", "correction", 60, 60), E("arrived", "reception", 2, 70)]), { status: "no_show", arrivedAt: null, needsReview: false });
  assertEquals(derive([E("no_show", "auto", 30, 30), E("waiting", "correction", 50, 50)]), { status: "waiting", arrivedAt: null, needsReview: false });
  assertEquals(derive([E("arrived", "correction", 100, 120), E("no_show", "correction", 110, 115)]), { status: "arrived", arrivedAt: new Date(T0 + 100 * 60000), needsReview: true });
  assertEquals(derive([E("no_show", "correction", 1, 1), E("no_show", "correction", 2, 2)]).needsReview, false);
});
