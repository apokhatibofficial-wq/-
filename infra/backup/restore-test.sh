#!/usr/bin/env bash
# Monthly automatic restore test (owner's decision), run from cron on the server:
#   30 4 1 * *  /opt/medlink/infra/backup/restore-test.sh >> /var/log/medlink-backup.log 2>&1
# The age private key stays offline, so the server cannot decrypt its own backups. This test proves the rest:
#  1. A fresh dump restores cleanly into a throw-away database, and every table has the same row count as the
#     live one (between the counts taken just before and just after the dump, since the system keeps working).
#  2. The newest backup in R2 is less than 7 hours old, is an age file, and still matches the SHA-256 recorded at
#     upload; this month's monthly copy exists.
# Decrypting a stored backup with the offline key is the owner's manual check (restore.sh, see docs/backup-restore.md).
. "$(dirname "$0")/lib.sh"
need R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
WORK=$(mktemp -d)
target=medlink_restore_test
cleanup() { local rc=$?; psql_owner -d postgres -c "DROP DATABASE IF EXISTS $target" >/dev/null 2>&1 || true; rm -rf "$WORK"; report_on_exit $rc restore_test; }
trap cleanup EXIT
fail() { FAIL_MESSAGE=$*; echo "RESTORE TEST FAILED: $*" >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)

# ---- 1. a fresh dump restores, with every table complete
psql_owner -d postgres -c "DROP DATABASE IF EXISTS $target" >/dev/null
psql_owner -d postgres -c "CREATE DATABASE $target" >/dev/null
psql_owner -d "$DB_NAME" -c "$COUNT_SQL" > "$WORK/before"
compose exec -T db pg_dump -U "$DB_OWNER_USER" -d "$DB_NAME" -Fc \
  | compose exec -T db pg_restore -U "$DB_OWNER_USER" -d "$target" --exit-on-error
psql_owner -d "$DB_NAME" -c "$COUNT_SQL" > "$WORK/after"
psql_owner -d "$target" -c "$COUNT_SQL" > "$WORK/restored"
[ "$(cut -d' ' -f1 "$WORK/restored")" = "$(cut -d' ' -f1 "$WORK/before")" ] || fail "the restored database has different tables"
tables=$(wc -l < "$WORK/restored")
bad=$(paste -d' ' "$WORK/before" "$WORK/after" "$WORK/restored" | awk '{
  lo = $2 < $4 ? $2 : $4; hi = $2 < $4 ? $4 : $2
  if ($6 < lo || $6 > hi) print $1 " live " $2 "-" $4 " restored " $6 }')
[ -z "$bad" ] || fail "row counts differ: $bad"
rows=$(awk '{ s += $2 } END { print s }' "$WORK/restored")
echo "$stamp restore test: fresh dump restored, $tables tables, $rows rows, counts match"

# ---- 2. the stored backups are recent and intact
latest=$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix postgres/daily/ \
  --query 'sort_by(Contents || `[]`, &LastModified)[-1].[Key, LastModified]' --output text)
key=${latest%%	*}; when=${latest#*	}
[ -n "$key" ] && [ "$key" != "None" ] || fail "no backup in R2 under postgres/daily/"
age_h=$(( ( $(date -u +%s) - $(date -u -d "$when" +%s) ) / 3600 ))
[ "$age_h" -lt "${BACKUP_MAX_AGE_HOURS:-7}" ] || fail "the newest backup is $age_h hours old ($key): is the backup cron running?"
s3 s3 cp "s3://$R2_BUCKET/$key" /work/latest.age --only-show-errors
recorded=$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$key" --query 'Metadata.sha256' --output text)
actual=$(sha256sum "$WORK/latest.age" | cut -d' ' -f1)
[ "$recorded" = "$actual" ] || fail "$key does not match its recorded checksum"
[ "$(head -c 21 "$WORK/latest.age")" = "age-encryption.org/v1" ] || fail "$key is not an age-encrypted file"
monthly=$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "postgres/monthly/medlink-$(date -u +%Y%m)" --query 'length(Contents || `[]`)' --output text)
[ "$monthly" != "0" ] || fail "no monthly backup for $(date -u +%Y-%m)"
echo "$stamp restore test: newest backup $key is ${age_h}h old, $(stat -c %s "$WORK/latest.age") bytes, checksum OK; monthly copy present"
echo "$stamp RESTORE TEST PASSED"
report restore_test true "fresh dump restored ($tables tables, $rows rows); newest backup ${age_h}h old, checksum OK"
