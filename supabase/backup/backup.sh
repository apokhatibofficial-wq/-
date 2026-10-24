#!/usr/bin/env bash
# Encrypted backup of MEDLINK's database on Supabase: pg_dump → age (public key only) → Cloudflare R2. Run every
# 6 hours by GitHub Actions (.github/workflows/backups.yml). Bucket layout (owner's decision: 30 daily + 12 monthly):
#   postgres/daily/    every backup, deleted after 30 days by the R2 lifecycle rule
#   postgres/monthly/  the first backup of each month, deleted after 365 days
# The dump never touches the disk unencrypted. Each object carries its SHA-256, checked after the upload and by
# restore-test.sh. The log shows file names and sizes only.
. "$(dirname "$0")/lib.sh"
need DB_URL BACKUP_AGE_RECIPIENT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

stamp=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rc=$?; rm -rf "$WORK"; report_on_exit $rc backup' EXIT
fail() { FAIL_MESSAGE=$*; echo "$stamp FAILED: $*" >&2; exit 1; }
name="medlink-$stamp.dump.age"

# While the dump streams into age, a copy goes through a pipe (in memory) to pg_restore --list, so the backup is
# refused unless it holds the data of every table (nobody can decrypt it later to check without the offline key).
mkfifo "$WORK/toc.pipe"
pg pg_restore --list < "$WORK/toc.pipe" > "$WORK/toc" & lister=$!
dump_live | tee "$WORK/toc.pipe" | age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/$name" || fail "the database could not be dumped"
wait "$lister" || fail "the dump could not be read back"
tables=$(live_psql -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
data=$(grep -c ' TABLE DATA public ' "$WORK/toc" || true)
[ "$data" = "$tables" ] || fail "the dump has data for $data of $tables tables"
size=$(stat -c %s "$WORK/$name")
[ "$size" -gt 1024 ] || fail "the backup is empty"
sha=$(sha256sum "$WORK/$name" | cut -d' ' -f1)

s3 s3 cp "/work/$name" "s3://$R2_BUCKET/postgres/daily/$name" --metadata "sha256=$sha" --only-show-errors \
  || fail "the upload to R2 failed (bucket $R2_BUCKET): check the R2 keys and the bucket"
check() { # the stored object has the same size and checksum
  local got
  got=$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$1" --query '[ContentLength, Metadata.sha256]' --output text) \
    || fail "$1 cannot be read back from R2"
  [ "$got" = "$size	$sha" ] || fail "$1 does not match after upload ($got)"
}
check "postgres/daily/$name"

month=$(date -u +%Y%m)
have=$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "postgres/monthly/medlink-$month" --query 'length(Contents || `[]`)' --output text)
if [ "$have" = "0" ]; then
  s3 s3 cp "/work/$name" "s3://$R2_BUCKET/postgres/monthly/$name" --metadata "sha256=$sha" --only-show-errors \
    || fail "the upload of this month's copy to R2 failed"
  check "postgres/monthly/$name"
  echo "$stamp backup uploaded ($size bytes, $tables tables), also kept as this month's backup"
  report backup true "$name uploaded ($size bytes), also kept as this month's backup"
else
  echo "$stamp backup uploaded ($size bytes, $tables tables)"
  report backup true "$name uploaded ($size bytes)"
fi
