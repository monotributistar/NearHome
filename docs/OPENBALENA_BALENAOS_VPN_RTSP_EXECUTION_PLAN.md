# OpenBalena + BalenaOS WireGuard Router Plan (RTSP from infra)

Date: 2026-05-06
Scope: expose IP camera RTSP streams through BalenaOS edge nodes acting as routed WireGuard gateways.

## 1) Target architecture
- Each site has one BalenaOS edge node connected to:
  - `WireGuard overlay` uplink
  - local camera LAN (RTSP sources)
- Infra reaches camera subnet through edge routing policy.
- Control-plane remains tenant/site scoped.
- openBalena connectivity remains available for fleet management; RTSP traffic must use WireGuard path.

## 2) Non-negotiable constraints
- No overlapping camera subnets between sites.
- Default deny firewall on edge; allow only approved infra CIDRs and RTSP ports.
- Route policy must be idempotent and reapplied on reboot/update.

## 3) Execution backlog (7 days)

### Day 1 - Addressing and policy freeze
Owner: Platform
- Define per-site camera subnet inventory.
- Define infra source CIDRs allowed to query RTSP.
- Confirm routing mode per site:
  - `route` (preferred): infra static route to camera subnet via edge.
  - `snat` (fallback): edge performs NAT to camera LAN.

Deliverables:
- site network matrix (site, edge-id, camera subnet, gateway, mode)
- allow-list document for infra CIDRs

### Day 2 - openBalena baseline hardening
Owner: Platform
- Bring up openBalena stack and verify API/registry and control-plane health.
- Validate fleet structure by tenant/site.
- Validate device provisioning and release rollout/rollback.

Commands:
```bash
pnpm openbalena:up:tunnel
pnpm openbalena:verify:tunnel
```

Acceptance:
- all core services healthy
- one canary device online and receiving release

### Day 3 - Edge router implementation
Owner: Edge
- Enable IP forwarding on BalenaOS node.
- Apply firewall/routing rules via edge service startup script.
- Implement two policy templates:
  - route mode (forward-only)
  - snat mode (masquerade)

Acceptance:
- rules survive reboot and service restart
- deny-by-default policy verified

### Day 4 - Infra-side route integration
Owner: Platform
- For `route` mode: add static routes in infra networking.
- For `snat` mode: no infra route needed; verify return path.
- Add monitoring probes for each camera endpoint.

Acceptance:
- infra can connect to RTSP TCP/554 on all target cameras

### Day 5 - Functional RTSP validation
Owner: QA/Platform
- Execute RTSP smoke for each site from infra.
- Validate both handshake and short stream pull.

Command:
```bash
CAMERA_IPS="192.168.10.101,192.168.10.102" \
RTSP_PATH="/stream1" \
bash scripts/openbalena/wireguard-rtsp-smoke.sh
```

Acceptance:
- >= 95% successful RTSP OPTIONS/DESCRIBE attempts
- >= 90% successful 30s stream probe attempts

### Day 6 - Failure/recovery testing
Owner: QA/Platform
- Reboot edge node.
- Restart balena supervisor.
- Simulate WAN flap and recover.

Acceptance:
- route restored automatically
- camera reachability restored under 2 minutes

### Day 7 - Pilot release (multi-client)
Owner: Platform + Ops
- Roll out to 2+ customer sites with 3+ devices total.
- Operate for 24h with alerting enabled.

Exit criteria:
- no recurrent disconnections
- no cross-tenant route leakage
- documented rollback works

## 4) Test matrix
- Connectivity:
  - TCP 554 reachability
  - RTSP OPTIONS/DESCRIBE
  - 30s pull with ffprobe/ffmpeg
- Security:
  - blocked access from non-allowed CIDR
  - blocked access to non-camera LAN hosts
- Stability:
  - repeated probes every 1 minute for 2 hours

## 5) Operational run commands
```bash
# openBalena lifecycle
pnpm openbalena:up:tunnel
pnpm openbalena:down:tunnel
pnpm openbalena:verify:tunnel

# RTSP VPN validation
CAMERA_IPS="192.168.10.101,192.168.10.102" bash scripts/openbalena/wireguard-rtsp-smoke.sh
```

## 6) Rollback strategy
- Disable route policy release on affected fleet.
- Revert to last known-good release in openBalena.
- For route mode: remove static route from infra.
- For snat mode: disable masquerade rules and restart router-agent.
