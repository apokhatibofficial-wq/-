#!/usr/bin/env bash
# Disaster recovery: restores a backup into a NEW, empty Supabase project (or any empty PostgreSQL), as its owner.
#   DB_URL=<new project's owner connection string> R2_...=... ./recover.sh <backup | latest | R2 key> <age private key file>
# Then run the "Deploy API" workflow against the new project (it sets the API's database password and the
# scheduler). Use the ORIGINAL function secrets (same TOTP_ENC_KEY, or every 2FA enrolment must be redone).
# It refuses to run if the target already has MEDLINK tables. Full steps: docs/backup-restore.md.
. "$(dirname "$0")/lib.sh"
need DB_URL
src=${1:?backup file, "latest" or R2 key}; keyfile=${2:?age private key file}
[ -r "$keyfile" ] || { echo "cannot read the key file $keyfile" >&2; exit 1; }
tables=$(live_psql -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
[ "$tables" = "0" ] || { echo "the target already has $tables tables in public: recover.sh only restores into an empty project" >&2; exit 1; }
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
# The API's role and the two extensions must exist before the tables that use them.
live_psql -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS btree_gist;
  DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medlink_app') THEN
    CREATE ROLE medlink_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END \$\$" >/dev/null
# One transaction: a wrong key or a damaged file leaves the project empty.
age -d -i "$keyfile" "$file" | restore_into "$DB_URL"
echo "restored. Row counts:"
live_psql -c "$COUNT_SQL"
echo "Next: run the Deploy API workflow for this project (docs/backup-restore.md)."
