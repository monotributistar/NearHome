#!/usr/bin/env bash
set -euo pipefail

CLIENT_ID="${CLIENT_ID:-}"
SITE_ID="${SITE_ID:-}"
EDGE_PUBLIC_KEY="${EDGE_PUBLIC_KEY:-}"
OVERLAY_IP="${OVERLAY_IP:-}"
CAMERA_SUBNET_CIDR="${CAMERA_SUBNET_CIDR:-}"

if [[ -z "$CLIENT_ID" || -z "$SITE_ID" || -z "$EDGE_PUBLIC_KEY" || -z "$OVERLAY_IP" || -z "$CAMERA_SUBNET_CIDR" ]]; then
  echo "Usage: CLIENT_ID=acme SITE_ID=plant1 EDGE_PUBLIC_KEY=... OVERLAY_IP=10.88.1.1 CAMERA_SUBNET_CIDR=192.168.10.0/24 $0" >&2
  exit 1
fi

echo "# Peer ${CLIENT_ID}-${SITE_ID}"
echo "[Peer]"
echo "PublicKey = ${EDGE_PUBLIC_KEY}"
echo "AllowedIPs = ${OVERLAY_IP}/32, ${CAMERA_SUBNET_CIDR}"
echo "PersistentKeepalive = 25"
