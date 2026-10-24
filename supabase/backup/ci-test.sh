#!/usr/bin/env bash
# The whole Supabase backup cycle on throw-away containers, run by CI on every push: a local PostgreSQL stands in for
# Supabase, a local S3 mock for R2; the age key pair and all passwords are made for the run and deleted after it.
#   migrate + some data → backup ×2 → monthly restore test → a failed backup is recorded → restore with the private
#   key (same rows) → disaster: recover into a new empty database (same rows)
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$dir/../.." && pwd)
DENO=${DENO:-deno}
S3MOCK_IMAGE=${S3MOCK_IMAGE:-adobe/s3mock:3.12.0}
tmp=$(mktemp -d)
step() { echo; echo "== $*"; }
fail() { echo "BACKUP CYCLE FAILED: $*" >&2; exit 1; }
cleanup() { docker rm -f medlink-live medlink-new medlink-s3mock >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

start_pg() { # name → connection string of a fresh PostgreSQL 17
  local pw; pw=$(openssl rand -hex 24)
  docker run -d --name "$1" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pw" "${PG_IMAGE:-postgres:17-alpine}" >/dev/null
  local port; port=$(docker port "$1" 5432/tcp | head -n 1 | sed 's/.*://')
  printf 'postgresql://postgres:%s@127.0.0.1:%s/postgres' "$pw" "$port"
}

age-keygen -o "$tmp/key.txt" 2>/dev/null
chmod 600 "$tmp/key.txt"
export BACKUP_AGE_RECIPIENT; BACKUP_AGE_RECIPIENT=$(grep -o 'age1[0-9a-z]*' "$tmp/key.txt" | head -n 1)
export R2_BUCKET=medlink-backups R2_ENDPOINT=http://127.0.0.1:9090 R2_ACCESS_KEY_ID; R2_ACCESS_KEY_ID=$(openssl rand -hex 16)
export R2_SECRET_ACCESS_KEY; R2_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
export DB_URL; DB_URL=$(start_pg medlink-live)
. "$dir/lib.sh"

step "the live database: migrations and some data"
docker run -d --name medlink-s3mock -p 127.0.0.1:9090:9090 -e initialBuckets=medlink-backups "$S3MOCK_IMAGE" >/dev/null
for _ in $(seq 60); do live_psql -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
DB_OWNER_URL=$DB_URL DB_APP_PASSWORD=$(openssl rand -hex 24) "$DENO" run -A "$repo/supabase/scripts/migrate.ts" | tail -n 1
live_psql -c "SELECT medlink_bootstrap_admin('owner@ci.invalid')" >/dev/null   # the link is not kept
live_psql -c "SELECT 'users ' || count(*) FROM users"
for _ in $(seq 60); do curl -sf -o /dev/null http://127.0.0.1:9090/medlink-backups && break; sleep 1; done

step "backup twice: the first is also this month's copy"
"$dir/backup.sh"; "$dir/backup.sh"
WORK=$tmp s3 s3 ls --recursive s3://medlink-backups/

step "monthly restore test (no private key)"
"$dir/restore-test.sh"
[ "$(live_psql -c "SELECT string_agg(name || '=' || ok, ' ' ORDER BY name) FROM ops_checks")" = "backup=true restore_test=true" ] \
  || fail "the results were not recorded"
echo "results recorded: backup ok, restore test ok"

step "a failed backup is recorded for the alert email"
if R2_BUCKET=no-such-bucket "$dir/backup.sh" >/dev/null 2>&1; then fail "a backup to a missing bucket succeeded"; fi
live_psql -c "SELECT ok, message FROM ops_checks WHERE name = 'backup'"
[ "$(live_psql -c "SELECT ok FROM ops_checks WHERE name = 'backup'")" = "f" ] || fail "the failure was not recorded"
"$dir/backup.sh" >/dev/null

step "the owner's check: restore with the private key, same rows as the live database"
live_psql -c "$COUNT_SQL" > "$tmp/live"
"$dir/restore.sh" latest "$tmp/key.txt" | grep -E '^[a-z_]+ [0-9]+$' > "$tmp/restored"
diff "$tmp/live" "$tmp/restored" || fail "the restored database differs from the live one"
echo "identical ($(wc -l < "$tmp/live") tables)"
wrong=$tmp/wrong-key.txt; age-keygen -o "$wrong" 2>/dev/null
if "$dir/restore.sh" latest "$wrong" >/dev/null 2>&1; then fail "a wrong key restored something"; fi
echo "a wrong key is refused"

step "disaster: recover into a new, empty database"
new=$(start_pg medlink-new)
for _ in $(seq 60); do psql_url "$new" -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
DB_URL=$new "$dir/recover.sh" latest "$tmp/key.txt" | grep -E '^[a-z_]+ [0-9]+$' > "$tmp/recovered"
diff "$tmp/live" "$tmp/recovered" || fail "the recovered database differs"
echo "identical after recovery"
out=$(DB_URL=$new "$dir/recover.sh" latest "$tmp/key.txt" 2>&1 || true)
grep -q 'only restores into an empty project' <<<"$out" || fail "recover.sh did not refuse a database that has tables"
echo "refuses a database that already has tables"
# The recovered database works with the migrations (nothing new to apply) and the API's role.
DB_OWNER_URL=$new DB_APP_PASSWORD=$(openssl rand -hex 24) "$DENO" run -A "$repo/supabase/scripts/migrate.ts" | tail -n 1
echo; echo "SUPABASE BACKUP CYCLE PASSED"
