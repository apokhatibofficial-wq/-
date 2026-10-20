#!/usr/bin/env bash
# Restore an encrypted backup into a NEW database (never over the live one), then check it.
#   ./restore.sh <backup.dump.age> <path-to-age-private-key> [target-db-name]
# Use this for the monthly restore test, on a machine that holds the offline private key.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ../.env; set +a
backup=${1:?backup file}; key=${2:?age private key file}; target=${3:-medlink_restore_$(date -u +%Y%m%d)}
owner=${DB_OWNER_USER:-medlink_owner}

docker compose exec -T db createdb -U "$owner" "$target"
age -d -i "$key" "$backup" | docker compose exec -T db pg_restore -U "$owner" -d "$target" --no-owner --exit-on-error

echo "restored into $target. Row counts:"
docker compose exec -T db psql -U "$owner" -d "$target" -At -c \
  "SELECT 'hospitals', count(*) FROM hospitals UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'audit_log', count(*) FROM audit_log UNION ALL SELECT 'migrations', count(*) FROM schema_migrations"
echo "Drop it when done: docker compose exec db dropdb -U $owner $target"
