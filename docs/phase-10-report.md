# Phase 10 report: automatic no-show, cleanup, retention and password recovery

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 11.

Real test results: [`test-results.md`](test-results.md) (Phase 10 section). Screenshots: [`screenshots/phase-10/`](screenshots/phase-10/).

## Decisions taken without your answer (please confirm or correct)
You asked me to continue in the background, so I went ahead with the three recommendations from the Phase 9 report. Each one is easy to change.

| Question | What I did | To change it |
|---|---|---|
| 1. Who resets a staff password? | **The hospital admin only** (Settings › send a reset link, as today). KHATIB support handles hospital admins. The forgot-password dialog now says so for reception, doctors and scanner staff. | Give support the "send link" action on hospital staff in the console. |
| 2. Retention: clear correction reasons too? | **Yes.** After the retention period, a correction keeps its type, time and account, but its free-text reason is cleared (it may contain a name). | Remove one statement in the retention job. |
| 3. Show a notice in the Windows app for each no-show? | **No, the status change only.** The row changes to "no-show — automatically by server", as before. | Add a notice like the live QR check-in. |

## What was built
**Automatic no-show (server, every minute):**
- A booking still "waiting" when its time plus the **hospital's own grace period** has passed becomes "no-show". The event is recorded at the moment the grace period ended, with the source "automatically by server" and no account.
- It is never applied to:
  - a booking that already has a check-in;
  - a booking with a manual correction (a person decided);
  - a cancelled booking.
- The approved policy still holds: if the patient arrives late (QR, reception or Windows, even offline), the arrival wins.
- At most one automatic mark per booking:
  - a database rule enforces it;
  - a lock stops two servers from running the job at the same time.
- After a long outage, bookings older than 6 days are left alone (the day is long over).
- The Windows app and the phone never mark no-shows themselves.

**Cleanup (every hour):** one-time links used or expired more than 7 days ago, and sessions ended more than 30 days ago, are deleted. The audit log keeps the history.

**Retention (every night after 03:00 Syria time):**
- Bookings older than the hospital's retention period (default 24 months) are anonymised:
  - patient name, phone and cancellation reason removed;
  - form answers deleted;
  - correction reasons cleared.
- Status, times and department stay, so reports keep their counts.
- An anonymised ticket QR is no longer accepted by the scanner.
- One audit entry, `retention_purge`, records only the count.
- Attendance events stay append-only. The database refuses any change except clearing a reason, once.

**Password recovery:**
- Hospital admins: the WhatsApp message to support (from Phase 5) is unchanged. A password is never changed from a WhatsApp message; support verifies the identity and sends a one-time email link.
- Company accounts: the company owner issues the reset link after checking the identity (unchanged).
- Staff (reception, doctors, scanner): the forgot dialog now says "ask your hospital admin to send you a reset link", on the hospital web and in the Windows app, in AR/EN/TR.

**Operations:**
- `JOBS_ENABLED` (default `true`, in `.env.example`) switches the jobs off, e.g. on a second server.
- `job_runs` shows when each job last ran and how many rows it changed.
- The log contains counts only.
- The database driver's per-command log lines were turned off. With the minute job they would have added about 20,000 lines a day. They never contained values, only SQL text.

## Files changed
- `api/src/MedLink.Api/Data/Migrations/0006_background_jobs.sql` (new): one auto mark per booking, reason redaction rules, `job_runs`.
- `api/src/MedLink.Api/Jobs/MaintenanceJobs.cs` (new): the three jobs and the background service.
- `api/src/MedLink.Api/Program.cs`, `Config/MedLinkOptions.cs`, `appsettings.json`, `.env.example`.
- `api/tests/MedLink.Api.Tests/JobsTests.cs` (new, 6 tests); test fixture: jobs off by default, on for one test.
- `web/shared/src/text.ts`; `windows/MedLink.App.Core/Strings.cs`; `windows/MedLink.Windows/Views/SignInView.xaml`.

## Known limits
- The no-show runs once a minute, so a booking can become no-show up to one minute after its grace period ends.
- Retention starts on the first night after deployment. On a new system there is nothing old enough yet.

## Questions for Phase 11 (tests, security, backups)
1. **Backups:** the scripts from Phase 4 encrypt each nightly database dump with `age` and upload it to Cloudflare R2.
   - Is R2 still your choice?
   - How long should backups be kept? I suggest **30 daily + 12 monthly**.
2. **Restore test:** may I add a monthly automatic check that restores the latest backup into a throw-away database and compares the row counts? It proves the backups can actually be restored.
3. **Outside security review:** do you want a list of what a penetration tester should check (I can prepare it), or will you rely on the automated checks in CI (dependency audit, secret scan and the security tests)?
