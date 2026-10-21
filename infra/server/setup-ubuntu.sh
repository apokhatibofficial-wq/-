#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VM (Oracle Cloud Always Free, ARM) for MEDLINK. Run once as root, after copying the
# repository to /opt/medlink:   sudo /opt/medlink/infra/server/setup-ubuntu.sh
# It installs Docker (from Docker's repository) and age, turns on automatic security updates (rebooting at 04:30
# Syria time when an update needs it), allows SSH with keys only, and installs the firewall service, the backup
# cron lines and log rotation. Safe to run again. It does NOT create .env or start MEDLINK (see docs/deployment.md).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
REPO=${REPO:-/opt/medlink}
[ -f "$REPO/infra/docker-compose.yml" ] || { echo "the repository is not at $REPO" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
step() { echo; echo "== $*"; }

step "packages and automatic security updates"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl git age unattended-upgrades cron logrotate
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52medlink-upgrades <<'CONF'
// Security updates install by themselves; when one needs a restart, the VM restarts at 01:30 UTC (04:30 in Syria).
// MEDLINK's containers start again by themselves (restart: unless-stopped); the Windows apps keep working offline.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "01:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF

if [ "${SKIP_DOCKER:-}" != 1 ]; then
  step "Docker (official repository)"
  if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  systemctl enable --now docker
fi

step "SSH: keys only, no root login"
if [ -n "${SUDO_USER:-}" ] && [ -s "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/60-medlink.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
  if [ "${SKIP_SYSTEMD:-}" != 1 ]; then sshd -t && systemctl reload ssh; fi
else
  echo "skipped: ${SUDO_USER:-the user who ran sudo} has no SSH key in authorized_keys, so password login stays on (add a key, then run this again with sudo)"
fi

step "files and permissions"
[ -f "$REPO/.env" ] && chmod 600 "$REPO/.env" && echo ".env is readable by its owner only"
chmod 755 "$REPO"/infra/backup/*.sh "$REPO"/infra/server/*.sh

step "backup cron lines and log rotation"
cat > /etc/cron.d/medlink <<CONF
# MEDLINK backups (docs/backup-restore.md). Results are emailed to ALERT_EMAIL by the API when something fails.
SHELL=/bin/bash
0 */6 * * *  root  $REPO/infra/backup/backup.sh >> /var/log/medlink-backup.log 2>&1
30 4 1 * *   root  $REPO/infra/backup/restore-test.sh >> /var/log/medlink-backup.log 2>&1
CONF
chmod 644 /etc/cron.d/medlink
cat > /etc/logrotate.d/medlink <<'CONF'
/var/log/medlink-backup.log {
  monthly
  rotate 12
  compress
  missingok
  notifempty
}
CONF

if [ "${SKIP_SYSTEMD:-}" != 1 ]; then
  step "firewall: only Cloudflare reaches ports 80/443"
  install -m 644 "$REPO/infra/server/medlink-firewall.service" "$REPO/infra/server/medlink-firewall.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now medlink-firewall.service medlink-firewall.timer
fi

echo; echo "Done. Next: docs/deployment.md, step 4 (.env), then start MEDLINK."
