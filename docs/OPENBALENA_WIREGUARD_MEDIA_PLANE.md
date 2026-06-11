# OpenBalena + WireGuard Media Plane (RTSP at scale)

Date: 2026-05-06

## Decision
- Keep openBalena for fleet/device management.
- Move RTSP transport to a dedicated WireGuard overlay.
- Do not depend on balenaVPN as media path for multi-stream workloads.

## Why
- WireGuard gives deterministic routing, lower overhead, and easier policy control for sustained multi-RTSP traffic.
- Separating control-plane (openBalena) from media-plane (WireGuard) improves stability and debuggability.

## Topology
- Hub-and-spoke:
  - Hub in infra (`wg0` on central host/VPS).
  - One spoke per BalenaOS edge node.
- Each edge advertises its camera subnet to hub.
- Infra routes to camera subnets via corresponding edge peer.

## Addressing model
- WG overlay CIDR example: `10.88.0.0/16`
  - Hub: `10.88.0.1/32`
  - Edge site A: `10.88.1.1/32`
  - Edge site B: `10.88.2.1/32`
- Camera LANs must not overlap:
  - Site A `192.168.10.0/24`
  - Site B `192.168.20.0/24`

## Routing model
Preferred (`route`):
- Static route in infra for each camera subnet via WG hub peer mapping.
- No NAT on edge for camera traffic.

Fallback (`snat`):
- Edge MASQUERADE from WG -> camera LAN if camera return routing is constrained.

## Edge requirements
- `net.ipv4.ip_forward=1`
- Firewall default deny.
- Allow only:
  - infra CIDRs -> camera subnet TCP/554
  - established/related return traffic
- Persist rules at boot and container restart.

## Performance guidance
- MTU tuning: start `1380` (adjust if fragmentation observed).
- Keepalive: `PersistentKeepalive=25` on edge peers behind NAT.
- Use TCP RTSP transport for traversal consistency unless UDP is explicitly required.

## Security
- One keypair per edge node.
- Per-tenant/site peer segmentation.
- Short credential rotation cycle and immediate revoke path.

## Migration steps
1. Stand up WireGuard hub in infra.
2. Add one edge node peer and validate route to one camera.
3. Move smoke/probes to WG path.
4. Gradually migrate remaining sites.
5. Keep openBalena VPN only for management fallback during migration window.

## Acceptance criteria
- 3+ concurrent RTSP streams per site stable for 30 min.
- Packet loss under agreed threshold.
- Recovery after edge reboot < 2 min.
- No cross-tenant subnet reachability.
