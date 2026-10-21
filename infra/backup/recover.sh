#!/usr/bin/env bash
# Disaster recovery on a NEW server: restores a backup as the live database, then starts MEDLINK.
#   ./recover.sh <backup.dump.age | latest | R2 key> <age private key file>
# Before: install Docker and age, copy the repository, and put back the ORIGINAL .env (same TOTP_ENC_KEY, or
# every 2FA enrolment must be redone; same SESSION_SIGNING_KEY). Full steps: docs/backup-restore.md.
# It refuses to run if the live database already has tables.
. "$(dirname "$0")/lib.sh"
src=${1:?backup file, "latest" or R2 key}; keyfile=${2:?age private key file}
[ -r "$keyfile" ] || { echo "cannot read the key file $keyfile" >&2; exit 1; }

compose up -d --wait db
tables=$(psql_owner -d "$DB_NAME" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
[ "$tables" = "0" ] || { echo "the database $DB_NAME already has $tables tables: recover.sh only restores into an empty one" >&2; exit 1; }

# Restore into a side database first, so a bad file never leaves a half-filled live database.
staging=medlink_recover_$(date -u +%Y%m%d%H%M%S)
"$BACKUP_DIR/restore.sh" "$src" "$keyfile" "$staging" >/dev/null
psql_owner -d postgres -c "DROP DATABASE $DB_NAME" >/dev/null
psql_owner -d postgres -c "ALTER DATABASE $staging RENAME TO $DB_NAME" >/dev/null
echo "restored into $DB_NAME"

# migrate sets the app role's password from .env and applies any newer migrations; then the API starts.
compose up -d --wait api
psql_owner -d "$DB_NAME" -c "$COUNT_SQL"
echo "MEDLINK is running on the restored data."
