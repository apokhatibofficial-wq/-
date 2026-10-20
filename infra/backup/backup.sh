#!/usr/bin/env bash
# Encrypted PostgreSQL backup: pg_dump → age (public key) → Cloudflare R2. Run every 6 hours from cron:
#   0 */6 * * *  /opt/medlink/infra/backup/backup.sh >> /var/log/medlink-backup.log 2>&1
# The dump is never written to disk unencrypted. Needs: docker, age, and the aws CLI (for R2 upload).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ../.env; set +a

: "${BACKUP_AGE_RECIPIENT:?}" "${R2_ACCOUNT_ID:?}" "${R2_BUCKET:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
file="$out/medlink-$stamp.dump.age"

docker compose exec -T db pg_dump -U "${DB_OWNER_USER:-medlink_owner}" -d "${DB_NAME:-medlink}" -Fc \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$file"

[ -s "$file" ] || { echo "backup is empty" >&2; exit 1; }

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
  aws s3 cp "$file" "s3://$R2_BUCKET/postgres/" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" --only-show-errors

echo "$stamp backup uploaded ($(stat -c %s "$file") bytes)"
# Retention (35 days) is an R2 lifecycle rule on the bucket: delete objects under postgres/ after 35 days.
