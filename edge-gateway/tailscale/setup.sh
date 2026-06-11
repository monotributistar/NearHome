#!/usr/bin/env bash
# =============================================================================
# NearHome Edge Gateway — Tailscale + RTSP Bridge Setup (F1.5)
# =============================================================================
# Alternativa ligera a openBalena para POC. Usa Tailscale como VPN mesh
# y systemd para el bridge RTSP, evitando Docker y arquitectura ARM64.
#
# Ejecutar en la Raspberry Pi (RPi OS / Ubuntu):
#   curl -sSL https://... | bash
#   o
#   bash edge-gateway/tailscale/setup.sh
#
# Requisitos:
#   - Raspberry Pi 3B+ o 4 con conexión a internet
#   - Tailscale account (free tier alcanza para POC)
#   - Cámaras RTSP accesibles en la LAN local del RPi
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[edge]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

# ─── Config ──────────────────────────────────────────────────────────────

NEARHOME_HOST="${NEARHOME_HOST:-}"           # IP Tailscale del host NearHome
RTSP_CAMERAS="${RTSP_CAMERAS:-}"             # "192.168.1.101:554,192.168.1.102:554"
BRIDGE_PORT_START="${BRIDGE_PORT_START:-18554}"

# ─── Install Tailscale ───────────────────────────────────────────────────

install_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    log "Tailscale already installed: $(tailscale version | head -1)"
    return 0
  fi

  log "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
  log "Tailscale installed. Run: sudo tailscale up"
}

# ─── Install socat (RTSP bridge) ─────────────────────────────────────────

install_socat() {
  if command -v socat >/dev/null 2>&1; then
    log "socat already installed"
    return 0
  fi

  log "Installing socat..."
  sudo apt-get update -qq && sudo apt-get install -y -qq socat
}

# ─── Create RTSP bridge systemd services ──────────────────────────────────

create_bridge_services() {
  if [[ -z "$RTSP_CAMERAS" ]]; then
    warn "RTSP_CAMERAS not set. Skipping bridge services."
    warn "Set it: RTSP_CAMERAS=\"192.168.1.101:554,192.168.1.102:554\""
    return 0
  fi

  log "Creating RTSP bridge services..."
  local port=$BRIDGE_PORT_START

  IFS=',' read -ra CAMS <<< "$RTSP_CAMERAS"
  for cam in "${CAMS[@]}"; do
    cam=$(echo "$cam" | xargs)  # trim
    local name="rtsp-bridge-${port}"
    local service_file="/etc/systemd/system/${name}.service"

    log "  Bridge: $cam → :$port (service: $name)"

    sudo tee "$service_file" > /dev/null <<EOF
[Unit]
Description=NearHome RTSP Bridge :$port → $cam
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:${port},fork,reuseaddr TCP:${cam}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$name"
    sudo systemctl start "$name"

    port=$((port + 1))
  done
}

# ─── Firewall rules ──────────────────────────────────────────────────────

setup_firewall() {
  log "Configuring firewall (default deny, allow RTSP + Tailscale)..."
  
  # Only configure if ufw is available
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw not found, skipping firewall"
    return 0
  fi

  sudo ufw --force reset >/dev/null 2>&1 || true
  sudo ufw default deny incoming >/dev/null
  sudo ufw default allow outgoing >/dev/null
  
  # Allow Tailscale
  sudo ufw allow in on tailscale0 >/dev/null 2>&1 || true
  
  # Allow SSH on local network
  sudo ufw allow from 192.168.0.0/16 to any port 22 >/dev/null 2>&1 || true
  
  sudo ufw --force enable >/dev/null
  log "Firewall configured: deny incoming, allow Tailscale + local SSH"
}

# ─── Status check ────────────────────────────────────────────────────────

show_status() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  NearHome Edge Gateway — Status"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "Tailscale IP: $(tailscale ip -4 2>/dev/null || echo 'not connected')"
  echo "Tailscale status: $(tailscale status 2>/dev/null | head -1 || echo 'run: sudo tailscale up')"
  echo ""
  
  if [[ -n "$RTSP_CAMERAS" ]]; then
    echo "RTSP Bridges:"
    local port=$BRIDGE_PORT_START
    IFS=',' read -ra CAMS <<< "$RTSP_CAMERAS"
    for cam in "${CAMS[@]}"; do
      cam=$(echo "$cam" | xargs)
      local status="stopped"
      systemctl is-active --quiet "rtsp-bridge-${port}" 2>/dev/null && status="running"
      echo "  :$port → $cam [$status]"
      port=$((port + 1))
    done
  fi
  
  if [[ -n "$NEARHOME_HOST" ]]; then
    echo ""
    echo "NearHome connectivity:"
    echo "  ping $NEARHOME_HOST: $(ping -c1 -W2 $NEARHOME_HOST >/dev/null 2>&1 && echo 'OK' || echo 'unreachable')"
  fi
}

# ─── Usage ────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: NEARHOME_HOST=<tailscale-ip> RTSP_CAMERAS=<ip:port,...> bash setup.sh [command]"
  echo ""
  echo "Commands:"
  echo "  install   Full setup: Tailscale + socat + bridges + firewall"
  echo "  status    Show current edge gateway status"
  echo "  start     Start all RTSP bridges"
  echo "  stop      Stop all RTSP bridges"
  echo ""
  echo "Environment:"
  echo "  NEARHOME_HOST       Tailscale IP of the NearHome server"
  echo "  RTSP_CAMERAS        Comma-separated camera IPs (e.g. 192.168.1.101:554,192.168.1.102:554)"
  echo "  BRIDGE_PORT_START   Starting port for bridges (default: 18554)"
  echo ""
  echo "Example:"
  echo "  NEARHOME_HOST=100.64.0.5 RTSP_CAMERAS=\"192.168.1.10:554,192.168.1.11:554\" bash setup.sh install"
  exit 0
}

# ─── Main ─────────────────────────────────────────────────────────────────

CMD="${1:-install}"

case "$CMD" in
  install)
    install_tailscale
    install_socat
    create_bridge_services
    setup_firewall
    show_status
    ;;
  status)
    show_status
    ;;
  start)
    local port=$BRIDGE_PORT_START
    IFS=',' read -ra CAMS <<< "${RTSP_CAMERAS:-}"
    for cam in "${CAMS[@]}"; do
      sudo systemctl start "rtsp-bridge-${port}" 2>/dev/null || true
      port=$((port + 1))
    done
    log "All bridges started"
    ;;
  stop)
    local port=$BRIDGE_PORT_START
    IFS=',' read -ra CAMS <<< "${RTSP_CAMERAS:-}"
    for cam in "${CAMS[@]}"; do
      sudo systemctl stop "rtsp-bridge-${port}" 2>/dev/null || true
      port=$((port + 1))
    done
    log "All bridges stopped"
    ;;
  *)
    usage
    ;;
esac
