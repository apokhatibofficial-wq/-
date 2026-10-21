# Phase 12 report: installer, documentation, deployment

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done. This was the last planned phase; next is the first real deployment, with the owner.

Real test results: [`test-results.md`](test-results.md) (Phase 12 section). Screenshots: [`screenshots/phase-12/`](screenshots/phase-12/).

## Owner decisions applied
| Decision | Where |
|---|---|
| 1. Fonts from MEDLINK's own sites | IBM Plex (SIL OFL) is bundled with the three sites. No request goes to Google, and the CSP no longer allows Google. |
| 2. Lock backups against deletion | R2 bucket lock, 30 days on `postgres/`, in the setup steps of [`backup-restore.md`](backup-restore.md). |
| 3. Email alerts | The API emails `ALERT_EMAIL` (your address only) once per failed backup or monthly test, and once a day while no backup has succeeded for 8 hours. |
| 4. Option (c): self-signed certificate | `windows/installer/new-signing-cert.ps1` (you make it once, on your PC, and keep the `.pfx` offline); hospital IT installs the `.cer` with `install-medlink.ps1`. |

## What was built
**Windows installer and updates:**
- **The package:**
  - an MSIX that includes .NET, so hospital PCs need nothing else installed;
  - Windows 10 version 2004 or later, or Windows 11;
  - signed with KHATIB's own certificate.
- **The icons:** the `.exe` icon and the tile images are rendered from the original logo file, which is unchanged.
- **Updates:**
  - `update.json` is signed with your offline Ed25519 key (`medlink-update publish`).
  - The app takes only a **newer** version whose signature verifies with the public key built into it.
  - It then checks the file's size and SHA-256.
  - Windows checks the package certificate too, and installs the update the next time MEDLINK opens. A banner says so, with "Close to update".
- **Proved on Windows in CI on every push:**
  1. Version 0.9.0 is installed with the IT script.
  2. A feed signed with another key is **refused**, and the version stays 0.9.0.
  3. A correctly signed 0.9.1 is downloaded and verified.
  4. After reopening, the running app is 0.9.1.
  5. The installed, updated app then passes all 34 window checks.

**Server:**
- `infra/server/firewall-cloudflare.sh` (+ systemd service and timer):
  - only Cloudflare's addresses reach ports 80/443;
  - the rules go in Docker's own chain, because Docker bypasses `ufw`.

  This matters because the API takes the client IP from Cloudflare's header for its rate limits.
- `infra/server/setup-ubuntu.sh` prepares a fresh Ubuntu 24.04 VM:
  - Docker and age;
  - automatic security updates, restarting at 04:30 Syria time if needed;
  - SSH with keys only (only when a key is in place, so nobody is locked out);
  - backup cron lines, log rotation and the firewall.
- **Production rehearsal** with the real production compose file:
  - HTTPS with HSTS, and HTTP redirects to HTTPS;
  - the API and the database cannot be reached from outside;
  - a request body over 1 MB is refused;
  - the API container is read-only and runs without privileges;
  - the sign-in limit counts each client IP separately;
  - `bootstrap-admin` refuses to run a second time.

**Guides:**
- [`deployment.md`](deployment.md): the whole procedure — keys, Oracle VM, `.env`, DNS/HTTPS, Pages, backups, Windows release, later updates, final checklist.
- [`windows-install.md`](windows-install.md): for hospital IT.
- `README.md` and `windows/README.md` updated.

## Found and fixed in this phase
1. **`.env` values ignored:** `docker-compose.yml` did not pass the rate limits, `JOBS_ENABLED` or the new `ALERT_EMAIL` to the API, so changing them in `.env` did nothing. It now passes them.
2. **Fonts blocked as `data:` URLs:** the CSP blocked the very small font files that Vite inlines, so they did not load. Vite no longer inlines fonts (0 CSP reports now).
3. **`setup-ubuntu.sh` run as root without `sudo`:** it stopped halfway (an unset variable). Fixed, and tested both ways.
4. **The first firewall test proved nothing:** Docker's local proxy bypassed the rule. It was redone through the same forwarding path that internet traffic takes: blocked → allowed → blocked again.
5. **The installer test expected Windows to apply an update immediately.** Windows applies it when the app next opens, as the banner says, so the test now reopens the app.

## Decisions I made (please confirm or correct)
1. **Where updates are downloaded from:** an R2 bucket `medlink-downloads` with the address `downloads.medlink.website`, in the website's Cloudflare account (free). The MSIX is about 80 MB, too large for Pages.
2. **Minimum Windows version:** Windows 10 version 2004 (needed for the silent update). Supported Windows 10 (22H2) and Windows 11 are fine.
3. **Updates install at the next start, not immediately,** so nobody loses what is on screen. "Close to update" closes the app; unsent check-ins are kept.

## Known limits
- **Not done on real accounts:** Oracle, Cloudflare (DNS, Pages, R2), Resend. I cannot reach them from here. The steps are written; the first deployment should be done together.
- **Not tested on a real hospital PC or real phones.** Windows was tested on GitHub's Windows Server; the manual checklists are in the Phase 8 and 9 reports.
- **The first HTTPS certificate:** Caddy gets it through Cloudflare. That is the documented order: "Full" first, then "Full (strict)", with "Always Use HTTPS" off.

## For the first deployment, you will need
- the domain on Cloudflare;
- two Cloudflare accounts (website and backups);
- an Oracle Cloud account;
- a Resend account;
- a Windows PC with the .NET 8 SDK and the Windows SDK, to make the keys and build the installer.

Then we follow [`deployment.md`](deployment.md) step by step.
