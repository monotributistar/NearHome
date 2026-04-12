import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app";

let app: FastifyInstance;
const prisma = new PrismaClient();

// Test constants
const TEST_DEVICE_UUID = "12345678-1234-1234-1234-123456789abc";
const TEST_TENANT_ID = "test-tenant-edge-gateway";

// State
let gatewayId: string;
let gatewayApiToken: string;
let adminToken: string;

async function login(email: string, password = "demo1234"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  return res.json().accessToken;
}

describe("Edge Gateway API", () => {
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create test tenant
    await prisma.tenant.upsert({
      where: { id: TEST_TENANT_ID },
      update: {},
      create: { id: TEST_TENANT_ID, name: "Test Tenant for Edge Gateway" }
    });

    // Login as superuser admin
    adminToken = await login("admin@nearhome.dev");
  });

  afterAll(async () => {
    // Cleanup
    await prisma.discoveredCamera.deleteMany({
      where: { tenantId: TEST_TENANT_ID }
    });
    await prisma.edgeGateway.deleteMany({
      where: { tenantId: TEST_TENANT_ID }
    });
    await prisma.tenant.delete({ where: { id: TEST_TENANT_ID } });
    await app.close();
    await prisma.$disconnect();
  });

  describe("POST /api/v1/edge-gateways/register", () => {
    it("should register a new edge gateway", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          balenaDeviceUUID: TEST_DEVICE_UUID,
          balenaAppId: "app-123",
          balenaFleetId: "fleet-456",
          deviceName: "test-gateway-01",
          osVersion: "2.114.0",
          supervisorVersion: "14.0.0",
          tenantId: TEST_TENANT_ID
        }
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toBeDefined();
      expect(body.apiToken).toBeDefined();
      expect(body.tenantId).toBe(TEST_TENANT_ID);
      expect(body.status).toBe("pending");

      gatewayId = body.id;
      gatewayApiToken = body.apiToken;
    });

    it("should reject duplicate device UUID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          balenaDeviceUUID: TEST_DEVICE_UUID,
          deviceName: "duplicate-gateway"
        }
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBe("DEVICE_ALREADY_REGISTERED");
    });

    it("should validate required fields", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/register",
        payload: {
          // Missing balenaDeviceUUID and deviceName
          tenantId: TEST_TENANT_ID
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/edge-gateways/:id/heartbeat", () => {
    it("should accept heartbeat and activate gateway", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId}/heartbeat`,
        headers: { authorization: `Bearer ${gatewayApiToken}` },
        payload: {
          timestamp: new Date().toISOString(),
          supervisorStatus: {
            deviceStatus: "running",
            isOnline: true,
            updateStatus: "up-to-date"
          },
          customMetrics: {
            cpuUsagePercent: 25.5,
            cpuTemperatureCelsius: 45.0,
            memoryUsedBytes: 1024000000,
            memoryTotalBytes: 2048000000,
            discoveredCamerasCount: 3,
            registeredCamerasCount: 1
          },
          version: "1.0.0"
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accepted).toBe(true);
      expect(body.status).toBe("active");
    });

    it("should return 401 without authorization header", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId}/heartbeat`,
        payload: {
          timestamp: new Date().toISOString()
        }
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return 404 for non-existent gateway", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/edge-gateways/non-existent-id/heartbeat",
        headers: { authorization: "Bearer some-token" },
        payload: {
          timestamp: new Date().toISOString()
        }
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/edge-gateways/:id/cameras/discover", () => {
    it("should report discovered cameras", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId}/cameras/discover`,
        headers: { authorization: `Bearer ${gatewayApiToken}` },
        payload: {
          cameras: [
            {
              ipAddress: "192.168.1.100",
              macAddress: "aa:bb:cc:dd:ee:01",
              rtspUrl: "rtsp://192.168.1.100/stream",
              onvifInfo: {
                manufacturer: "Hikvision",
                model: "DS-2CD2043G2",
                firmware: "V5.7.12"
              },
              ports: [554, 80]
            },
            {
              ipAddress: "192.168.1.101",
              macAddress: "aa:bb:cc:dd:ee:02",
              ports: [554]
            }
          ],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discovered).toHaveLength(2);
      expect(body.discovered[0].manufacturer).toBe("Hikvision");
    });

    it("should update existing discovered camera", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/edge-gateways/${gatewayId}/cameras/discover`,
        headers: { authorization: `Bearer ${gatewayApiToken}` },
        payload: {
          cameras: [
            {
              ipAddress: "192.168.1.100",
              macAddress: "aa:bb:cc:dd:ee:01",
              ports: [554]
            }
          ],
          discoveryTimestamp: new Date().toISOString()
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Should not count re-discovered camera as new
      expect(body.discovered).toHaveLength(0);
    });
  });

  describe("GET /api/v1/edge-gateways/:id/cameras", () => {
    it("should list discovered cameras", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId}/cameras`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": TEST_TENANT_ID
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(2);
    });

    it("should filter cameras by status", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/edge-gateways/${gatewayId}/cameras?status=discovered`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": TEST_TENANT_ID
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.every((c: any) => c.status === "discovered")).toBe(true);
    });
  });
});
