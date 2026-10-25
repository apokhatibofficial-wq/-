# Report: MEDLINK's backend on Supabase (free)

**Date:** 2026-10-24 · **Branch:** `claude/clever-noether-tt7hdg`

**Owner's decisions:**
- free hosting: Supabase rather than a paid server;
- rewrite the backend for it;
- keep the .NET code until the new one is live and tested;
- no paid plan.

Deployment guide: [`deployment-supabase.md`](deployment-supabase.md).

## What was built
- **The API in TypeScript, for Supabase Edge Functions** (`supabase/functions/api`, about 3,950 lines, on Deno with Hono and postgres.js):
  - all 61 endpoints of the .NET API, with the same paths, rules, error codes and JSON answers, so the three sites and the Windows app need no change;
  - one new endpoint: the scheduler's `/internal/jobs`.
- **The same database:**
  - the same 7 migrations, with row-level security per hospital;
  - one new migration (`0008`) with:
    - rate limits kept in the database (function instances share no memory);
    - the first-owner and recovery commands as SQL functions, run in the Supabase SQL editor (there is no server terminal any more);
    - Supabase's automatic REST access to MEDLINK's tables closed.
- **Security kept as it was:**
  - Argon2id passwords (64 MiB, 3 passes; about 0.3 s, within Supabase's 2-second limit);
  - TOTP 2FA, encrypted at rest;
  - HttpOnly `__Host-` session cookies with CSRF tokens; bearer tokens for Windows;
  - account lockout and rate limits;
  - security headers and CORS.
- **`api.medlink.website`:**
  - a small Cloudflare Worker (`supabase/proxy`) forwards requests to the function, so the session cookie stays first-party;
  - it passes the real client IP with a shared secret. The function refuses any request that does not come through it, so nobody can bypass the rate limits.
- **Scheduled jobs:**
  - the database scheduler (pg_cron) calls the API every minute with a secret: no-show, hourly cleanup and backup alerts, nightly retention;
  - the "Deploy API" workflow sets this up.
- **Backups** (`supabase/backup`, run by GitHub Actions):
  - an encrypted backup to R2 every 6 hours (30 daily + 12 monthly), with a monthly restore test and failure emails, as before;
  - the owner's quarterly check with the offline key;
  - recovery into a new project.
- **Deployment** (`.github/workflows/deploy-api.yml`), on every push:
  - tests, migrations, the function, the scheduler and the proxy;
  - the server secrets are generated on the first run, straight into Supabase and Cloudflare, and never shown;
  - an encrypted copy goes to R2 for recovery.

## Real test results (in this environment)
- **API: 96 tests, all passing, on PostgreSQL 16.** Most are ported one by one from the .NET suite (same scenarios and assertions). They cover:
  - sign-in, lockout, 2FA replay, CSRF, cookies, bearer tokens;
  - one-time links and the first owner;
  - hospitals, staff, departments, schedules, closures, slugs, settings, form builder;
  - booking:
    - 10 simultaneous requests for one seat;
    - idempotency, answers, the 2-hour form grace, availability rules, phone limit;
  - scanner, Windows sync (long-poll, dedupe, offline arrival, corrections), doctors' limited view;
  - jobs and alerts;
  - time zones with daylight saving.
- **Security:**
  - an endpoint sweep: 62 endpoints, each with its declared rule;
  - 52 refused without signing in;
  - 265 calls refused for roles without the permission, with nothing written;
  - tenant isolation through the API and in the database;
  - the app role cannot bypass RLS or edit the audit log;
  - NUL bytes answer 400;
  - no secret, link or email address appears in the logs.
- **Backups:** `supabase/backup/ci-test.sh`, the whole cycle (a local PostgreSQL stands in for Supabase, an S3 mock for R2), passed:
  - backup twice;
  - monthly restore test;
  - a failed backup recorded;
  - restore with the key, identical rows;
  - a wrong key refused;
  - recovery into an empty database, identical rows.
- **Proxy:** its test passes (path, query, body, secret, client IP, cookies, redirects).
- CI now runs the API tests and the backup cycle on every push.

## Found and fixed by the ported tests
1. **JSON was stored double-encoded** (as a JSON string inside jsonb): the form versions, the drafts and the audit log. It is now written as real JSON, and a test checks it.
2. **A restore failed on "schema public already exists"** (a Supabase-style dump of one schema). The restore now skips that one statement.

## Owner's decisions (2026-10-24, after the report)
1. **The scheduler runs every minute**, as before (about 43,000 of the 500,000 free calls a month).
2. **The hospital board refreshes every 30 seconds** (was 15), to halve its use of the free calls.
3. **Doctors do not see the booking form answers** (as built).

## Decision I made (please confirm or correct)
- **Backups cover MEDLINK's own schema only.** Supabase's internal schemas are not ours to restore.

## Not done, and why
- **First real deployment: done on 2026-10-24** (Deploy API run #5, every step green). Checked from outside:
  - `https://api.medlink.website/health` answers `{"status":"ok"}`. The function reaches the database through Supabase's pooler as its own role, `medlink_app`.
  - A wrong sign-in answers 401 `INVALID_CREDENTIALS` with the CORS header for the admin site.
  - Calling the function directly at `*.supabase.co` is refused (403): only the proxy gets in.
  - The scheduler (pg_cron + pg_net) and the Workers custom domain were set up by the workflow.

  On the way, two problems in the deployment were found and fixed:
  - a database address containing `[` or `]` broke the workflow's parsing;
  - a test failed on a minute boundary.
- **Email: working since 2026-10-25.** `medlink.website` is verified in Resend, and an invitation from the admin Team page arrived. On the way:
  - the first try failed because the `EMAIL_API_KEY` secret reached the deployment empty;
  - the deployment now warns when it is empty, and a failed send logs the provider's status code and error name (never the recipient or the link).
- **The three sites and the Windows app have not been re-run end to end against the new API in a browser.** The earlier browser scripts were in this environment's temporary folder, which was lost when the session restarted. The API's answers are checked field by field by the tests above. The first real sign-in and booking after deployment is the end-to-end check (checklist in the deployment guide).
- **The .NET API, the server scripts and their CI jobs are still in the repository,** by your decision. I will remove them after the new API has run in production.
