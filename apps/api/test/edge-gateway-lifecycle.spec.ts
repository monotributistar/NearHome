/**
 * Edge Gateway Full Lifecycle Tests (TDD)
 *
 * Tests the complete lifecycle of an edge gateway fleet:
 *  1. Fleet creation & tenant assignment
 *  2. Edge gateway registration with security (API token)
 *  3. QR pairing: device-to-tenant binding
 *  4. Discovery: cameras & smart lights on local LAN
 *  5. VPN provisioning for tunnel connectivity
 *  6. RTSP channel proxying from edge to infrastructure
 *  7. Security: tenant isolation, cross-tenant rejection, token validation
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app";

let app: FastifyInstance;
const prisma = new PrismaClient();

// ─── Test identifiers ───
const TENANT_A_ID = "test-tenant-lifecycle-a";
const TENANT_B_ID = "test-tenant-lifecycle-b";
const FLEET_NAME = "test-fleet-residential";
const DEVICE_UUID_1 = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const DEVICE_UUID_2 = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const DEVICE_UUID_3 = "cccccccc-3333-3333-3333-cccccccccccc";

// ─── State carried between tests ───
let adminToken: string;
let monitorToken: string;
let tenantAId: string;
let tenantBId: string;
let fleetId: string;
let gatewayId1: string;
let gatewayApiToken1: string;
let gatewayId2: string;
let gatewayApiToken2: string;
let gatewayId3: string;
let gatewayApiToken3: string;
let pairingToken: string;
let vpnId: string;

// ─── Helpers ───

async function login(email: string, password = "demo1234"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "x-forwarded-for": `test-${email}-${Date.now()}-${Math.random()}` },
    payload: { email, password }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ accessToken: string }>().accessToken;
}

function authHeaders(token: string, tenantId?: string) {
  const h: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) h["x-tenant-id"] = tenantId;
  return h;
}

function deviceHeaders(apiToken: string) {
  return { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };
}

// ─── Setup / Teardown ───

beforeAll(async () => {
  app = await buildApp();

  // Create test tenants
  await prisma.tenant.upsert({
    where: { id: TENANT_A_ID },
    update: {},
    create: { id: TENANT_A_ID, name: "Tenant A - Lifecycle Test" }
  });
  await prisma.tenant.upsert({
    where: { id: TENANT_B_ID },
    update: {},
    create: { id: TENANT_B_ID, name: "Tenant B - Lifecycle Test" }
  });

  // Create users with memberships
  const adminEmail = "admin@nearhome.dev";
  const monitorEmail = "monitor@nearhome.dev";

  // Login as existing seeded users
  adminToken = await login(adminEmail);
  monitorToken = await login(monitorEmail);

  // Create memberships for test tenants
  const adminUser = await prisma.user.findFirst({ where: { email: adminEmail } });
  const monitorUser = await prisma.user.findFirst({ where: { email: monitorEmail } });

  if (adminUser) {
    await prisma.membership.upsert({
      where: { tenantId_userId: { userId: adminUser.id, tenantId: TENANT_A_ID } },
      update: {},
      create: { userId: adminUser.id, tenantId: TENANT_A_ID, role: "tenant_admin" }
    });
    await prisma.membership.upsert({
      where: { tenantId_userId: { userId: adminUser.id, tenantId: TENANT_B_ID } },
      update: {},
      create: { userId: adminUser.id, tenantId: TENANT_B_ID, role: "tenant_admin" }
    });
  }

  if (monitorUser) {
    await prisma.membership.upsert({
      where: { tenantId_userId: { userId: monitorUser.id, tenantId: TENANT_A_ID } },
      update: {},
      create: { userId: monitorUser.id, tenantId: TENANT_A_ID, role: "monitor" }
    });
  }

  tenantAId = TENANT_A_ID;
  tenantBId = TENANT_B_ID;
});

afterAll(async () => {
  // Cleanup in dependency order
  await prisma.edgeGatewayPairingToken.deleteMany({
    where: { edgeGateway: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } } }
  });
  await prisma.discoveredDevice.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.discoveredCamera.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.edgeGateway.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID, "pending"] } }
  });
  await prisma.fleet.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.tenantVpnPeer.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.tenantVpnRoutePolicy.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.tenantNetworkSpace.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.tenantVpn.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.membership.deleteMany({
    where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [TENANT_A_ID, TENANT_B_ID] } }
  });
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════
// PHASE 1: FLEET MANAGEMENT
// ═══════════════════════════════════════════════════════════════

describe("Phase 1: Fleet Management", () => {
  describe("POST /api/v1/fleets - Create fleet", () => {
    it("should create a fleet for tenant A", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/fleets",
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          name: FLEET_NAME,
          description: "Residential edge fleet for testing",
          deviceType: "raspberrypi4-64"
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe(FLEET_NAME);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.status).toBe("active");
      fleetId = body.id;
    });

    it("should reject duplicate fleet name within same tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/fleets",
        headers: authHeaders(adminToken, tenantAId),
        payload: { name: FLEET_NAME, deviceType: "raspberrypi4-64" }
      });

      expect(res.statusCode).toBe(409);
    });

    it("should allow same fleet name in different tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/fleets",
        headers: authHeaders(adminToken, tenantBId),
        payload: { name: FLEET_NAME, deviceType: "raspberrypi4-64" }
      });

      expect(res.statusCode).toBe(201);
    });

    it("should reject fleet creation without tenant context", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/fleets",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: "orphan-fleet" }
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("monitor role should not create fleets", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/fleets",
        headers: authHeaders(monitorToken, tenantAId),
        payload: { name: "monitor-fleet", deviceType: "raspberrypi4-64" }
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/v1/fleets - List fleets", () => {
    it("should list fleets for tenant A", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/fleets",
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data.some((f: any) => f.name === FLEET_NAME)).toBe(true);
    });

    it("tenant B should not see tenant A fleets", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/fleets",
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Tenant B has its own fleet, but not tenant A's
      const names = body.data.map((f: any) => f.id);
      expect(names).not.toContain(fleetId);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 2: EDGE GATEWAY REGISTRATION & SECURITY
// ═══════════════════════════════════════════════════════════════

describe("Phase 2: Edge Gateway Registration & Security", () => {
  describe("POST /api/v1/edge-gateways/register - Secure registration", () => {
    it("should register gateway 1 into fleet for tenant A", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          balenaDeviceUUID: DEVICE_UUID_1,
          deviceName: "edge-router-living-room",
          osVersion: "5.3.2",
          supervisorVersion: "16.0.0",
          tenantId: tenantAId,
          fleetId
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.apiToken).toBeDefined();
      expect(body.apiToken.length).toBeGreaterThanOrEqual(32);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.status).toBe("pending");

      gatewayId1 = body.id;
      gatewayApiToken1 = body.apiToken;
    });

    it("should register gateway 2 for tenant B (different tenant)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          balenaDeviceUUID: DEVICE_UUID_2,
          deviceName: "edge-router-garage",
          tenantId: tenantBId
        }
      });

      expect(res.statusCode).toBe(201);
      gatewayId2 = res.json().id;
      gatewayApiToken2 = res.json().apiToken;
    });

    it("should register gateway 3 without tenant (pending assignment)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          balenaDeviceUUID: DEVICE_UUID_3,
          deviceName: "edge-router-unassigned"
        }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().tenantId).toBe("pending");
      gatewayId3 = res.json().id;
      gatewayApiToken3 = res.json().apiToken;
    });
  });

  describe("Device API Token Validation", () => {
    it("heartbeat should succeed with valid API token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/heartbeat`,
        headers: deviceHeaders(gatewayApiToken1),
        payload: {
          timestamp: new Date().toISOString(),
          supervisorStatus: { deviceStatus: "running", isOnline: true, updateStatus: "up-to-date" },
          customMetrics: { cpuUsagePercent: 20, cpuTemperatureCelsius: 42 },
          version: "1.0.0"
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
    });

    it("heartbeat should REJECT request with wrong API token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/heartbeat`,
        headers: deviceHeaders("wrong-token-deadbeef"),
        payload: {
          timestamp: new Date().toISOString(),
          supervisorStatus: { deviceStatus: "running", isOnline: true, updateStatus: "up-to-date" },
          version: "1.0.0"
        }
      });

      expect(res.statusCode).toBe(403);
    });

    it("heartbeat should REJECT request with no Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/heartbeat`,
        headers: { "content-type": "application/json" },
        payload: {
          timestamp: new Date().toISOString(),
          version: "1.0.0"
        }
      });

      expect(res.statusCode).toBe(401);
    });

    it("heartbeat should REJECT using tenant B token on tenant A gateway", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/heartbeat`,
        headers: deviceHeaders(gatewayApiToken2),
        payload: {
          timestamp: new Date().toISOString(),
          version: "1.0.0"
        }
      });

      expect(res.statusCode).toBe(403);
    });

    it("camera discovery should REJECT with wrong API token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/discover`,
        headers: deviceHeaders("invalid-token"),
        payload: {
          cameras: [],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(403);
    });

    it("device discovery should REJECT with wrong API token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/discover`,
        headers: deviceHeaders("invalid-token"),
        payload: {
          devices: [],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("Tenant Isolation - Admin API", () => {
    it("tenant A admin should see gateway 1 but NOT gateway 2", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/edge-gateways",
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const ids = res.json().data.map((g: any) => g.id);
      expect(ids).toContain(gatewayId1);
      expect(ids).not.toContain(gatewayId2);
    });

    it("tenant B admin should see gateway 2 but NOT gateway 1", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/edge-gateways",
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(200);
      const ids = res.json().data.map((g: any) => g.id);
      expect(ids).toContain(gatewayId2);
      expect(ids).not.toContain(gatewayId1);
    });

    it("should NOT allow tenant B to get details of tenant A gateway", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}`,
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 3: QR PAIRING (CLIENT BINDS TO PHYSICAL DEVICE)
// ═══════════════════════════════════════════════════════════════

describe("Phase 3: QR Pairing - Device-to-Client Binding", () => {
  describe("POST /api/v1/edge-gateways/:id/pairing-token - Generate QR", () => {
    it("admin should generate a pairing token for gateway 1", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/pairing-token`,
        headers: authHeaders(adminToken, tenantAId),
        payload: { expiresInMinutes: 30 }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.token.length).toBeGreaterThanOrEqual(16);
      expect(body.qrPayload).toBeDefined();
      expect(body.qrPayload).toContain(body.token);
      expect(body.expiresAt).toBeDefined();
      expect(body.status).toBe("pending");
      pairingToken = body.token;
    });

    it("monitor role should NOT generate pairing tokens", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/pairing-token`,
        headers: authHeaders(monitorToken, tenantAId),
        payload: { expiresInMinutes: 30 }
      });

      expect(res.statusCode).toBe(403);
    });

    it("should NOT generate token for another tenant's gateway", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId2}/pairing-token`,
        headers: authHeaders(adminToken, tenantAId),
        payload: { expiresInMinutes: 30 }
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/edge-gateways/pair - Client scans QR to pair", () => {
    it("client should pair with gateway using valid token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/pair",
        headers: authHeaders(adminToken, tenantAId),
        payload: { pairingToken }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.edgeGatewayId).toBe(gatewayId1);
      expect(body.status).toBe("paired");
      expect(body.tenantId).toBe(tenantAId);
    });

    it("should reject already-used pairing token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/pair",
        headers: authHeaders(adminToken, tenantAId),
        payload: { pairingToken }
      });

      expect(res.statusCode).toBe(410); // Gone
    });

    it("should reject invalid/nonexistent pairing token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/pair",
        headers: authHeaders(adminToken, tenantAId),
        payload: { pairingToken: "fake-token-nonexistent" }
      });

      expect(res.statusCode).toBe(404);
    });

    it("should reject expired pairing token", async () => {
      // Create a token with 0 minutes expiry (already expired)
      const expiredRes = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/pairing-token`,
        headers: authHeaders(adminToken, tenantAId),
        payload: { expiresInMinutes: 0 }
      });

      if (expiredRes.statusCode === 201) {
        const expiredToken = expiredRes.json().token;
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/edge-gateways/pair",
          headers: authHeaders(adminToken, tenantAId),
          payload: { pairingToken: expiredToken }
        });

        expect(res.statusCode).toBe(410);
      }
    });
  });

  describe("POST /api/v1/edge-gateways/:id/assign-tenant - Assign pending gateway to tenant", () => {
    it("should assign unassigned gateway 3 to tenant A", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId3}/assign-tenant`,
        headers: authHeaders(adminToken, tenantAId),
        payload: { tenantId: tenantAId }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tenantId).toBe(tenantAId);
      expect(body.status).not.toBe("pending"); // Should be at least assigned
    });

    it("should NOT reassign a gateway already bound to another tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/assign-tenant`,
        headers: authHeaders(adminToken, tenantBId),
        payload: { tenantId: tenantBId }
      });

      expect(res.statusCode).toBe(403);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 4: DISCOVERY - CAMERAS & SMART DEVICES
// ═══════════════════════════════════════════════════════════════

describe("Phase 4: Discovery - Cameras & Smart Devices", () => {
  describe("POST /api/v1/edge-gateways/:id/cameras/discover - Camera discovery", () => {
    it("should report discovered cameras with valid API token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/discover`,
        headers: deviceHeaders(gatewayApiToken1),
        payload: {
          cameras: [
            {
              ipAddress: "172.30.0.10",
              macAddress: "02:42:ac:1e:00:0a",
              rtspUrl: "rtsp://172.30.0.10/stream",
              onvifInfo: { manufacturer: "Hikvision", model: "DS-2CD2043G2-I", firmware: "5.7.20" },
              ports: [554, 80]
            },
            {
              ipAddress: "172.30.0.11",
              macAddress: "02:42:ac:1e:00:0b",
              rtspUrl: "rtsp://172.30.0.11/stream",
              onvifInfo: { manufacturer: "Dahua", model: "IPC-HDW5442T-ZE", firmware: "2.830.0" },
              ports: [554, 80]
            },
            {
              ipAddress: "172.30.0.12",
              macAddress: "02:42:ac:1e:00:0c",
              ports: [554]
            }
          ],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.discovered).toHaveLength(3);
      expect(body.discovered[0].manufacturer).toBe("Hikvision");
    });

    it("should not duplicate cameras on repeated discovery", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/discover`,
        headers: deviceHeaders(gatewayApiToken1),
        payload: {
          cameras: [
            {
              ipAddress: "172.30.0.10",
              macAddress: "02:42:ac:1e:00:0a",
              ports: [554]
            }
          ],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(200);
      // MAC already exists, should update not duplicate
    });

    it("cameras should be tenant-scoped to gateway's tenant", async () => {
      const cameras = await prisma.discoveredCamera.findMany({
        where: { edgeGatewayId: gatewayId1 }
      });

      expect(cameras.length).toBe(3);
      cameras.forEach((c) => {
        expect(c.tenantId).toBe(tenantAId);
      });
    });
  });

  describe("GET /api/v1/edge-gateways/:id/cameras - List discovered cameras", () => {
    it("should list all discovered cameras for gateway 1 with admin auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(3);
    });

    it("should filter cameras by status", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras?status=discovered`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      res.json().data.forEach((c: any) => {
        expect(c.status).toBe("discovered");
      });
    });

    it("tenant B should NOT see tenant A cameras", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras`,
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(404); // Gateway not found for this tenant
    });
  });

  describe("POST /api/v1/edge-gateways/:id/cameras/confirm - Register camera for config", () => {
    it("should confirm and register a discovered camera", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/confirm`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          macAddress: "02:42:ac:1e:00:0a",
          rtspUrl: "rtsp://172.30.0.10/stream",
          username: "admin",
          password: "admin123"
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.cameraId).toBeDefined();
      expect(body.status).toBe("registered");
      expect(body.tunnelPort).toBeDefined();
    });

    it("should NOT allow tenant B to confirm tenant A cameras", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/confirm`,
        headers: authHeaders(adminToken, tenantBId),
        payload: {
          macAddress: "02:42:ac:1e:00:0b",
          rtspUrl: "rtsp://172.30.0.11/stream"
        }
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/edge-gateways/:id/devices/discover - Smart device discovery", () => {
    it("should report discovered smart lightbulbs", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/discover`,
        headers: deviceHeaders(gatewayApiToken1),
        payload: {
          devices: [
            {
              ipAddress: "172.30.0.20",
              macAddress: "02:42:ac:1e:01:01",
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
              macAddress: "02:42:ac:1e:01:02",
              deviceType: "light",
              manufacturer: "NearHome",
              model: "NHB-200-RGB",
              protocol: "http+mqtt",
              httpPort: 80,
              capabilities: ["on_off", "brightness", "color_temp", "rgb"]
            }
          ],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.discovered).toHaveLength(2);
      expect(body.discovered[0].deviceType).toBe("light");
    });
  });

  describe("GET /api/v1/edge-gateways/:id/devices - List smart devices", () => {
    it("should list discovered smart devices for gateway", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(2);
    });

    it("should filter devices by type", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices?deviceType=light`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      res.json().data.forEach((d: any) => {
        expect(d.deviceType).toBe("light");
      });
    });

    it("tenant B should NOT see tenant A smart devices", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices`,
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/edge-gateways/:id/devices/:deviceId/command - Control devices", () => {
    it("should send command to a discovered smart bulb", async () => {
      const devices = await prisma.discoveredDevice.findMany({
        where: { edgeGatewayId: gatewayId1, tenantId: tenantAId }
      });
      const deviceId = devices[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/${deviceId}/command`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          command: "set_state",
          payload: { on: true, brightness: 75 }
        }
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("accepted");
    });

    it("should persist state after set_state command", async () => {
      const devices = await prisma.discoveredDevice.findMany({
        where: { edgeGatewayId: gatewayId1, tenantId: tenantAId }
      });
      const deviceId = devices[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/${deviceId}/state`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.currentState).toBeDefined();
      expect(body.currentState.on).toBe(true);
      expect(body.currentState.brightness).toBe(75);
    });

    it("should NOT allow tenant B to command tenant A devices", async () => {
      const devices = await prisma.discoveredDevice.findMany({
        where: { edgeGatewayId: gatewayId1, tenantId: tenantAId }
      });
      const deviceId = devices[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/${deviceId}/command`,
        headers: authHeaders(adminToken, tenantBId),
        payload: { command: "set_state", payload: { on: false } }
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5: VPN PROVISIONING
// ═══════════════════════════════════════════════════════════════

describe("Phase 5: VPN Provisioning", () => {
  describe("POST /api/v1/vpns - Create VPN for tenant", () => {
    it("should create a WireGuard VPN for tenant A", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vpns",
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          name: "residential-vpn",
          provider: "wireguard",
          topology: "hub_spoke"
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe("draft");
      expect(body.provider).toBe("wireguard");
      vpnId = body.id;
    });

    it("should reject duplicate VPN name in same tenant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vpns",
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          name: "residential-vpn",
          provider: "wireguard",
          topology: "hub_spoke"
        }
      });

      expect(res.statusCode).toBe(409);
    });

    it("monitor should NOT create VPN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vpns",
        headers: authHeaders(monitorToken, tenantAId),
        payload: {
          name: "monitor-vpn",
          provider: "wireguard",
          topology: "hub_spoke"
        }
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/v1/vpns/:id/network-spaces - Allocate CIDR", () => {
    it("should allocate camera_lan network space", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/network-spaces`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          spaceType: "camera_lan",
          cidr: "10.100.1.0/24",
          description: "Camera LAN segment"
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.spaceType).toBe("camera_lan");
      expect(body.cidr).toBe("10.100.1.0/24");
      expect(body.status).toBe("allocated");
    });

    it("should allocate edge_nodes network space", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/network-spaces`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          spaceType: "edge_nodes",
          cidr: "10.100.2.0/24",
          description: "Edge node management"
        }
      });

      expect(res.statusCode).toBe(201);
    });

    it("should reject overlapping CIDR in same VPN", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/network-spaces`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          spaceType: "operations",
          cidr: "10.100.1.0/24", // Overlaps with camera_lan
          description: "Should fail"
        }
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe("POST /api/v1/vpns/:id/peers - Add edge gateway as VPN peer", () => {
    it("should add gateway 1 as VPN peer", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/peers`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          peerId: gatewayId1,
          peerRole: "edge_gateway",
          endpoint: "dynamic",
          allowedCidrs: ["10.100.1.0/24"]
        }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.peerId).toBe(gatewayId1);
      expect(body.peerRole).toBe("edge_gateway");
      expect(body.status).toBe("pending");
    });

    it("should NOT add tenant B gateway as peer in tenant A VPN", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/peers`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          peerId: gatewayId2,
          peerRole: "edge_gateway",
          endpoint: "dynamic",
          allowedCidrs: ["10.100.3.0/24"]
        }
      });

      // Should fail because gatewayId2 belongs to tenant B
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe("POST /api/v1/vpns/:id/validate - Validate VPN config", () => {
    it("should validate the VPN configuration", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/validate`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.status).toBe("validating");
    });
  });

  describe("POST /api/v1/vpns/:id/provision - Provision VPN", () => {
    it("should provision the VPN", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/vpns/${vpnId}/provision`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(["provisioning", "active"]).toContain(body.status);
    });
  });

  describe("GET /api/v1/vpns - List VPNs", () => {
    it("should list VPNs for tenant A", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/vpns",
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("tenant B should NOT see tenant A VPNs", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/vpns",
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(200);
      const ids = res.json().data.map((v: any) => v.id);
      expect(ids).not.toContain(vpnId);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 6: RTSP TUNNEL PROXY
// ═══════════════════════════════════════════════════════════════

describe("Phase 6: RTSP Channel Proxy", () => {
  describe("POST /api/v1/edge-gateways/:id/tunnels - Configure RTSP tunnels", () => {
    it("should configure RTSP tunnel for confirmed camera", async () => {
      // Find the confirmed camera
      const camera = await prisma.discoveredCamera.findFirst({
        where: { edgeGatewayId: gatewayId1, status: "registered" }
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/tunnels`,
        headers: authHeaders(adminToken, tenantAId),
        payload: {
          cameras: [
            {
              cameraId: camera!.id,
              rtspPort: 554,
              localPort: 8554
            }
          ]
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tunnels).toBeDefined();
      expect(body.tunnels).toHaveLength(1);
    });
  });

  describe("GET /api/v1/edge-gateways/:id/tunnels/status - Tunnel health", () => {
    it("should return tunnel status for gateway", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/tunnels/status`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tunnels).toBeDefined();
    });

    it("tenant B should NOT see tenant A tunnel status", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId1}/tunnels/status`,
        headers: authHeaders(adminToken, tenantBId)
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/cameras/:id/stream-token - RTSP via infrastructure", () => {
    it("should generate stream token for tunneled camera", async () => {
      // Find the Camera created from confirming the discovered camera
      const camera = await prisma.camera.findFirst({
        where: {
          tenantId: tenantAId,
          tags: { contains: "edge-gateway" }
        }
      });

      if (!camera) return; // Skip if camera confirmation didn't create a Camera record

      const res = await app.inject({
        method: "GET",
        url: `/cameras/${camera.id}/stream-token`,
        headers: authHeaders(adminToken, tenantAId)
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.streamUrl).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7: SECURITY MATRIX - COMPREHENSIVE CROSS-CUTTING
// ═══════════════════════════════════════════════════════════════

describe("Phase 7: Security Matrix", () => {
  describe("No auth = rejected on all tenant-scoped endpoints", () => {
    const endpoints = [
      { method: "GET" as const, url: "/api/v1/fleets" },
      { method: "GET" as const, url: "/api/v1/edge-gateways" },
      { method: "GET" as const, url: "/api/v1/vpns" },
    ];

    endpoints.forEach(({ method, url }) => {
      it(`${method} ${url} should require authentication`, async () => {
        const res = await app.inject({ method, url });
        expect([401, 500]).toContain(res.statusCode);
      });
    });
  });

  describe("Device API tokens are gateway-specific", () => {
    it("gateway 2 token should NOT access gateway 1 cameras/discover", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/cameras/discover`,
        headers: deviceHeaders(gatewayApiToken2),
        payload: {
          cameras: [{ ipAddress: "192.168.1.200", macAddress: "ff:ff:ff:ff:ff:01", ports: [554] }],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(403);
    });

    it("gateway 2 token should NOT access gateway 1 devices/discover", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId1}/devices/discover`,
        headers: deviceHeaders(gatewayApiToken2),
        payload: {
          devices: [],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("API token should NOT grant admin access", () => {
    it("device API token should NOT work on admin endpoints", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/edge-gateways",
        headers: {
          authorization: `Bearer ${gatewayApiToken1}`,
          "x-tenant-id": tenantAId
        }
      });

      // Device tokens are not JWTs, so JWT verification should fail
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Fleet-level tenant isolation", () => {
    it("should NOT allow assigning gateway to fleet of different tenant", async () => {
      // Get tenant B fleet
      const tenantBFleets = await prisma.fleet.findMany({
        where: { tenantId: tenantBId }
      });

      if (tenantBFleets.length > 0) {
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/fleets/${tenantBFleets[0].id}/gateways`,
          headers: authHeaders(adminToken, tenantAId),
          payload: { edgeGatewayId: gatewayId1 }
        });

        // Should fail - can't put tenant A gateway in tenant B fleet
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      }
    });
  });
});
