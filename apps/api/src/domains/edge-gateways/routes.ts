import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { getTenantContext } from "../../core/utils.js";
import { NotFoundError } from "../../core/types.js";
import { BalenaFleetService } from "./balena.service.js";

export type EdgeGatewaysPluginOptions = { middleware: AppMiddleware; balenaApiUrl: string | null; balenaApiKey: string | null };

export const edgeGatewaysPlugin: FastifyPluginAsync<EdgeGatewaysPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;

  // Device-auth middleware: validates gateway API token from Authorization header
  const deviceAuthPreHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Missing or invalid Authorization header" });
    }
    const token = authHeader.slice(7);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const gateway = await prisma.edgeGateway.findUnique({ where: { id } });
    if (!gateway) {
      return reply.status(404).send({ error: "NOT_FOUND", message: "Edge gateway not found" });
    }
    if (!gateway.apiToken || gateway.apiToken !== token) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "Invalid device API token" });
    }
    (request as any).edgeGateway = gateway;
  };

  // Role-checking middleware for tenant-scoped admin endpoints
  const requireRole = (...roles: string[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await tenantScopedPreHandler(request);
      const ctx = getTenantContext(request);
      if (ctx.role && !roles.includes(ctx.role)) {
        return reply.status(403).send({ error: "FORBIDDEN", message: `Requires one of: ${roles.join(", ")}` });
      }
    };
  };

  app.post("/api/v1/edge-gateways/register", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      balenaDeviceUUID: z.string().uuid(),
      balenaAppId: z.string().optional(),
      balenaFleetId: z.string().optional(),
      deviceName: z.string().min(1).max(100),
      osVersion: z.string().optional(),
      supervisorVersion: z.string().optional(),
      tenantId: z.string().optional(),
      networkConfig: z.object({ type: z.enum(["ethernet", "wifi"]), ssid: z.string().optional(), password: z.string().optional(), security: z.enum(["wpa2", "wpa3", "wpa2-enterprise"]).optional() }).optional()
    }).parse(request.body);

    const existing = await prisma.edgeGateway.findUnique({ where: { balenaDeviceUUID: body.balenaDeviceUUID } });
    if (existing) return reply.status(409).send({ error: "DEVICE_ALREADY_REGISTERED", message: "Device with this UUID is already registered" });

    const apiToken = randomBytes(32).toString("hex");
    const edgeGateway = await prisma.edgeGateway.create({
      data: { balenaDeviceUUID: body.balenaDeviceUUID, balenaAppId: body.balenaAppId, balenaFleetId: body.balenaFleetId, deviceName: body.deviceName, osVersion: body.osVersion, supervisorVersion: body.supervisorVersion, tenantId: body.tenantId ?? "pending", status: "pending", apiToken, networkConfig: body.networkConfig ? JSON.stringify(body.networkConfig) : null }
    });
    return reply.status(201).send({ id: edgeGateway.id, apiToken: edgeGateway.apiToken, tenantId: edgeGateway.tenantId, status: edgeGateway.status });
  });

  app.get("/api/v1/edge-gateways", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const edgeGateways = await prisma.edgeGateway.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { registeredAt: "desc" } });
    return { data: edgeGateways };
  });

  app.get("/api/v1/edge-gateways/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId }, include: { discoveredCameras: { orderBy: { lastSeenAt: "desc" } } } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");
    return { data: edgeGateway };
  });

  app.post("/api/v1/edge-gateways/:id/heartbeat", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findUnique({ where: { id } });
    if (!edgeGateway) return reply.status(404).send({ error: "NOT_FOUND", message: "Edge gateway not found" });

    const body = z.object({
      timestamp: z.string().datetime(),
      supervisorStatus: z.object({ deviceStatus: z.string(), isOnline: z.boolean(), updateStatus: z.string(), supervisorVersion: z.string().optional(), osVersion: z.string().optional() }).optional(),
      customMetrics: z.object({ cpuUsagePercent: z.number(), cpuTemperatureCelsius: z.number(), memoryUsedBytes: z.number().optional(), memoryTotalBytes: z.number().optional(), vpnLatencyMs: z.number().optional(), tunnelStatus: z.object({ activeTunnels: z.number(), failedTunnels: z.number(), lastFailure: z.string().optional() }).optional(), discoveredCamerasCount: z.number(), registeredCamerasCount: z.number() }).optional(),
      version: z.string().optional()
    }).parse(request.body);

    const updated = await prisma.edgeGateway.update({ where: { id }, data: { lastHeartbeatAt: new Date(body.timestamp), latestMetrics: body.customMetrics ? JSON.stringify(body.customMetrics) : null, status: edgeGateway.status === "pending" ? "active" : edgeGateway.status, activatedAt: edgeGateway.status === "pending" ? new Date() : undefined } });
    return reply.send({ accepted: true, nextHeartbeatIntervalSeconds: 30, status: updated.status });
  });

  app.post("/api/v1/edge-gateways/:id/cameras/discover", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findUnique({ where: { id } });
    if (!edgeGateway) return reply.status(404).send({ error: "NOT_FOUND", message: "Edge gateway not found" });

    const body = z.object({
      cameras: z.array(z.object({ ipAddress: z.string().ip(), macAddress: z.string(), rtspUrl: z.string().optional(), onvifInfo: z.object({ manufacturer: z.string(), model: z.string(), firmware: z.string() }).optional(), ports: z.array(z.number()).optional() })),
      discoveryTimestamp: z.string().datetime()
    }).parse(request.body);

    const discovered: Array<{ ipAddress: string; macAddress: string; manufacturer?: string; model?: string }> = [];
    const alreadyRegistered: Array<{ ipAddress: string; macAddress: string; cameraId: string }> = [];

    for (const camera of body.cameras) {
      const existing = await prisma.discoveredCamera.findUnique({ where: { macAddress: camera.macAddress } });
      if (existing && existing.status !== "discovered") {
        alreadyRegistered.push({ ipAddress: camera.ipAddress, macAddress: camera.macAddress, cameraId: existing.id });
        continue;
      }
      await prisma.discoveredCamera.upsert({
        where: { macAddress: camera.macAddress },
        create: { edgeGatewayId: id, tenantId: edgeGateway.tenantId, macAddress: camera.macAddress, ipAddress: camera.ipAddress, hostname: camera.rtspUrl ? new URL(camera.rtspUrl).hostname : undefined, manufacturer: camera.onvifInfo?.manufacturer, model: camera.onvifInfo?.model, firmwareVersion: camera.onvifInfo?.firmware, rtspPort: camera.ports?.find((p) => p === 554 || p === 8554), onvifPort: camera.ports?.find((p) => p === 80 || p === 8000), status: "discovered", lastSeenAt: new Date(body.discoveryTimestamp) },
        update: { ipAddress: camera.ipAddress, manufacturer: camera.onvifInfo?.manufacturer, model: camera.onvifInfo?.model, firmwareVersion: camera.onvifInfo?.firmware, lastSeenAt: new Date(body.discoveryTimestamp), status: "discovered" }
      });
      discovered.push({ ipAddress: camera.ipAddress, macAddress: camera.macAddress, manufacturer: camera.onvifInfo?.manufacturer, model: camera.onvifInfo?.model });
    }
    return reply.send({ discovered, alreadyRegistered });
  });

  app.post("/api/v1/edge-gateways/:id/cameras/confirm", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");

    const body = z.object({ macAddress: z.string(), rtspUrl: z.string().url(), username: z.string().optional(), password: z.string().optional() }).parse(request.body);
    const discoveredCamera = await prisma.discoveredCamera.findFirst({ where: { macAddress: body.macAddress, edgeGatewayId: id, tenantId: ctx.tenantId } });
    if (!discoveredCamera) return reply.status(404).send({ error: "CAMERA_NOT_FOUND", message: "Discovered camera not found for this gateway" });

    const updated = await prisma.discoveredCamera.update({ where: { id: discoveredCamera.id }, data: { rtspUrl: body.rtspUrl, username: body.username, passwordEncrypted: body.password ? Buffer.from(body.password).toString("base64") : null, status: "registered", tunnelPort: 8554 + Math.floor(Math.random() * 1000) } });
    const camera = await prisma.camera.create({ data: { tenantId: ctx.tenantId, name: `${discoveredCamera.manufacturer ?? "Camera"} ${discoveredCamera.model ?? discoveredCamera.macAddress.slice(-5)}`, rtspUrl: body.rtspUrl, location: discoveredCamera.ipAddress, tags: JSON.stringify(["edge-gateway", "discovered"]), isActive: true, lifecycleStatus: "provisioning" } });
    return reply.status(201).send({ cameraId: camera.id, discoveredCameraId: updated.id, status: "registered", tunnelPort: updated.tunnelPort });
  });

  app.get("/api/v1/edge-gateways/:id/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { status } = z.object({ status: z.enum(["discovered", "pending", "registered"]).optional() }).parse(request.query);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");
    const cameras = await prisma.discoveredCamera.findMany({ where: { edgeGatewayId: id, tenantId: ctx.tenantId, ...(status ? { status } : {}) }, orderBy: { lastSeenAt: "desc" } });
    return { data: cameras };
  });

  app.post("/api/v1/edge-gateways/:id/tunnels", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");
    const body = z.object({ cameras: z.array(z.object({ cameraId: z.string(), rtspPort: z.number().min(1).max(65535), localPort: z.number().min(8000).max(9000) })) }).parse(request.body);
    const configured: Array<{ cameraId: string; localPort: number; status: string; error?: string }> = [];
    for (const cam of body.cameras) {
      const discovered = await prisma.discoveredCamera.findFirst({ where: { id: cam.cameraId, edgeGatewayId: id, tenantId: ctx.tenantId } });
      if (!discovered) { configured.push({ cameraId: cam.cameraId, localPort: cam.localPort, status: "failed", error: "Camera not found" }); continue; }
      await prisma.discoveredCamera.update({ where: { id: discovered.id }, data: { tunnelPort: cam.localPort } });
      configured.push({ cameraId: cam.cameraId, localPort: cam.localPort, status: "active" });
    }
    return { configured };
  });

  app.get("/api/v1/edge-gateways/:id/tunnels/status", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");
    const cameras = await prisma.discoveredCamera.findMany({ where: { edgeGatewayId: id, tenantId: ctx.tenantId, status: "registered" } });
    return { tunnels: cameras.map((c) => ({ cameraId: c.id, localPort: c.tunnelPort, status: c.lastSeenAt && Date.now() - new Date(c.lastSeenAt).getTime() < 300000 ? "active" : "disconnected", lastHealthCheck: c.lastSeenAt?.toISOString() })) };
  });

  app.delete("/api/v1/edge-gateways/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const edgeGateway = await prisma.edgeGateway.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!edgeGateway) throw new NotFoundError("Edge gateway not found");
    await prisma.edgeGateway.update({ where: { id }, data: { status: "decommissioned" } });
    await prisma.discoveredCamera.updateMany({ where: { edgeGatewayId: id }, data: { status: "offline" } });
    return reply.status(204).send();
  });

  // ============================================
  // Fleet Management Routes
  // ============================================

  // POST /api/v1/fleets - Create a fleet
  app.post(
    "/api/v1/fleets",
    { preHandler: requireRole("tenant_admin", "super_admin") },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      const body = z
        .object({
          name: z.string().min(1).max(100),
          description: z.string().optional(),
          deviceType: z.string().default("raspberrypi4-64")
        })
        .parse(request.body);

      const existing = await prisma.fleet.findFirst({
        where: { tenantId: ctx.tenantId, name: body.name }
      });
      if (existing) {
        return reply.status(409).send({ error: "DUPLICATE_FLEET", message: "Fleet with this name already exists for this tenant" });
      }

      const fleet = await prisma.fleet.create({
        data: {
          tenantId: ctx.tenantId,
          name: body.name,
          description: body.description,
          deviceType: body.deviceType,
          status: "active"
        }
      });

      return reply.status(201).send(fleet);
    }
  );

  // GET /api/v1/fleets - List fleets
  app.get(
    "/api/v1/fleets",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest) => {
      const ctx = getTenantContext(request);
      const fleets = await prisma.fleet.findMany({
        where: { tenantId: ctx.tenantId },
        include: { _count: { select: { gateways: true } } },
        orderBy: { createdAt: "desc" }
      });
      return { data: fleets };
    }
  );

  // GET /api/v1/fleets/:id - Get fleet details
  app.get(
    "/api/v1/fleets/:id",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest) => {
      const ctx = getTenantContext(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const fleet = await prisma.fleet.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: { gateways: true }
      });
      if (!fleet) throw new NotFoundError("Fleet not found");
      return fleet;
    }
  );

  // POST /api/v1/fleets/:id/gateways - Add gateway to fleet
  app.post(
    "/api/v1/fleets/:id/gateways",
    { preHandler: requireRole("tenant_admin", "super_admin") },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ edgeGatewayId: z.string() }).parse(request.body);

      const fleet = await prisma.fleet.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!fleet) throw new NotFoundError("Fleet not found");

      const gateway = await prisma.edgeGateway.findFirst({
        where: { id: body.edgeGatewayId, tenantId: ctx.tenantId }
      });
      if (!gateway) {
        return reply.status(400).send({ error: "INVALID_GATEWAY", message: "Gateway not found or belongs to different tenant" });
      }

      const updated = await prisma.edgeGateway.update({
        where: { id: body.edgeGatewayId },
        data: { fleetId: id }
      });

      return { edgeGatewayId: updated.id, fleetId: id };
    }
  );

  // ============================================
  // Smart Device Discovery Routes
  // ============================================

  // POST /api/v1/edge-gateways/:id/devices/discover - Gateway reports discovered IoT devices
  app.post(
    "/api/v1/edge-gateways/:id/devices/discover",
    { preHandler: deviceAuthPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const edgeGateway = await prisma.edgeGateway.findUnique({ where: { id } });
      if (!edgeGateway) {
        return reply.status(404).send({ error: "NOT_FOUND", message: "Edge gateway not found" });
      }

      if (!edgeGateway.tenantId) {
        return reply.status(409).send({
          error: "GATEWAY_UNASSIGNED",
          message: "Gateway must be assigned to a tenant before reporting device discoveries"
        });
      }

      const tenantId = edgeGateway.tenantId;

      const body = z
        .object({
          devices: z.array(
            z.object({
              ipAddress: z.string().ip(),
              macAddress: z.string(),
              deviceType: z.string(),
              manufacturer: z.string().optional(),
              model: z.string().optional(),
              firmwareVersion: z.string().optional(),
              protocol: z.string().optional(),
              httpPort: z.number().optional(),
              mqttTopic: z.string().optional(),
              capabilities: z.array(z.string()).optional()
            })
          ),
          discoveryTimestamp: z.string().datetime()
        })
        .parse(request.body);

      const discovered: Array<{ ipAddress: string; macAddress: string; deviceType: string }> = [];
      const alreadyRegistered: Array<{ ipAddress: string; macAddress: string; deviceId: string }> = [];

      for (const device of body.devices) {
        const existing = await prisma.discoveredDevice.findUnique({
          where: { macAddress: device.macAddress }
        });

        if (existing && existing.status !== "discovered") {
          alreadyRegistered.push({
            ipAddress: device.ipAddress,
            macAddress: device.macAddress,
            deviceId: existing.id
          });
          continue;
        }

        await prisma.discoveredDevice.upsert({
          where: { macAddress: device.macAddress },
          create: {
            edgeGatewayId: id,
            tenantId,
            deviceType: device.deviceType,
            macAddress: device.macAddress,
            ipAddress: device.ipAddress,
            manufacturer: device.manufacturer,
            model: device.model,
            firmwareVersion: device.firmwareVersion,
            protocol: device.protocol,
            httpPort: device.httpPort,
            mqttTopic: device.mqttTopic,
            capabilities: device.capabilities ? JSON.stringify(device.capabilities) : null,
            status: "discovered",
            lastSeenAt: new Date(body.discoveryTimestamp)
          },
          update: {
            ipAddress: device.ipAddress,
            manufacturer: device.manufacturer,
            model: device.model,
            firmwareVersion: device.firmwareVersion,
            protocol: device.protocol,
            httpPort: device.httpPort,
            capabilities: device.capabilities ? JSON.stringify(device.capabilities) : null,
            lastSeenAt: new Date(body.discoveryTimestamp),
            status: "discovered"
          }
        });

        discovered.push({
          ipAddress: device.ipAddress,
          macAddress: device.macAddress,
          deviceType: device.deviceType
        });
      }

      return reply.send({ discovered, alreadyRegistered });
    }
  );

  // GET /api/v1/edge-gateways/:id/devices - List discovered smart devices
  app.get(
    "/api/v1/edge-gateways/:id/devices",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest) => {
      const ctx = getTenantContext(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          status: z.enum(["discovered", "pending", "registered", "offline"]).optional(),
          deviceType: z.string().optional()
        })
        .parse(request.query);

      const edgeGateway = await prisma.edgeGateway.findFirst({
        where: { id, tenantId: ctx.tenantId }
      });
      if (!edgeGateway) throw new NotFoundError("Edge gateway not found");

      const devices = await prisma.discoveredDevice.findMany({
        where: {
          edgeGatewayId: id,
          tenantId: ctx.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.deviceType ? { deviceType: query.deviceType } : {})
        },
        orderBy: { lastSeenAt: "desc" }
      });

      return { data: devices };
    }
  );

  // POST /api/v1/edge-gateways/:id/devices/:deviceId/command - Send command to device
  app.post(
    "/api/v1/edge-gateways/:id/devices/:deviceId/command",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      const { id, deviceId } = z.object({ id: z.string(), deviceId: z.string() }).parse(request.params);

      const device = await prisma.discoveredDevice.findFirst({
        where: { id: deviceId, edgeGatewayId: id, tenantId: ctx.tenantId }
      });
      if (!device) throw new NotFoundError("Device not found");

      const body = z
        .object({
          command: z.string(),
          payload: z.record(z.unknown()).optional()
        })
        .parse(request.body);

      if (body.command === "set_state" && body.payload) {
        const currentState = device.currentState ? JSON.parse(device.currentState) : {};
        const newState = { ...currentState, ...body.payload };
        await prisma.discoveredDevice.update({
          where: { id: deviceId },
          data: { currentState: JSON.stringify(newState) }
        });
      }

      return reply.status(202).send({
        deviceId,
        command: body.command,
        status: "accepted"
      });
    }
  );

  // GET /api/v1/edge-gateways/:id/devices/:deviceId/state - Get device state
  app.get(
    "/api/v1/edge-gateways/:id/devices/:deviceId/state",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest) => {
      const ctx = getTenantContext(request);
      const { id, deviceId } = z.object({ id: z.string(), deviceId: z.string() }).parse(request.params);

      const device = await prisma.discoveredDevice.findFirst({
        where: { id: deviceId, edgeGatewayId: id, tenantId: ctx.tenantId }
      });
      if (!device) throw new NotFoundError("Device not found");

      return {
        deviceId: device.id,
        deviceType: device.deviceType,
        status: device.status,
        currentState: device.currentState ? JSON.parse(device.currentState) : null,
        lastSeenAt: device.lastSeenAt
      };
    }
  );

  // ============================================
  // QR Pairing & Tenant Assignment
  // ============================================

  // POST /api/v1/edge-gateways/:id/pairing-token - Generate QR pairing token
  app.post(
    "/api/v1/edge-gateways/:id/pairing-token",
    { preHandler: requireRole("tenant_admin", "super_admin") },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ expiresInMinutes: z.number().min(0).max(1440).default(30) }).parse(request.body);

      const gateway = await prisma.edgeGateway.findFirst({
        where: { id, tenantId: ctx.tenantId }
      });
      if (!gateway) throw new NotFoundError("Edge gateway not found");

      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60 * 1000);
      const qrPayload = JSON.stringify({
        type: "nearhome:edge-pair",
        token,
        gatewayId: id,
        tenantId: ctx.tenantId
      });

      const pairingToken = await prisma.edgeGatewayPairingToken.create({
        data: {
          edgeGatewayId: id,
          token,
          qrPayload,
          status: "pending",
          expiresAt
        }
      });

      return reply.status(201).send({
        token: pairingToken.token,
        qrPayload: pairingToken.qrPayload,
        expiresAt: pairingToken.expiresAt.toISOString(),
        status: pairingToken.status
      });
    }
  );

  // POST /api/v1/edge-gateways/pair - Client scans QR to pair with device
  app.post(
    "/api/v1/edge-gateways/pair",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      const body = z.object({ pairingToken: z.string() }).parse(request.body);

      const pairingRecord = await prisma.edgeGatewayPairingToken.findUnique({
        where: { token: body.pairingToken },
        include: { edgeGateway: true }
      });

      if (!pairingRecord) {
        return reply.status(404).send({ error: "TOKEN_NOT_FOUND", message: "Pairing token not found" });
      }

      if (pairingRecord.status !== "pending") {
        return reply.status(410).send({ error: "TOKEN_USED", message: "Pairing token already used or revoked" });
      }

      if (pairingRecord.expiresAt < new Date()) {
        return reply.status(410).send({ error: "TOKEN_EXPIRED", message: "Pairing token has expired" });
      }

      await prisma.edgeGatewayPairingToken.update({
        where: { id: pairingRecord.id },
        data: {
          status: "claimed",
          claimedByUserId: ctx.userId,
          claimedAt: new Date()
        }
      });

      await prisma.edgeGateway.update({
        where: { id: pairingRecord.edgeGatewayId },
        data: { pairedAt: new Date() }
      });

      return reply.send({
        edgeGatewayId: pairingRecord.edgeGatewayId,
        tenantId: pairingRecord.edgeGateway.tenantId,
        status: "paired"
      });
    }
  );
};
