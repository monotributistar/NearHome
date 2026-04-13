import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { getTenantContext } from "../../core/utils.js";
import { NotFoundError } from "../../core/types.js";

export type EdgeGatewaysPluginOptions = { middleware: AppMiddleware };

export const edgeGatewaysPlugin: FastifyPluginAsync<EdgeGatewaysPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;

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
};
