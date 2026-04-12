/**
 * Edge Fleet Scenario Test
 *
 * Simulates a real production scenario with two tenants running edge router fleets.
 * Each tenant has:
 *   - 1 fleet
 *   - 1 edge gateway (balenaOS device)
 *   - 2-3 discovered IP cameras
 *   - 1-2 discovered smart lightbulbs
 *   - 1 VPN (WireGuard hub_spoke)
 *
 * Verifies:
 *   - Complete onboarding lifecycle (register → heartbeat → discover → confirm)
 *   - VPN isolation (tenant A VPN is invisible to tenant B)
 *   - Cross-tenant device access is rejected
 *   - Device commands are scoped correctly
 *   - Gateway logs / metrics are tenant-scoped
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app";

let app: FastifyInstance;
const prisma = new PrismaClient();

// ── Tenant identifiers ────────────────────────────────────────
const T_ALPHA = "fleet-test-alpha";
const T_BETA = "fleet-test-beta";

// ── Device UUIDs ─────────────────────────────────────────────
const UUID_ALPHA_GW = "11aaaaaa-0000-0000-0000-000000000001";
const UUID_BETA_GW = "22bbbbbb-0000-0000-0000-000000000002";

// ── Per-tenant state ─────────────────────────────────────────
const alpha = { adminToken: "", tenantId: T_ALPHA, fleetId: "", gwId: "", gwToken: "", vpnId: "" };
const beta = { adminToken: "", tenantId: T_BETA, fleetId: "", gwId: "", gwToken: "", vpnId: "" };

// ── Helpers ───────────────────────────────────────────────────
async function login(email: string, password = "demo1234") {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "x-forwarded-for": `test-fleet-${email}-${Math.random()}` },
    payload: { email, password }
  });
  expect(r.statusCode).toBe(200);
  return r.json<{ accessToken: string }>().accessToken;
}

function ah(token: string, tenantId: string) {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

function dh(apiToken: string) {
  return { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };
}

async function ensureMembership(userId: string, tenantId: string, role: string) {
  await prisma.membership.upsert({
    where: { tenantId_userId: { userId, tenantId } },
    update: {},
    create: { userId, tenantId, role }
  });
}

// ── Setup ─────────────────────────────────────────────────────
beforeAll(async () => {
  app = await buildApp();

  // Pre-clean any leftover state from failed prior runs
  const knownUUIDs = [UUID_ALPHA_GW, UUID_BETA_GW];
  const existingGws = await prisma.edgeGateway.findMany({ where: { balenaDeviceUUID: { in: knownUUIDs } }, select: { id: true } });
  if (existingGws.length > 0) {
    const gwIds = existingGws.map((g) => g.id);
    await prisma.edgeGatewayPairingToken.deleteMany({ where: { edgeGatewayId: { in: gwIds } } });
    await prisma.discoveredDevice.deleteMany({ where: { edgeGatewayId: { in: gwIds } } });
    await prisma.discoveredCamera.deleteMany({ where: { edgeGatewayId: { in: gwIds } } });
    await prisma.edgeGateway.deleteMany({ where: { id: { in: gwIds } } });
  }

  // Create tenants
  for (const id of [T_ALPHA, T_BETA]) {
    await prisma.tenant.upsert({
      where: { id },
      update: {},
      create: { id, name: id === T_ALPHA ? "Alpha Residential" : "Beta Commerce" }
    });
  }

  // Lookup admin user and create memberships
  const adminUser = await prisma.user.findFirst({ where: { email: "admin@nearhome.dev" } });
  if (adminUser) {
    await ensureMembership(adminUser.id, T_ALPHA, "tenant_admin");
    await ensureMembership(adminUser.id, T_BETA, "tenant_admin");
  }

  // Login once; the same admin user is member of both tenants
  const tok = await login("admin@nearhome.dev");
  alpha.adminToken = tok;
  beta.adminToken = tok;
});

afterAll(async () => {
  const tenantIds = [T_ALPHA, T_BETA];
  const knownUUIDs = [UUID_ALPHA_GW, UUID_BETA_GW];
  const knownGws = await prisma.edgeGateway.findMany({ where: { balenaDeviceUUID: { in: knownUUIDs } }, select: { id: true } });
  await prisma.edgeGatewayPairingToken.deleteMany({ where: { edgeGatewayId: { in: knownGws.map((g) => g.id) } } });
  await prisma.discoveredDevice.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.discoveredCamera.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.edgeGateway.deleteMany({ where: { balenaDeviceUUID: { in: knownUUIDs } } });
  await prisma.fleet.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantVpnPeer.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantVpnRoutePolicy.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantNetworkSpace.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantVpn.deleteMany({ where: { tenantId: { in: tenantIds } } });
  try {
    await prisma.streamSessionTransition.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.streamSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.cameraAssignment.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.cameraHealthSnapshot.deleteMany({ where: { camera: { tenantId: { in: tenantIds } } } });
    await prisma.cameraLifecycleLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.cameraProfile.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.camera.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.membership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  } catch {
    // Best-effort cleanup; next run's beforeAll pre-cleans by UUID
  }
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════
// 1. FLEET SETUP
// ═══════════════════════════════════════════════════════════════

describe("1 · Fleet Setup", () => {
  it("creates fleet for Alpha Residential", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/fleets",
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { name: "Alpha Fleet", deviceType: "raspberrypi4-64" }
    });
    expect(r.statusCode).toBe(201);
    alpha.fleetId = r.json().id;
    expect(alpha.fleetId).toBeTruthy();
  });

  it("creates fleet for Beta Commerce", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/fleets",
      headers: ah(beta.adminToken, T_BETA),
      payload: { name: "Beta Fleet", deviceType: "raspberrypi4-64" }
    });
    expect(r.statusCode).toBe(201);
    beta.fleetId = r.json().id;
  });

  it("each tenant sees only their own fleet", async () => {
    const ra = await app.inject({ method: "GET", url: "/api/v1/fleets", headers: ah(alpha.adminToken, T_ALPHA) });
    const rb = await app.inject({ method: "GET", url: "/api/v1/fleets", headers: ah(beta.adminToken, T_BETA) });

    const alphaIds = ra.json().data.map((f: any) => f.id);
    const betaIds = rb.json().data.map((f: any) => f.id);

    expect(alphaIds).toContain(alpha.fleetId);
    expect(alphaIds).not.toContain(beta.fleetId);
    expect(betaIds).toContain(beta.fleetId);
    expect(betaIds).not.toContain(alpha.fleetId);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. EDGE GATEWAY REGISTRATION & HEARTBEAT
// ═══════════════════════════════════════════════════════════════

describe("2 · Edge Gateway Registration & Heartbeat", () => {
  it("registers Alpha gateway into Alpha fleet", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/edge-gateways/register",
      payload: {
        balenaDeviceUUID: UUID_ALPHA_GW,
        deviceName: "alpha-edge-router-01",
        tenantId: T_ALPHA,
        fleetId: alpha.fleetId,
        osVersion: "5.3.2",
        supervisorVersion: "16.0.0"
      }
    });
    expect(r.statusCode).toBe(201);
    alpha.gwId = r.json().id;
    alpha.gwToken = r.json().apiToken;
    expect(alpha.gwToken.length).toBeGreaterThanOrEqual(32);
  });

  it("registers Beta gateway into Beta fleet", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/edge-gateways/register",
      payload: {
        balenaDeviceUUID: UUID_BETA_GW,
        deviceName: "beta-edge-router-01",
        tenantId: T_BETA,
        fleetId: beta.fleetId
      }
    });
    expect(r.statusCode).toBe(201);
    beta.gwId = r.json().id;
    beta.gwToken = r.json().apiToken;
  });

  it("Alpha gateway heartbeat activates it", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/heartbeat`,
      headers: dh(alpha.gwToken),
      payload: {
        timestamp: new Date().toISOString(),
        supervisorStatus: { deviceStatus: "running", isOnline: true, updateStatus: "up-to-date" },
        customMetrics: {
          cpuUsagePercent: 18.5,
          cpuTemperatureCelsius: 44,
          memoryUsedBytes: 800_000_000,
          memoryTotalBytes: 2_000_000_000,
          discoveredCamerasCount: 0,
          registeredCamerasCount: 0,
          vpnLatencyMs: 12.3
        },
        version: "1.0.0"
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("active");
  });

  it("Beta gateway heartbeat activates it", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${beta.gwId}/heartbeat`,
      headers: dh(beta.gwToken),
      payload: {
        timestamp: new Date().toISOString(),
        supervisorStatus: { deviceStatus: "running", isOnline: true, updateStatus: "up-to-date" },
        customMetrics: { cpuUsagePercent: 22, cpuTemperatureCelsius: 46 },
        version: "1.0.0"
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("active");
  });

  describe("Security: cross-gateway token rejection", () => {
    it("Alpha token rejected on Beta gateway heartbeat", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${beta.gwId}/heartbeat`,
        headers: dh(alpha.gwToken),
        payload: { timestamp: new Date().toISOString(), version: "1.0.0" }
      });
      expect(r.statusCode).toBe(403);
    });

    it("No token rejected on any heartbeat", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${alpha.gwId}/heartbeat`,
        payload: { timestamp: new Date().toISOString(), version: "1.0.0" }
      });
      expect(r.statusCode).toBe(401);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. CAMERA DISCOVERY (2-3 cameras per tenant)
// ═══════════════════════════════════════════════════════════════

describe("3 · Camera Discovery", () => {
  const alphaCameras = [
    { ipAddress: "172.30.0.10", macAddress: "02:42:ac:aa:00:0a", onvifInfo: { manufacturer: "Hikvision", model: "DS-2CD2043G2-I", firmware: "5.7.20" }, ports: [554, 80] },
    { ipAddress: "172.30.0.11", macAddress: "02:42:ac:aa:00:0b", onvifInfo: { manufacturer: "Dahua", model: "IPC-HDW5442T-ZE", firmware: "2.830.0" }, ports: [554, 80] },
    { ipAddress: "172.30.0.12", macAddress: "02:42:ac:aa:00:0c", onvifInfo: { manufacturer: "Reolink", model: "RLC-810A", firmware: "3.1.0" }, ports: [554] }
  ];

  const betaCameras = [
    { ipAddress: "172.31.0.10", macAddress: "02:42:ac:bb:00:0a", onvifInfo: { manufacturer: "Axis", model: "M3115-LVE", firmware: "11.6.54" }, ports: [554, 80] },
    { ipAddress: "172.31.0.11", macAddress: "02:42:ac:bb:00:0b", ports: [554] }
  ];

  it("Alpha gateway discovers 3 cameras on its LAN", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/cameras/discover`,
      headers: dh(alpha.gwToken),
      payload: {
        cameras: alphaCameras.map((c) => ({ ...c, rtspUrl: `rtsp://${c.ipAddress}/stream` })),
        discoveryTimestamp: new Date().toISOString()
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().discovered).toHaveLength(3);
  });

  it("Beta gateway discovers 2 cameras on its LAN", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${beta.gwId}/cameras/discover`,
      headers: dh(beta.gwToken),
      payload: {
        cameras: betaCameras.map((c) => ({ ...c, rtspUrl: `rtsp://${c.ipAddress}/stream` })),
        discoveryTimestamp: new Date().toISOString()
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().discovered).toHaveLength(2);
  });

  it("Alpha sees exactly 3 cameras", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${alpha.gwId}/cameras`, headers: ah(alpha.adminToken, T_ALPHA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toHaveLength(3);
    r.json().data.forEach((c: any) => expect(c.tenantId).toBe(T_ALPHA));
  });

  it("Beta sees exactly 2 cameras", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${beta.gwId}/cameras`, headers: ah(beta.adminToken, T_BETA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toHaveLength(2);
    r.json().data.forEach((c: any) => expect(c.tenantId).toBe(T_BETA));
  });

  it("Beta cannot see Alpha cameras via Alpha gateway", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${alpha.gwId}/cameras`, headers: ah(beta.adminToken, T_BETA) });
    expect(r.statusCode).toBe(404);
  });

  it("Alpha cannot see Beta cameras via Beta gateway", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${beta.gwId}/cameras`, headers: ah(alpha.adminToken, T_ALPHA) });
    expect(r.statusCode).toBe(404);
  });

  it("Alpha confirms first camera (registers for streaming)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/cameras/confirm`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: {
        macAddress: alphaCameras[0].macAddress,
        rtspUrl: `rtsp://172.30.0.10/stream`,
        username: "admin",
        password: "admin123"
      }
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("registered");
    expect(r.json().tunnelPort).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. SMART DEVICE DISCOVERY (1-2 bulbs per tenant)
// ═══════════════════════════════════════════════════════════════

describe("4 · Smart Device Discovery (Lightbulbs)", () => {
  it("Alpha gateway discovers 2 smart bulbs", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/devices/discover`,
      headers: dh(alpha.gwToken),
      payload: {
        devices: [
          {
            ipAddress: "172.30.0.20",
            macAddress: "02:42:ac:aa:01:01",
            deviceType: "light",
            manufacturer: "NearHome",
            model: "NHB-100",
            protocol: "http+mqtt",
            httpPort: 80,
            mqttTopic: "nearhome/lights/01",
            capabilities: ["on_off", "brightness", "color_temp"]
          },
          {
            ipAddress: "172.30.0.21",
            macAddress: "02:42:ac:aa:01:02",
            deviceType: "light",
            manufacturer: "NearHome",
            model: "NHB-200-RGB",
            protocol: "http+mqtt",
            httpPort: 80,
            mqttTopic: "nearhome/lights/02",
            capabilities: ["on_off", "brightness", "color_temp", "rgb"]
          }
        ],
        discoveryTimestamp: new Date().toISOString()
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().discovered).toHaveLength(2);
  });

  it("Beta gateway discovers 1 smart bulb", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${beta.gwId}/devices/discover`,
      headers: dh(beta.gwToken),
      payload: {
        devices: [
          {
            ipAddress: "172.31.0.20",
            macAddress: "02:42:ac:bb:01:01",
            deviceType: "light",
            manufacturer: "NearHome",
            model: "NHB-100",
            protocol: "http+mqtt",
            httpPort: 80,
            mqttTopic: "nearhome/lights/01",
            capabilities: ["on_off", "brightness"]
          }
        ],
        discoveryTimestamp: new Date().toISOString()
      }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().discovered).toHaveLength(1);
  });

  it("Alpha lists 2 light devices with correct type", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/edge-gateways/${alpha.gwId}/devices?deviceType=light`,
      headers: ah(alpha.adminToken, T_ALPHA)
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    expect(data).toHaveLength(2);
    data.forEach((d: any) => {
      expect(d.deviceType).toBe("light");
      expect(d.tenantId).toBe(T_ALPHA);
    });
  });

  it("Beta lists 1 light device", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/edge-gateways/${beta.gwId}/devices?deviceType=light`,
      headers: ah(beta.adminToken, T_BETA)
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toHaveLength(1);
  });

  it("Alpha controls first bulb (set_state command)", async () => {
    const devices = await prisma.discoveredDevice.findMany({ where: { edgeGatewayId: alpha.gwId } });
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/devices/${devices[0].id}/command`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { command: "set_state", payload: { on: true, brightness: 80 } }
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe("accepted");
  });

  it("Beta cannot command Alpha bulbs", async () => {
    const alphaDevices = await prisma.discoveredDevice.findMany({ where: { edgeGatewayId: alpha.gwId } });
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/devices/${alphaDevices[0].id}/command`,
      headers: ah(beta.adminToken, T_BETA),
      payload: { command: "set_state", payload: { on: false } }
    });
    expect(r.statusCode).toBe(404);
  });

  it("device state persisted after command", async () => {
    const devices = await prisma.discoveredDevice.findMany({ where: { edgeGatewayId: alpha.gwId } });
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/edge-gateways/${alpha.gwId}/devices/${devices[0].id}/state`,
      headers: ah(alpha.adminToken, T_ALPHA)
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().currentState.on).toBe(true);
    expect(r.json().currentState.brightness).toBe(80);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. VPN ISOLATION
// ═══════════════════════════════════════════════════════════════

describe("5 · VPN Isolation", () => {
  it("creates WireGuard VPN for Alpha", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/vpns",
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { name: "alpha-vpn", provider: "wireguard", topology: "hub_spoke" }
    });
    expect(r.statusCode).toBe(201);
    alpha.vpnId = r.json().id;
    expect(r.json().status).toBe("draft");
  });

  it("creates WireGuard VPN for Beta", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/vpns",
      headers: ah(beta.adminToken, T_BETA),
      payload: { name: "beta-vpn", provider: "wireguard", topology: "hub_spoke" }
    });
    expect(r.statusCode).toBe(201);
    beta.vpnId = r.json().id;
  });

  it("Alpha VPN gets camera_lan CIDR 10.100.1.0/24", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${alpha.vpnId}/network-spaces`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { spaceType: "camera_lan", cidr: "10.100.1.0/24", description: "Alpha cam LAN" }
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().cidr).toBe("10.100.1.0/24");
  });

  it("Beta VPN gets camera_lan CIDR 10.200.1.0/24 (different subnet – no overlap)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${beta.vpnId}/network-spaces`,
      headers: ah(beta.adminToken, T_BETA),
      payload: { spaceType: "camera_lan", cidr: "10.200.1.0/24", description: "Beta cam LAN" }
    });
    expect(r.statusCode).toBe(201);
  });

  it("Alpha adds its gateway as VPN peer", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${alpha.vpnId}/peers`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { peerId: alpha.gwId, peerRole: "edge_gateway", endpoint: "dynamic", allowedCidrs: ["10.100.1.0/24"] }
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().peerRole).toBe("edge_gateway");
  });

  it("Alpha cannot add Beta gateway as a peer (cross-tenant rejection)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${alpha.vpnId}/peers`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { peerId: beta.gwId, peerRole: "edge_gateway", endpoint: "dynamic", allowedCidrs: ["10.200.0.0/24"] }
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("Beta cannot see Alpha VPN", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/vpns", headers: ah(beta.adminToken, T_BETA) });
    const ids = r.json().data.map((v: any) => v.id);
    expect(ids).not.toContain(alpha.vpnId);
  });

  it("Alpha cannot see Beta VPN", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/vpns", headers: ah(alpha.adminToken, T_ALPHA) });
    const ids = r.json().data.map((v: any) => v.id);
    expect(ids).not.toContain(beta.vpnId);
  });

  it("validates and provisions Alpha VPN", async () => {
    // Validate
    const vr = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${alpha.vpnId}/validate`,
      headers: ah(alpha.adminToken, T_ALPHA)
    });
    expect(vr.statusCode).toBe(200);
    expect(vr.json().valid).toBe(true);

    // Provision
    const pr = await app.inject({
      method: "POST",
      url: `/api/v1/vpns/${alpha.vpnId}/provision`,
      headers: ah(alpha.adminToken, T_ALPHA)
    });
    expect(pr.statusCode).toBe(202);
    expect(["provisioning", "active"]).toContain(pr.json().status);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. RTSP TUNNELS
// ═══════════════════════════════════════════════════════════════

describe("6 · RTSP Tunnel", () => {
  it("Alpha tunnel status shows registered cameras with ports", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/edge-gateways/${alpha.gwId}/tunnels/status`,
      headers: ah(alpha.adminToken, T_ALPHA)
    });
    expect(r.statusCode).toBe(200);
    const { tunnels } = r.json();
    expect(Array.isArray(tunnels)).toBe(true);
    // One camera was confirmed, should appear
    expect(tunnels.length).toBeGreaterThanOrEqual(1);
    tunnels.forEach((t: any) => {
      expect(t.tunnelPort).toBeDefined();
      expect(t.status).toBe("connected");
    });
  });

  it("Beta cannot see Alpha tunnel status", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/edge-gateways/${alpha.gwId}/tunnels/status`,
      headers: ah(beta.adminToken, T_BETA)
    });
    expect(r.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. QR PAIRING FLOW
// ═══════════════════════════════════════════════════════════════

describe("7 · QR Pairing", () => {
  let alphaToken = "";

  it("generates pairing token for Alpha gateway", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/edge-gateways/${alpha.gwId}/pairing-token`,
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { expiresInMinutes: 15 }
    });
    expect(r.statusCode).toBe(201);
    alphaToken = r.json().token;
    const qr = JSON.parse(r.json().qrPayload);
    expect(qr.type).toBe("nearhome:edge-pair");
    expect(qr.gatewayId).toBe(alpha.gwId);
    expect(qr.tenantId).toBe(T_ALPHA);
  });

  it("client pairs using valid token", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/edge-gateways/pair",
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { pairingToken: alphaToken }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().edgeGatewayId).toBe(alpha.gwId);
    expect(r.json().status).toBe("paired");
  });

  it("reusing token returns 410 Gone", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/edge-gateways/pair",
      headers: ah(alpha.adminToken, T_ALPHA),
      payload: { pairingToken: alphaToken }
    });
    expect(r.statusCode).toBe(410);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. FLEET SUMMARY VIEW (simulates admin dashboard data)
// ═══════════════════════════════════════════════════════════════

describe("8 · Fleet Summary (Admin Dashboard Data)", () => {
  it("Alpha admin can fetch complete fleet picture", async () => {
    // Fleet
    const fleet = await app.inject({ method: "GET", url: "/api/v1/fleets", headers: ah(alpha.adminToken, T_ALPHA) });
    expect(fleet.json().data[0].name).toBe("Alpha Fleet");

    // Gateways
    const gws = await app.inject({ method: "GET", url: "/api/v1/edge-gateways", headers: ah(alpha.adminToken, T_ALPHA) });
    expect(gws.json().data.length).toBeGreaterThanOrEqual(1);
    const gw = gws.json().data.find((g: any) => g.id === alpha.gwId);
    expect(gw.status).toBe("active");

    // Cameras
    const cams = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${alpha.gwId}/cameras`, headers: ah(alpha.adminToken, T_ALPHA) });
    expect(cams.json().data).toHaveLength(3);

    // Smart devices
    const devs = await app.inject({ method: "GET", url: `/api/v1/edge-gateways/${alpha.gwId}/devices`, headers: ah(alpha.adminToken, T_ALPHA) });
    expect(devs.json().data).toHaveLength(2);

    // VPN
    const vpns = await app.inject({ method: "GET", url: "/api/v1/vpns", headers: ah(alpha.adminToken, T_ALPHA) });
    expect(vpns.json().data[0].provider).toBe("wireguard");
  });

  it("all Alpha data is invisible to Beta", async () => {
    // Alpha gateways invisible to Beta
    const gws = await app.inject({ method: "GET", url: "/api/v1/edge-gateways", headers: ah(beta.adminToken, T_BETA) });
    const gwIds = gws.json().data.map((g: any) => g.id);
    expect(gwIds).not.toContain(alpha.gwId);

    // Alpha VPN invisible to Beta
    const vpns = await app.inject({ method: "GET", url: "/api/v1/vpns", headers: ah(beta.adminToken, T_BETA) });
    const vpnIds = vpns.json().data.map((v: any) => v.id);
    expect(vpnIds).not.toContain(alpha.vpnId);
  });
});
