#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="infra/openbalena/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from ${ENV_FILE}.example and configure values." >&2
  exit 1
fi

extract_env() {
  local key="$1"
  awk -F= -v k="$key" '
    $0 !~ /^#/ && $1 == k {
      sub(/^[[:space:]]+/, "", $2)
      sub(/[[:space:]]+$/, "", $2)
      gsub(/^"|"$/, "", $2)
      print $2
      exit
    }
  ' "$ENV_FILE"
}

API_HOSTNAME="$(extract_env OPENBALENA_API_HOSTNAME || true)"
REGISTRY_HOSTNAME="$(extract_env OPENBALENA_REGISTRY_HOSTNAME || true)"
VPN_HOSTNAME="$(extract_env OPENBALENA_VPN_HOSTNAME || true)"

if [[ -z "$API_HOSTNAME" || -z "$REGISTRY_HOSTNAME" || -z "$VPN_HOSTNAME" ]]; then
  echo "Missing OPENBALENA_*_HOSTNAME variables in $ENV_FILE" >&2
  exit 1
fi

echo "[1/5] docker compose services"
docker compose --env-file "$ENV_FILE" -f infra/openbalena/docker-compose.yml -f infra/openbalena/docker-compose.cloudflare-tunnel.yml ps

echo "[2/5] cloudflared logs (last 30 lines)"
docker compose --env-file "$ENV_FILE" -f infra/openbalena/docker-compose.yml -f infra/openbalena/docker-compose.cloudflare-tunnel.yml logs --tail=30 cloudflared || true

echo "[3/5] API via tunnel: https://${API_HOSTNAME}/health"
curl -fsS "https://${API_HOSTNAME}/health" | sed -n '1,3p'

echo "[4/5] Registry via tunnel: https://${REGISTRY_HOSTNAME}/v2/"
set +e
REGISTRY_CODE="$(curl -s -o /dev/null -w "%{http_code}" "https://${REGISTRY_HOSTNAME}/v2/")"
set -e
echo "registry status: ${REGISTRY_CODE} (200/401 expected)"

if [[ "$REGISTRY_CODE" != "200" && "$REGISTRY_CODE" != "401" ]]; then
  echo "Unexpected registry status code: $REGISTRY_CODE" >&2
  exit 1
fi

echo "[5/5] VPN endpoint DNS check: ${VPN_HOSTNAME}"
getent hosts "$VPN_HOSTNAME" >/dev/null 2>&1 || dscacheutil -q host -a name "$VPN_HOSTNAME" >/dev/null 2>&1 || nslookup "$VPN_HOSTNAME" >/dev/null 2>&1 || {
  echo "Unable to resolve ${VPN_HOSTNAME}" >&2
  exit 1
}

echo "Tunnel verification checks passed."
