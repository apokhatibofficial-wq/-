# MEDLINK — Smart Hospital Appointment System

**KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية**

> العربية أولًا · [English below](#english)

## نظرة عامة
MEDLINK نظام مواعيد للمستشفيات يتكوّن من: لوحة تحكم الشركة، وتطبيق Windows للمستشفى، وموقع حجز للمرضى برابط خاص لكل مستشفى، وصفحة جوال لمسح QR، وخادم مركزي.

**الحالة:** اكتملت المرحلة 6 (الحجز الإلكتروني ومنشئ النموذج وإصداراته)، وهي بانتظار مراجعة المالك.
- التقارير: [`docs/phase-6-report.md`](docs/phase-6-report.md) و[`docs/phase-5-report.md`](docs/phase-5-report.md) و[`docs/phase-4-report.md`](docs/phase-4-report.md)
- نتائج الاختبارات الفعلية: [`docs/test-results.md`](docs/test-results.md)

| المجلد | المحتوى |
|---|---|
| `api/` | الخادم: ASP.NET Core 8، وترحيلات SQL، والاختبارات |
| `web/admin/` | لوحة تحكم الشركة (React + Vite + TypeScript) |
| `web/hospital/` | ويب المستشفى: منشئ النموذج، والحجوزات، والأقسام والجداول، والإعدادات والمستخدمون |
| `web/booking/` | موقع الحجز للمرضى `/book/{slug}` |
| `web/shared/` | المكوّنات المشتركة بين المواقع الثلاثة |
| `windows/` | تطبيق Windows بـ WPF (المرحلة 8) |
| `infra/` | Docker Compose، وCaddy، وسكربتات النسخ الاحتياطي |
| `docs/` | حزمة التصميم، والتقارير، ولقطات الشاشة |

### قواعد ثابتة
- لا حسابات تجريبية ولا كلمات مرور افتراضية. أول مالك يُنشأ بالأمر `bootstrap-admin` فقط.
- لا أسرار داخل المستودع. ملف `.env` الحقيقي لا يُرفع أبدًا. وُلّد الأسرار على جهازك ولا تُرسلها في المحادثة أو واتساب.

### التشغيل للتطوير
```bash
cp .env.example .env && chmod 600 .env
# ضع قيمًا عشوائية للأسرار الأربعة:
#   DB_PASSWORD, DB_APP_PASSWORD, SESSION_SIGNING_KEY, TOTP_ENC_KEY
openssl rand -base64 48      # نفّذه مرة لكل سر

cd infra
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env up -d --build db migrate api mailpit
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env run --rm api bootstrap-admin --email you@example.com
cd ../web && npm ci
npm run dev -w @medlink/admin      # لوحة الشركة  http://localhost:5173
npm run dev -w @medlink/hospital   # ويب المستشفى http://localhost:5174
npm run dev -w @medlink/booking    # موقع الحجز   http://localhost:5175/book/<slug>
```
- افتح رابط الإعداد الذي يطبعه الأمر (صالح 30 دقيقة)، ثم اختر كلمة المرور وفعّل التحقق الثنائي.
- رسائل البريد في وضع التطوير تظهر في Mailpit: http://localhost:8025

### الاختبارات
```bash
cd api && dotnet test                      # يحتاج Docker (Testcontainers)
cd web && npm test && npm run typecheck
```

---

<a id="english"></a>
## English

MEDLINK is a hospital appointment system with five parts: a company console, a hospital Windows app, a patient booking site (one link per hospital), a phone QR check-in page, and a central API.

**Status:** Phase 6 (online booking, form builder and versions) is complete and waiting for the owner's review.
- Reports: [`docs/phase-6-report.md`](docs/phase-6-report.md), [`docs/phase-5-report.md`](docs/phase-5-report.md), [`docs/phase-4-report.md`](docs/phase-4-report.md)
- Real test results: [`docs/test-results.md`](docs/test-results.md)
- Design handoff: [`docs/design/`](docs/design/)

### Stack (approved, free tier)
- One Oracle Cloud Always Free ARM VM running Docker: ASP.NET Core 8 API, PostgreSQL 16, and Caddy (HTTPS via Let's Encrypt).
- Cloudflare free: DNS, proxy and WAF; Pages for the static front-ends; R2 for encrypted backups.
- A free transactional-email tier, used only for activation and reset links.

### Rules that never change
- **No demo accounts and no default passwords.** The first company owner is created only by `medlink bootstrap-admin --email …`, which prints a single-use 30-minute setup link. Hospital admins get a 24-hour activation link by email.
- **No secrets in the repo.** `.env` is git-ignored. Generate secrets locally with `openssl rand -base64 48`, and never paste them into chat, WhatsApp or tickets.
- Patient data never goes in development or tests. Test runs create throwaway users with random passwords in a disposable database.

### Run locally
```bash
cp .env.example .env && chmod 600 .env
# fill DB_PASSWORD, DB_APP_PASSWORD, SESSION_SIGNING_KEY, TOTP_ENC_KEY with: openssl rand -base64 48
cd infra
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env up -d --build db migrate api mailpit
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env run --rm api bootstrap-admin --email you@example.com
cd ../web && npm ci                      # one npm workspace: shared, admin, hospital, booking
npm run dev -w @medlink/admin     # company console  http://localhost:5173
npm run dev -w @medlink/hospital  # hospital web     http://localhost:5174
npm run dev -w @medlink/booking   # booking site     http://localhost:5175/book/<slug>
# each dev server proxies the API under /api
```
- Open the printed setup link, choose a password and scan the 2FA QR code.
- Development emails appear in Mailpit at http://localhost:8025.

Without Docker for the API: `cd api/src/MedLink.Api && dotnet run`, with the variables from `.env` exported and PostgreSQL reachable. Run `dotnet run -- migrate` first.

### Tests
```bash
cd api && dotnet test                         # needs Docker: Testcontainers starts PostgreSQL 16
cd web && npm test && npm run typecheck && npm audit && npm run build
```
CI (`.github/workflows/ci.yml`) also runs a vulnerable-package check and gitleaks over the full history.

### Configuration
All settings are environment variables; see [`.env.example`](.env.example). The API refuses to start if a secret is missing or shorter than 32 random bytes.

| Variable | Purpose |
|---|---|
| `DB_PASSWORD` | DB owner, used only by `migrate` and the Postgres container |
| `DB_APP_PASSWORD` | the `medlink_app` role the API uses; row-level security applies to it |
| `SESSION_SIGNING_KEY` | CSRF/HMAC key |
| `TOTP_ENC_KEY` | encrypts 2FA secrets at rest |
| `EMAIL_API_KEY` | SMTP password of the email provider |

### Deployment (outline; full guide in Phase 12)
1. Create the Oracle ARM VM and install Docker. Allow 80/443 **only from Cloudflare's IP ranges**, and SSH only from your own IP.
2. In Cloudflare, point `api.medlink.website` at the VM (proxied, SSL mode "Full (strict)").
3. Copy the repo, create `.env` (`chmod 600`), then run `cd infra && docker compose --env-file ../.env up -d --build`.
4. Run `docker compose --env-file ../.env run --rm api bootstrap-admin --email <owner email>` once.
5. Build each site with `VITE_API_URL=https://api.medlink.website` and publish its `dist/` to Cloudflare Pages: `web/admin` → `admin.medlink.website`, `web/hospital` → `app.medlink.website`, `web/booking` → `medlink.website` (also deploy `web/booking/functions/` and set `API_ORIGIN=https://api.medlink.website`, so renamed links get a real 301).
6. Set `HOSPITAL_WEB_URL=https://app.medlink.website` and list all three origins in `CORS_ORIGINS`.
7. Company-wide values (default time zone, booking window, minimum notice, patient cancellation, per-phone limit) are set in the console under **System settings**, not in `.env`.
8. If the only Owner loses access: `docker compose --env-file ../.env run --rm api reset-company-user --email <address>` prints a 1-hour reset link. Hand it over only after verifying identity.

### Backups
Every 6 hours `infra/backup/backup.sh` dumps the database, encrypts it with `age` (public key only; the private key stays offline with the owner) and uploads it to Cloudflare R2. Every backup is kept for 30 days and the first of each month for 12 months. `restore-test.sh` runs monthly and checks that a fresh dump restores and that the stored backups are recent and intact. `restore.sh` opens a backup with the private key into a new database; `recover.sh` rebuilds a lost server. The whole cycle runs in CI on every push. Setup, cron lines and the disaster procedure: [`docs/backup-restore.md`](docs/backup-restore.md).

### Free-tier limits (check the current terms when you sign up)
- Oracle Always Free: Ampere A1 up to 4 OCPU / 24 GB in total; idle instances may be reclaimed.
- Cloudflare R2: 10 GB storage free.
- Cloudflare Pages: 500 builds/month.
- Resend free tier: about 100 emails/day.

These limits fit 20–100 hospitals for activation and reset email. The risk is a single VM with no failover, which the owner accepted.
