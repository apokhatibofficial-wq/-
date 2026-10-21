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
psql_owner() { compose exec -T db psql -U "$DB_OWNER_USER" -v ON_ERROR_STOP=1 -At "$@"; }

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
