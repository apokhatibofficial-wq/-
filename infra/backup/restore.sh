#!/usr/bin/env bash
# Decrypts a backup with the offline private key and restores it into a NEW database (never over the live one),
# then prints its row counts. For the owner's manual check and for looking at old data.
#   ./restore.sh <backup.dump.age | latest | R2 key> <age private key file> [target-db-name]
# "latest" or an R2 key (e.g. postgres/monthly/medlink-20261101T000000Z.dump.age) downloads it from R2 first.
. "$(dirname "$0")/lib.sh"
src=${1:?backup file, "latest" or R2 key}; keyfile=${2:?age private key file}; target=${3:-medlink_restore_$(date -u +%Y%m%d)}
[ "$target" != "$DB_NAME" ] || { echo "refusing to restore over the live database $DB_NAME" >&2; exit 1; }
[ -r "$keyfile" ] || { echo "cannot read the key file $keyfile" >&2; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

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

# The roles are per server; on a new server the app role must exist before its grants are restored.
psql_owner -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medlink_app') THEN
  CREATE ROLE medlink_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END \$\$" >/dev/null
psql_owner -d postgres -c "CREATE DATABASE $target" >/dev/null
# A wrong key or a damaged file leaves nothing behind.
trap 'rm -rf "$WORK"; [ "${done:-}" = 1 ] || psql_owner -d postgres -c "DROP DATABASE IF EXISTS $target" >/dev/null 2>&1 || true' EXIT
age -d -i "$keyfile" "$file" | compose exec -T db pg_restore -U "$DB_OWNER_USER" -d "$target" --exit-on-error
done=1
echo "restored into $target. Row counts:"
psql_owner -d "$target" -c "$COUNT_SQL"
echo "Drop it when done: docker compose exec db dropdb -U $DB_OWNER_USER $target"
