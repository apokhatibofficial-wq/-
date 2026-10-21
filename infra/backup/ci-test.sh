#!/usr/bin/env bash
# The whole backup cycle on a throw-away stack, run by CI on every push: a local S3 mock stands in for R2, and the
# age key pair and all secrets are generated for the run and deleted after it. Never run it on the server.
#   backup ×2 → monthly restore test → restore with the private key → disaster (all volumes deleted) → recover
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$dir/../.." && pwd)
S3MOCK_IMAGE=${S3MOCK_IMAGE:-adobe/s3mock:3.12.0}
tmp=$(mktemp -d)
export ENV_FILE=$tmp/ci.env COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.dev.yml"
step() { echo; echo "== $*"; }
fail() { echo "BACKUP CYCLE FAILED: $*" >&2; exit 1; }

age-keygen -o "$tmp/key.txt" 2>/dev/null
pub=$(grep -o 'age1[0-9a-z]*' "$tmp/key.txt" | head -n 1)
sed -E -e "s#^(DB_PASSWORD|DB_APP_PASSWORD|SESSION_SIGNING_KEY|TOTP_ENC_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)=.*#\1=RANDOM#" \
  -e "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=$pub|" -e "s|^R2_BUCKET=.*|R2_BUCKET=medlink-backups|" "$repo/.env.example" \
  | while IFS= read -r line; do [ "${line#*=}" = RANDOM ] && line="${line%%=*}=$(openssl rand -hex 32)"; printf '%s\n' "$line"; done > "$ENV_FILE"
echo "R2_ENDPOINT=http://127.0.0.1:9090" >> "$ENV_FILE"
chmod 600 "$ENV_FILE" "$tmp/key.txt"
. "$dir/lib.sh"
cleanup() { compose down -v >/dev/null 2>&1 || true; docker rm -f medlink-s3mock >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

step "start the stack and the S3 mock"
docker run -d --name medlink-s3mock -p 127.0.0.1:9090:9090 -e initialBuckets=medlink-backups "$S3MOCK_IMAGE" >/dev/null
compose up -d --wait api mailpit >/dev/null 2>&1
for _ in $(seq 60); do curl -sf -o /dev/null http://127.0.0.1:9090/medlink-backups && break; sleep 1; done
compose run --rm -T api bootstrap-admin --email owner@ci.invalid >/dev/null 2>&1   # some data (the link is not kept)
psql_owner -d "$DB_NAME" -c "SELECT 'users', count(*) FROM users"

step "lifecycle rules (set once on the empty bucket)"
"$dir/r2-lifecycle.sh" | grep -c '"Days"'

step "backup twice: the first is also this month's copy"
"$dir/backup.sh"; "$dir/backup.sh"
WORK=$tmp s3 s3 ls --recursive s3://medlink-backups/

step "monthly restore test (no private key)"
"$dir/restore-test.sh"
[ "$(psql_owner -d "$DB_NAME" -c "SELECT string_agg(name || '=' || ok, ' ' ORDER BY name) FROM ops_checks")" = "backup=true restore_test=true" ] \
  || fail "the results were not recorded"
echo "results recorded: backup ok, restore test ok"

step "a failed backup is recorded and the owner gets an email"
if R2_BUCKET=no-such-bucket "$dir/backup.sh" >/dev/null 2>&1; then fail "a backup to a missing bucket succeeded"; fi
psql_owner -d "$DB_NAME" -c "SELECT ok, message FROM ops_checks WHERE name = 'backup'"
compose restart api >/dev/null 2>&1   # the alert job runs at start, then hourly
mail=""
for _ in $(seq 60); do
  mail=$(curl -sf "http://127.0.0.1:8025/api/v1/search?query=subject:%22backup%20failed%22" | grep -o '"Subject":"[^"]*"' | head -n 1 || true)
  [ -n "$mail" ] && break; sleep 1
done
[ -n "$mail" ] || fail "no alert email"
echo "alert email: $mail"
"$dir/backup.sh" >/dev/null   # a good backup again for the steps below

step "restore with the private key into a new database: same rows as the live one"
psql_owner -d "$DB_NAME" -c "$COUNT_SQL" > "$tmp/live"
"$dir/restore.sh" latest "$tmp/key.txt" medlink_check | grep -E '^[a-z_]+ [0-9]+$' > "$tmp/restored"
diff "$tmp/live" "$tmp/restored" || fail "the restored database differs from the live one"
echo "identical ($(wc -l < "$tmp/live") tables)"
out=$("$dir/restore.sh" latest "$tmp/key.txt" "$DB_NAME" 2>&1 || true)
grep -q 'refusing' <<<"$out" || fail "restore.sh did not refuse the live database"
echo "refuses to restore over the live database"

step "disaster: the whole stack and its volumes are deleted, then recovered from R2"
compose down -v >/dev/null 2>&1
"$dir/recover.sh" latest "$tmp/key.txt" 2>/dev/null | grep -E '^[a-z_]+ [0-9]+$' | grep -v '^job_runs ' > "$tmp/recovered"
grep -v '^job_runs ' "$tmp/live" | diff - "$tmp/recovered" || fail "the recovered database differs"
echo "identical after recovery"
curl -sf http://127.0.0.1:8080/health || fail "the API is not healthy after recovery"
echo
echo; echo "BACKUP CYCLE PASSED"
