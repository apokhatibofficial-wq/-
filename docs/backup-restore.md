# Backup and restore (MEDLINK)

The procedure for the owner and for whoever runs the server. Every script described here was run for real in Phase 11, and the whole cycle runs in CI on every push (job `backups`); see [`test-results.md`](test-results.md).

## What is protected, and how
| | |
|---|---|
| What | The whole PostgreSQL database: hospitals, accounts, bookings, attendance, form versions, audit log. |
| How often | Every 6 hours (at most 6 hours of data can be lost). |
| Where | Cloudflare R2, in a **separate Cloudflare account** from the website. |
| Kept | Every backup for 30 days (`postgres/daily/`), plus the first backup of each month for 12 months (`postgres/monthly/`). |
| Encryption | `age`, with a public key on the server. **The private key never touches the server.** A stolen backup or R2 account reveals nothing. |
| Checks | Each backup must contain the data of every table before it is uploaded. Its SHA-256 is stored with it and checked after upload. A monthly automatic test (below) checks the rest. |

**Not in the backup, and needed to recover:** the `.env` file.
- Keep a copy offline with the private key.
- Without the same `TOTP_ENC_KEY`, every 2FA enrolment must be redone.
- Without the same `SESSION_SIGNING_KEY`, everyone signs in again (harmless).

## One-time setup
1. **Key pair, on your own PC (never on the server):**
   - Run `age-keygen -o medlink-backup-key.txt`.
   - Copy the line `# public key: age1…` into `.env` as `BACKUP_AGE_RECIPIENT`.
   - Keep `medlink-backup-key.txt` in two safe offline places (e.g. two USB sticks), together with a copy of `.env`. **If this key is lost, the backups can never be read.**
2. **R2:**
   - In a second Cloudflare account, create the bucket (e.g. `medlink-backups`).
   - Create an R2 API token limited to that bucket ("Object Read & Write").
   - Put `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in `.env`.
3. **Retention rules, on the empty bucket, before the first backup (and before the lock in step 4):** run `infra/backup/r2-lifecycle.sh`. If the token is not allowed to set rules, add them in the dashboard (R2 › bucket › Settings › Object lifecycle rules):
   - prefix `postgres/daily/`: delete after 30 days;
   - prefix `postgres/monthly/`: delete after 365 days.
4. **Lock against deletion (owner's decision, Phase 12):** in the dashboard, R2 › bucket › Settings › **Bucket lock rules** › Add rule:
   - name `medlink-30d`;
   - prefix `postgres/`;
   - retain for **30 days**.

   Nobody can delete or overwrite a backup during its first 30 days, not even with the server's key, so someone who took over the server cannot erase recent backups. Afterwards the lifecycle rules delete as planned (daily at 30 days, monthly at 365). Only the Cloudflare account owner can change the lock, from the dashboard. Keep that account's password and 2FA away from the server.
5. **Server:** install `age` (`sudo apt install age`). The S3 tool runs in Docker, so nothing else is needed. Then add the cron lines (`crontab -e` for the user that runs Docker):
   ```
   0 */6 * * *  /opt/medlink/infra/backup/backup.sh       >> /var/log/medlink-backup.log 2>&1
   30 4 1 * *   /opt/medlink/infra/backup/restore-test.sh >> /var/log/medlink-backup.log 2>&1
   ```
6. Put your address in `.env` as `ALERT_EMAIL` (see "Alerts" below).
7. Run `infra/backup/backup.sh` once by hand. It must print `backup uploaded (…), also kept as this month's backup`.

## The monthly automatic test (`restore-test.sh`)
It runs on the server without the private key and checks:
1. **A fresh copy of the database restores:** into a throw-away database, with every table's row count matching the live one.
2. **The stored backups are fresh and intact:**
   - the newest backup is less than 7 hours old (so the 6-hourly cron is running);
   - it is an `age` file;
   - its content still matches the checksum recorded at upload;
   - this month's monthly copy exists.

It prints `RESTORE TEST PASSED`, or `RESTORE TEST FAILED: <reason>` with a non-zero exit.

## Alerts (owner's decision, Phase 12)
Both scripts record their result in the database (`ops_checks`). Every hour, the API emails `ALERT_EMAIL` (your address only) when:
- a backup or the monthly test **failed**: one email per failure, with the reason (e.g. `the upload to R2 failed (bucket …)`);
- **no backup has succeeded for 8 hours** (the cron stopped, the server was off, or the database could not be written): one email a day while it lasts;
- no monthly test has succeeded for 35 days.

The emails are in Arabic and English, carry no personal data, and say where to look (`/var/log/medlink-backup.log`). Without `ALERT_EMAIL`, the alerts are only written to the API log.

## Every 3 months: the owner opens a real backup (about 10 minutes)
This is the only check that uses the private key, so it is done by hand on a machine you trust:
1. On the server (or a copy of it), put the private key in a temporary file readable only by you.
2. Run `infra/backup/restore.sh latest /path/to/medlink-backup-key.txt`. It:
   - downloads the newest backup;
   - decrypts it;
   - restores it into a **new** database named `medlink_restore_<date>`;
   - prints the row counts.

   It refuses to touch the live database, and a wrong key leaves nothing behind.
3. Check that the counts look right (number of hospitals, bookings), then:
   - drop the copy with `docker compose exec db dropdb -U medlink_owner medlink_restore_<date>`;
   - delete the key file (`shred -u`).

To look at older data, pass an R2 key instead of `latest`, e.g. `postgres/monthly/medlink-20261101T000000Z.dump.age`. A local file works too.

## Disaster: the server is lost
Tested in Phase 11 by deleting the whole stack and its data volumes. The recovery took 13 seconds, gave identical row counts, and signed-in users were still signed in.
1. Create a new VM as in the deployment guide (Docker; firewall open only to Cloudflare), and install `age`.
2. Copy the repository to `/opt/medlink`, and put the **original** `.env` back (`chmod 600`).
3. Build the API image: `cd infra && docker compose --env-file ../.env build`.
4. Run `infra/backup/recover.sh latest /path/to/medlink-backup-key.txt`. It:
   - starts PostgreSQL;
   - refuses to continue if the database is not empty;
   - restores into a side database first, then makes it the live one;
   - runs the migrations;
   - starts the API and prints the row counts.
5. Start everything (`docker compose --env-file ../.env up -d`). Point Cloudflare DNS at the new VM if its address changed. Delete the key file.
6. Re-add the cron lines (setup step 5).

The Windows apps keep their unsent check-ins and send them once the API is back. Check-ins made after the last backup and already sent are lost, unless a PC still holds them.

## Remaining risks
- **Backups older than 30 days are not locked.** Someone who took over the server could delete the older monthly copies (the 30 most recent days are locked).
- **The private key is the single point of failure for reading backups.** Keep two offline copies.
- **One region, one provider (Cloudflare R2)** for the backups.
