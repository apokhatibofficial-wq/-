# Phase 4 report: auth, permissions, company console

**Date:** 2026-10-20 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 5.

Real test results: [`test-results.md`](test-results.md). Screenshots: [`screenshots/phase-4/`](screenshots/phase-4/).

## Decisions approved by the owner for this phase
| Topic | Decision |
|---|---|
| Web front-ends | React 18 + Vite 6 + TypeScript |
| Database access | Hand-written SQL migrations + Dapper |
| 2FA for reception / QR scanner | Optional, set per hospital by its admin (`hospitals.staff_totp_required`, default off). Mandatory for all company users and hospital admins |
| Email during development | Mailpit in Docker. Production uses the provider's SMTP relay (e.g. Resend) with `EMAIL_API_KEY` |

## What was built
**1. Repo scaffold:** `api/` (ASP.NET Core 8 + tests), `web/admin/` (company console), `web/booking/` and `web/hospital/` (placeholders), `windows/` (placeholder), `infra/` (Dockerfile, docker-compose, Caddyfile, backup scripts), `docs/` (design handoff, reports), `.env.example`, `.gitignore`, CI.

**2. Migration `0001_core_auth.sql`:** `hospitals`, `hospital_slugs` (+ `reserved_slugs`), `users`, `user_roles`, `sessions`, `one_time_links`, `audit_log`.
- The API connects as `medlink_app`. That role does not own the tables, cannot bypass RLS, and is not a superuser.
- RLS on every table. The context (`app.scope`, `app.hospital_id`) is set per transaction from the session principal, never from the request. With no context set, the role sees nothing.
- `audit_log`: INSERT and SELECT only (no UPDATE/DELETE grant). Slugs: no DELETE grant, and slug/owner can't change after insert.
- The DB itself rejects non-Argon2id password hashes and roles that don't match the user's scope (company vs hospital).

**3. Auth:**
- `medlink bootstrap-admin --email …`: refuses if any company user exists; creates the owner with no password; prints a 30-minute single-use link. It takes no password argument and logs nothing.
- One-time links (setup 30 min, activation 24 h, reset 1 h): 256-bit tokens, stored as SHA-256 only, carried in the URL `#fragment` (never reaches server logs), single use. Issuing a new link cancels the user's older ones.
- Argon2id `m=65536, t=3, p=1`, rehash on login if the parameters change, timing-equal check for unknown emails.
- TOTP (RFC 6238): secret encrypted with AES-256-GCM (key derived from `TOTP_ENC_KEY`); a used code can't be replayed.
- Sessions: opaque 256-bit token, SHA-256 stored. Web: `__Host-medlink_session` cookie (HttpOnly, Secure, SameSite=Strict) plus an HMAC CSRF token in a header. Windows: bearer token. Idle timeout 8 h for admins, 12 h for reception/scanner. Revoked on logout, suspension, password set/reset and admin recovery.
- Lockout: 5 failures → 15 minutes. Rate limits on `/auth/*`: 20/min per IP and 60/min per /24 (configurable).

**4. Company console** (`web/admin`), built to `Company Console.dc.html` with the prototype's AR/EN/TR text verbatim:
- Hospitals list with search, filters and copy link. Create dialog with a slug suggested from the English name and checked live on the server.
- Edit drawer (fixed ID, names, slug policy, old slugs, facts).
- Suspend/reactivate with a required reason. Recover admin access with the 3-item checklist.
- Reports, audit log, roles matrix.
- Sign-in page (split layout, same as the Windows design) with a TOTP step, and the setup/activation page with a QR code.
- Buttons follow the user's permissions, but every action is checked again on the server.

**5. Tests:** 26 API tests on real PostgreSQL, 3 web unit tests, a 16-step browser run, gitleaks, and dependency scans. All pass; see `test-results.md`.

## Interpretations I made (please confirm or correct)
1. **Password rule:** at least 10 characters (128 max), no composition rules, must not contain the email name, needs at least 4 different characters. 2FA is mandatory for admins, so 10 is reasonable. You may prefer 12.
2. **Support's "◐" (partial) audit access** in the roles matrix: Support sees entries tied to a hospital, but not company-internal ones (such as company staff sign-ins).
3. **Reports** show zeros and "—" until booking exists (Phase 6). Nothing is invented.
4. **Hospital admin activation page:** the hospital web (`app.`) is Phase 5, so for now the admin console also serves the `/link` page. **Until Phase 5, set `HOSPITAL_WEB_URL` to the admin console address in production**, otherwise activation emails point to a site that doesn't exist yet.
5. **Windows app:** gets the session token as a bearer token; the DPAPI-protected refresh token comes in Phase 8.

## Open questions for the owner (needed before or during Phase 5)
1. **Hospital time zone:** the design's create dialog has no time-zone field, and no-show/"today" depend on it. New hospitals get `DEFAULT_HOSPITAL_TIMEZONE` (default `UTC`). Recommendation: add a time-zone dropdown to the create dialog and drawer. Which time zone(s) should the default be (e.g. `Africa/Tripoli`, `Europe/Istanbul`)?
2. **Company staff accounts** (Support, Viewer): the design has no screen for them. Recommendation: a "Team" tab, Owner only, using the same invite-by-link flow.
3. **When a company user loses access** (lost phone or password): there is no flow yet. Recommendation: another Owner issues a reset link; if there is only one Owner, a server-side command `medlink reset-company-user`, run on the VM with SSH access.
4. **Maximum session age:** sessions currently have only an idle timeout. Recommendation: also a hard limit of 7 days.

## Remaining risks
- **Device security at hospitals:** shared reception PCs, and saved browser passwords.
- **Admins' email accounts:** whoever controls the email can use a reset link (2FA is re-enrolled during reset). Recommend admins use email accounts with 2FA.
- **Local legal requirements** for patient data: not reviewed yet.
- **Single free VM:** no redundancy; Oracle can reclaim idle Always Free instances. Backups (Phase 11) are the safety net.
- **The CI workflow and the full `api/Dockerfile` build** have not run outside this sandbox yet (see `test-results.md` §4).
