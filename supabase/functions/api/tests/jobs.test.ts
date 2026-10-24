import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { Db } from "../src/db.ts";
import type { EmailMessage, EmailSender } from "../src/email.ts";
import { cleanup, noShow, opsAlert, retention, retentionDue } from "../src/jobs.ts";
import { appSql, book, type BookingHospital, bookingHospital, ownerSql, secrets, slot, staff, test, TestApi } from "./harness.ts";

const db = () => new Db(appSql);

/** A booking whose slot started `minutesAgo` minutes ago (negative = in the future). */
async function bookingAt(api: TestApi, h: BookingHospital, minutesAgo: number, name = "مريض تجريبي للمهام") {
  const r = await book(api, h, await slot(api, h), { name, phone: "+963944000555" });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  secrets.push(r.body.qr);
  await ownerSql`UPDATE bookings SET slot_start = date_trunc('minute', now()) - make_interval(secs => ${minutesAgo * 60}::float8) WHERE ref = ${r.body.ref}`;
  const [{ id }] = await ownerSql<{ id: string }[]>`SELECT id FROM bookings WHERE ref = ${r.body.ref}`;
  return { id, ref: r.body.ref as string, qr: r.body.qr as string };
}

const status = async (id: string) => (await ownerSql<{ s: string }[]>`SELECT status AS s FROM bookings WHERE id = ${id}`)[0].s;

test("Acceptance 10: no-show is recorded after the grace period (per hospital), once, by the server", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const late = await bookingAt(api, h, 45);
  const inGrace = await bookingAt(api, h, 20);
  const arrived = await bookingAt(api, h, 50);
  const corrected = await bookingAt(api, h, 55);
  const cancelled = await bookingAt(api, h, 60);
  const old = await bookingAt(api, h, 60 * 24 * 6.5);
  await ownerSql`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'اختبار' WHERE id = ${cancelled.id}`;
  assertEquals((await reception.post(`/hospital/bookings/${arrived.id}/attendance`, { type: "arrived" })).status, 200);
  assertEquals((await reception.post(`/hospital/bookings/${corrected.id}/attendance`, { type: "waiting", reason: "ينتظر في الصالة" })).status, 200);
  // Other tests' bookings in the same database are not this test's business: only this hospital is checked.
  await ownerSql`UPDATE bookings SET slot_start = slot_start + interval '30 days' WHERE hospital_id <> ${h.hospitalId} AND status = 'waiting' AND slot_start < now()`;

  const now = new Date();
  const counts = await Promise.all([noShow(db(), now), noShow(db(), now)]);
  assertEquals(counts[0] + counts[1], 1);
  assertEquals(await status(late.id), "no_show");
  for (const [id, expected] of [[inGrace.id, "waiting"], [arrived.id, "arrived"], [corrected.id, "waiting"], [cancelled.id, "cancelled"], [old.id, "waiting"]]) {
    assertEquals(await status(id), expected);
  }
  const [e] = await ownerSql<{ source: string; actor: string | null; at: Date; slot: Date }[]>`
    SELECT e.source, e.actor_id AS actor, e.at, b.slot_start AS slot FROM attendance_events e JOIN bookings b ON b.id = e.booking_id WHERE b.id = ${late.id}`;
  assertEquals([e.source, e.actor], ["auto", null]);
  assert(Math.abs(e.at.getTime() - (e.slot.getTime() + 30 * 60000)) < 1000);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT last_count AS n FROM job_runs WHERE job = 'no_show'`;
  assertEquals(n, 1);
  assertEquals(await noShow(db(), new Date(now.getTime() + 60000)), 0);

  assertEquals((await h.adminClient.patch("/hospital/settings", { noShowGraceMin: 60 })).status, 200);
  const other = await bookingAt(api, h, 46);
  assertEquals(await noShow(db(), new Date()), 0);
  assertEquals(await status(other.id), "waiting");

  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  assertEquals((await scanner.post("/scan/qr", { code: late.qr })).body.kind, "ok");
});

test("Retention: after the hospital's period, names, phones, answers and reasons are removed; status and times stay", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  assertEquals((await h.adminClient.patch("/hospital/settings", { retentionMonths: 1 })).status, 200);
  const { client: reception } = await staff(api, h.adminClient, "reception");
  const oldOne = await bookingAt(api, h, 0, "مريض قديم");
  const recent = await bookingAt(api, h, 60 * 24 * 10, "مريض حديث");
  assertEquals((await reception.post(`/hospital/bookings/${oldOne.id}/attendance`, { type: "no_show", reason: "قال مريض قديم إنه لن يأتي" })).status, 200);
  await ownerSql`UPDATE bookings SET slot_start = now() - interval '45 days' WHERE id = ${oldOne.id}`;
  await ownerSql`INSERT INTO booking_answers (booking_id, hospital_id, question_id, value_json) VALUES (${oldOne.id}, ${h.hospitalId}, 'q1', '"جواب"')`;
  const [{ before }] = await ownerSql<{ before: number }[]>`SELECT count(*)::int AS before FROM audit_log WHERE action = 'retention_purge'`;

  assert(await retention(db(), new Date()) >= 1);
  const [b] = await ownerSql<{ name: string | null; phone: string | null; status: string; anon: Date | null }[]>`
    SELECT patient_name AS name, phone, status, anonymized_at AS anon FROM bookings WHERE id = ${oldOne.id}`;
  assertEquals([b.name, b.phone, b.status], [null, null, "no_show"]);
  assert(b.anon !== null);
  assertEquals((await ownerSql`SELECT 1 FROM booking_answers WHERE booking_id = ${oldOne.id}`).length, 0);
  const [ev] = await ownerSql<{ type: string; reason: string | null; redacted: Date | null }[]>`
    SELECT type, reason, redacted_at AS redacted FROM attendance_events WHERE booking_id = ${oldOne.id}`;
  assertEquals([ev.type, ev.reason], ["no_show", null]);
  assert(ev.redacted !== null);
  assertEquals((await ownerSql<{ n: string }[]>`SELECT patient_name AS n FROM bookings WHERE id = ${recent.id}`)[0].n, "مريض حديث");
  const [{ after }] = await ownerSql<{ after: number }[]>`SELECT count(*)::int AS after FROM audit_log WHERE action = 'retention_purge'`;
  assertEquals(after, before + 1);
  const dump = (await ownerSql<{ t: string }[]>`SELECT row_to_json(a)::text AS t FROM audit_log a`).map((x) => x.t).join("\n") +
    (await ownerSql<{ t: string }[]>`SELECT row_to_json(b)::text AS t FROM bookings b WHERE id = ${oldOne.id}`)[0].t;
  assert(!dump.includes("مريض قديم"));
  assertEquals(await retention(db(), new Date()), 0);

  const { client: scanner } = await staff(api, h.adminClient, "scanner");
  assertEquals((await scanner.post("/scan/qr", { code: oldOne.qr })).body.kind, "bad");
  await assertRejects(() => appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.scope', 'system', true)`;
    await tx`UPDATE attendance_events SET type = 'arrived' WHERE booking_id = ${oldOne.id}`;
  }));
});

test("Retention: a redacted reason cannot be rewritten, and reasons cannot be edited outside redaction", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const b = await bookingAt(api, h, 10);
  assertEquals((await h.adminClient.post(`/hospital/bookings/${b.id}/attendance`, { type: "arrived", reason: "تصحيح للاختبار" })).status, 200);
  const tryIt = async (q: string) => {
    try {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.scope', 'system', true)`;
        await tx.unsafe(q, [b.id]);
      });
      return "ok";
    } catch (e) {
      return (e as { code: string }).code;
    }
  };
  assertEquals(await tryIt("UPDATE attendance_events SET reason = 'نص آخر' WHERE booking_id = $1"), "42501");
  assertEquals(await tryIt("UPDATE attendance_events SET reason = NULL, redacted_at = now() WHERE booking_id = $1"), "ok");
  assertEquals(await tryIt("UPDATE attendance_events SET redacted_at = now() WHERE booking_id = $1"), "42501");
});

test("Cleanup: old used or expired links and ended sessions are deleted; current ones stay", async () => {
  const api = await TestApi.create();
  const { client: owner, user } = await api.companyUser("owner");
  await ownerSql`
    INSERT INTO one_time_links (id, user_id, purpose, token_hash, expires_at, used_at)
    VALUES ('otl_' || substr(md5(random()::text), 1, 20), ${user.id}, 'reset', sha256(random()::text::bytea), now() - interval '10 days', NULL),
           ('otl_' || substr(md5(random()::text), 1, 20), ${user.id}, 'reset', sha256(random()::text::bytea), now() + interval '1 hour', NULL)`;
  await ownerSql`
    INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, revoke_reason)
    VALUES ('ses_' || substr(md5(random()::text), 1, 20), ${user.id}, sha256(random()::text::bytea), 'web',
            now() - interval '50 days', now() - interval '41 days', now() - interval '43 days', now() - interval '43 days', now() - interval '40 days', 'test')`;
  await ownerSql`INSERT INTO rate_limits (key, bucket, count) VALUES ('test:old', now() - interval '2 hours', 1)`;
  const n = await cleanup(db(), new Date());
  assert(n >= 2);
  const [c] = await ownerSql<{ links: number; sessions: number; limits: number; live: number }[]>`
    SELECT (SELECT count(*)::int FROM one_time_links WHERE greatest(coalesce(used_at, expires_at), expires_at) < now() - interval '7 days') AS links,
           (SELECT count(*)::int FROM sessions WHERE revoked_at < now() - interval '30 days') AS sessions,
           (SELECT count(*)::int FROM rate_limits WHERE key = 'test:old') AS limits,
           (SELECT count(*)::int FROM one_time_links WHERE user_id = ${user.id} AND used_at IS NULL AND expires_at > now()) AS live`;
  assertEquals({ ...c }, { links: 0, sessions: 0, limits: 0, live: 1 });
  assertEquals((await owner.get("/auth/me")).status, 200);
});

test("Retention runs nightly after 03:00 Syria time, once per day", async () => {
  await ownerSql`DELETE FROM job_runs WHERE job = 'retention'`;
  const before3 = new Date("2026-10-20T23:30:00Z"), after3 = new Date("2026-10-21T00:30:00Z");
  assertEquals(await retentionDue(db(), before3), false);
  assertEquals(await retentionDue(db(), after3), true);
  await retention(db(), after3);
  assertEquals(await retentionDue(db(), new Date(after3.getTime() + 5 * 3600_000)), false);
  assertEquals(await retentionDue(db(), new Date(after3.getTime() + 86400_000)), true);
  await ownerSql`DELETE FROM job_runs WHERE job = 'retention'`;
});

test("The scheduler endpoint runs the jobs with the secret only", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const h = await bookingHospital(api, owner);
  const late = await bookingAt(api, h, 120);
  const call = (secret?: string) => api.fetch("/internal/jobs", { method: "POST", headers: secret === undefined ? {} : { "x-medlink-jobs": secret } });
  for (const r of [await call(), await call("x".repeat(40))]) {
    assertEquals(r.status, 403);
    await r.body?.cancel();
  }
  assertEquals(await status(late.id), "waiting");
  const ok = await call(api.deps.config.jobsSecret);
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assertEquals(body.status, "ok");
  assert(body.noShow >= 1);
  assertEquals(await status(late.id), "no_show");
  // Even behind a proxy secret, the scheduler reaches it directly (it does not go through Cloudflare).
  api.deps.config.proxySecret = "p".repeat(40);
  const direct = await call(api.deps.config.jobsSecret);
  assertEquals(direct.status, 200);
  await direct.body?.cancel();
});

class Capture implements EmailSender {
  sent: EmailMessage[] = [];
  send(m: EmailMessage) {
    this.sent.push(m);
    return Promise.resolve();
  }
}
class Failing implements EmailSender {
  send(): Promise<void> {
    return Promise.reject(new Error("mail server down"));
  }
}

test("Alerts: a failed or missing backup emails the owner once per failure, and once a day while backups are missing", async () => {
  const owner = "owner-alerts@medlink.invalid";
  const mail = new Capture();
  const now = new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);
  const H = 3600_000;
  const set = async (name: string, ok: boolean, message: string, when: Date, lastOk: Date, clearAlert = false) => {
    await ownerSql`UPDATE ops_checks SET ok = ${ok}, message = ${message}, at = ${when}, last_ok_at = ${lastOk},
                   alerted_at = CASE WHEN ${clearAlert}::boolean THEN NULL ELSE alerted_at END WHERE name = ${name}`;
  };
  await set("restore_test", true, "ok", now, now, true);
  await set("backup", true, "uploaded", now, now, true);
  assertEquals(await opsAlert(db(), mail, owner, now), 0);

  await set("backup", false, "the dump has data for 0 of 22 tables", now, at(-H));
  assertEquals(await opsAlert(db(), mail, owner, at(60000)), 1);
  const m = mail.sent.at(-1)!;
  assertStringIncludes(m.subject, "The backup failed.");
  assertStringIncludes(m.textBody, "فشل النسخ الاحتياطي");
  assertStringIncludes(m.textBody, "the dump has data for 0 of 22 tables");
  assertEquals(m.to, owner);
  assertEquals(await opsAlert(db(), mail, owner, at(120000)), 0);
  await set("backup", false, "upload refused", at(6 * H), at(-H));
  assertEquals(await opsAlert(db(), mail, owner, at(6 * H + 60000)), 1);

  await set("backup", true, "uploaded", at(-9 * H), at(-9 * H), true);
  const before = mail.sent.length;
  assertEquals(await opsAlert(db(), mail, owner, now), 1);
  assertStringIncludes(mail.sent.at(-1)!.subject, "No successful backup since");
  assertEquals(await opsAlert(db(), mail, owner, at(5 * H)), 0);
  assertEquals(await opsAlert(db(), mail, owner, at(25 * H)), 1);
  assertEquals(mail.sent.length, before + 2);

  await set("backup", true, "uploaded", now, now, true);
  await set("restore_test", false, "row counts differ: bookings", now, at(-30 * 24 * H));
  assertEquals(await opsAlert(db(), mail, owner, now), 1);
  assertStringIncludes(mail.sent.at(-1)!.subject, "monthly restore test failed");

  // The mail server is down: nothing is marked, so the next hour tries again.
  await set("restore_test", false, "row counts differ: bookings", at(5 * 60000), at(-30 * 24 * H), true);
  await assertRejects(() => opsAlert(db(), new Failing(), owner, at(6 * 60000)));
  assertEquals(await opsAlert(db(), mail, owner, at(7 * 60000)), 1);

  // No ALERT_EMAIL: nothing is sent (it is logged), and it does not repeat every hour.
  await set("restore_test", true, "ok", now, now, true);
  await set("backup", false, "upload refused", at(10 * 60000), now, true);
  const n = mail.sent.length;
  assertEquals(await opsAlert(db(), mail, "", at(11 * 60000)), 1);
  assertEquals(await opsAlert(db(), mail, "", at(12 * 60000)), 0);
  assertEquals(mail.sent.length, n);
  await set("backup", true, "uploaded", now, now, true);
});

test("Alerts: the application role can read the backup results and mark an alert, but not change a result", async () => {
  let code = "";
  try {
    await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', 'system', true)`;
      assertEquals((await tx`SELECT 1 FROM ops_checks`).length, 2);
      await tx`UPDATE ops_checks SET alerted_at = alerted_at`;
      await tx`UPDATE ops_checks SET ok = true`;
    });
  } catch (e) {
    code = (e as { code: string }).code;
  }
  assertEquals(code, "42501");
});
