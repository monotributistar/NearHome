#!/usr/bin/env bash
set -euo pipefail

WG_INTERFACE="${WG_INTERFACE:-wg0}"
WG_CONFIG_PATH="${WG_CONFIG_PATH:-/etc/wireguard/wg0.conf}"
CAMERA_SUBNET_CIDR="${CAMERA_SUBNET_CIDR:-192.168.10.0/24}"
INFRA_ALLOWED_CIDRS="${INFRA_ALLOWED_CIDRS:-10.88.0.0/16}"
CAMERA_IFACE="${CAMERA_IFACE:-eth0}"
ROUTING_MODE="${ROUTING_MODE:-route}" # route|snat

if [[ ! -f "$WG_CONFIG_PATH" ]]; then
  echo "Missing WireGuard config at $WG_CONFIG_PATH" >&2
  exit 1
fi

# Enable forwarding for camera LAN routing.
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Bring up WireGuard interface.
wg-quick down "$WG_INTERFACE" >/dev/null 2>&1 || true
wg-quick up "$WG_INTERFACE"

# Baseline FORWARD policy (idempotent).
iptables -P FORWARD DROP
iptables -F FORWARD

# Keep existing established connections.
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow infra -> camera subnet only for RTSP.
IFS=',' read -r -a CIDR_LIST <<< "$INFRA_ALLOWED_CIDRS"
for cidr in "${CIDR_LIST[@]}"; do
  value="$(echo "$cidr" | xargs)"
  [[ -n "$value" ]] || continue
  iptables -A FORWARD -s "$value" -d "$CAMERA_SUBNET_CIDR" -p tcp --dport 554 -j ACCEPT
  iptables -A FORWARD -s "$value" -d "$CAMERA_SUBNET_CIDR" -p tcp --dport 8554 -j ACCEPT
  iptables -A FORWARD -s "$value" -d "$CAMERA_SUBNET_CIDR" -p udp --dport 554 -j ACCEPT
  iptables -A FORWARD -s "$value" -d "$CAMERA_SUBNET_CIDR" -p udp --dport 8554 -j ACCEPT
done

# Fallback mode when camera return-route cannot be configured.
if [[ "$ROUTING_MODE" == "snat" ]]; then
  iptables -t nat -C POSTROUTING -o "$CAMERA_IFACE" -s 10.88.0.0/16 -d "$CAMERA_SUBNET_CIDR" -j MASQUERADE >/dev/null 2>&1 \
    || iptables -t nat -A POSTROUTING -o "$CAMERA_IFACE" -s 10.88.0.0/16 -d "$CAMERA_SUBNET_CIDR" -j MASQUERADE
fi

echo "wireguard-router ready"
echo "- interface: $WG_INTERFACE"
echo "- routing mode: $ROUTING_MODE"
echo "- camera subnet: $CAMERA_SUBNET_CIDR"
echo "- infra cidrs: $INFRA_ALLOWED_CIDRS"

# Keep container alive and print peer status periodically.
while true; do
  wg show "$WG_INTERFACE" || true
  sleep 30
done
