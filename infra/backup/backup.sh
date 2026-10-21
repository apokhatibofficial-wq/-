#!/usr/bin/env bash
# Encrypted PostgreSQL backup: pg_dump → age (public key only) → Cloudflare R2. Run every 6 hours from cron:
#   0 */6 * * *  /opt/medlink/infra/backup/backup.sh >> /var/log/medlink-backup.log 2>&1
# Layout in the bucket (owner's decision: 30 daily + 12 monthly):
#   postgres/daily/    every backup, deleted after 30 days by the R2 lifecycle rule (r2-lifecycle.sh)
#   postgres/monthly/  the first backup of each month, deleted after 365 days
# The dump never touches the disk unencrypted. Each object carries its SHA-256, checked after the upload and by
# restore-test.sh. Needs: docker and age.
. "$(dirname "$0")/lib.sh"
need BACKUP_AGE_RECIPIENT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

stamp=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
name="medlink-$stamp.dump.age"

compose exec -T db pg_dump -U "$DB_OWNER_USER" -d "$DB_NAME" -Fc | age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/$name"
size=$(stat -c %s "$WORK/$name")
[ "$size" -gt 1024 ] || { echo "$stamp FAILED: backup is empty" >&2; exit 1; }
sha=$(sha256sum "$WORK/$name" | cut -d' ' -f1)

s3 s3 cp "/work/$name" "s3://$R2_BUCKET/postgres/daily/$name" --metadata "sha256=$sha" --only-show-errors
check() { # the stored object has the same size and checksum
  local got
  got=$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$1" --query '[ContentLength, Metadata.sha256]' --output text)
  [ "$got" = "$size	$sha" ] || { echo "$stamp FAILED: $1 does not match after upload ($got)" >&2; exit 1; }
}
check "postgres/daily/$name"

month=$(date -u +%Y%m)
have=$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "postgres/monthly/medlink-$month" --query 'length(Contents || `[]`)' --output text)
if [ "$have" = "0" ]; then
  s3 s3 cp "/work/$name" "s3://$R2_BUCKET/postgres/monthly/$name" --metadata "sha256=$sha" --only-show-errors
  check "postgres/monthly/$name"
  echo "$stamp backup uploaded ($size bytes), also kept as this month's backup"
else
  echo "$stamp backup uploaded ($size bytes)"
fi
