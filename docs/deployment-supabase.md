# Deploying MEDLINK on Supabase (free)

**Owner's decision (2026-10-24):** no server. The API runs as a Supabase Edge Function, with Supabase's PostgreSQL. `api.medlink.website` is a small Cloudflare Worker in front of it. The three sites stay on Cloudflare Pages, as before.

- The database, its migrations and row-level security are the same as before.
- The API was rewritten in TypeScript (`supabase/functions/api`), with the same endpoints and answers, so the sites and the Windows app are unchanged.
- The report is [`supabase-report.md`](supabase-report.md).

**Everything here is free**, within these limits:

| Limit | Meaning for MEDLINK |
|---|---|
| Supabase: 500,000 function calls a month | The scheduler uses about 43,000. Each open hospital board uses about 1,200 a day (one call every 30 seconds for 10 hours; owner's decision). |
| Supabase: 500 MB database | Hundreds of thousands of bookings. |
| Supabase: a project with **no activity for 7 days is paused** | The scheduler calls the API every minute. Unpause it from the dashboard if it ever happens. |
| Cloudflare Workers: 100,000 requests a day | Far above the use above. |
| GitHub: scheduled runs of a public repository stop after 60 days without a commit | The backups would stop. MEDLINK emails you within 8 hours, and a commit or one manual run starts them again. |

## 1. Supabase project (about 10 minutes)
1. Sign in at **supabase.com** with GitHub, then **New project**:
   - **Name:** `medlink`
   - **Database password:** use **Generate a password**, and keep it in your password manager (never in chat or WhatsApp).
   - **Region:** Central EU (Frankfurt)
2. When the project is ready, copy these three things into GitHub (repository › Settings › Secrets and variables › Actions › **New repository secret**):

   | Secret | Where to find it |
   |---|---|
   | `SUPABASE_PROJECT_REF` | Project settings › General › **Project ID** |
   | `SUPABASE_DB_URL` | **Connect** (top of the page) › **Session pooler** › the URI. Replace `[YOUR-PASSWORD]` with the database password. |
   | `SUPABASE_ACCESS_TOKEN` | Your avatar › Account preferences › **Access Tokens** › Generate new token |

3. Under **Variables** (same page, next tab), add `MEDLINK_ALERT_EMAIL`: your address, for backup alerts.

## 2. Cloudflare: allow the token to publish `api.medlink.website`
In Cloudflare › My Profile › **API Tokens**, edit the token used by GitHub (`CLOUDFLARE_API_TOKEN`), and add these permissions:
- Account › **Workers Scripts: Edit**
- Zone › **Workers Routes: Edit**
- Zone › **DNS: Edit**

## 3. Deploy
GitHub › **Actions › Deploy API › Run workflow**. In one run, it:
1. runs the API's tests;
2. **first time only:** generates the server secrets (session and 2FA keys, the API's database password, the proxy and scheduler secrets) straight into Supabase and Cloudflare. They are never shown anywhere;
3. applies the database migrations;
4. deploys the function;
5. sets up the scheduler (every minute);
6. publishes `api.medlink.website`, then checks `https://api.medlink.website/health`.

After that, it runs by itself on every change.

If a step failed during the first run (for example, the Cloudflare token lacked a permission): fix the cause, then run it again with **"Make new proxy, scheduler and database secrets"** ticked. Sessions and 2FA are not affected.

## 4. Your owner account
1. Supabase › **SQL Editor** › New query. Run (with your address):
   ```sql
   SELECT medlink_bootstrap_admin('you@example.com');
   ```
2. Open the link it returns **within 30 minutes**, choose a password and set up 2FA. Then sign in at `https://admin.medlink.website`.

It refuses to run a second time. If you lose your password or phone, run `SELECT medlink_reset_company_user('you@example.com');` in the same place.

## 5. Email (Resend)
1. At **resend.com**: sign up, then Domains › Add `medlink.website`.
2. Add the DNS records it shows in Cloudflare › DNS. They must be **DNS only** (grey cloud).
3. API Keys › Create (Sending access) › add it as the GitHub secret `EMAIL_API_KEY`.
4. Run **Deploy API** again.

Until then, invitations and reset links are not emailed. The admin console says "email not sent", and you can send them again later.

## 6. Backups
See [`backup-restore.md`](backup-restore.md), section "On Supabase". You need:
- an R2 bucket, with its keys as GitHub secrets;
- your age public key (`BACKUP_AGE_RECIPIENT`).

The **Backups** workflow then runs every 6 hours by itself.

## 7. Check
- [ ] `https://api.medlink.website/health` answers `{"status":"ok"}`.
- [ ] Sign-in works on admin and app; a test booking works on the booking link.
- [ ] Supabase › Database › Cron Jobs shows `medlink-jobs` succeeding every minute.
- [ ] Actions › Backups › Run workflow (backup) succeeds; on the 1st of the month, the restore test runs.
