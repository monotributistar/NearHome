#!/bin/bash
# Quick deployment script for Raspberry Pi 3B+ Edge Gateway
# Usage: ./deploy-to-pi.sh [pi-ip-or-hostname]

set -e

PI_TARGET="${1:-192.168.1.100}"  # Default IP, can override
API_URL="${2:-http://localhost:3001}"

echo "=========================================="
echo "Edge Gateway Deployment for Raspberry Pi 3B+"
echo "=========================================="

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker first."
    exit 1
fi

if ! command -v balena &> /dev/null; then
    echo "⚠️ balena CLI not found. You can still run locally with Docker."
fi

# Option 1: Run locally on Pi with Docker
echo ""
echo "Option 1: Running locally on Raspberry Pi (without balena)"
echo "----------------------------------------------------------------"

# Create environment file
cat > .env.deploy <<EOF
BALENA_DEVICE_UUID=rpi3b-test-001
EDGE_GATEWAY_API_TOKEN=
API_BASE_URL=$API_URL
EOF

echo "Environment configured:"
echo "  API_BASE_URL: $API_URL"
echo "  Device UUID: rpi3b-test-001"
echo ""

# Build the Docker image for armv7 (Pi 3B+)
echo "Building Docker image for Raspberry Pi 3B+ (armv7hf)..."
docker build -f edge-gateway/discovery-agent/Dockerfile.rpi3 \
    -t nearhome/edge-gateway:rpi3 \
    edge-gateway/discovery-agent/

echo ""
echo "✅ Docker image built: nearhome/edge-gateway:rpi3"
echo ""

# Instructions for running
echo "=========================================="
echo "To run on your Raspberry Pi 3B+:"
echo "=========================================="
echo ""
echo "1. Copy image to Pi:"
echo "   docker save nearhome/edge-gateway:rpi3 | gzip | ssh pi@$PI_TARGET 'docker load'"
echo ""
echo "2. Or use Docker registry:"
echo "   docker tag nearhome/edge-gateway:rpi3 your-registry/edge-gateway:rpi3"
echo "   docker push your-registry/edge-gateway:rpi3"
echo "   # Then pull on Pi"
echo ""
echo "3. Run on Pi:"
echo "   docker run -d \\
        --network host \\
        --privileged \\
        -e API_BASE_URL=$API_URL \\
        -e BALENA_DEVICE_UUID=rpi3b-test-001 \\
        nearhome/edge-gateway:rpi3"
echo ""
echo "4. Check logs:"
echo "   docker logs -f nearhome/edge-gateway:rpi3"
echo ""

# Option 2: If balena CLI available
if command -v balena &> /dev/null; then
    echo "=========================================="
    echo "Option 2: Using balena CLI"
    echo "=========================================="
    echo ""
    echo "If you have a balenaCloud account or openbalena:"
    echo ""
    echo "1. Login: balena login"
    echo "2. Push to fleet: balena push <your-fleet>"
    echo ""
fi

echo "=========================================="
echo "After deployment:"
echo "=========================================="
echo ""
echo "1. Register the device with API:"
echo "   curl -X POST http://localhost:3001/api/v1/edge-gateways/register \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{"
echo '       "balenaDeviceUUID": "rpi3b-test-001",'
echo '       "deviceName": "test-gateway",'
echo '       "tenantId": "your-tenant-id"'
echo "     }'"
echo ""
echo "2. Check discovered cameras:"
echo "   curl -X GET http://localhost:3001/api/v1/edge-gateways"
echo ""

# Make executable
chmod +x deploy-to-pi.sh