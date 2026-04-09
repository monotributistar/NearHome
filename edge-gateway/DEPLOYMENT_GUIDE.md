# Edge Gateway Deployment Guide

This guide covers two deployment options for the Edge Gateway on Raspberry Pi 3B+.

---

## Quick Comparison

| Feature              | Option A: Docker Directo  | Option B: balenaOS + openbalena |
| -------------------- | ------------------------- | ------------------------------- |
| **Setup complexity** | ⭐ Simple                 | ⭐⭐ More complex               |
| **VPN built-in**     | ❌ No (use local network) | ✅ Yes (balenaVPN)              |
| **OTA updates**      | ❌ Manual                 | ✅ Automatic                    |
| **Remote access**    | ❌ Local network only     | ✅ From anywhere                |
| **Fleet management** | ❌ Manual                 | ✅ Dashboard                    |
| **Ideal for**        | Testing/Development       | Production                      |

---

## Option A: Docker Directo (Simpler)

Use this for local testing with your cameras on the same network.

### Files for SD Card

Copy to Raspberry Pi SD card boot partition:

- `edge-gateway/sd-card/config.txt`
- `edge-gateway/sd-card/firstrun-simple.sh` → rename to `firstrun.sh`

### Configuration

Edit `firstrun-simple.sh` and set:

```bash
API_BASE_URL="http://192.168.1.100:3001"  # Your computer's IP
WIFI_SSID="YourNetwork"                      # Optional
WIFI_PASSWORD="YourPassword"                 # Optional
```

### Steps

1. Download Raspberry Pi OS Lite (32-bit)
2. Flash with balenaEtcher
3. Copy `config.txt` and `firstrun.sh` to boot partition
4. Edit `firstrun.sh` with your API IP
5. Boot Pi and wait 5-10 minutes
6. SSH: `ssh pi@<pi-ip>` (password: raspberry)
7. Register with API

---

## Option B: balenaOS + openbalena (Production)

Use this for full remote management, OTA updates, and fleet control.

### Part 1: Start openbalena Server

```bash
# Add openbalena to your stack
cd NearHome/infra
docker-compose --profile edge-gateway up -d

# Wait for services
docker-compose ps
# Should see: openbalena-api, openbalena-vpn, openbalena-registry, etc.
```

**Ports:**

- `localhost:3000` - openbalena API
- `localhost:9001` - MinIO Console (S3)

### Part 2: Configure DNS (Development)

Add to `/etc/hosts`:

```bash
127.0.0.1 api.balena vpn.balena registry.balena
```

### Part 3: Create Fleet

1. Open http://localhost:3000
2. Create fleet: "edge-gateways"
3. Device type: "raspberrypi3"
4. Generate provisioning API key

### Part 4: Prepare SD Card

Copy to boot partition:

- `edge-gateway/sd-card/config.txt`
- `edge-gateway/sd-card/firstrun-balenamode.sh` → rename to `firstrun.sh`

**IMPORTANT**: Edit first and set:

```bash
OPENBALENA_API_URL="http://192.168.1.100:3000"
OPENBALENA_VPN_HOST="192.168.1.100"
FLEET_NAME="edge-gateways"
```

### Part 5: Boot and Connect

1. Insert SD card in Raspberry Pi
2. Power on
3. Wait for connection (~2-5 minutes)
4. Check openbalena dashboard for new device

### Part 6: Deploy Application

```bash
cd NearHome/edge-gateway
balena push edge-gateways
```

---

## API Registration

After device connects, register with NearHome API:

```bash
# Get device UUID from openbalena dashboard or:
ssh root@<device-ip> "cat /proc/cpuinfo | grep Serial | cut -d' ' -f2"

# Register
curl -X POST http://localhost:3001/api/v1/edge-gateways/register \
  -H 'Content-Type: application/json' \
  -d '{
    "balenaDeviceUUID": "YOUR_DEVICE_UUID",
    "deviceName": "rpi-gateway-01",
    "tenantId": "YOUR_TENANT_ID",
    "balenaFleetId": "FLEET_ID"
  }'
```

---

## Camera Discovery

Once registered, the discovery agent will:

1. Scan local network (ARP)
2. Check RTSP ports (554, 8554, 8080, 8000)
3. Probe ONVIF endpoints
4. Report to NearHome API

View discovered cameras:

```bash
curl http://localhost:3001/api/v1/edge-gateways/<gateway-id>/cameras
```

---

## Troubleshooting

### Device not appearing in openbalena

```bash
# Check network
ssh pi@<ip> "curl -I http://api.balena"

# Check supervisor
ssh pi@<ip> "balena ps"
```

### No cameras discovered

```bash
# Check if cameras are reachable
ssh pi@<ip> "arp-scan --localnet"

# Check ports
nmap -p 554,80,8000 <camera-ip>
```

### API not accessible

```bash
# From Pi, test API
ssh pi@<ip> "curl http://192.168.1.100:3001/health"
```

---

## Network Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Computer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ NearHome    │  │ openbalena    │  │ MinIO             │  │
│  │ API :3001   │  │ API :3000     │  │ Console :9001     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         │   Ethernet/WiFi   │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                 Raspberry Pi 3B+ (Edge Gateway)            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ balenaOS                                            │  │
│  │  ├── Discovery Agent (cámara discovery)             │  │
│  │  ├── balena Supervisor (updates, health)           │  │
│  │  └── balenaVPN (tunnel to server)                   │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │
         │   Local Network (same subnet as cameras)
         ▼
┌─────────────────────────────────────────────────────────────┐
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │Camera 1  │  │Camera 2  │  │Camera 3  │  IP Cameras    │
│  │ RTSP:554 │  │ RTSP:554 │  │ RTSP:554 │                │
│  └──────────┘  └──────────┘  └──────────┘                │
└─────────────────────────────────────────────────────────────┘
```
