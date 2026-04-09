#!/bin/bash
# First Run Script for balenaOS mode
# This script configures the device to connect to openbalena server
# and pulls the edge gateway application

# =============================================
# CONFIGURATION - EDIT THESE VALUES
# =============================================

# OpenBalena Server Configuration
# Replace with your openbalena server IP/domain
OPENBALENA_API_URL="http://192.168.1.100:3000"
OPENBALENA_VPN_HOST="192.168.1.100"

# Your fleet name (create in openbalena dashboard)
FLEET_NAME="edge-gateways"

# Device name
DEVICE_NAME="rpi3b-gateway-001"

# Optional: Provisioning API key (from openbalena)
PROVISIONING_KEY=""

# WiFi Configuration (optional)
WIFI_SSID=""
WIFI_PASSWORD=""

# =============================================

set -e

echo "=========================================="
echo "NearHome Edge Gateway - balenaOS Mode"
echo "=========================================="

# Wait for network
sleep 5

# Check if running on balenaOS
if [ -f /etc/balena-version ]; then
    echo "Detected balenaOS"
    BALENA_VERSION=$(cat /etc/balena-version)
    echo "Version: $BALENA_VERSION"
else
    echo "WARNING: Not running on balenaOS"
    echo "This script is designed for balenaOS"
fi

# Get device UUID
DEVICE_UUID=$(cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2)
echo "Device UUID: $DEVICE_UUID"

# Configure openbalena connection
echo "Configuring openbalena connection..."

# Create openbalena config file
mkdir -p /mnt/boot
if [ -f /mnt/boot/config.json ]; then
    echo "Updating existing config.json..."
    
    # Backup original
    cp /mnt/boot/config.json /mnt/boot/config.json.bak
fi

# Create config.json for balenaOS to connect to openbalena
cat > /mnt/boot/config.json <<EOF
{
  "apiEndpoint": "$OPENBALENA_API_URL/",
  "vpnHost": "$OPENBALENA_VPN_HOST",
  "deviceType": "raspberrypi3",
  "appUpdatePollInterval": 10,
  "supervisorApiPort": 48484,
  "journaldMaxFiles": 5,
  "persistentLogging": false,
  "hostname": "$DEVICE_NAME",
  "country": "US",
  "sshKeys": [],
  "network": {
    "wifi": {
      "ssid": "$WIFI_SSID",
      "psk": "$WIFI_PASSWORD"
    }
  }
}
EOF

echo "Config file created at /mnt/boot/config.json"

# If not on balenaOS, offer to switch
if [ ! -f /etc/balena-version ]; then
    echo ""
    echo "=========================================="
    echo "IMPORTANT: Switch to balenaOS first!"
    echo "=========================================="
    echo ""
    echo "To use balenaOS, you need to reflash your SD card with balenaOS."
    echo ""
    echo "1. Download balenaOS for Raspberry Pi 3:"
    echo "   https://www.balena.io/os/"
    echo ""
    echo "2. Flash with balenaEtcher"
    echo ""
    echo "3. Copy this config.json to the boot partition"
    echo ""
    echo "Then this device will register with your openbalena server."
fi

echo ""
echo "=========================================="
echo "Configuration Complete"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. If not on balenaOS, reflash with balenaOS"
echo "2. Device will boot and connect to openbalena"
echo "3. Check openbalena dashboard for new device"
echo "4. Push application: balena push $FLEET_NAME"
echo ""

exit 0