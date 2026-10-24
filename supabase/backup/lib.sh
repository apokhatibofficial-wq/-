# Shared helpers for the Supabase backup scripts (sourced, not run). Everything comes from the environment (GitHub
# Actions secrets); nothing is read from or written to the repository. Needs Docker and age.
#   DB_URL                the database owner's connection string (Supabase "session pooler", port 5432)
#   BACKUP_AGE_RECIPIENT  the age PUBLIC key (the private key stays offline with the owner)
#   R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY  (R2_ENDPOINT overrides the address, for tests)
set -euo pipefail
BACKUP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PG_IMAGE=${PG_IMAGE:-postgres:17-alpine}
AWS_CLI_IMAGE=${AWS_CLI_IMAGE:-amazon/aws-cli:2.22.35}
R2_ENDPOINT=${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com}

need() { local k; for k in "$@"; do [ -n "${!k:-}" ] || { echo "$k is not set" >&2; exit 1; }; done; }

# PostgreSQL 17 client tools in a container (pg_dump must not be older than the server). The connection string
# travels in the environment, never on a command line.
pg() { PGURL=${PGURL:-$DB_URL} docker run --rm -i --network host -e PGURL -e PGOPTIONS=--client-min-messages=warning "$PG_IMAGE" "$@"; }
psql_url() { local url=$1; shift; PGURL=$url pg sh -c 'exec psql "$PGURL" -v ON_ERROR_STOP=1 -At "$@"' psql "$@"; }
live_psql() { psql_url "$DB_URL" "$@"; }

# Only MEDLINK's schema: Supabase's own schemas (auth, storage, …) are not ours to back up. Owners are left out
# (the restoring account becomes the owner); grants to medlink_app are kept.
dump_live() { PGURL=$DB_URL pg sh -c 'exec pg_dump "$PGURL" -Fc -n public --no-owner'; }

# Restores a custom-format dump from stdin into the database at $1, in one transaction (a damaged file leaves nothing).
# The dump recreates schema "public", which every PostgreSQL already has: that one statement is skipped.
restore_into() {
  PGURL=$1 pg sh -c 'pg_restore --no-owner -f - | grep -vx "CREATE SCHEMA public;" | psql "$PGURL" -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null'
}

# The AWS CLI (R2 speaks the S3 API) in a container. Keys go through the environment. $WORK is mounted at /work.
s3() {
  AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
    docker run --rm -i --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION=auto \
      -v "${WORK:-/tmp}:/work" "$AWS_CLI_IMAGE" --endpoint-url "$R2_ENDPOINT" "$@"
}

# Row counts of every MEDLINK table, "table count" per line, sorted.
COUNT_SQL="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

# A throw-away local PostgreSQL to restore into (the monthly test, the owner's check). Prints its connection string.
# It gets the role and extensions MEDLINK's dump expects: citext and btree_gist, in the schema they live in on Supabase.
scratch_db() {
  local name=$1 pw ext_schema
  pw=$(openssl rand -hex 24)
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pw" "$PG_IMAGE" >/dev/null
  local port; port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')
  local url="postgresql://postgres:$pw@127.0.0.1:$port/postgres"
  for _ in $(seq 60); do psql_url "$url" -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
  ext_schema=${EXT_SCHEMA:-public}
  psql_url "$url" -c "CREATE SCHEMA IF NOT EXISTS $ext_schema; CREATE EXTENSION IF NOT EXISTS citext SCHEMA $ext_schema;
    CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA $ext_schema;
    DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medlink_app') THEN
      CREATE ROLE medlink_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END \$\$" >/dev/null
  printf '%s' "$url"
}

# The schema the extensions live in on the live database (Supabase may put them in "extensions").
ext_schema_of_live() { live_psql -c "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'citext'"; }

# Records a check's result (backup | restore_test) in the database. The API emails the owner (ALERT_EMAIL) about a
# failure, or when no run has succeeded for too long. The message is technical, never personal data.
report() {
  local name=$1 ok=$2 message=${3:0:500}
  live_psql -v name="$name" -v ok="$ok" -v msg="$message" >/dev/null <<'SQL' || echo "could not record the result in the database" >&2
UPDATE ops_checks SET ok = :'ok'::boolean, message = :'msg', at = now(),
  last_ok_at = CASE WHEN :'ok'::boolean THEN now() ELSE last_ok_at END
WHERE name = :'name';
SQL
}
report_on_exit() {
  local rc=$1 name=$2
  [ "$rc" -eq 0 ] || report "$name" false "${FAIL_MESSAGE:-$(basename "$0") stopped with exit code $rc; see the Backups run in GitHub Actions}"
}
