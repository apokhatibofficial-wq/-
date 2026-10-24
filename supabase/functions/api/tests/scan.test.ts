import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { ulid } from "../src/security.ts";
import { book, type BookingHospital, bookingHospital, CapturingEmail, newEmail, ownerSql, secrets, slot, staff, test, TestApi } from "./harness.ts";

/** Books a slot and moves it to today (hospital time) at 00:00 + minutes. Returns id, ref and QR code. */
export async function bookToday(api: TestApi, h: BookingHospital, minutes: number, dayShift = 0): Promise<{ id: string; ref: string; qr: string }> {
  const r = await book(api, h, await slot(api, h), { name: "مريض تجريبي للماسح" });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  secrets.push(r.body.qr);
  await ownerSql`
    UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(days => ${dayShift}::int, mins => ${minutes}::int)) AT TIME ZONE h.timezone
    FROM hospitals h WHERE h.id = b.hospital_id AND b.ref = ${r.body.ref}`;
  const [{ id }] = await ownerSql<{ id: string }[]>`SELECT id FROM bookings WHERE ref = ${r.body.ref}`;
  return { id, ref: r.body.ref, qr: r.body.qr };
}

test("Scan: a valid code checks in at once (source qr); scanning again says already, at the same time, and records nothing new", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  const b = await bookToday(api, h, 600);
  const r = await scanner.post("/scan/qr", { code: b.qr, clientEventId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(r.body.kind, "ok");
  assertEquals([r.body.booking.ref, r.body.booking.patientName, r.body.booking.time], [b.ref, "مريض تجريبي للماسح", "10:00"]);
  assertEquals(r.body.bookingId, null);
  const at = r.body.booking.arrivedAt;
  assert(at !== null);
  assert(!JSON.stringify(r.body).toLowerCase().includes("phone"));
  const again = await scanner.post("/scan/qr", { code: b.qr, clientEventId: crypto.randomUUID() });
  assertEquals(again.body.kind, "already");
  assertEquals(again.body.booking.arrivedAt, at);
  const [ev] = await ownerSql<{ source: string; n: number }[]>`SELECT min(source) AS source, count(*)::int AS n FROM attendance_events WHERE booking_id = ${b.id}`;
  assertEquals([ev.source, ev.n], ["qr", 1]);
  const [{ status }] = await ownerSql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${b.id}`;
  assertEquals(status, "arrived");
  // A repeated clientEventId (the phone retried) is applied once.
  const c2 = await bookToday(api, h, 610);
  const ce = crypto.randomUUID();
  assertEquals((await scanner.post("/scan/qr", { code: c2.qr, clientEventId: ce })).body.kind, "ok");
  assertEquals((await scanner.post("/scan/qr", { code: c2.qr, clientEventId: "not-a-guid" })).status, 400);
});

test("Scan: cancelled and other-day bookings show details but are not checked in; another hospital's code shows nothing; bad codes are unknown", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const other = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const cancelled = await bookToday(api, h, 300);
  assertEquals((await reception.post(`/hospital/bookings/${cancelled.id}/cancel`, { reason: "طلب المريض" })).status, 200);
  const tomorrow = await bookToday(api, h, 300, 1);
  const otherB = await bookToday(api, other, 300);
  const c = await reception.post("/scan/qr", { code: cancelled.qr });
  assertEquals(c.body.kind, "cancelled");
  assertEquals(c.body.booking.patientName, "مريض تجريبي للماسح");
  const d = await reception.post("/scan/qr", { code: tomorrow.qr });
  assertEquals(d.body.kind, "otherday");
  assert(typeof d.body.booking.date === "string");
  const o = await reception.post("/scan/qr", { code: otherB.qr });
  assertEquals(o.body, { kind: "other" });
  for (const bad of ["MLK1." + "A".repeat(22), "hello", "", "https://example.com", otherB.qr + "x"]) {
    const r = await reception.post("/scan/qr", { code: bad });
    assertEquals([r.status, r.body], [200, { kind: "bad" }]);
  }
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_events WHERE hospital_id IN (${h.hospitalId}, ${other.hospitalId})`;
  assertEquals(n, 0);
});

test("Scan: an arrival by QR overrides the automatic no-show; a manual correction is not overridden", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  const auto = await bookToday(api, h, 1);
  const corrected = await bookToday(api, h, 2);
  await ownerSql`INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at) VALUES (${"att_" + ulid()}, ${h.hospitalId}, ${auto.id}, 'no_show', 'auto', now())`;
  await ownerSql`UPDATE bookings SET status = 'no_show' WHERE id = ${auto.id}`;
  assertEquals((await scanner.post("/scan/qr", { code: auto.qr })).body.kind, "ok");
  const corr = await h.adminClient.post(`/hospital/bookings/${corrected.id}/attendance`, { type: "no_show", reason: "لم يحضر بعد التحقق" });
  assertEquals(corr.status, 200);
  assertEquals(corr.body, { status: "no_show", arrivedAt: null, needsReview: false });
  assertEquals((await scanner.post("/scan/qr", { code: corrected.qr })).body.kind, "corrected");
  const [{ status }] = await ownerSql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${corrected.id}`;
  assertEquals(status, "no_show");
});

test("Scan by booking number: found → confirm → checked in; another hospital's number is not found; doctors and anonymous callers are refused", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const other = await bookingHospital(api, owner);
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  const b = await bookToday(api, h, 700);
  const ob = await bookToday(api, other, 700);
  const found = await scanner.get(`/scan/lookup?ref=${b.ref.toLowerCase()}`);
  assertEquals([found.body.kind, found.body.bookingId], ["found", b.id]);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_events WHERE booking_id = ${b.id}`;
  assertEquals(n, 0);
  assertEquals((await scanner.post("/scan/checkin", { bookingId: b.id, clientEventId: crypto.randomUUID() })).body.kind, "ok");
  assertEquals((await scanner.get(`/scan/lookup?ref=${b.ref}`)).body.kind, "already");
  const [{ source }] = await ownerSql<{ source: string }[]>`SELECT source FROM attendance_events WHERE booking_id = ${b.id}`;
  assertEquals(source, "reception");
  assertEquals((await scanner.get(`/scan/lookup?ref=${ob.ref}`)).body, { kind: "notfound" });
  assertEquals((await scanner.get("/scan/lookup?ref=ML-ZZZZZZ")).body.kind, "notfound");
  assertEquals((await scanner.get(`/scan/lookup?ref=${encodeURIComponent("مريض")}`)).body.kind, "notfound");
  const ob2 = await bookToday(api, other, 710);
  assertEquals((await scanner.post("/scan/checkin", { bookingId: ob2.id })).body.kind, "notfound");
  assertEquals((await scanner.post("/scan/checkin", {})).body.kind, "notfound");

  const docEmail = newEmail("doc");
  const inv = await h.adminClient.post("/hospital/users", { email: docEmail, role: "doctor", departmentIds: [h.departmentId] });
  assertEquals(inv.status, 201);
  const { password, totpSecret } = await api.completeLink(CapturingEmail.tokenFrom(api.email.lastTo(docEmail)));
  const doctor = await api.signIn({ id: inv.body.id, email: docEmail, password, totpSecret });
  assertEquals((await doctor.get(`/scan/lookup?ref=${b.ref}`)).status, 403);
  assertEquals((await doctor.post("/scan/qr", { code: "MLK1." + "A".repeat(22) })).status, 403);
  assertEquals((await api.anonymous().get(`/scan/lookup?ref=${b.ref}`)).status, 401);
});

test("Scan: QR-scanner sessions end 12 hours after sign-in; reception keeps the 7-day limit", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { user: scanner } = await staff(api, h.adminClient, "scanner");
  const { user: rec } = await staff(api, h.adminClient, "reception");
  const hours = async (userId: string) => {
    const [{ x }] = await ownerSql<{ x: number }[]>`
      SELECT (extract(epoch FROM max(absolute_expires_at - created_at)) / 3600)::float8 AS x FROM sessions WHERE user_id = ${userId}`;
    return x;
  };
  const s = await hours(scanner.id), r = await hours(rec.id);
  assert(s > 11.99 && s < 12.01, String(s));
  assert(r > 7 * 24 - 0.01 && r < 7 * 24 + 0.01, String(r));
});

test("Scan: lookups are rate limited per IP (429)", async () => {
  const api = await TestApi.create({ scanRate: 5 });
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  scanner.ip = "198.18." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250);
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await scanner.get("/scan/lookup?ref=ML-ZZZZZZ")).status);
  assertEquals(codes.filter((c) => c === 200).length, 5);
  assertEquals(codes.filter((c) => c === 429).length, 3);
});
