#!/usr/bin/env bash
# MEDLINK on a fresh Ubuntu 24.04 VM, in one command (as root). Either:
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/infra/server/install.sh)"
# or, with the repository already in /opt/medlink:
#   sudo /opt/medlink/infra/server/install.sh
# It gets the code, prepares the server (setup-ubuntu.sh), creates .env (the server secrets are generated here and
# never shown; it asks only for your email, the domain and the email-service key), starts MEDLINK, creates the first
# owner account and prints its one-time link. Safe to run again: an existing .env is kept, MEDLINK is rebuilt.
# Answers can also come from the environment (OWNER_EMAIL, DOMAIN, RESEND_API_KEY, BACKUP_AGE_RECIPIENT, R2_*).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
REPO=${REPO:-/opt/medlink}
step() { echo; echo "== $*"; }
ask() { # ask VAR "question" [default] [secret]
  local var=$1 q=$2 def=${3:-} secret=${4:-} val=${!1:-}
  if [ -z "$val" ] && [ -t 0 ]; then
    if [ -n "$secret" ]; then read -r -s -p "$q: " val; echo; else read -r -p "$q${def:+ [$def]}: " val; fi
  fi
  printf -v "$var" '%s' "${val:-$def}"
}

step "1/6 code in $REPO"
if [ ! -f "$REPO/infra/docker-compose.yml" ]; then
  command -v git >/dev/null || { apt-get update -q && apt-get install -y -q git; }
  ask REPO_URL "Repository address (e.g. https://github.com/<owner>/<repo>.git)"
  [ -n "$REPO_URL" ] || { echo "no repository address" >&2; exit 1; }
  # For a private repository git asks for a user name and a read-only access token; nothing is stored.
  git -c credential.helper= clone --depth 1 ${BRANCH:+--branch "$BRANCH"} "$REPO_URL" "$REPO"
else
  echo "found"
fi
cd "$REPO"

if [ "${SKIP_SETUP:-}" != 1 ]; then
  step "2/6 server preparation (Docker, security updates, SSH, firewall, backup schedule)"
  "$REPO/infra/server/setup-ubuntu.sh"
fi

step "3/6 settings (.env)"
setenv() { # setenv KEY VALUE: replaces the KEY= line (any characters in VALUE are safe)
  KEY=$1 VAL=$2 awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' .env > .env.new
  mv .env.new .env
}
if [ -f .env ]; then
  echo ".env exists: kept as it is (edit it with: nano $REPO/.env)"
else
  umask 077
  cp .env.example .env
  ask OWNER_EMAIL "Your email (first owner account and server alerts)"
  case "$OWNER_EMAIL" in *@*.*) ;; *) echo "that is not an email address" >&2; rm -f .env; exit 1 ;; esac
  ask DOMAIN "Domain" "medlink.website"
  ask RESEND_API_KEY "Resend API key (typing is hidden; empty = set it later in .env)" "" secret
  ask BACKUP_AGE_RECIPIENT "Backup public key age1... (from age-keygen on YOUR PC; empty = later)"
  for k in DB_PASSWORD DB_APP_PASSWORD SESSION_SIGNING_KEY TOTP_ENC_KEY; do setenv "$k" "$(openssl rand -base64 48 | tr -d '\n')"; done
  setenv SMTP_HOST smtp.resend.com; setenv SMTP_PORT 465; setenv SMTP_TLS ssl; setenv SMTP_USER resend
  setenv EMAIL_API_KEY "$RESEND_API_KEY"
  setenv EMAIL_FROM "MEDLINK <no-reply@$DOMAIN>"
  setenv ADMIN_WEB_URL "https://admin.$DOMAIN"; setenv HOSPITAL_WEB_URL "https://app.$DOMAIN"
  setenv CORS_ORIGINS "https://admin.$DOMAIN,https://app.$DOMAIN,https://$DOMAIN"
  setenv API_DOMAIN "api.$DOMAIN"; setenv ACME_EMAIL "$OWNER_EMAIL"; setenv ALERT_EMAIL "$OWNER_EMAIL"
  setenv COOKIE_SECURE true
  setenv BACKUP_AGE_RECIPIENT "${BACKUP_AGE_RECIPIENT:-}"
  for k in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do setenv "$k" "${!k:-}"; done
  chmod 600 .env
  echo ".env created (secrets generated on this server, readable by root only)"
fi

step "4/6 build and start MEDLINK"
cd infra
# NO_BUILD=1 uses an API image built beforehand (medlink-api:local) instead of building it here.
build=--build; [ "${NO_BUILD:-}" = 1 ] && build=
docker compose --env-file ../.env up -d $build --quiet-pull 2>&1 | grep -vE '^ *(#|=>)' | tail -n 5
for i in $(seq 90); do
  if docker compose --env-file ../.env exec -T caddy wget -qO- http://api:8080/health 2>/dev/null | grep -q '"ok"'; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || { echo "the API did not start; see: docker compose --env-file ../.env logs api" >&2; exit 1; }
echo "API is running"

step "5/6 first owner account"
email=$(grep -E '^ALERT_EMAIL=' ../.env | cut -d= -f2-)
if out=$(docker compose --env-file ../.env run --rm -T api bootstrap-admin --email "$email" 2>&1); then
  echo "$out" | grep -vE '^ *Container' || true
  echo "(The link works once, for 30 minutes, after the sites are online. It is shown only here, never logged.)"
elif echo "$out" | grep -q 'already exists'; then
  echo "an owner account exists already"
else
  echo "$out" >&2; exit 1
fi

step "6/6 what is left"
grep -qE '^EMAIL_API_KEY=.+' ../.env || echo "- Put your Resend API key in $REPO/.env (EMAIL_API_KEY), then run this script again."
grep -qE '^R2_BUCKET=.+' ../.env && grep -qE '^BACKUP_AGE_RECIPIENT=age1' ../.env \
  || echo "- Backups are not configured yet: until they are, the 6-hourly backup fails and you get an alert email. See docs/backup-restore.md."
cat <<TEXT
- Cloudflare DNS: an A record "api" -> this server's public IP (from the Oracle console), proxied (orange cloud);
  SSL/TLS "Full", and "Always Use HTTPS" off, until https://$(grep -E '^API_DOMAIN=' ../.env | cut -d= -f2-)/health answers; then "Full (strict)".
- GitHub: add the secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; the three sites then publish themselves.
TEXT
