import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import { z } from "zod";
import type { FastifyRequest } from "fastify";

import { prisma } from "./core/prisma.js";
import { createMiddleware } from "./core/middleware.js";
import { statusToCode, resolveRepoRoot, syncCameraHealthFromGateway } from "./core/utils.js";
import { ApiDomainError } from "./core/types.js";
import type { ApiErrorBody, LoginBucket } from "./core/types.js";

import { authPlugin } from "./domains/auth/routes.js";
import { tenantsPlugin } from "./domains/tenants/routes.js";
import { identityPlugin } from "./domains/identity/routes.js";
import { camerasPlugin } from "./domains/cameras/routes.js";
import { detectionPlugin } from "./domains/detection/routes.js";
import { subscriptionsPlugin } from "./domains/subscriptions/routes.js";
import { edgeGatewaysPlugin } from "./domains/edge-gateways/routes.js";
import { opsPlugin } from "./domains/ops/routes.js";
import { eventsPlugin } from "./domains/events/routes.js";
import { householdsPlugin } from "./domains/households/routes.js";
import { notificationsPlugin } from "./domains/notifications/routes.js";

type StreamHealthSyncStats = {
  enabled: boolean;
  inFlight: boolean;
  tenantCursors: number;
  lastRunAt: string | null;
  lastDurationMs: number;
  lastScanned: number;
  lastSynced: number;
  lastFailed: number;
  totalCycles: number;
  totalScanned: number;
  totalSynced: number;
  totalFailed: number;
  lastError: string | null;
};

export async function buildApp() {
  const app = Fastify({ logger: true });
  const repoRoot = resolveRepoRoot();

  // ── Config ────────────────────────────────────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET ?? "dev-super-secret";
  const streamGatewayUrl = process.env.STREAM_GATEWAY_URL?.replace(/\/$/, "") ?? null;
  const streamGatewayPublicUrl = process.env.STREAM_GATEWAY_PUBLIC_URL?.replace(/\/$/, "") ?? streamGatewayUrl;
  const detectionBridgeUrl = process.env.DETECTION_BRIDGE_URL?.replace(/\/$/, "") ?? null;
  const audioDetectionRunnerUrl = process.env.AUDIO_DETECTION_RUNNER_URL?.replace(/\/$/, "") ?? null;
  const temporalDispatchUrl = process.env.DETECTION_TEMPORAL_DISPATCH_URL?.replace(/\/$/, "") ?? null;
  const detectionCallbackSecret = process.env.DETECTION_CALLBACK_SECRET ?? "dev-detection-callback-secret";
  const eventGatewayUrl = process.env.EVENT_GATEWAY_URL?.replace(/\/$/, "") ?? null;
  const eventPublishSecret = process.env.EVENT_PUBLISH_SECRET ?? "dev-event-publish-secret";
  const detectionExecutionMode = process.env.DETECTION_EXECUTION_MODE ?? "inline";
  const streamHealthSyncEnabled = process.env.STREAM_HEALTH_SYNC_ENABLED === "1";
  const streamHealthSyncIntervalMs = Number(process.env.STREAM_HEALTH_SYNC_INTERVAL_MS ?? 30_000);
  const streamHealthSyncBatchSize = Number(process.env.STREAM_HEALTH_SYNC_BATCH_SIZE ?? 100);
  const inferenceBridgeUrl =
    process.env.INFERENCE_BRIDGE_URL?.replace(/\/$/, "") ?? detectionBridgeUrl ?? "http://inference-bridge:8090";
  const nodeAuthAdminSecret = process.env.NODE_AUTH_ADMIN_SECRET ?? "dev-node-auth-admin-secret";
  const detectionDeployOutputPath =
    process.env.DETECTION_DEPLOY_OUTPUT_PATH ?? `${repoRoot}/deploy/detection`;
  const detectionStackSyncCommand = process.env.DETECTION_STACK_SYNC_COMMAND ?? "";
  const detectionStackSyncTimeoutMsRaw = Number(process.env.DETECTION_STACK_SYNC_TIMEOUT_MS ?? 600_000);
  const detectionStackSyncMaxRetriesRaw = Number(process.env.DETECTION_STACK_SYNC_MAX_RETRIES ?? 0);
  const detectionStackSyncRetryDelayMsRaw = Number(process.env.DETECTION_STACK_SYNC_RETRY_DELAY_MS ?? 2_000);
  const detectionStackSyncTimeoutMs =
    Number.isFinite(detectionStackSyncTimeoutMsRaw) && detectionStackSyncTimeoutMsRaw >= 5_000
      ? Math.min(Math.trunc(detectionStackSyncTimeoutMsRaw), 3_600_000)
      : 600_000;
  const detectionStackSyncMaxRetries =
    Number.isFinite(detectionStackSyncMaxRetriesRaw) && detectionStackSyncMaxRetriesRaw >= 0
      ? Math.min(Math.trunc(detectionStackSyncMaxRetriesRaw), 5)
      : 0;
  const detectionStackSyncRetryDelayMs =
    Number.isFinite(detectionStackSyncRetryDelayMsRaw) && detectionStackSyncRetryDelayMsRaw >= 0
      ? Math.min(Math.trunc(detectionStackSyncRetryDelayMsRaw), 60_000)
      : 2_000;
  const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20);
  const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const readinessForceFail = process.env.READINESS_FORCE_FAIL === "1";
  const superuserEmails = new Set(
    (process.env.SUPERUSER_EMAILS ?? "admin@nearhome.dev")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0)
  );

  // ── Plugins ───────────────────────────────────────────────────────────────
  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: jwtSecret });
  await app.register(sensible);

  // ── Middleware ────────────────────────────────────────────────────────────
  const loginBuckets = new Map<string, LoginBucket>();
  const middleware = createMiddleware(app, {
    superuserEmails,
    loginBuckets,
    loginRateLimitMax,
    loginRateLimitWindowMs
  });

  // ── Hooks ─────────────────────────────────────────────────────────────────
  app.addHook("onRequest", async (request, reply) => {
    const incomingRequestId = request.headers["x-request-id"];
    const requestId =
      typeof incomingRequestId === "string" && incomingRequestId.trim().length > 0
        ? incomingRequestId.trim()
        : request.id;
    request.requestId = requestId;
    request.requestStartedAt = Date.now();
    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (request, reply) => {
    const latencyMs = request.requestStartedAt ? Date.now() - request.requestStartedAt : undefined;
    request.log.info(
      {
        requestId: request.requestId ?? request.id,
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        latencyMs,
        tenantId: request.ctx?.tenantId ?? null,
        userId: request.ctx?.userId ?? null
      },
      "request.summary"
    );
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    let statusCode = (err.statusCode ?? 500) as number;

    if (error instanceof z.ZodError) statusCode = 400;
    if (err.message === "MISSING_TENANT") statusCode = 400;
    if (err.message === "FORBIDDEN_ROLE") statusCode = 403;
    if (err.message === "INVALID_LIFECYCLE_TRANSITION") statusCode = 400;
    if (err.message === "CAMERA_NOT_FOUND") statusCode = 404;
    if (err.message === "STREAM_SESSION_NOT_FOUND") statusCode = 404;
    if (err.message === "INVALID_STREAM_SESSION_TRANSITION") statusCode = 400;
    if (error instanceof ApiDomainError) statusCode = error.statusCode;

    const code =
      error instanceof z.ZodError
        ? "VALIDATION_ERROR"
        : error instanceof ApiDomainError
          ? error.apiCode
          : statusToCode(statusCode);

    const body: ApiErrorBody = {
      code,
      message:
        err.message === "MISSING_TENANT"
          ? "X-Tenant-Id required"
          : err.message === "FORBIDDEN_ROLE"
            ? "Insufficient permissions"
            : err.message === "INVALID_LIFECYCLE_TRANSITION"
              ? "Invalid camera lifecycle transition"
              : err.message === "CAMERA_NOT_FOUND"
                ? "Camera not found"
                : err.message === "STREAM_SESSION_NOT_FOUND"
                  ? "Stream session not found"
                  : err.message === "INVALID_STREAM_SESSION_TRANSITION"
                    ? "Invalid stream session transition"
                    : error instanceof ApiDomainError
                      ? error.message
                      : error instanceof z.ZodError
                        ? "Validation failed"
                        : err.message || (statusCode >= 500 ? "Internal server error" : "Request failed")
    };

    if (error instanceof z.ZodError) {
      body.details = error.flatten();
    } else if (error instanceof ApiDomainError) {
      body.details = error.details;
    } else if (err.code === "P2025") {
      body.code = "NOT_FOUND";
      body.message = "Resource not found";
    }

    reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = { code: "NOT_FOUND", message: "Route not found" };
    reply.status(404).send(body);
  });

  // ── Domain plugins ────────────────────────────────────────────────────────
  await app.register(authPlugin, { middleware, superuserEmails });
  await app.register(tenantsPlugin, { middleware });
  await app.register(identityPlugin, { middleware });
  await app.register(camerasPlugin, {
    middleware,
    streamGatewayUrl,
    streamGatewayPublicUrl,
    streamTokenSecret: process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret"
  });
  await app.register(detectionPlugin, {
    middleware,
    detectionCallbackSecret,
    eventGatewayUrl,
    eventPublishSecret,
    detectionBridgeUrl,
    audioDetectionRunnerUrl,
    temporalDispatchUrl,
    detectionExecutionMode
  });
  await app.register(subscriptionsPlugin, { middleware });
  await app.register(edgeGatewaysPlugin, { middleware });
  await app.register(opsPlugin, {
    middleware,
    inferenceBridgeUrl,
    nodeAuthAdminSecret,
    streamGatewayUrl,
    eventGatewayUrl,
    temporalDispatchUrl,
    detectionDeployOutputPath,
    repoRoot,
    detectionStackSyncCommand: detectionStackSyncCommand || null,
    detectionStackSyncTimeoutMs,
    detectionStackSyncMaxRetries,
    detectionStackSyncRetryDelayMs
  });
  await app.register(eventsPlugin, { middleware });
  await app.register(householdsPlugin, { middleware });
  await app.register(notificationsPlugin, { middleware });

  // ── Stream health sync timer ───────────────────────────────────────────────
  let streamSyncTimer: NodeJS.Timeout | null = null;
  let streamSyncInFlight = false;
  const streamSyncCursorByTenant = new Map<string, string | null>();
  const streamSyncStats: StreamHealthSyncStats = {
    enabled: streamHealthSyncEnabled && !!streamGatewayUrl,
    inFlight: false,
    tenantCursors: 0,
    lastRunAt: null,
    lastDurationMs: 0,
    lastScanned: 0,
    lastSynced: 0,
    lastFailed: 0,
    totalCycles: 0,
    totalScanned: 0,
    totalSynced: 0,
    totalFailed: 0,
    lastError: null
  };

  if (streamHealthSyncEnabled) {
    if (!streamGatewayUrl) {
      app.log.warn("stream health sync is enabled but STREAM_GATEWAY_URL is missing");
    } else {
      const runStreamHealthSync = async () => {
        if (streamSyncInFlight) return;
        streamSyncInFlight = true;
        streamSyncStats.inFlight = true;
        streamSyncStats.lastError = null;
        const cycleStartedAt = Date.now();
        let scannedInCycle = 0;
        let syncedInCycle = 0;
        let failedInCycle = 0;
        try {
          const activeTenants = await prisma.camera.findMany({
            where: { deletedAt: null, isActive: true },
            select: { tenantId: true },
            distinct: ["tenantId"],
            orderBy: { tenantId: "asc" }
          });

          for (const tenant of activeTenants) {
            const tenantId = tenant.tenantId;
            const tenantCursor = streamSyncCursorByTenant.get(tenantId) ?? null;

            let cameras = await prisma.camera.findMany({
              where: {
                deletedAt: null,
                isActive: true,
                tenantId,
                ...(tenantCursor ? { id: { gt: tenantCursor } } : {})
              },
              select: { id: true, tenantId: true },
              orderBy: { id: "asc" },
              take: streamHealthSyncBatchSize
            });

            if (cameras.length === 0) {
              streamSyncCursorByTenant.set(tenantId, null);
              cameras = await prisma.camera.findMany({
                where: { deletedAt: null, isActive: true, tenantId },
                select: { id: true, tenantId: true },
                orderBy: { id: "asc" },
                take: streamHealthSyncBatchSize
              });
            }

            if (cameras.length > 0) {
              streamSyncCursorByTenant.set(tenantId, cameras[cameras.length - 1].id);
            }

            for (const camera of cameras) {
              scannedInCycle += 1;
              try {
                await syncCameraHealthFromGateway({
                  tenantId: camera.tenantId,
                  cameraId: camera.id,
                  streamGatewayUrl
                });
                syncedInCycle += 1;
              } catch (error) {
                failedInCycle += 1;
                app.log.warn({ error, tenantId: camera.tenantId, cameraId: camera.id }, "stream_health_sync.camera_failed");
              }
            }
          }

          const activeTenantSet = new Set(activeTenants.map((t) => t.tenantId));
          for (const tenantId of streamSyncCursorByTenant.keys()) {
            if (!activeTenantSet.has(tenantId)) streamSyncCursorByTenant.delete(tenantId);
          }
        } finally {
          streamSyncStats.lastRunAt = new Date().toISOString();
          streamSyncStats.lastDurationMs = Date.now() - cycleStartedAt;
          streamSyncStats.lastScanned = scannedInCycle;
          streamSyncStats.lastSynced = syncedInCycle;
          streamSyncStats.lastFailed = failedInCycle;
          streamSyncStats.totalCycles += 1;
          streamSyncStats.totalScanned += scannedInCycle;
          streamSyncStats.totalSynced += syncedInCycle;
          streamSyncStats.totalFailed += failedInCycle;
          streamSyncStats.tenantCursors = streamSyncCursorByTenant.size;
          streamSyncStats.inFlight = false;
          streamSyncInFlight = false;
        }
      };

      streamSyncTimer = setInterval(() => {
        runStreamHealthSync().catch((error) => {
          streamSyncStats.lastError = error instanceof Error ? error.message : String(error);
          app.log.error({ error }, "stream_health_sync.loop_failed");
        });
      }, streamHealthSyncIntervalMs);
      streamSyncTimer.unref?.();
    }
  }

  app.addHook("onClose", async () => {
    if (streamSyncTimer) {
      clearInterval(streamSyncTimer);
      streamSyncTimer = null;
    }
  });

  // ── System routes ─────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    ok: true,
    streamHealthSync: streamSyncStats
  }));

  app.get("/metrics", async (_request, reply) => {
    const lastRunUnix = streamSyncStats.lastRunAt ? Date.parse(streamSyncStats.lastRunAt) / 1000 : 0;
    const lines = [
      "# HELP nearhome_stream_health_sync_enabled 1 if stream health scheduler is enabled, 0 otherwise.",
      "# TYPE nearhome_stream_health_sync_enabled gauge",
      `nearhome_stream_health_sync_enabled ${streamSyncStats.enabled ? 1 : 0}`,
      "# HELP nearhome_stream_health_sync_in_flight 1 if scheduler cycle is currently running.",
      "# TYPE nearhome_stream_health_sync_in_flight gauge",
      `nearhome_stream_health_sync_in_flight ${streamSyncStats.inFlight ? 1 : 0}`,
      "# HELP nearhome_stream_health_sync_tenant_cursors Number of tenant cursors currently tracked.",
      "# TYPE nearhome_stream_health_sync_tenant_cursors gauge",
      `nearhome_stream_health_sync_tenant_cursors ${streamSyncStats.tenantCursors}`,
      "# HELP nearhome_stream_health_sync_last_run_unix_seconds Last completed sync cycle timestamp as unix seconds.",
      "# TYPE nearhome_stream_health_sync_last_run_unix_seconds gauge",
      `nearhome_stream_health_sync_last_run_unix_seconds ${lastRunUnix}`,
      "# HELP nearhome_stream_health_sync_last_duration_ms Last sync cycle duration in milliseconds.",
      "# TYPE nearhome_stream_health_sync_last_duration_ms gauge",
      `nearhome_stream_health_sync_last_duration_ms ${streamSyncStats.lastDurationMs}`,
      "# HELP nearhome_stream_health_sync_last_scanned Number of cameras scanned in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_scanned gauge",
      `nearhome_stream_health_sync_last_scanned ${streamSyncStats.lastScanned}`,
      "# HELP nearhome_stream_health_sync_last_synced Number of cameras synced in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_synced gauge",
      `nearhome_stream_health_sync_last_synced ${streamSyncStats.lastSynced}`,
      "# HELP nearhome_stream_health_sync_last_failed Number of cameras failed in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_failed gauge",
      `nearhome_stream_health_sync_last_failed ${streamSyncStats.lastFailed}`,
      "# HELP nearhome_stream_health_sync_cycles_total Total scheduler cycles completed.",
      "# TYPE nearhome_stream_health_sync_cycles_total counter",
      `nearhome_stream_health_sync_cycles_total ${streamSyncStats.totalCycles}`,
      "# HELP nearhome_stream_health_sync_scanned_total Total cameras scanned across cycles.",
      "# TYPE nearhome_stream_health_sync_scanned_total counter",
      `nearhome_stream_health_sync_scanned_total ${streamSyncStats.totalScanned}`,
      "# HELP nearhome_stream_health_sync_synced_total Total cameras synced across cycles.",
      "# TYPE nearhome_stream_health_sync_synced_total counter",
      `nearhome_stream_health_sync_synced_total ${streamSyncStats.totalSynced}`,
      "# HELP nearhome_stream_health_sync_failed_total Total cameras failed across cycles.",
      "# TYPE nearhome_stream_health_sync_failed_total counter",
      `nearhome_stream_health_sync_failed_total ${streamSyncStats.totalFailed}`
    ];
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });

  app.get("/readiness", async (request: FastifyRequest, reply) => {
    if (readinessForceFail) {
      reply.status(503);
      return { ok: false, db: "down", reason: "forced_failure", timestamp: new Date().toISOString(), requestId: request.requestId ?? request.id };
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up", timestamp: new Date().toISOString(), requestId: request.requestId ?? request.id };
    } catch {
      reply.status(503);
      return { ok: false, db: "down", reason: "db_unreachable", timestamp: new Date().toISOString(), requestId: request.requestId ?? request.id };
    }
  });

  // ── v1 proxy compatibility ─────────────────────────────────────────────────
  app.all("/v1/*", async (request, reply) => {
    const targetUrl = request.url.replace(/^\/v1/, "") || "/";
    const proxied = (await app.inject({
      method: request.method as any,
      url: targetUrl,
      headers: request.headers as Record<string, string>,
      payload: request.body as any
    })) as any;
    const ignoredHeaders = new Set(["content-length", "transfer-encoding", "connection"]);
    for (const [key, value] of Object.entries(proxied.headers)) {
      if (!ignoredHeaders.has(key.toLowerCase()) && value !== undefined) {
        reply.header(key, value as string);
      }
    }
    reply.status(proxied.statusCode).send(proxied.body);
  });

  return app;
}
