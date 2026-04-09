# Edge Gateway Deployment Guide for Raspberry Pi 3B+

This guide helps you deploy the Edge Gateway on a Raspberry Pi 3B+ for testing with your local cameras.

## Prerequisites

### Hardware

- Raspberry Pi 3B+ (or Raspberry Pi 4)
- MicroSD card (8GB minimum, 16GB recommended)
- Ethernet cable for network connection
- Power supply (5V 2.5A for Pi 3B+)

### Software Requirements

- balenaEtcher: https://www.balena.io/etcher/
- balena CLI: `npm install -g balena-cli`

### Network Requirements

- Raspberry Pi must be on the same network as your cameras
- Your Control Plane API must be accessible (via localhost or public URL)
- openbalena server running (or use balenaCloud for testing)

---

## Option A: Quick Test with balenaCloud (Easiest)

### 1. Create a balenaCloud Account

1. Go to https://dashboard.balena-cloud.com/
2. Create a free account
3. Create a new application named "edge-gateway-test"
4. Select device type: "Raspberry Pi 3" (or 3B+)
5. Select OS version: "balenaOS 2.x"

### 2. Flash the SD Card

1. In balenaCloud dashboard, click "Add Device"
2. Download the provisioning image
3. Flash with balenaEtcher to your SD card
4. Insert SD card in Raspberry Pi and power on

### 3. Deploy the Application

```bash
# Install balena CLI
npm install -g balena-cli

# Login
balena login

# Push the application
cd edge-gateway
balena push edge-gateway-test
```

### 4. Configure Environment Variables

In balenaCloud dashboard, add:

```
API_BASE_URL=http://YOUR_API_IP:3001
```

---

## Option B: Self-Hosted with openbalena

### 1. Start openbalena Server

```bash
cd NearHome/infra/openbalena
cp .env.example .env
# Edit .env with your settings
docker-compose up -d
```

### 2. Configure DNS

Add to your `/etc/hosts` (for local testing):

```
127.0.0.1 api.balena vpn.balena registry.balena
```

### 3. Create Fleet

```bash
# Access openbalena API (port 3000)
# Create fleet via dashboard or API
```

### 4. Flash Raspberry Pi

Download balenaOS image for Raspberry Pi 3B+:
https://www.balena.io/os/#download

Or use balenaCLI to configure WiFi:

```bash
# Create config.json for WiFi
cat > config.json << 'EOF'
{
  "wifi": {
    "ssid": "YOUR_WIFI_SSID",
    "password": "YOUR_WIFI_PASSWORD"
  },
  "applicationName": "Edge Gateway Test",
  "apiEndpoint": "https://api.balena/",
  "provisioningApiKey": "YOUR_PROVISIONING_KEY"
}
EOF

# Flash with balenaEtcher
# After flashing, copy config.json to boot partition
```

---

## Step-by-Step: Running Locally (Development)

### 1. Start the API Server

```bash
cd NearHome/apps/api
npm run dev
```

### 2. Configure the Discovery Agent

Create `edge-gateway/discovery-agent/.env`:

```bash
BALENA_DEVICE_UUID=test-gateway-001
EDGE_GATEWAY_API_TOKEN=
API_BASE_URL=http://localhost:3001
WIFI_SSID=
WIFI_PASSWORD=
```

### 3. Run Discovery Agent on Raspberry Pi

```bash
# Install dependencies
cd edge-gateway/discovery-agent
pip install -r requirements.txt

# Run the agent
python src/discovery_agent.py
```

---

## Testing with Your Cameras

### 1. Check Network Connectivity

```bash
# SSH into Raspberry Pi
ssh root@<pi-ip>

# Check network
ip addr show
ping 8.8.8.8
```

### 2. Verify Camera Discovery

The discovery agent should:

1. Scan your local network via ARP
2. Check ports 554, 8554, 80, 8000 on discovered devices
3. Probe ONVIF endpoints for camera info
4. Report to API

### 3. View Discovered Cameras

```bash
# Via API
curl -X GET http://localhost:3001/api/v1/edge-gateways \
  -H "Authorization: Bearer <token>"
```

---

## Troubleshooting

### Camera Not Being Discovered

1. Check firewall on camera (some block scans)
2. Verify camera IP is in same subnet as Pi
3. Check if RTSP port is open:
   ```bash
   nmap -p 554,8554,80,8000 <camera-ip>
   ```

### API Not Accessible

1. Check API is running: `curl http://localhost:3001/health`
2. Verify API_BASE_URL is correct
3. For local testing, use `http://host.docker.internal:3001` from container

### Discovery Agent Issues

```bash
# Check logs
docker logs discovery-agent

# Or run directly with debug
python -c "import logging; logging.basicConfig(level=logging.DEBUG)"
```

---

## Quick Commands Reference

```bash
# Build and push to balena
balena push <fleet>

# SSH into device
balena ssh <device-uuid>

# View device logs
balena logs <device-uuid>

# Check device status
balena devices

# Restart application
balena rebuild <device-uuid>
```

---

## Next Steps After Testing

1. **If working**: Proceed to production deployment
2. **If issues**: Check the Discovery Agent logs and verify camera compatibility
3. **Camera ONVIF**: Some cameras require authentication for ONVIF probing

---

## Support

- Check API docs: `docs/edge-gateway-api.md`
- balenaOS docs: https://www.balena.io/docs/
- ONVIF compatibility: Most IP cameras support ONVIF (Hikvision, Dahua, Axis, etc.)
