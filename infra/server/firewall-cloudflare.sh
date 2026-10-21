#!/usr/bin/env bash
# Only Cloudflare may reach the published web ports (80/443). Run as root after Docker starts (medlink-firewall.service
# does that at boot and refreshes Cloudflare's list daily).
# Why here: Docker publishes ports with its own iptables rules, which bypass ufw. Rules in Docker's DOCKER-USER chain
# are honoured. This matters because the API trusts the client IP in CF-Connecting-IP (rate limits): a request that
# does not come through Cloudflare could forge it. The Oracle cloud firewall (security list) should say the same.
#   EXT_IF   the internet-facing interface (default: the one with the default route)
#   PORTS    ports to protect, as the container sees them (default 80,443)
#   EXTRA_ALLOW  additional source ranges (space-separated), e.g. for a test
set -euo pipefail
default_if() {
  if command -v ip >/dev/null; then ip route show default | awk '{print $5; exit}'
  else awk '$2 == "00000000" { print $1; exit }' /proc/net/route; fi
}
EXT_IF=${EXT_IF:-$(default_if)}
PORTS=${PORTS:-80,443}
CACHE=${CACHE:-/etc/medlink}
[ -n "$EXT_IF" ] || { echo "cannot find the internet-facing interface; set EXT_IF" >&2; exit 1; }
mkdir -p "$CACHE"

# Cloudflare's published ranges; the last good copy is kept, so a failed download never opens or closes the ports.
fetch() {
  local url=$1 file=$2 tmp
  tmp=$(mktemp)
  if curl -sf --max-time 20 "$url" -o "$tmp" && grep -Eq '^[0-9a-f:.]+/[0-9]+$' "$tmp"; then
    grep -E '^[0-9a-f:.]+/[0-9]+$' "$tmp" > "$file"
  fi
  rm -f "$tmp"
  [ -s "$file" ] || { echo "no Cloudflare ranges in $file and the download failed: nothing changed" >&2; exit 1; }
}
fetch https://www.cloudflare.com/ips-v4 "$CACHE/cloudflare-ips-v4"
fetch https://www.cloudflare.com/ips-v6 "$CACHE/cloudflare-ips-v6"

apply() {
  local ipt=$1 list=$2 extra=$3
  $ipt -L DOCKER-USER -n >/dev/null 2>&1 || { echo "$ipt: no DOCKER-USER chain (is Docker running?)" >&2; return 1; }
  $ipt -N MEDLINK-CF 2>/dev/null || $ipt -F MEDLINK-CF
  for c in $(cat "$list") $extra; do $ipt -A MEDLINK-CF -s "$c" -j RETURN; done
  $ipt -A MEDLINK-CF -j DROP
  local rule=(-i "$EXT_IF" -p tcp -m multiport --dports "$PORTS" -m conntrack --ctstate NEW -j MEDLINK-CF)
  $ipt -C DOCKER-USER "${rule[@]}" 2>/dev/null || $ipt -I DOCKER-USER "${rule[@]}"
  echo "$ipt: ports $PORTS on $EXT_IF accept only $(wc -l < "$list") Cloudflare ranges${extra:+ (+ $extra)}"
}
v4extra=""; v6extra=""
for r in ${EXTRA_ALLOW:-}; do case $r in *:*) v6extra+=" $r" ;; *) v4extra+=" $r" ;; esac; done
apply iptables "$CACHE/cloudflare-ips-v4" "${v4extra# }"
if command -v ip6tables >/dev/null && ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
  apply ip6tables "$CACHE/cloudflare-ips-v6" "${v6extra# }"
fi
