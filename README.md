# MEDLINK — Smart Hospital Appointment System

**KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية**

> العربية أولًا · [English below](#english)

## نظرة عامة
MEDLINK نظام مواعيد للمستشفيات يتكوّن من: لوحة تحكم الشركة، وتطبيق Windows للمستشفى، وموقع حجز للمرضى برابط خاص لكل مستشفى، وصفحة جوال لمسح QR، وخادم مركزي.

**الحالة:** اكتملت المرحلة 4 (المصادقة والصلاحيات ولوحة الشركة)، وهي بانتظار مراجعة المالك.
- التقرير: [`docs/phase-4-report.md`](docs/phase-4-report.md)
- نتائج الاختبارات الفعلية: [`docs/test-results.md`](docs/test-results.md)

| المجلد | المحتوى |
|---|---|
| `api/` | الخادم: ASP.NET Core 8، وترحيلات SQL، والاختبارات |
| `web/admin/` | لوحة تحكم الشركة (React + Vite + TypeScript) |
| `web/booking/`، `web/hospital/` | موقع الحجز وويب المستشفى (المرحلتان 5 و6) |
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
cd ../web/admin && npm ci && npm run dev    # http://localhost:5173
```
- افتح رابط الإعداد الذي يطبعه الأمر (صالح 30 دقيقة)، ثم اختر كلمة المرور وفعّل التحقق الثنائي.
- رسائل البريد في وضع التطوير تظهر في Mailpit: http://localhost:8025

### الاختبارات
```bash
cd api && dotnet test                      # يحتاج Docker (Testcontainers)
cd web/admin && npm test && npm run typecheck
```

---

<a id="english"></a>
## English

MEDLINK is a hospital appointment system with five parts: a company console, a hospital Windows app, a patient booking site (one link per hospital), a phone QR check-in page, and a central API.

**Status:** Phase 4 (auth, permissions, company console) is complete and waiting for the owner's review.
- Report: [`docs/phase-4-report.md`](docs/phase-4-report.md)
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
cd ../web/admin && npm ci && npm run dev   # http://localhost:5173 (the API is proxied under /api)
```
- Open the printed setup link, choose a password and scan the 2FA QR code.
- Development emails appear in Mailpit at http://localhost:8025.

Without Docker for the API: `cd api/src/MedLink.Api && dotnet run`, with the variables from `.env` exported and PostgreSQL reachable. Run `dotnet run -- migrate` first.

### Tests
```bash
cd api && dotnet test                         # needs Docker: Testcontainers starts PostgreSQL 16
cd web/admin && npm test && npm run typecheck && npm audit
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
5. Build `web/admin` with `VITE_API_URL=https://api.medlink.website` and publish `dist/` to Cloudflare Pages on `admin.medlink.website`.
6. Until the hospital web exists (Phase 5), set `HOSPITAL_WEB_URL` to the admin console URL.

### Backups
`infra/backup/backup.sh` runs `pg_dump`, encrypts it with `age` using a public key, and uploads it to R2. Schedule it every 6 hours with cron, and set an R2 lifecycle rule to keep 35 days. `infra/backup/restore.sh` restores into a new database for the monthly restore test. The age private key stays offline with the owner. These scripts are written but not yet run; that is Phase 11.

### Free-tier limits (check the current terms when you sign up)
- Oracle Always Free: Ampere A1 up to 4 OCPU / 24 GB in total; idle instances may be reclaimed.
- Cloudflare R2: 10 GB storage free.
- Cloudflare Pages: 500 builds/month.
- Resend free tier: about 100 emails/day.

These limits fit 20–100 hospitals for activation and reset email. The risk is a single VM with no failover, which the owner accepted.
