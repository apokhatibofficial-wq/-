# Shared helpers for the backup scripts (sourced, not run).
set -euo pipefail
BACKUP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INFRA_DIR=$(dirname "$BACKUP_DIR")
ENV_FILE=${ENV_FILE:-$INFRA_DIR/../.env}
AWS_CLI_IMAGE=${AWS_CLI_IMAGE:-amazon/aws-cli:2.22.35}
[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE" >&2; exit 1; }

# Reads KEY=VALUE from .env without running it as a script (values may hold spaces, < or >, e.g. EMAIL_FROM).
# A variable already set in the environment wins.
env_get() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}; line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}
for k in DB_OWNER_USER DB_NAME BACKUP_AGE_RECIPIENT R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT; do
  [ -n "${!k:-}" ] || printf -v "$k" '%s' "$(env_get "$k")"
done
DB_OWNER_USER=${DB_OWNER_USER:-medlink_owner}
DB_NAME=${DB_NAME:-medlink}
R2_ENDPOINT=${R2_ENDPOINT:-https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com}

need() { local k; for k in "$@"; do [ -n "${!k:-}" ] || { echo "$k is not set in $ENV_FILE" >&2; exit 1; }; done; }

# docker compose for this stack. COMPOSE_ARGS adds files, e.g. "-f docker-compose.yml -f docker-compose.dev.yml".
compose() { (cd "$INFRA_DIR" && docker compose ${COMPOSE_ARGS:-} --env-file "$ENV_FILE" "$@"); }
psql_owner() { compose exec -T -e PGOPTIONS=--client-min-messages=warning db psql -U "$DB_OWNER_USER" -v ON_ERROR_STOP=1 -At "$@"; }

# The AWS CLI (R2 speaks the S3 API) in a container, so the server needs only Docker. The keys are passed through
# the environment, never on a command line. $WORK is mounted at /work for uploads and downloads.
s3() {
  AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
    docker run --rm -i --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION=auto \
      -v "${WORK:-/tmp}:/work" "$AWS_CLI_IMAGE" --endpoint-url "$R2_ENDPOINT" "$@"
}

# Row counts of every table, one "table count" per line, sorted (the owner role is not limited by row-level security).
COUNT_SQL="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

# Records a check's result (backup | restore_test) in the database. The API emails the owner (ALERT_EMAIL) about a
# failure, or when no run has succeeded for too long. The message is technical, never personal data.
report() {
  local name=$1 ok=$2 message=$3
  psql_owner -d "$DB_NAME" -v name="$name" -v ok="$ok" -v msg="${message:0:500}" >/dev/null <<'SQL' || echo "could not record the result in the database" >&2
UPDATE ops_checks SET ok = :'ok'::boolean, message = :'msg', at = now(),
  last_ok_at = CASE WHEN :'ok'::boolean THEN now() ELSE last_ok_at END
WHERE name = :'name';
SQL
}
# Run on exit: a failure that stopped the script (set -e) is reported too, with FAIL_MESSAGE when one was set.
report_on_exit() {
  local rc=$1 name=$2
  [ "$rc" -eq 0 ] || report "$name" false "${FAIL_MESSAGE:-$(basename "$0") stopped with exit code $rc; see /var/log/medlink-backup.log}"
}
