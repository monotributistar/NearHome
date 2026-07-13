#!/bin/bash
# Agrega un peer WireGuard al Home Hub
set -euo pipefail

PUBKEY="${1:?Uso: $0 <public-key> <nombre> <subnet>}"
NOMBRE="${2:?Uso: $0 <public-key> <nombre> <subnet>}"
SUBNET="${3:-10.99.1.0/24}"

echo "Agregando peer $NOMBRE ($PUBKEY) con subnet $SUBNET..."
sudo wg set wg0 peer "$PUBKEY" allowed-ips "$SUBNET"
sudo wg show
echo "✅ Peer $NOMBRE agregado"
