#!/usr/bin/env bash
# The owner's check, on their own computer (Docker and age): decrypts a backup with the offline private key and
# restores it into a local, throw-away PostgreSQL, then prints the row counts. Supabase is not touched.
#   R2_...=... ./restore.sh <backup.dump.age | latest | R2 key> <age private key file> [keep]
# With "keep", the local database stays running for a look (its address is printed); remove it with
#   docker rm -f medlink-restore-check
. "$(dirname "$0")/lib.sh"
src=${1:?backup file, "latest" or R2 key}; keyfile=${2:?age private key file}; keep=${3:-}
[ -r "$keyfile" ] || { echo "cannot read the key file $keyfile" >&2; exit 1; }
WORK=$(mktemp -d)
name=medlink-restore-check
trap 'rm -rf "$WORK"; [ "$keep" = keep ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

if [ -f "$src" ]; then
  file=$src
else
  need R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  if [ "$src" = latest ]; then
    src=$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix postgres/daily/ --query 'sort_by(Contents || `[]`, &LastModified)[-1].Key' --output text)
  fi
  s3 s3 cp "s3://$R2_BUCKET/$src" /work/backup.age --only-show-errors
  file=$WORK/backup.age
  echo "downloaded $src"
fi
target=$(EXT_SCHEMA=${EXT_SCHEMA:-public} scratch_db "$name")
# A wrong key or a damaged file stops here.
age -d -i "$keyfile" "$file" | restore_into "$target"
echo "restored. Row counts:"
psql_url "$target" -c "$COUNT_SQL"
[ "$keep" != keep ] || echo "kept running: $target"
