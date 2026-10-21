# Phase 7 report: sync and the local SQLite database for the Windows app

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 8.

Real test results: [`test-results.md`](test-results.md) (Phase 7 section). Screenshots: [`screenshots/phase-7/`](screenshots/phase-7/).

## Owner decisions applied
| Decision | Where |
|---|---|
| The Windows app also runs on doctors' PCs; a doctor sees **only their own department's appointments** | New `doctor` role. The hospital admin picks 1+ departments when inviting a doctor and can change them. Doctors' pulls are filtered on the server and never include phone numbers. Doctors cannot check in or correct. |
| Offline check-in allowed, **by booking number only**, marked "pending sync" | Windows library `CheckInByRef`. The server re-checks everything when it arrives. |
| About 10 PCs per hospital | Limit set to **25 active devices** per hospital (room to replace PCs); revoked ones don't count. |
| Approved conflict policy | Correction beats everything; between corrections the latest received wins and the booking is flagged for review; otherwise the earliest arrival wins and beats an automatic no-show. Events are never deleted (the database refuses DELETE). |

## What was built
**Database (`0005_attendance_and_sync.sql`):**
- `attendance_events`, append-only (insert and select only). Each event records its type, source, time, account, device, a unique `client_event_id` and the reason. A correction without a reason is refused by the database.
- `devices`, plus `doctor_departments`.
- `bookings.needs_review`, and a sync sequence number that changes on every booking change.
- RLS on all new tables, and triggers that block cross-hospital references.

**Server:**
- `POST /sync/devices` registers a device. `GET /sync/pull` returns changes after a cursor for yesterday to +30 days in hospital time, in pages of 500, with an optional 25-second long-poll.
- `POST /sync/push` takes up to 200 events. Each one is checked again with the server-side session (never the PC's local copy) and answered applied, duplicate or rejected with a reason: cancelled, other day, not found, implausible time, forbidden.
- `POST /hospital/bookings/{id}/attendance` handles web check-in and correction.
- Hospital admins can list devices and revoke them.
- The console's "last sync" and "bookings in 30 days" columns now show real values (they were empty until now).
- Corrections are also written to the audit log, as the design text says.

**Windows sync library (`windows/MedLink.Sync`, .NET 8):**
- **Local database:** SQLite encrypted with SQLCipher. It uses a random 256-bit key protected by DPAPI for the signed-in Windows user.
- **Contents:** bookings from yesterday to +30 days. Older and later rows are deleted after each pull.
- **Outbox:** events wait in a local queue and are retried with backoff (2 s up to 5 min). A lost response is retried and applied only once.
- **Rejections:** a check-in the server rejects is listed for reception, and the screen goes back to the server's state.
- **Window:** the app's screens come in Phase 8.

**Web:**
- **Hospital Settings:** doctor invite with a department picker, department editing, and the devices list with last sync and revoke.
- **Bookings page:** manual check-in (on the appointment day), status correction with a required reason, and a "needs review" flag. Strings are copied verbatim from the Windows App and QR Scanner prototypes.
- **Console:** a doctor column in the roles matrix, and labels for the new audit actions.

## Decisions I made (please confirm or correct)
1. **Check-in only on the appointment's own day** (hospital time). Corrections are allowed on any day. Offline events older than 7 days, or more than 5 minutes in the future, are refused.
2. **Corrections are open to reception and the hospital admin** (the existing permission matrix). The cancel button stays, for waiting bookings only.
3. On the hospital **web**, a doctor sees only the departments page (read-only). Their appointment list is in the Windows app.
4. "Last sync" in the console = the latest contact from any PC of that hospital, including PCs revoked later.

## Known limits
- DPAPI exists only on Windows. Tests use a stand-in protector, and the encryption test checks the file itself (no plaintext, the wrong key fails). The library has not run on a real Windows PC yet.
- The automatic "no-show" job is Phase 10. The policy and the tests already cover it (an offline arrival beats it).
- QR check-in (`source = qr`) is in the schema; the scanner comes in Phase 9.

## Questions for Phase 8 (Windows app and splash animation)
1. **Testing on Windows:** WPF can be built here (Linux) but cannot run or be screenshotted here. I suggest a GitHub Actions `windows-latest` job that builds the app and runs its tests and UI smoke tests. It is free for public repos; private repos get 2,000 free minutes a month. After that, you or a hospital PC do a short manual checklist. Do you agree, or do you have a Windows PC for testing?
2. **Staying signed in:** should the app keep the session after closing (token protected by DPAPI, with the server's limits: 12 hours idle, 7 days at most)? Or should staff sign in every time the app opens? I recommend keeping it, because reception PCs restart often.
3. **Doctor screen:** the design only shows the reception dashboard. For doctors, I plan the same list, read-only, for their departments, with no phone numbers and no check-in buttons. Is that right?
