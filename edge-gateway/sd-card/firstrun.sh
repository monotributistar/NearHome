#!/bin/bash
# First Run Script for balenaOS mode
# This script configures the device to connect to openbalena server
# and sets up the edge gateway application
# 
# IMPORTANT: Edit the configuration variables below before copying to SD!

# =============================================
# CONFIGURATION - EDIT THESE VALUES
# =============================================

# OpenBalena Server Configuration
OPENBALENA_API_URL="http://192.168.0.114:3002"
OPENBALENA_VPN_HOST="192.168.0.114"

# Your fleet name (create in openbalena dashboard)
FLEET_NAME="edge-gateways"

# Device name
DEVICE_NAME="rpi4-gateway-001"

# Device Type - Raspberry Pi 4 Model B
DEVICE_TYPE="raspberrypi4-64"

# NearHome API URL (for camera discovery reporting)
NEARHOME_API_URL="http://192.168.0.114:3001"

# WiFi Configuration (optional - leave empty for Ethernet)
WIFI_SSID=""
WIFI_PASSWORD=""

# =============================================

set -e

echo "=========================================="
echo "NearHome Edge Gateway - balenaOS Mode"
echo "=========================================="

# Wait for network
sleep 10

# Get device UUID from hardware
DEVICE_UUID=$(cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2)
MY_IP=$(hostname -I | awk '{print $1}')
echo "Device UUID: $DEVICE_UUID"
echo "Device IP: $MY_IP"
echo ""

# Check if running on balenaOS
if [ -f /etc/balena-version ]; then
    echo "Running on balenaOS"
    BALENA_VERSION=$(cat /etc/balena-version)
    echo "Version: $BALENA_VERSION"
    IS_BALENA=1
else
    echo "NOT running on balenaOS - will install balenaOS"
    IS_BALENA=0
fi

# Mount boot partition
mkdir -p /mnt/boot
mount /dev/mmcblk0p1 /mnt/boot 2>/dev/null || mount /dev/sda1 /mnt/boot 2>/dev/null || true

# Create balenaOS config.json
echo "Creating balenaOS configuration..."
cat > /mnt/boot/config.json <<EOF
{
  "apiEndpoint": "$OPENBALENA_API_URL/",
  "vpnHost": "$OPENBALENA_VPN_HOST",
  "deviceType": "$DEVICE_TYPE",
  "appUpdatePollInterval": 10,
  "supervisorApiPort": 48484,
  "journaldMaxFiles": 5,
  "persistentLogging": false,
  "hostname": "$DEVICE_NAME",
  "country": "US",
  "network": {
    "wifi": {
      "ssid": "$WIFI_SSID",
      "psk": "$WIFI_PASSWORD"
    }
  },
  "environment": {
    "NEARHOME_API_URL": "$NEARHOME_API_URL"
  }
}
EOF

echo "Config file created at /mnt/boot/config.json"
echo ""

# If NOT on balenaOS, instructions to switch
if [ "$IS_BALENA" = "0" ]; then
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
    echo "3. After flashing, copy this config.json to the boot partition"
    echo ""
    echo "4. Boot the Pi - it will automatically connect to openbalena"
    echo ""
fi

echo "=========================================="
echo "Configuration Complete"
echo "=========================================="
echo ""
echo "Device will connect to:"
echo "  - openbalena API: $OPENBALENA_API_URL"
echo "  - NearHome API: $NEARHOME_API_URL"
echo ""
echo "Check openbalena dashboard to see the device connect."
echo ""

# Cleanup
umount /mnt/boot 2>/dev/null || true
rm -f /boot/firstrun.sh 2>/dev/null || true

exit 0