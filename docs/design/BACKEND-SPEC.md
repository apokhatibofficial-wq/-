# MEDLINK: Backend & Security Specification (Phase 4 onward)

## 0. No demo accounts — hard rule
- The repository, migrations, seed scripts, Docker images and docs contain **no user accounts, no default passwords and no example credentials**.
- The prototypes show `user@example.com` only as a visual placeholder. It is not an account and must not be created.
- **First company admin:** run `medlink bootstrap-admin --email <owner email>` once on the server. The command:
  1. refuses to run if any company user already exists;
  2. creates the user with no password;
  3. prints a **single-use setup link** valid for 30 minutes. The owner sets their password and enrols TOTP 2FA through that link.
  The command never accepts a password as an argument and writes no secret to logs or shell history.
- **Hospital accounts:** created only from the company console. The hospital admin receives a one-time activation email (valid 24h) and sets their own password and 2FA. Hospital staff accounts (reception, scanner) are created by the hospital admin the same way.
- **Tests:** each test run creates its own throwaway users in a disposable database, with random passwords generated at runtime (`RandomNumberGenerator`). These are destroyed after the run. Credentials are never committed, printed or reused.
- **Data:** no real patient data in development or tests. Use generated fake data only, and only inside test fixtures.

## 1. Stack (approved, fully free)
- **API:** ASP.NET Core 8 (minimal APIs), with EF Core + Npgsql (or Dapper) and versioned SQL migrations.
- **Database:** PostgreSQL 16 in Docker on an Oracle Cloud Always Free ARM VM. Caddy provides HTTPS via Let's Encrypt. Cloudflare (free) sits in front for DNS, proxy and WAF.
- **Background jobs:** an in-process `BackgroundService`, ticking every 60s:
  - no-show marking;
  - expiry of idempotency keys, setup links and reset links;
  - nightly retention purge.
- **Real-time:** SignalR hub, so the Windows app receives check-ins pushed from the phone scanner.
- **Web front-ends:** booking site, hospital web (form builder + scanner) and company console. Static builds on Cloudflare Pages (free), calling `api.medlink.website`.
- **Windows:** .NET 8 WPF, with SQLite + SQLCipher. The DB key is stored with DPAPI (CurrentUser) in `%LOCALAPPDATA%\MEDLINK\`, never in the install folder.
- **Email:** free tier of a transactional provider, used only for activation and reset links.
- **Backups:** `pg_dump` every 6h, encrypted with `age` (public key on the server, private key held offline by the owner), uploaded to Cloudflare R2 free in a separate account. Kept 35 days. A restore test runs monthly.

## 2. Secrets
- `.env.example` lists variable names with dummy values only. The real `.env` file is `chmod 600`, owned by the service user, and listed in `.gitignore` along with `*.db`, `*.sqlite`, `backups/`, `*.age` and `*.pfx`.
- Required secrets:
  - `DB_PASSWORD`
  - `DATA_PROTECTION_KEYS_PATH`
  - `SESSION_SIGNING_KEY`
  - `TOTP_ENC_KEY`
  - `EMAIL_API_KEY`
  - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
  - `BACKUP_AGE_RECIPIENT`
  - `UPDATE_SIGNING_PUBLIC_KEY` (the Windows app ships with the public key only)
- Generate all of them locally, e.g. with `openssl rand -base64 48`. **Never paste them into chat, WhatsApp, tickets or the repo.**
- Add a CI step that scans the repo for secrets (e.g. gitleaks) and a dependency vulnerability scan (`dotnet list package --vulnerable`, `npm audit`).

## 3. Auth & sessions
- Passwords are hashed with **Argon2id** (memory ≥ 64 MiB, iterations ≥ 3, parallelism 1–2; tune to about 250ms on the VM). Rehash on login if the parameters change.
- TOTP 2FA is **mandatory** for company users and hospital admins, and optional for reception and scanner staff (decision for later).
- Sessions:
  - opaque random 256-bit tokens; only their SHA-256 hash is stored in `sessions`;
  - web: `HttpOnly; Secure; SameSite=Strict` cookie plus CSRF token;
  - Windows: bearer token held in memory, refresh token protected with DPAPI;
  - idle timeout 12h for scanner and reception, 8h for admins;
  - revoked on logout, suspension, password reset and role change.
- Rate limits:
  - login: 5 failures → 15-minute lock per account, plus limits per IP and per /24 network;
  - booking creation: per IP and per hospital;
  - QR verification: per device.
- **Authorization:** the `hospital_id` always comes from the session principal. Every repository method requires it, and PostgreSQL row-level security (RLS) with `SET app.hospital_id` acts as a second layer. Client-supplied hospital IDs and URL slugs are never trusted for access.
- Logs: structured, with no names, phones, tokens, passwords or QR values. Use request IDs only.

## 4. Data model (draft; review constraints and normalisation before migrating)
```
hospitals(id PK, name_ar, name_en, name_tr, status[active|suspended|pending],
          no_show_grace_min DEFAULT 30, retention_months DEFAULT 24, timezone, created_at)
hospital_slugs(slug PK, hospital_id FK, is_primary, retired_at, redirect_until)
          -- slug is never deleted; UNIQUE(slug) forever; max 1 change / 30 days
users(id PK, scope[company|hospital], hospital_id FK NULL, email UNIQUE,
      password_hash NULL, totp_secret_enc NULL, status, failed_attempts, locked_until)
user_roles(user_id, role)  -- owner|support|viewer|hosp_admin|reception|scanner
sessions(id PK, user_id, token_hash UNIQUE, created_at, last_seen_at, expires_at, revoked_at)
one_time_links(id PK, user_id, purpose[setup|activation|reset], token_hash UNIQUE, expires_at, used_at)
departments(id PK, hospital_id, name_ar/en/tr, active, sort)
schedules(id PK, department_id, weekday, start_time, end_time, slot_minutes, capacity)
closures(hospital_id, department_id NULL, date, reason)
form_versions(id PK, hospital_id, version, schema_json, published_by, published_at,
              restored_from_version NULL, change_summary_json)
              UNIQUE(hospital_id, version); immutable (no UPDATE grant)
form_drafts(hospital_id PK, schema_json, base_version, updated_by, updated_at)
hospital_active_form(hospital_id PK, form_version_id FK)
bookings(id PK, hospital_id, ref UNIQUE, department_id, slot_start timestamptz, seat_no,
         patient_name, phone NULL, form_version_id, status[waiting|arrived|no_show|cancelled],
         arrived_at NULL, qr_token_hash UNIQUE, idempotency_key, created_at,
         UNIQUE(hospital_id, department_id, slot_start, seat_no),
         UNIQUE(hospital_id, idempotency_key))
booking_answers(booking_id, question_id, value_json)
attendance_events(id PK, booking_id, type, source[qr|reception|auto|correction], at,
                  actor_id NULL, reason NULL, device_id NULL, client_event_id UNIQUE NULL,
                  received_at, needs_review bool)
audit_log(id PK, at, actor_id, hospital_id NULL, action, target, meta_json)
          -- INSERT only; UPDATE/DELETE revoked from app role
sync_cursors(device_id, hospital_id, last_seq)
```

## 5. Critical mechanisms
- **No double booking:** in one transaction, insert the booking with the first free `seat_no` (1..capacity) for the slot. The unique constraint rejects concurrent duplicates; retry with the next seat, otherwise return **409 SLOT_FULL**. Availability is checked again at confirm time.
- **Idempotency:** the client sends an `Idempotency-Key` header, generated when the review step opens. A repeated key returns the original booking (200), not a new one.
- **QR:** a 128+ bit random token, `MLK1.` + 22 base64url characters. Only its SHA-256 hash is stored, and the token carries no personal data. Verification checks hospital = the session's hospital, date = today (in the hospital's timezone), and status = waiting. Check-in runs as `UPDATE … SET status='arrived' WHERE id=$1 AND status='waiting'`; if 0 rows change, return "already".
- **Form publish:**
  1. take a transaction with `pg_advisory_xact_lock(hospital)`;
  2. insert a new `form_versions` row (version = max+1);
  3. update `hospital_active_form`;
  4. write the audit row;
  5. commit.
  Any failure rolls back, so the live version is untouched; report success only after the commit. Restoring copies an old `schema_json` into a new version with `restored_from_version` set.
- **Open forms during publish:** a booking carries `form_version_id`. Answers are validated **server-side** against that version, which is accepted for 2h after it is superseded; after that, return 409 FORM_UPDATED and the client re-renders with the patient's answers preserved where question IDs still match.
- **No-show:** the job sets `waiting → no_show` where `slot_start + grace < now()`, adding an `auto` event.
- **Attendance conflicts** (approved policy): status is derived from events.
  - The earliest `arrived` wins.
  - `arrived` beats `auto` no-show.
  - A `correction` beats `qr`, `reception` and `auto`.
  - When two corrections conflict, the latest `received_at` wins and `needs_review` is set.
  - Events are never deleted.
- **Windows sync:**
  - Local outbox: every attendance action gets a `client_event_id` (UUIDv7). Retry with exponential backoff, and deduplicate on the server.
  - Pull changes since `last_seq`.
  - Local cache window: yesterday to +30 days.
  - The local DB is never trusted for permissions.
- **Slug policy:** an old slug returns a 301 redirect until `redirect_until` (+90 days), then a "link changed" page. Old slugs are reserved forever.
- **Retention:** nightly, for bookings older than `retention_months`, null `patient_name` and `phone`, delete `booking_answers`, and keep aggregates.

## 6. Phase 4 scope (do this next, then stop for review)
1. Repo scaffold: `/api` (ASP.NET Core), `/web/booking`, `/web/hospital`, `/web/admin`, `/windows`, `/infra` (docker-compose, Caddyfile, backup scripts), `/docs`; plus `.env.example` and `.gitignore`.
2. Migrations for `hospitals`, `hospital_slugs`, `users`, `user_roles`, `sessions`, `one_time_links` and `audit_log`, with RLS.
3. The `bootstrap-admin` CLI, the setup-link flow, login with Argon2id and TOTP, sessions, logout, and lockout/rate limits.
4. Company console screens from `designs/Company Console.dc.html`: hospitals list, create, edit, suspend/reactivate, recover access, audit, roles.
5. Tests (xUnit + Testcontainers PostgreSQL), each with **actual results recorded** in `docs/test-results.md`:
   - create a hospital and sign in;
   - unauthorised access is denied (server-side);
   - hospital A cannot read hospital B, even with tampered IDs;
   - slugs are unique, reserved and redirected;
   - password storage is verified (the hash is Argon2id, with no plaintext anywhere);
   - no secrets in the repo or logs (gitleaks plus a log assertion).

## 7. Full acceptance test list (later phases)
1. Create a hospital account and sign in.
2. Unauthorised users cannot reach the dashboards.
3. A hospital cannot read another hospital's data.
4. Each hospital gets a unique booking link.
5. Book an available slot.
6. The same slot cannot be booked twice at the same time.
7. Re-submitting the same request does not create a duplicate.
8. Generate and verify the QR code.
9. Check-in happens only once.
10. No-show is recorded after the grace period.
11. An authorised user can correct attendance.
12. A newly published question appears on the booking link.
13. Required and optional fields behave correctly.
14. Previewing the draft does not affect the live form.
15. Publishing requires confirmation.
16. A failed publish keeps the live version.
17. Restoring an old version publishes it as a new version.
18. Forms already open during a publish are handled correctly.
19. Sync works after an internet outage.
20. Attendance conflicts are resolved.
21. No secret leaks in the repo or logs.
22. Passwords are protected.
23. Backup and restore work.
24. Mobile, desktop and RTL layouts work.
25. Permissions are enforced on the server, not only in the UI.

Document real results only. Also document the remaining risks:
- device security at hospitals;
- the security of admins' email accounts;
- local legal requirements for patient data;
- single-VM availability on a free plan.
