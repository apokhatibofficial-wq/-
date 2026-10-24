// The background jobs (BACKEND-SPEC §2): automatic no-show every minute, cleanup of expired links and old sessions
// every hour, the nightly retention purge, and the backup alerts. On Supabase the database scheduler (pg_cron) calls
// POST /internal/jobs every minute. Each job takes a transaction-level advisory lock, so two calls never run the same
// job at once. The Windows app never marks no-shows itself.
import { record } from "./attendance.ts";
import { audit, Db, Scopes, type Tx } from "./db.ts";
import type { EmailSender } from "./email.ts";
import { localDate, toUtc } from "./tz.ts";

const LockBase = 7240300;
export const Batch = 500;
/** Bookings older than this are not marked any more (e.g. after a long outage): the day is long over. */
export const NoShowLookBackMs = 6 * 24 * 3600_000;

async function tryLock(tx: Tx, k: number): Promise<boolean> {
  const [{ ok }] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${k}::bigint) AS ok`;
  return ok;
}

async function recordRun(tx: Tx, job: string, now: Date, count: number) {
  await tx`
    INSERT INTO job_runs (job, last_run_at, last_count) VALUES (${job}, ${now}, ${count})
    ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at, last_count = excluded.last_count`;
}

/**
 * Waiting bookings whose slot + the hospital's grace has passed become no-show, with an "auto" event at that time.
 * Skipped: bookings with any correction (a person decided) and bookings already marked. Returns how many were marked.
 */
export function noShow(db: Db, now: Date): Promise<number> {
  return db.run(Scopes.system, async (tx) => {
    if (!await tryLock(tx, LockBase + 1)) return 0;
    const due = await tx<{ id: string; hospital_id: string; due_at: Date }[]>`
      SELECT b.id, b.hospital_id, b.slot_start + make_interval(mins => h.no_show_grace_min) AS due_at
      FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
      WHERE b.status = 'waiting' AND b.anonymized_at IS NULL
        AND b.slot_start + make_interval(mins => h.no_show_grace_min) < ${now}
        AND b.slot_start > ${new Date(now.getTime() - NoShowLookBackMs)}
        AND NOT EXISTS (SELECT 1 FROM attendance_events e WHERE e.booking_id = b.id AND e.source IN ('auto', 'correction'))
      ORDER BY b.slot_start
      LIMIT ${Batch}`;
    let marked = 0;
    for (const b of due) {
      const r = await record(tx, {
        hospitalId: b.hospital_id, bookingId: b.id, type: "no_show", source: "auto", at: b.due_at,
        actorId: null, deviceId: null, clientEventId: null, reason: null,
      }, now);
      if (r.outcome === "applied") marked++;
    }
    await recordRun(tx, "no_show", now, marked);
    return marked;
  });
}

/** Deletes one-time links used or expired more than 7 days ago, sessions ended more than 30 days ago, and old rate-limit counters. */
export function cleanup(db: Db, now: Date): Promise<number> {
  return db.run(Scopes.system, async (tx) => {
    if (!await tryLock(tx, LockBase + 2)) return 0;
    const links = await tx`DELETE FROM one_time_links WHERE greatest(coalesce(used_at, expires_at), expires_at) < ${new Date(now.getTime() - 7 * 86400_000)}`;
    const sessions = await tx`
      DELETE FROM sessions WHERE least(coalesce(revoked_at, absolute_expires_at), absolute_expires_at, expires_at) < ${new Date(now.getTime() - 30 * 86400_000)}`;
    await tx`DELETE FROM rate_limits WHERE bucket < ${new Date(now.getTime() - 3600_000)}`;
    await recordRun(tx, "cleanup", now, links.count + sessions.count);
    return links.count + sessions.count;
  });
}

/**
 * Bookings older than their hospital's retention period (default 24 months) are anonymised: name, phone, cancel reason
 * and form answers are removed, correction reasons are cleared; status and times stay for the reports.
 */
export function retention(db: Db, now: Date): Promise<number> {
  return db.run(Scopes.system, async (tx) => {
    if (!await tryLock(tx, LockBase + 3)) return 0;
    let total = 0;
    while (true) {
      const ids = (await tx<{ id: string }[]>`
        SELECT b.id FROM bookings b JOIN hospitals h ON h.id = b.hospital_id
        WHERE b.anonymized_at IS NULL AND b.slot_start < ${now}::timestamptz - make_interval(months => h.retention_months)
        ORDER BY b.slot_start LIMIT ${Batch}`).map((r) => r.id);
      if (ids.length === 0) break;
      await tx`DELETE FROM booking_answers WHERE booking_id = ANY(${ids}::text[])`;
      await tx`UPDATE attendance_events SET reason = NULL, redacted_at = ${now}
               WHERE booking_id = ANY(${ids}::text[]) AND reason IS NOT NULL AND redacted_at IS NULL`;
      await tx`UPDATE bookings SET patient_name = NULL, phone = NULL, cancel_reason = NULL, anonymized_at = ${now} WHERE id = ANY(${ids}::text[])`;
      total += ids.length;
    }
    if (total > 0) await audit(tx, null, null, "retention_purge", "bookings", { count: total });
    await recordRun(tx, "retention", now, total);
    return total;
  });
}

/** The retention purge runs once a day, after 03:00 in Syria (quiet hours), or at the first tick after that. */
export async function retentionDue(db: Db, now: Date): Promise<boolean> {
  const [row] = await db.run(Scopes.system, (tx) => tx<{ last: Date }[]>`SELECT last_run_at AS last FROM job_runs WHERE job = 'retention'`);
  const todayAt3 = toUtc(localDate(now, "Asia/Damascus"), 180, "Asia/Damascus")!;
  if (now < todayAt3) return false;
  return !row || row.last < todayAt3;
}

/** Cleanup and backup alerts run every hour. */
export async function hourlyDue(db: Db, now: Date): Promise<boolean> {
  const [row] = await db.run(Scopes.system, (tx) => tx<{ last: Date }[]>`SELECT last_run_at AS last FROM job_runs WHERE job = 'cleanup'`);
  return !row || now.getTime() - row.last.getTime() >= 3600_000 - 30_000;
}

/** How long without a successful run before the owner is told: backups run every 6 hours, the restore test monthly. */
export const OpsMaxAgeMs: Record<string, number> = { backup: 8 * 3600_000, restore_test: 35 * 86400_000 };

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/**
 * Emails the owner (ALERT_EMAIL) when a backup reported a failure (once per failure), or when a check has not
 * succeeded for too long (once a day while it lasts). Returns the number of alerts. Without ALERT_EMAIL they are logged.
 */
export function opsAlert(db: Db, email: EmailSender, alertEmail: string, now: Date): Promise<number> {
  return db.run(Scopes.system, async (tx) => {
    if (!await tryLock(tx, LockBase + 4)) return 0;
    const checks = await tx<{ name: string; ok: boolean; message: string; at: Date; last_ok_at: Date; alerted_at: Date | null }[]>`
      SELECT name, ok, message, at, last_ok_at, alerted_at FROM ops_checks ORDER BY name`;
    let sent = 0;
    for (const k of checks) {
      const what = k.name === "backup" ? ["النسخ الاحتياطي", "backup"] : ["فحص الاستعادة الشهري", "monthly restore test"];
      let problem: [string, string] | null = null;
      if (!k.ok && (k.alerted_at === null || k.alerted_at < k.at)) problem = [`فشل ${what[0]}.`, `The ${what[1]} failed.`];
      else if (now.getTime() - k.last_ok_at.getTime() > OpsMaxAgeMs[k.name] && (k.alerted_at === null || now.getTime() - k.alerted_at.getTime() > 86400_000)) {
        problem = [`لم ينجح ${what[0]} منذ ${fmt(k.last_ok_at)} UTC.`, `No successful ${what[1]} since ${fmt(k.last_ok_at)} UTC.`];
      }
      if (problem === null) continue;
      if (alertEmail.length === 0) {
        console.warn(JSON.stringify({ level: "warn", msg: "ops alert not emailed: ALERT_EMAIL is not set", check: k.name }));
      } else {
        await email.send({
          kind: "ops_alert",
          to: alertEmail,
          subject: "MEDLINK: " + problem[1],
          textBody: `تنبيه من MEDLINK:
${problem[0]}

MEDLINK alert:
${problem[1]}

Last report / آخر تقرير (${fmt(k.at)} UTC): ${k.message}

راجع سجل "Backups" في GitHub Actions، واتبع docs/backup-restore.md.
Check the "Backups" run in GitHub Actions and follow docs/backup-restore.md.`,
        });
      }
      await tx`UPDATE ops_checks SET alerted_at = ${now} WHERE name = ${k.name}`;
      sent++;
    }
    return sent;
  });
}

/** One scheduler tick: no-show; cleanup and alerts if an hour has passed; retention if due. A failed job never stops the others. */
export async function tick(db: Db, email: EmailSender, alertEmail: string, now: Date): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  const run = async (name: string, job: () => Promise<number>) => {
    try {
      out[name] = await job();
    } catch (e) {
      // Only the error type is logged (no personal data); the next tick tries again.
      out[name] = "failed";
      console.error(JSON.stringify({ level: "error", msg: "job failed", job: name, error: (e as Error)?.name }));
    }
  };
  await run("noShow", () => noShow(db, now));
  if (await hourlyDue(db, now)) {
    await run("cleanup", () => cleanup(db, now));
    await run("opsAlert", () => opsAlert(db, email, alertEmail, now));
  }
  if (await retentionDue(db, now)) await run("retention", () => retention(db, now));
  return out;
}
