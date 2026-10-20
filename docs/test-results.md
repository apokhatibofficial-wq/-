# MEDLINK — Test results (Phase 4)

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
