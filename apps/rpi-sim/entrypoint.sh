#!/bin/bash
set -euo pipefail

TENANT_ID="${TENANT_ID:-tenant-simulado}"
RPI_ID="${RPI_ID:-rpi-sim-1}"
LOCAL_SUBNET="${LOCAL_SUBNET:-10.99.1.0/24}"
LOCAL_RTSP_CAMERAS="${LOCAL_RTSP_CAMERAS:-[]}"
WG_HUB_PUBLIC_KEY="${WG_HUB_PUBLIC_KEY:-}"
WG_HUB_ENDPOINT="${WG_HUB_ENDPOINT:-192.168.0.156:51820}"
API_BASE_URL="${API_BASE_URL:-http://192.168.0.115:3001}"
HEADSCALE_URL="${HEADSCALE_URL:-}"
HEADSCALE_AUTH_KEY="${HEADSCALE_AUTH_KEY:-}"
WG_STATE_DIR="${WG_STATE_DIR:-/var/lib/nearhome}"

echo "=== RPi Simulado: $RPI_ID (tenant: $TENANT_ID) ==="

# ─── 1. Configurar WireGuard ────────────────────────────────────────
mkdir -p "$WG_STATE_DIR"
chmod 700 "$WG_STATE_DIR"
if [[ ! -s "$WG_STATE_DIR/wireguard.key" ]]; then
  umask 077
  wg genkey > "$WG_STATE_DIR/wireguard.key"
fi
WG_PRIVATE_KEY=$(cat "$WG_STATE_DIR/wireguard.key")
WG_PUBLIC_KEY=$(echo "$WG_PRIVATE_KEY" | wg pubkey)

cat > /etc/wireguard/wg0.conf <<WGCONF
[Interface]
Address = 10.200.1.1/24
ListenPort = 51820
PrivateKey = ${WG_PRIVATE_KEY}

[Peer]
PublicKey = ${WG_HUB_PUBLIC_KEY}
AllowedIPs = 10.0.0.0/8
Endpoint = ${WG_HUB_ENDPOINT}
PersistentKeepalive = 25
WGCONF

echo "RPi PublicKey: $WG_PUBLIC_KEY"
if [[ -n "$WG_HUB_PUBLIC_KEY" && -n "$WG_HUB_ENDPOINT" ]]; then
  echo "Iniciando WireGuard hacia $WG_HUB_ENDPOINT..."
  wg-quick up wg0
  sleep 2
  wg show
else
  echo "WireGuard deshabilitado: faltan WG_HUB_PUBLIC_KEY/WG_HUB_ENDPOINT"
fi

# ─── 2. Discovery Agent: escanear cámaras y reportar ────────────────
report_cameras() {
  local cameras='[]'

  # Parsear LOCAL_RTSP_CAMERAS (JSON array)
  local urls=$(echo "$LOCAL_RTSP_CAMERAS" | jq -r '.[]' 2>/dev/null || echo "")

  if [ -z "$urls" ]; then
    # Auto-detect: escanear puerto 554 en la red local
    for ip in $(seq 1 20); do
      local host="10.99.1.$ip"
      if timeout 2 bash -c "echo > /dev/tcp/$host/554" 2>/dev/null; then
        urls="$urls rtsp://$host:554/test"
      fi
    done
  fi

  for url in $urls; do
    cameras=$(echo "$cameras" | jq \
      --arg url "$url" \
      --arg status "online" \
      '. + [{"id": ($url | split("/") | last), "rtspUrl": $url, "status": $status, "tenantId": "'$TENANT_ID'"}]')
  done

  echo "Cámaras detectadas: $(echo "$cameras" | jq length)"

  # Reportar via API
  if [ -n "$API_BASE_URL" ]; then
    curl -s -X POST "$API_BASE_URL/api/edge/cameras/sync" \
      -H "Content-Type: application/json" \
      -H "X-Tenant-Id: $TENANT_ID" \
      -d "{\"tenantId\": \"$TENANT_ID\", \"cameras\": $cameras}" \
      2>/dev/null || echo "API no disponible"
  fi
}

# ─── 3. Health Keeper ───────────────────────────────────────────────
report_health() {
  local wireguard_peers=0
  if ip link show wg0 >/dev/null 2>&1; then
    wireguard_peers=$(wg show wg0 peers 2>/dev/null | sed '/^$/d' | wc -l | tr -d ' ')
  fi
  local report=$(cat <<EOF
{
  "rpiId": "$RPI_ID",
  "tenantId": "$TENANT_ID",
  "cpu": $(cat /proc/loadavg | cut -d' ' -f1),
  "uptime": $(cat /proc/uptime | cut -d' ' -f1 | cut -d. -f1),
  "wireguard": $wireguard_peers,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
  if [ -n "$API_BASE_URL" ]; then
    curl -s -X POST "$API_BASE_URL/api/edge/health" \
      -H "Content-Type: application/json" \
      -H "X-Tenant-Id: $TENANT_ID" \
      -d "$report" 2>/dev/null || true
  fi
  echo "[$(date +%H:%M:%S)] Health: CPU=$(echo "$report" | jq .cpu) WG=$(echo "$report" | jq .wireguard)"
}

# ─── Loop principal ─────────────────────────────────────────────────
echo "=== Iniciando monitoreo ==="

# Reporte inicial
report_cameras

while true; do
  report_health
  sleep 30
done
