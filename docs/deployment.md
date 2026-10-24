# Deploying MEDLINK

The full procedure for the first production deployment and for later updates. The scripts it uses were tested in Phase 12 (see [`test-results.md`](test-results.md)). The cloud accounts themselves (Oracle, Cloudflare, Resend) could not be used from the development environment, so **the first deployment should be done together, step by step.**

## The short way (about 1 hour)
1. **Accounts:** open the accounts in the table below (they must be in your name). Move the domain's DNS to Cloudflare.
2. **Server:**
   - Create the Oracle VM (step 2, items 1–2, below).
   - Connect with SSH and paste one command:
     ```bash
     sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/infra/server/install.sh)"
     ```
   - If the repository is private, `curl` cannot fetch the script. Instead:
     - `git clone` the repository to `/opt/medlink`, with a **read-only** access token, typed when git asks;
     - then run `sudo /opt/medlink/infra/server/install.sh`.
   - It asks for three things: your email, the domain, and the Resend key (hidden while you type). It then:
     - generates the server secrets on the server itself (they are never shown);
     - starts MEDLINK;
     - prints the one-time link for your owner account, and what is left.
3. **DNS:** in Cloudflare, add the `api` A record and the SSL settings the script prints (step 4 below).
4. **Sites:**
   - In Cloudflare, create an API token with the permission **"Cloudflare Pages: Edit"**.
   - In GitHub, under Settings › Secrets and variables › Actions, add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   - The workflow **Deploy web** then publishes the three sites and attaches `admin.`, `app.` and the main domain on every push. Actions › Deploy web › Run workflow runs it at once.
5. **Backups:** follow [`backup-restore.md`](backup-restore.md). Until they are set up, you get an alert email every 6 hours.

The sections below are the same procedure in full detail.

## 0. What you need
| Account / item | Used for | Cost |
|---|---|---|
| Domain `medlink.website`, DNS on Cloudflare | all addresses | the yearly domain fee |
| Cloudflare account **A** | DNS and proxy, Pages (three sites), R2 bucket `medlink-downloads` (Windows updates) | free |
| Cloudflare account **B** (separate login) | R2 bucket `medlink-backups` | free (10 GB) |
| Oracle Cloud | one Always Free Ampere A1 VM | free |
| Resend (or a similar provider) | activation and reset emails, server alerts | free tier |
| A Windows PC of yours (only if the Windows app is used) | creating the signing keys and building the installer | — |

## 1. Keys, made on your own PC (never on the server, never in chat or WhatsApp)
| Key | How | Where it goes |
|---|---|---|
| Server secrets (`DB_PASSWORD`, `DB_APP_PASSWORD`, `SESSION_SIGNING_KEY`, `TOTP_ENC_KEY`) | `openssl rand -base64 48`, once each | `.env` on the server |
| Backup key pair | `age-keygen -o medlink-backup-key.txt` | public line → `.env` `BACKUP_AGE_RECIPIENT`; the file stays **offline** |
| Update signing key (Windows app only) | `dotnet run --project windows/MedLink.UpdateTool -- keygen medlink-update.key` | the printed `UPDATE_SIGNING_PUBLIC_KEY` goes into every installer build; the key file stays **offline** |
| Package-signing certificate (Windows app only) | `windows/installer/new-signing-cert.ps1 -OutDir <folder>` | `.pfx` stays **offline**; `.cer` goes to hospital IT |

Keep the offline files on two USB sticks in two places, with a copy of `.env`. **If they are lost:**
- **backup key:** old backups can no longer be read;
- **update key or certificate:** every hospital PC needs a manual reinstall.

## 2. The server (Oracle Cloud)
1. Create a VM: **Ubuntu 24.04, Ampere A1** (e.g. 2 OCPU / 12 GB), boot volume 100 GB, with your SSH public key.
2. **Network security list** of its subnet, ingress:
   - TCP 22 from **your own IP only**;
   - TCP 80 and 443 from **Cloudflare's ranges only** (<https://www.cloudflare.com/ips>).

   Remove the default "0.0.0.0/0 port 22" rule.
3. Copy the repository to `/opt/medlink` (clone it with a read-only access token, or copy an archive), then run:
   ```bash
   sudo /opt/medlink/infra/server/setup-ubuntu.sh
   ```
   It sets up:
   - Docker and age;
   - automatic security updates (restarting at 04:30 Syria time when needed);
   - SSH with keys only;
   - the firewall that lets only Cloudflare reach ports 80/443 (a second layer behind the security list);
   - the backup cron lines and log rotation.

## 3. `.env`
```bash
cd /opt/medlink && cp .env.example .env && chmod 600 .env && nano .env
```
| Variable | Value |
|---|---|
| `DB_PASSWORD`, `DB_APP_PASSWORD`, `SESSION_SIGNING_KEY`, `TOTP_ENC_KEY` | from step 1 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_TLS` / `SMTP_USER` / `EMAIL_API_KEY` | e.g. Resend: `smtp.resend.com`, `465`, `ssl`, `resend`, your API key |
| `EMAIL_FROM` | `MEDLINK <no-reply@medlink.website>` (verify the domain at the provider) |
| `ADMIN_WEB_URL` / `HOSPITAL_WEB_URL` | `https://admin.medlink.website` / `https://app.medlink.website` |
| `CORS_ORIGINS` | `https://admin.medlink.website,https://app.medlink.website,https://medlink.website` |
| `API_DOMAIN` / `ACME_EMAIL` | `api.medlink.website` / your address |
| `ALERT_EMAIL` | your address (backup alerts) |
| `BACKUP_AGE_RECIPIENT`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | see [`backup-restore.md`](backup-restore.md) (account **B**) |

`COOKIE_SECURE` and `TRUSTED_PROXIES` are already set correctly by `infra/docker-compose.yml`.

## 4. DNS and HTTPS (Cloudflare account A)
1. Add `api.medlink.website` as an **A record** to the VM's public IP, **proxied** (orange cloud).
2. Set **SSL/TLS** mode to **Full** for now. Keep **"Always Use HTTPS" off**: Caddy redirects to HTTPS itself, and leaves the certificate checks on port 80 alone.
3. Start MEDLINK:
   ```bash
   cd /opt/medlink/infra && docker compose --env-file ../.env up -d --build
   docker compose --env-file ../.env logs caddy | grep -i certificate   # "certificate obtained successfully"
   curl https://api.medlink.website/health                              # {"status":"ok"}
   ```
4. Once the certificate is obtained, switch SSL/TLS to **Full (strict)**.
5. Create the first owner account (it prints a one-time link valid for 30 minutes):
   ```bash
   docker compose --env-file ../.env run --rm api bootstrap-admin --email <your address>
   ```

## 5. The three sites (Cloudflare Pages, account A)
Create three Pages projects from the GitHub repository:

| Project | Root directory | Build command | Output | Custom domain |
|---|---|---|---|---|
| medlink-admin | `web/admin` | `cd .. && npm ci && npm run build -w admin` | `dist` | `admin.medlink.website` |
| medlink-hospital | `web/hospital` | `cd .. && npm ci && npm run build -w hospital` | `dist` | `app.medlink.website` |
| medlink-booking | `web/booking` | `cd .. && npm ci && npm run build -w booking` | `dist` | `medlink.website` |

- **Environment variables for all three:** `NODE_VERSION=22`, `VITE_API_URL=https://api.medlink.website`.
- **Booking site only:** also `API_ORIGIN=https://api.medlink.website` (for its redirect function in `web/booking/functions/`).
- **Security headers:** each site's `_headers` file (CSP and the others) is applied by Pages automatically.

## 6. Backups
Follow [`backup-restore.md`](backup-restore.md):
- the R2 bucket in account **B**;
- the retention rules, then the lock;
- `ALERT_EMAIL`;
- one manual `backup.sh`.

The cron lines are already installed by `setup-ubuntu.sh`.

## 7. Windows app (optional, deferred: owner's decision)
The hospital web (`app.medlink.website`) is the main tool for staff: the live day board, check-in, corrections, cancellations, and doctors' read-only view. The Windows app is kept for hospitals that need to keep working **during internet outages**. Do this step only when a hospital asks for it.

1. On your Windows PC (with the .NET 8 SDK and the Windows SDK), build and sign:
   ```powershell
   windows\installer\build-msix.ps1 -Version 1.0.0 -Pfx <...>\medlink-signing.pfx -UpdatePublicKey <UPDATE_SIGNING_PUBLIC_KEY> -OutDir <release folder>
   ```
2. **Updates feed:**
   - In account A, create the R2 bucket `medlink-downloads`.
   - Connect the custom domain `downloads.medlink.website` (public read).
   - Publish the release:
     ```
     dotnet run --project windows\MedLink.UpdateTool -- publish <release folder>\MEDLINK-1.0.0.msix 1.0.0 <...>\medlink-update.key <feed folder>
     dotnet run --project windows\MedLink.UpdateTool -- verify <feed folder> <UPDATE_SIGNING_PUBLIC_KEY>
     ```
   - Upload the three files to the bucket under `windows/`: **the `.msix` first, then `update.json` and `update.json.sig`**.
3. Give hospital IT these files, and tell them the certificate thumbprint by phone or in person:
   - `medlink-signing.cer`;
   - `MEDLINK-1.0.0.msix`;
   - `install-medlink.ps1`;
   - [`windows-install.md`](windows-install.md).

## 8. Later updates
- **Server:**
  ```bash
  cd /opt/medlink && git pull --ff-only && cd infra && docker compose --env-file ../.env up -d --build
  curl https://api.medlink.website/health
  ```
  Database changes apply by themselves (the `migrate` service); a backup runs every 6 hours anyway. Before a large update, run `infra/backup/backup.sh` by hand.
- **Sites:** Pages rebuilds by itself on each push.
- **Windows:**
  1. Build a higher version with the same certificate and key, then `publish` and upload as in step 7.
  2. Each PC checks a minute after start and every 6 hours.
  3. It installs the update when MEDLINK is next opened; a banner says so.

  A version signed with another key, or a file that does not match `update.json`, is never installed.

## 9. After deployment, check
- [ ] `https://api.medlink.website/health` answers `ok`.
- [ ] Direct access to the VM's IP on 443 fails (only Cloudflare gets through).
- [ ] Sign-in on admin, app and the booking link.
- [ ] A test booking, then a check-in from the phone scanner and from Windows.
- [ ] `infra/backup/backup.sh` uploads; `restore-test.sh` passes.
- [ ] An alert email arrives: e.g. run `R2_BUCKET=wrong infra/backup/backup.sh`, then wait up to an hour, or run `docker compose restart api`.
- [ ] Every 3 months: open a real backup with your key ([`backup-restore.md`](backup-restore.md)).
