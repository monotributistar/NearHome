#!/bin/bash
# Raspberry Pi 3B+ First Boot Setup Script
# This script runs on first boot to install Docker and configure the edge gateway
# 
# Usage: Copy this to /boot/firstrun.sh on the SD card and it will run on first boot

set -e

echo "=========================================="
echo "NearHome Edge Gateway - First Boot Setup"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

# Configuration variables
DEVICE_UUID="${BALENA_DEVICE_UUID:-rpi3b-$(cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2)}"
API_URL="${API_BASE_URL:-http://192.168.1.100:3001}"
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PASSWORD="${WIFI_PASSWORD:-}"

echo "Device UUID: $DEVICE_UUID"
echo "API URL: $API_URL"

# Step 1: Update and install dependencies
echo ""
echo "Step 1: Updating system..."
apt-get update
apt-get upgrade -y

# Step 2: Install Docker
echo ""
echo "Step 2: Installing Docker..."
if command -v docker &> /dev/null; then
    echo "Docker already installed"
else
    curl -sSL https://get.docker.com | sh
    echo "Docker installed"
fi

# Enable Docker on boot
systemctl enable docker

# Add pi user to docker group
usermod -aG docker pi || true

# Step 3: Install required tools
echo ""
echo "Step 3: Installing network tools..."
apt-get install -y \
    arp-scan \
    iproute2 \
    iputils-ping \
    curl \
    python3 \
    python3-pip \
    python3-venv

# Step 4: Create directories
echo ""
echo "Step 4: Creating directories..."
mkdir -p /opt/nearhome/edge-gateway
mkdir -p /opt/nearhome/edge-gateway/data

# Step 5: Create environment file
echo ""
echo "Step 5: Creating configuration..."
cat > /opt/nearhome/edge-gateway/.env <<EOF
BALENA_DEVICE_UUID=$DEVICE_UUID
API_BASE_URL=$API_URL
EDGE_GATEWAY_API_TOKEN=
WIFI_SSID=$WIFI_SSID
WIFI_PASSWORD=$WIFI_PASSWORD
EOF

# Step 6: Create systemd service for edge gateway
echo ""
echo "Step 6: Creating systemd service..."
cat > /etc/systemd/system/nearhome-edge-gateway.service <<'EOF'
[Unit]
Description=NearHome Edge Gateway Discovery Agent
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/nearhome/edge-gateway

# Pull the Docker image
ExecStartPre=/usr/bin/docker pull nearhome/edge-gateway:rpi3

# Run the container
ExecStart=/usr/bin/docker run \
    --network host \
    --privileged \
    --name nearhome-edge-gateway \
    -v /opt/nearhome/edge-gateway/config.yaml:/app/config.yaml:ro \
    --env-file /opt/nearhome/edge-gateway/.env \
    nearhome/edge-gateway:rpi3

# Restart on failure
ExecStop=/usr/bin/docker stop nearhome-edge-gateway
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Step 7: Enable service
echo ""
echo "Step 7: Enabling service..."
systemctl daemon-reload
systemctl enable nearhome-edge-gateway.service

# Step 8: Configure WiFi if provided
if [ -n "$WIFI_SSID" ]; then
    echo ""
    echo "Step 8: Configuring WiFi..."
    cat > /etc/wpa_supplicant/wpa_supplicant.conf <<EOF
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=US

network={
    ssid="$WIFI_SSID"
    psk="$WIFI_PASSWORD"
    key_mgmt=WPA-PSK
}
EOF
    systemctl enable wpa_supplicant.service
fi

# Final message
echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Reboot: sudo reboot"
echo "2. Check status: systemctl status nearhome-edge-gateway"
echo "3. View logs: docker logs nearhome-edge-gateway"
echo ""
echo "Then register the device with your API:"
echo "  curl -X POST http://YOUR_API/api/v1/edge-gateways/register \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{"
echo '      "balenaDeviceUUID": "'$DEVICE_UUID'",'
echo '      "deviceName": "rpi-gateway",'
echo '      "tenantId": "YOUR_TENANT_ID"'
echo "    }'"
echo ""

# Disable first boot to prevent re-run
rm -f /boot/firstrun.sh 2>/dev/null || true

exit 0