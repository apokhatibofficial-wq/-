# Phase 11 report: tests, security, backups

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 12.

Real test results: [`test-results.md`](test-results.md) (Phase 11 section). New documents:
- [`backup-restore.md`](backup-restore.md): the backup procedure;
- [`security-checklist.md`](security-checklist.md): for an outside tester;
- [`acceptance-tests.md`](acceptance-tests.md): the 25 acceptance tests and where each is covered.

Screenshot: [the hospital web after the disaster recovery](screenshots/phase-11/after-disaster-recovery.png).

## Owner decisions applied
| Decision | Where |
|---|---|
| Backups on Cloudflare R2, kept **30 daily + 12 monthly** | `infra/backup/backup.sh` every 6 h → `postgres/daily/` (deleted after 30 days); the first backup of each month is also copied to `postgres/monthly/` (deleted after 365 days, by `r2-lifecycle.sh`). |
| **Monthly automatic restore test** | `infra/backup/restore-test.sh` (cron, 1st of the month). See the note below about the private key. |
| **Checklist for an outside penetration tester** | `docs/security-checklist.md` |

The Phase 10 recommendations (staff resets by the hospital admin; reasons cleared at retention; no-show without a notice) stay as built, since you approved continuing. Tell me if any should change.

## Backups
- **`backup.sh`:**
  - the dump is encrypted with `age` while it streams, so it never touches the disk unencrypted;
  - before upload, it checks that the dump contains the data of every table;
  - after upload, it checks the size and SHA-256 of the stored object.
- **The monthly automatic test.** The private key must stay offline (spec), so the server cannot decrypt its own backups. The test proves everything it can without the key:
  1. a fresh copy of the database restores into a throw-away database, with every table's row count matching;
  2. the newest backup in R2 is less than 7 hours old, is an `age` file, and still matches its checksum;
  3. this month's copy exists.

  **Opening a real backup with the key** is a 10-minute check for you every 3 months (`restore.sh latest <key>`), described step by step in `backup-restore.md`.
- **`restore.sh`** restores into a **new** database only. It refuses the live one, and a wrong key leaves nothing behind.
- **`recover.sh`** rebuilds a lost server from R2. Tested by deleting the whole stack and its volumes: recovered in 13 seconds, identical row counts, and the hospital admin was still signed in and saw the bookings.
- **CI job `backups`** runs the whole cycle on every push, with a local S3 mock in place of R2 and a key pair made for the run. It passed on GitHub.
- **Fixed:** the Phase 4 scripts loaded `.env` through bash, which fails on a value such as `EMAIL_FROM=MEDLINK <no-reply@…>`. They would have failed on the server. The scripts now read only the keys they need.

## Security
- **Endpoint sweep (new tests).** All 61 API endpoints are listed automatically and compared with a fixed table of who may call each one:
  - the 9 public ones (sign-in, links, health, booking site) are the only open ones;
  - the other 52 answer 401 without a session;
  - each of the 7 roles gets 403 on every endpoint whose permission it lacks (267 refusals checked).

  Seeded faults (a missing rule, a wrong permission, a removed check inside 3 endpoints, an extra public path) are all caught.
- **Hardening found by the sweep:** `/sync/push` refused company accounts only because no device matched. It now requires a hospital account explicitly.
- **Security headers for the three sites** (`web/*/public/_headers`, for Cloudflare Pages):
  - Before: no CSP, the company console could be framed (clickjacking), and the camera was allowed everywhere.
  - Now: a strict CSP, no framing, and the camera on the hospital site only.
  - All 81 browser steps of phases 4–10 pass with the CSP enforced, with no violations. An injected script and an iframe are blocked.
- **OWASP ZAP:**
  - baseline on the three sites: 0 failures, 58 checks passed each;
  - active scan of the booking site: 0 failures;
  - API scan of the public and sign-in endpoints: it found **one real bug**. A NUL byte in any input (e.g. `?departmentId=%00`) caused a server error (500). Fixed for all endpoints at once, with a test. The rerun: 0 warnings, 113 checks passed.
  - Remaining warnings, accepted:
    - inline styles (React needs them);
    - no integrity hash on the Google Fonts stylesheet (see question 1).

## Tests now
- **100 API tests** (4 new).
- **The backup cycle in CI.**
- **81 browser steps against the built sites.**
- **The Windows run in CI.**
- **Mutation checks:**
  - 4 seeded backup faults: a schema-only dump, a tampered backup, a stale backup, a wrong key;
  - 7 authorisation faults.

  All caught, except one that cannot change any behaviour today (see test-results). The schema-only dump and two of the authorisation faults were caught only after a new check was added.

## Files changed
- `infra/backup/`: `lib.sh`, `backup.sh` (rewritten), `r2-lifecycle.sh`, `restore-test.sh`, `restore.sh` (rewritten), `recover.sh`, `ci-test.sh`.
- `.github/workflows/ci.yml`: job `backups`.
- `api/src/MedLink.Api/Auth/HttpAuth.cs` (endpoint markers), `Endpoints/SyncEndpoints.cs` (`/sync/push`), `Program.cs` (NUL → 400).
- `api/tests/MedLink.Api.Tests/EndpointSweepTests.cs` (new, 4 tests).
- `web/admin|hospital|booking/public/_headers` (new).
- `docs/backup-restore.md`, `docs/security-checklist.md`, `docs/acceptance-tests.md` (new); `README.md`.

## Known limits
- R2 itself was not used: the S3 mock stands in for it. The real bucket is set up and tested at deployment (Phase 12).
- In the S3 mock, setting the retention rules deleted every object; on R2 they only remove old ones. The procedure sets the rules once on the empty bucket, before the first backup.
- Not yet tested on real phones (manual checklist in the Phase 9 report).

## Questions for Phase 12 (installer, documentation, deployment)
1. **Fonts:** the web pages load their fonts from Google, so every patient's IP address reaches Google. May I serve the same fonts (IBM Plex, free licence) from MEDLINK's own sites? The look stays the same. I recommend yes.
2. **Protecting backups:** the server's R2 key can also delete backups, so someone who took over the server could erase them. May I enable an R2 **bucket lock** that forbids deleting a backup before it is 30 days old? I recommend yes.
3. **Alerts:** should the server email you when a backup or the monthly test fails, using the existing email service? I recommend yes, to your address only.
4. **Windows installer:** an MSIX installer must be signed. Do you have a code-signing certificate? If not:
   - (a) buy one (about USD 200–400 a year);
   - (b) use Microsoft Trusted Signing (about USD 10 a month);
   - (c) use a self-signed certificate that IT installs once on each hospital PC.

   I recommend (b).
