#!/bin/bash
set -euo pipefail

WG_CONF="/etc/wireguard/wg0.conf"
WG_ADDRESS="${WG_ADDRESS:-10.0.0.1/24}"
WG_LISTEN_PORT="${WG_LISTEN_PORT:-51820}"
WG_PRIVATE_KEY_FILE="${WG_PRIVATE_KEY_FILE:-/etc/wireguard/private.key}"

if [[ ! -f "$WG_PRIVATE_KEY_FILE" ]]; then
  echo "Missing WireGuard private key: $WG_PRIVATE_KEY_FILE" >&2
  echo "Create it securely with: umask 077; wg genkey | sudo tee $WG_PRIVATE_KEY_FILE >/dev/null" >&2
  exit 1
fi

WG_PRIVATE_KEY="$(sudo cat "$WG_PRIVATE_KEY_FILE")"
sudo install -d -m 700 "$(dirname "$WG_CONF")"
sudo tee "$WG_CONF" >/dev/null <<WGE
[Interface]
Address = $WG_ADDRESS
ListenPort = $WG_LISTEN_PORT
PrivateKey = $WG_PRIVATE_KEY

# RPi-A (tenant-oficinas) — agregar cuando esté lista
# [Peer]
# PublicKey = <rpi-a-pub>
# AllowedIPs = 10.0.1.0/24
# Endpoint = rpi-a.dyndns.org:51820
# PersistentKeepalive = 25

# RPi-B (tenant-logistica)
# [Peer]
# PublicKey = <rpi-b-pub>
# AllowedIPs = 10.0.2.0/24
# Endpoint = rpi-b.dyndns.org:51820
# PersistentKeepalive = 25
WGE
sudo chmod 600 "$WG_CONF"

echo "WG_CONFIG_OK"

sudo systemctl enable wg-quick@wg0 2>&1 | tail -2
sudo systemctl start wg-quick@wg0 2>&1 | tail -2

echo "=== WG STATUS ==="
sudo wg show
