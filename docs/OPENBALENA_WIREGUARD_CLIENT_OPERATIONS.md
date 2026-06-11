# OpenBalena + WireGuard Operations (Edge RPi + Cloudflare + per-client VPN)

Date: 2026-05-06

## 1) Goal
- openBalena manages devices/fleets/releases.
- WireGuard carries RTSP/media traffic from camera LANs to infra.
- Each client/site is isolated with dedicated WG peer and route policy.

## 2) Deploy edge Raspberry Pi code

### 2.1 Prepare edge config
1. Copy and edit WG config for each edge:
```bash
cp edge-gateway/wireguard-router/wg0.conf.example edge-gateway/wireguard-router/wg0.conf
```
2. Update in `wg0.conf`:
- edge private key
- hub public key
- hub endpoint
- allowed IPs for your overlay and infra ranges

3. In `edge-gateway/docker-compose.yml`, mount real config file:
- replace `wg0.conf.example` with `wg0.conf`

### 2.2 Build and push to openBalena fleet
```bash
cd edge-gateway
balena push <fleet-name>
```

### 2.3 Required edge env vars (fleet/device)
- `WG_INTERFACE` (default `wg0`)
- `CAMERA_SUBNET_CIDR` (site camera LAN)
- `INFRA_ALLOWED_CIDRS` (comma-separated infra CIDRs)
- `CAMERA_IFACE` (`eth0` typically)
- `ROUTING_MODE` (`route` preferred, `snat` fallback)

## 3) Deploy openBalena with Cloudflare

### 3.1 openBalena stack
```bash
cp infra/openbalena/.env.example infra/openbalena/.env
pnpm openbalena:up:tunnel
pnpm openbalena:verify:tunnel
```

### 3.2 Cloudflare publication
Publish only HTTP control endpoints via tunnel:
- `api.<domain>` -> `http://api:3000`
- `registry.<domain>` -> `http://registry:80`

Keep WireGuard/public UDP path outside Cloudflare Tunnel:
- expose WG hub endpoint directly on `51820/udp`

## 4) WireGuard hub setup (infra)

### 4.1 Minimal hub config (`/etc/wireguard/wg0.conf`)
```ini
[Interface]
Address = 10.88.0.1/16
ListenPort = 51820
PrivateKey = <hub-private-key>

# Site client-a
[Peer]
PublicKey = <edge-a-public-key>
AllowedIPs = 10.88.1.1/32, 192.168.10.0/24
PersistentKeepalive = 25

# Site client-b
[Peer]
PublicKey = <edge-b-public-key>
AllowedIPs = 10.88.2.1/32, 192.168.20.0/24
PersistentKeepalive = 25
```

### 4.2 Bring up hub
```bash
sudo wg-quick up wg0
sudo wg show
```

### 4.3 Firewall (hub)
- Allow `51820/udp` inbound.
- Allow forward from infra probe/stream services to camera subnets.

## 5) Per-client VPN handling model

### 5.1 Isolation rules
- One WG peer per edge/site.
- One camera subnet per site (no overlaps).
- `AllowedIPs` must include only that site subnet.
- No cross-client routes in peer definitions.

### 5.2 Inventory table (must exist)
- `client_id`
- `site_id`
- `edge_device_uuid`
- `wg_peer_public_key`
- `overlay_ip`
- `camera_subnet_cidr`
- `routing_mode`
- `allowed_infra_cidrs`

### 5.3 Rotation/revoke
- Rotate edge keypair per incident/change window.
- Remove peer block from hub config to revoke.
- Redeploy edge with new key and peer entry.

## 6) Validation workflow

### 6.1 WireGuard + RTSP smoke from infra
```bash
CAMERA_IPS="192.168.10.101,192.168.10.102" \
RTSP_PATH="/stream1" \
pnpm openbalena:smoke:wireguard:rtsp
```

### 6.2 Success criteria
- TCP connect 554 works for all cameras.
- ffprobe stream probe succeeds on target cameras.
- `wg show` has recent handshake and transfer counters increasing.

## 7) Troubleshooting fast path
- No handshake:
  - verify edge can reach hub UDP/51820
  - verify keys and endpoint DNS/IP
- Handshake yes, no RTSP:
  - verify edge `CAMERA_SUBNET_CIDR`
  - verify iptables rules in router container
  - verify camera gateway/return route (or switch to `ROUTING_MODE=snat`)
- Intermittent drops:
  - reduce MTU (`1380` start point)
  - keep `PersistentKeepalive=25`

## 8) Operational commands
```bash
# openBalena lifecycle
pnpm openbalena:up:tunnel
pnpm openbalena:down:tunnel
pnpm openbalena:verify:tunnel

# RTSP over WireGuard
pnpm openbalena:smoke:wireguard:rtsp

# Local edge stack (for debugging outside balena)
cd edge-gateway
docker compose up -d
docker compose logs -f wireguard-router
```
