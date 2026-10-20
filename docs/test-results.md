# MEDLINK — Test results

Real runs only. Re-run the commands to reproduce. Newest phase first.

---

# Phase 6 — online booking, form builder and versions (2026-10-20)

## 1. API tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 59 passed, 0 failed** (3 min 59 s). That is 44 earlier tests plus 15 new ones.

| Acceptance test (BACKEND-SPEC §7) | Test | Result |
|---|---|---|
| 5. Book an available slot | `Acceptance 5/8: book an available slot; the QR is an opaque 128-bit token, stored only as a hash` | ✅ |
| 6. The same slot cannot be booked twice at once | `Acceptance 6: … 10 parallel requests, capacity 1 and 2` (exactly 1 and exactly 2 succeed; seats 1..n) | ✅ |
| 7. Re-submitting does not duplicate | `Acceptance 7: re-sending the same request returns the original booking` (5 parallel replays → same ref and QR, 1 row) | ✅ |
| 8. Generate the QR code | covered by 5/8: `MLK1.` + 22 base64url chars; only its SHA-256 in the DB. (Verification by the scanner is phase 9) | ✅ |
| 12. A newly published question appears on the booking link | `Acceptance 12/14` | ✅ |
| 13. Required and optional fields behave correctly | `Acceptance 13: … checked on the server against the published version` | ✅ |
| 14. Previewing/saving the draft doesn't affect the live form | `Acceptance 12/14` | ✅ |
| 15. Publishing requires confirmation | `Acceptance 15: publishing is blocked until …` (server blockers) + browser step (confirmation dialog) | ✅ |
| 16. A failed publish keeps the live version | `Acceptance 16: a publish that fails inside the database keeps the live version and the draft` (a real DB trigger forces the failure) | ✅ |
| 17. Restoring publishes a new version | `Acceptance 17: restoring an old version publishes it as a new version; old versions stay` | ✅ |
| 18. Forms open during a publish | `Acceptance 18: a form opened before a publish is accepted for 2 hours, then the patient must reload` | ✅ |

Other new tests:
- Availability rules: 14 days, 30-minute notice, closures, the Damascus time zone, and per-hospital overrides.
- Reception cancels with a reason and the seat is freed; scanners and other hospitals cannot.
- Suspended hospitals take no bookings; the per-phone limit works only when switched on.
- RLS on bookings, answers and forms.
- Published versions can't be updated in the database.
- **A signed-in browser can still open one-time links and sign in again** (a bug the browser run found; see below).

**Mutation check:** three bugs were introduced on purpose: seats beyond the capacity, no full-slot check, and a 1000-hour grace for old forms. 3 tests failed as expected. A fourth mutation removed the cookie fix, and its test failed too. All code was restored.

## 2. Web (npm workspace)
| Check | Result |
|---|---|
| `npm audit` | ✅ 0 vulnerabilities |
| `tsc` × 4 | ✅ 0 errors |
| Unit tests | ✅ shared 3/3 · hospital 5/5 (form diff and publish blockers) · booking 5/5 (phone rule, Pages 301 function) |
| `vite build` × 3 | ✅ admin 252 kB · hospital 271 kB · booking 207 kB |

## 3. Browser end-to-end on the real stack (Phase 6 run)
**10 of 10 steps passed.**
```
PASS owner and hospital admin set up (hospital in Asia/Damascus)
PASS form builder: add a required choice question and an optional note, publish v1 with confirmation
PASS preview shows the draft and validates required questions without sending anything
PASS patient books: details → department → questions → date/time → review → confirmation ticket with QR
PASS the booked time is no longer offered to the next patient
PASS two patients pick the same last seat: the second gets the conflict banner and is sent back to pick a time
PASS a form published while a patient is booking: the patient finishes on the version they opened
PASS a publish that fails in the database shows the red banner and keeps v2 live
PASS versions tab: restore v1 publishes it as v3
PASS reception finds the booking by number, sees the answers, and cancels it with a reason
```
Also checked in that run:
- The **saved ticket PNG** (1080×1500) was decoded with a QR reader (`jsQR`). It contains a token of the form `MLK1.` + 22 characters, and its SHA-256 matches the stored `qr_token_hash` of booking `ML-YSL55X`.
- **API container log** (549 lines): 0 matches for patient names, the phone number, `MLK1.`, `#t=` or test emails.
- No horizontal scrolling at 390 px on the ticket page.

**Regression runs after Phase 6:**
- Phase 4: 16/16.
- Phase 5: 16/16. Its booking-site steps were updated on purpose, because departments are now step 2 of the booking flow.
- System settings: 7/7.

Bugs the browser run found (fixed):
1. **Session cookie blocking anonymous pages.** A browser already signed in to the console sent its session cookie to `/auth/link/inspect`. Without a CSRF header, the server refused the request, so the activation link looked "invalid". The same would have blocked signing in again. Anonymous routes (`/auth/login`, `/auth/link/*`, `/public/*`) now ignore the session cookie. A test covers it and fails without the fix.
2. The test script itself had a few wrong assumptions (a guessed error text, an option label equal to the "Continue" button). These were corrected in the test, not the product.

Screenshots: `docs/screenshots/phase-6/`.

## Not tested yet
- Printing: the print button opens a new window with the ticket image; the browser's print dialog was not driven by the test.
- The scanner verifying the QR (phase 9), no-show marking (phase 10), and the Windows app (phases 7–8).
- The same infrastructure limits as earlier phases still apply.

---

# Phase 5 addendum — System settings in the company console (2026-10-20)

The owner asked for these values to be editable in the company console, not fixed in code: default time zone (Syria), booking window (14 days), minimum notice (30 min), patient cancellation (off), and the per-phone limit (none).

| Check | Result |
|---|---|
| API tests (`dotnet test -c Release`) | ✅ **44 passed, 0 failed** (2 min 2 s). 5 new in `PlatformSettingsTests`, plus the Syria-default check in the time-zone test |
| Web: `tsc` × 4, unit tests, `vite build` × 3 | ✅ no errors · 9/9 · 3 built |
| Browser, focused run (System settings) | ✅ **7 of 7** |
| Browser, Phase 5 run repeated | ✅ 16 of 16 |
| Browser, Phase 4 run repeated | ✅ 16 of 16 |

Browser steps:
```
PASS owner signs in
PASS System settings tab shows the owner values (Syria, 14 days, 30 min, no cancel, no limit)
PASS create dialog defaults to the system time zone (Asia/Damascus)
PASS owner changes the booking window to 21 days; saved and audited
PASS hospital drawer: override minimum notice to 60 minutes for this hospital only
PASS hospital admin sees the effective rules read-only: 21 days (company) and 60 minutes (override)
PASS audit log labels the new actions
```
The hospital step also calls `PATCH /admin/settings` directly → **403**.

Failures along the way (both in the tests, not the product):
- The database-guard test tried to "change" an active hospital's status to `active`, which isn't a change, so the guard correctly didn't fire. It now uses `suspended`.
- The browser test clicked the middle of a hospital row, where the Copy button sits. It now clicks the hospital name.

Screenshots: `docs/screenshots/phase-5/system-*.png`.

---

# Phase 5 — hospital management and unique links (2026-10-20)

## 1. API tests — xUnit + Testcontainers (PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 39 passed, 0 failed** (1 min 49 s). These are the 26 Phase 4 tests plus 13 new ones:

| New test | Result |
|---|---|
| Hospital admin invites reception and scanner staff; they activate without 2FA by default and get only their permissions | ✅ |
| Changing a staff role or disabling the account revokes sessions; admins cannot change themselves or other admins | ✅ |
| Send-link gives a pending user a new activation link and an active user a reset link | ✅ |
| When the hospital requires staff 2FA, new staff must enrol and staff without 2FA are told to get a reset link | ✅ |
| Hospital settings: validated ranges and real IANA time zones, recorded in the audit log | ✅ |
| Departments and weekly schedules: validation, overlap rejected by the database, deactivate instead of delete | ✅ |
| Closures: one per day per department (or whole hospital), and only for the session's hospital | ✅ |
| RLS also isolates departments, schedules and closures, and the DB rejects cross-hospital links | ✅ |
| Team: only an Owner invites company staff, by an emailed 24-hour activation link | ✅ |
| Team: role changes revoke sessions; nobody can change themselves; two Owners demoting each other at once leave one Owner | ✅ |
| reset-company-user: server-side recovery revokes sessions and issues a 1-hour reset link | ✅ |
| A session ends 7 days after sign-in even if it is used all the time | ✅ |
| Hospital time zone is chosen at creation and can be edited; unknown zones are refused | ✅ |

The slug test now also covers `/public/slugs/{slug}`, the non-redirecting endpoint the booking app uses.

**Mutation check:** two bugs were introduced on purpose: hospital admins allowed to create other admins, and role changes no longer revoking sessions. 3 tests failed as expected (`Failed: 3, Passed: 10`), and the code was restored.

**Failures along the way:**
- The 7-day session test was too strict: the database's transaction time is a few milliseconds earlier than the API's clock. One minute of tolerance was added; the 7-day limit itself is unchanged.

## 2. Web — npm workspace (`web/`: shared, admin, hospital, booking)
`cd web && npm ci && npm audit && npm run typecheck && npm test && npm run build`

| Check | Result |
|---|---|
| `npm audit` | ✅ 0 vulnerabilities |
| `tsc` (4 workspaces, strict) | ✅ no errors |
| Unit tests | ✅ shared 3/3, hospital 2/2, booking 4/4 (includes the Cloudflare Pages 301 function) |
| `vite build` × 3 | ✅ admin 242 kB, hospital 231 kB, booking 153 kB (JS, before gzip) |

## 3. Browser end-to-end on the real stack
API image + PostgreSQL + Mailpit (docker compose dev) and three Vite servers: console :5173, hospital web :5174, booking site :5175. Headless Chromium.

**Phase 5 run: 16 of 16 steps passed.**
```
PASS owner sets up the account and signs in
PASS create hospital with a chosen time zone (Europe/Istanbul)
PASS Team tab: owner invites a Support colleague by email
PASS hospital admin activation link opens the hospital web (port 5174) and enrols 2FA
PASS hospital sign-in: forgot password opens the prepared WhatsApp message to support
PASS hospital admin signs in with 2FA
PASS add two departments and a Sunday + Monday timetable
PASS an overlapping block is rejected with a clear message
PASS hide a department and add a closure day
PASS settings: booking link shown, grace changed to 45 minutes
PASS admin invites a reception user; the admin row itself is locked
PASS reception activates without 2FA, sees a limited, read-only dashboard
PASS booking site shows the hospital and only its visible departments
PASS renamed link: old URL lands on the new one; after 90 days it shows "link changed"
PASS audit log shows the hospital-side actions
PASS hospital web at phone width: top bar, no horizontal scroll
```
**Phase 4 run repeated after the refactor: 16 of 16 passed.** One expectation was updated on purpose: the hospital admin's activation link now points to the hospital web (:5174), not the console.

The reception step also calls the API directly: `PATCH /hospital/settings` → **403**, so the server refuses, not only the interface. A `grep` of the API container log for test emails and `#t=` found **0 matches**.

Bugs this run found (fixed):
1. **Booking site, renamed links:** the app relied on the browser following the API's 301, which pointed to a path on the API. Behind the dev proxy it landed on the wrong server, and it would have broken behind any other proxy. Fixed with a non-redirecting endpoint, `/public/slugs/{slug}`. The real 301 remains at `/public/book/{slug}`, used by the Cloudflare Pages Function.
2. **Closure form:** a flex rule meant for row layouts made the fields about 220 px tall. Fixed.

Screenshots: `docs/screenshots/phase-5/`.

## 4. Secrets
Run on the Phase 5 tree: `gitleaks dir . --redact` and `gitleaks git . --redact` → no leaks (§ Phase 4 shows the control check).

## Not tested yet
- The same limits as Phase 4 still apply: the full `api/Dockerfile` build, CI on GitHub, Caddy/Cloudflare, real email, and backups.
- The Cloudflare Pages Function was unit-tested with Node's `Request`/`Response`, not deployed to Cloudflare.

---

# Phase 4 — auth, permissions, company console

Recorded on **2026-10-20** from real runs in the development container. Nothing here is estimated: every line below was printed by the tool named in its section. Re-run the commands to reproduce.

Environment: .NET SDK 8.0.426, Node 22.22.0, Docker 29.9.1, PostgreSQL 16 (`postgres:16-alpine`, pulled from the `mirror.gcr.io` mirror because Docker Hub rate-limited the container), Chromium 1194 (Playwright).

---

## 1. API tests — xUnit + Testcontainers (real PostgreSQL 16)

```bash
cd api
dotnet build -c Release
dotnet test --no-build -c Release
```

**Result: 26 passed, 0 failed** (total 53.3 s).

Each run starts a disposable PostgreSQL container, applies the real migrations, and creates throwaway users with passwords generated at runtime (`RandomNumberGenerator`). Nothing is committed or reused.

| Phase 4 requirement (BACKEND-SPEC §6.5) | Test(s) | Result |
|---|---|---|
| Create a hospital and sign in | `Acceptance 1: create a hospital account, the admin activates it and signs in` | ✅ Passed |
| Unauthorised access is denied (server-side) | `Acceptance 2/25: anonymous callers are refused…`, `Acceptance 25: each company role can do only what the matrix allows`, `Hospital users cannot reach the company console…`, `Cookie requests that change state need the CSRF token` | ✅ Passed |
| Hospital A cannot read hospital B, even with tampered IDs | `Acceptance 3: … through the API, even with tampered IDs`, `Acceptance 3: row-level security stops hospital A's context…`, `With no request context set, the application role sees nothing at all`, `The application role cannot bypass RLS, edit or delete the audit log, or delete slugs` | ✅ Passed |
| Slugs are unique, reserved and redirected | `Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused`, `Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days`, `Two concurrent creates with the same slug: exactly one wins` | ✅ Passed |
| Password storage is verified (Argon2id, no plaintext anywhere) | `Password storage: Argon2id with the required parameters, salted, never plaintext` | ✅ Passed |
| No secrets in the repo or logs | `Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs` (+ gitleaks, §3) | ✅ Passed |

Other passing tests: lockout after 5 failures (15 min, even for the right password), wrong TOTP counts as a failure, a used TOTP code can't be replayed, logout revokes the session on the server, the Windows client gets a bearer token instead of a cookie, one-time links work once and expire, weak passwords and wrong codes are rejected, `bootstrap-admin` runs only once, suspending revokes sessions and blocks sign-in, admin recovery needs all 3 identity checks, per-IP rate limiting (429), startup refuses missing or weak secrets, security headers.

<details><summary>Full list of the 26 passing tests</summary>

```
5 failed sign-ins lock the account for 15 minutes, even for the right password
A one-time link works once and stops working after it expires
A wrong TOTP code counts as a failed attempt and a used code cannot be replayed
Acceptance 1: create a hospital account, the admin activates it and signs in
Acceptance 2/25: anonymous callers are refused by the server on every protected route
Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs
Acceptance 25: each company role can do only what the matrix allows
Acceptance 3: hospital A cannot read hospital B through the API, even with tampered IDs
Acceptance 3: row-level security stops hospital A's context from seeing or changing B's rows
Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused
Cookie requests that change state need the CSRF token
Hospital users cannot reach the company console, and company users cannot use hospital routes
Logout revokes the session on the server
Password storage: Argon2id with the required parameters, salted, never plaintext
Recovering admin access needs all 3 identity checks, revokes sessions and emails a 1-hour reset link
Security headers are set and errors reveal no internals
Sign-in is rate limited per client IP
Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days
Startup refuses missing or weak secrets
Suspending a hospital revokes its sessions and blocks sign-in; reactivating restores it
The application role cannot bypass RLS, edit or delete the audit log, or delete slugs
Two concurrent creates with the same slug: exactly one wins
Weak passwords and wrong TOTP codes are rejected when completing a link
Windows clients get a bearer token instead of a cookie
With no request context set, the application role sees nothing at all
bootstrap-admin creates one owner with a setup link and refuses to run twice
```
</details>

### Failures found along the way (now fixed)
These were real failures, kept here because the owner asked for actual results:
- **Logs test proved nothing at first.** `appsettings.json` filters hid almost all log lines from the test capture, so "no secrets found" was checked against an almost empty log. Fixed: the capture now records everything down to `Trace` and the test requires more than 100 lines, including ASP.NET routing, Npgsql and `/auth/login` entries, before it searches them. Npgsql was also not connected to the app's logging at all; it now is.
- **Mutation check.** To confirm the tests really detect faults, two bugs were introduced on purpose: (a) the hospital-user lookup ignored the session's hospital; (b) suspending a hospital no longer required the Owner permission. Both tests failed as expected (`Failed: 2, Passed: 8`), and the code was restored.

## 2. Company console (web/admin)

```bash
cd web/admin
npm ci && npm audit && npm run typecheck && npm test && npx vite build
```

| Check | Result |
|---|---|
| `npm audit` | ✅ found 0 vulnerabilities |
| `tsc -b` (strict) | ✅ no errors |
| `node --test` (slug rule matches the server, `slugify`, all 3 languages have the same keys) | ✅ 3 passed, 0 failed |
| `vite build` | ✅ built (JS 227 kB, 75 kB gzip) |

`vitest` was removed because every version compatible with Vite 6 has open advisories (`npm audit`: 2 critical, 1 moderate). Node's built-in test runner is used instead.

### End-to-end in a real browser
Stack: the API image, PostgreSQL 16 and Mailpit via `infra/docker-compose.yml` + `docker-compose.dev.yml`, the Vite dev server, and headless Chromium. The owner account was created with the real `bootstrap-admin` command.

**Result: 16 of 16 steps passed.**

```
PASS setup link opens, token removed from the address bar
PASS owner sets password and enrols TOTP
PASS the used link no longer works
PASS wrong password shows a generic error
PASS owner signs in with password + TOTP
PASS create hospital: slug suggested from the English name, checked by the server
PASS a reserved slug is refused live
PASS activation email reaches Mailpit with a 24h one-time link
PASS hospitals table, drawer with fixed ID and slug policy
PASS suspend needs a reason, then shows as suspended
PASS recover access needs all three checks
PASS audit log lists the actions; roles matrix renders
PASS English switches to LTR
PASS phone width (390px): top bar layout, no horizontal page scroll
PASS the reset link replaced the activation link (old one refused)
PASS sign out ends the session
```

Also checked by hand during that run:
- `bootstrap-admin` run a second time → exit code 1, "A company user already exists".
- `grep` over the API container's whole log for the owner email, `#t=` and the setup token → **0 matches**.

Bugs this run found (fixed):
1. The data-protection key folder in the container belonged to root, so the non-root `app` user couldn't write to it. The Dockerfile now creates it with the right owner.
2. The link page lost its token in React development mode, because the first render was discarded after it had already cleared the URL. The token is now read once when the page loads.
3. The drawer's "Save" button was squashed when the drawer scrolled. Fixed in CSS.
4. Mailpit's web UI was on an internal-only Docker network (dev file only). Fixed.

Screenshots from this run: `docs/screenshots/phase-4/`.

## 3. Secrets and dependencies

| Check | Command | Result |
|---|---|---|
| Secret scan, working tree | `gitleaks dir . --redact` (v8.28.0) | ✅ no leaks found |
| Secret scan, git history | `gitleaks git . --redact` | ✅ no leaks found |
| Control: gitleaks really detects a key | fake AWS key in a scratch folder | ✅ "leaks found: 1" (folder deleted) |
| NuGet vulnerabilities (incl. transitive), API | `dotnet list package --vulnerable --include-transitive` | ✅ none |
| NuGet vulnerabilities (incl. transitive), tests | same | ✅ none |

What these checks found and what was done:
- `MailKit 4.8.0` had a moderate advisory → upgraded to 4.18.1.
- MimeKit pulled in `System.Security.Cryptography.Pkcs 10.0.0` (high, GHSA-846f-f764-76mx; moderate, GHSA-2fmv-rv2c-59x7) → pinned to 10.0.13, the first patched release.
- Testcontainers 3.10 pulled in `SSH.NET 2023.0.0` and old `System.Net.Http` / `System.Text.RegularExpressions` (high) → Testcontainers 4.15.0, xUnit 2.9.2.

The CI workflow (`.github/workflows/ci.yml`) runs all of these on every push. **It has not run on GitHub yet**; nothing here claims that it has.

## 4. Not tested yet (and why)
- **The production Docker build (`api/Dockerfile`) was not completed here.** Inside `docker build`, this sandbox can't reach nuget.org (`NU1301`, no proxy inside build containers). The image used in the end-to-end run was made from a host `dotnet publish` plus the same runtime stage. The full Dockerfile should be verified on the server or in CI.
- **Caddy / HTTPS / Cloudflare**: needs the real domain and VM.
- **Backup and restore scripts** (`infra/backup/`): written, not run. They need the R2 bucket and an age key pair (Phase 11 covers the restore test).
- **Real email delivery** through Resend: only Mailpit was used.
