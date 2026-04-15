import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";
import type { FastifyRequest } from "fastify";
import Redis from "ioredis";

// Edge Gateway heartbeat processing endpoint
// Extends the event gateway to handle edge gateway health events

type EdgeGatewayHealthEvent = {
  eventType: "edge_gateway.health";
  gatewayId: string;
  tenantId: string;
  timestamp: string;
  payload: {
    cpuTemperature: number;
    cpuUsage: number;
    memoryUsage: number;
    vpnLatency: number;
    tunnelStatus: {
      activeTunnels: number;
      failedTunnels: number;
    };
    status: "healthy" | "unhealthy" | "degraded";
  };
};

type WsClaims = {
  sub: string;
  tenantId: string;
  topics: string[];
  typ: "ws";
  exp: number;
};

type OutboundEvent = {
  eventId: string;
  eventVersion: string;
  eventType: string;
  tenantId: string;
  cameraId?: string;
  occurredAt: string;
  correlationId: string;
  sequence: number;
  payload: Record<string, unknown>;
};

type WsSubscriber = {
  socket: {
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    on: (event: string, listener: (...args: any[]) => void) => void;
    readyState: number;
  };
  topics: string[];
};

type SseSubscriber = {
  write: (chunk: string) => void;
  end: () => void;
  topics: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    wsClaims?: WsClaims;
  }
}

const tenantSequence = new Map<string, number>();
const tenantBacklog = new Map<string, OutboundEvent[]>();
const wsSubscribers = new Map<string, Set<WsSubscriber>>();
const sseSubscribers = new Map<string, Set<SseSubscriber>>();
const MAX_BACKLOG_PER_TENANT = 500;

// Redis Streams — durable backlog (optional; falls back to in-memory)
const redisUrl = process.env.REDIS_URL;
let redis: Redis | null = null;
if (redisUrl) {
  redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on("error", (err: unknown) => console.error("[event-gateway] redis error", err));
}
const redisStreamKey = (tenantId: string) => `nearhome:events:${tenantId}`;

function eventMatchesTopics(eventType: string, topics: string[]) {
  if (topics.length === 0) return true;
  if (topics.includes("*")) return true;
  return topics.some((topic) => eventType === topic || eventType.startsWith(`${topic}.`));
}

function nextSequence(tenantId: string) {
  const current = tenantSequence.get(tenantId) ?? 0;
  const next = current + 1;
  tenantSequence.set(tenantId, next);
  return next;
}

function createEvent(args: {
  tenantId: string;
  eventType: string;
  correlationId: string;
  payload: Record<string, unknown>;
  cameraId?: string;
}): OutboundEvent {
  return {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    eventVersion: "1.0",
    eventType: args.eventType,
    tenantId: args.tenantId,
    cameraId: args.cameraId,
    occurredAt: new Date().toISOString(),
    correlationId: args.correlationId,
    sequence: nextSequence(args.tenantId),
    payload: args.payload
  };
}

async function addBacklogEvent(event: OutboundEvent) {
  // In-memory (always kept for zero-latency subscriber delivery)
  const events = tenantBacklog.get(event.tenantId) ?? [];
  events.push(event);
  if (events.length > MAX_BACKLOG_PER_TENANT) {
    events.splice(0, events.length - MAX_BACKLOG_PER_TENANT);
  }
  tenantBacklog.set(event.tenantId, events);

  // Durable: Redis Streams with capped length
  if (redis) {
    try {
      await redis.xadd(
        redisStreamKey(event.tenantId),
        "MAXLEN", "~", String(MAX_BACKLOG_PER_TENANT),
        "*",
        "data", JSON.stringify(event)
      );
    } catch {
      // Non-fatal: in-memory backlog is still intact
    }
  }
}

async function publishEvent(event: OutboundEvent) {
  await addBacklogEvent(event);

  const wsSet = wsSubscribers.get(event.tenantId);
  if (wsSet) {
    for (const subscriber of wsSet) {
      if (!eventMatchesTopics(event.eventType, subscriber.topics)) continue;
      if (subscriber.socket.readyState === 1) {
        subscriber.socket.send(JSON.stringify(event));
      }
    }
  }

  const sseSet = sseSubscribers.get(event.tenantId);
  if (sseSet) {
    for (const subscriber of sseSet) {
      if (!eventMatchesTopics(event.eventType, subscriber.topics)) continue;
      subscriber.write(`id: ${event.eventId}\n`);
      subscriber.write(`event: ${event.eventType}\n`);
      subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  const jwtSecret = process.env.JWT_SECRET ?? "dev-super-secret";
  const eventPublishSecret = process.env.EVENT_PUBLISH_SECRET ?? "dev-event-publish-secret";

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: jwtSecret });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, service: "event-gateway" }));

  app.post("/internal/events/publish", async (request, reply) => {
    const providedSecret = request.headers["x-event-publish-secret"];
    if (providedSecret !== eventPublishSecret) {
      reply.status(401);
      return { code: "UNAUTHORIZED", message: "invalid publish secret" };
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const eventType = typeof body.eventType === "string" ? body.eventType.trim() : "";
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!eventType || !tenantId) {
      reply.status(400);
      return { code: "BAD_REQUEST", message: "eventType and tenantId are required" };
    }

    const event: OutboundEvent = {
      eventId:
        typeof body.eventId === "string" && body.eventId.length > 0
          ? body.eventId
          : `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      eventVersion: typeof body.eventVersion === "string" && body.eventVersion.length > 0 ? body.eventVersion : "1.0",
      eventType,
      tenantId,
      cameraId: typeof body.cameraId === "string" ? body.cameraId : undefined,
      occurredAt:
        typeof body.occurredAt === "string" && body.occurredAt.length > 0 ? body.occurredAt : new Date().toISOString(),
      correlationId:
        typeof body.correlationId === "string" && body.correlationId.length > 0 ? body.correlationId : request.id,
      sequence: typeof body.sequence === "number" ? body.sequence : nextSequence(tenantId),
      payload: typeof body.payload === "object" && body.payload ? (body.payload as Record<string, unknown>) : {}
    };

    await publishEvent(event);
    reply.code(202);
    return { data: event };
  });

  app.get("/events/stream", async (request, reply) => {
    const tenantId = request.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      reply.status(400);
      return { code: "BAD_REQUEST", message: "X-Tenant-Id required" };
    }
    const query = request.query as Record<string, unknown>;
    const replayRequested = typeof query.replay === "string" ? Math.max(0, Number(query.replay) || 0) : 0;
    const topics =
      typeof query.topics === "string"
        ? query.topics
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
    const once = query.once === "1";

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");

    const subscriber: SseSubscriber = {
      write: (chunk: string) => reply.raw.write(chunk),
      end: () => reply.raw.end(),
      topics
    };
    const subscribers = sseSubscribers.get(tenantId) ?? new Set<SseSubscriber>();
    subscribers.add(subscriber);
    sseSubscribers.set(tenantId, subscribers);

    if (replayRequested > 0) {
      let replayEvents: OutboundEvent[] = [];
      if (redis) {
        try {
          const entries = await redis.xrevrange(redisStreamKey(tenantId), "+", "-", "COUNT", replayRequested);
          replayEvents = entries
            .reverse()
            .map(([, fields]) => {
              const idx = fields.indexOf("data");
              if (idx === -1) return null;
              try { return JSON.parse(fields[idx + 1]) as OutboundEvent; } catch { return null; }
            })
            .filter((e): e is OutboundEvent => e !== null);
        } catch {
          // Fall back to in-memory
          const backlog = tenantBacklog.get(tenantId) ?? [];
          replayEvents = backlog.slice(Math.max(0, backlog.length - replayRequested));
        }
      } else {
        const backlog = tenantBacklog.get(tenantId) ?? [];
        replayEvents = backlog.slice(Math.max(0, backlog.length - replayRequested));
      }
      for (const event of replayEvents) {
        if (!eventMatchesTopics(event.eventType, topics)) continue;
        reply.raw.write(`id: ${event.eventId}\n`);
        reply.raw.write(`event: ${event.eventType}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    const welcome = createEvent({
      tenantId,
      eventType: "system.welcome",
      correlationId: request.id,
      payload: { message: "SSE stream ready", topics }
    });
    reply.raw.write(`id: ${welcome.eventId}\n`);
    reply.raw.write(`event: ${welcome.eventType}\n`);
    reply.raw.write(`data: ${JSON.stringify(welcome)}\n\n`);

    const detach = () => {
      const set = sseSubscribers.get(tenantId);
      if (!set) return;
      set.delete(subscriber);
      if (set.size === 0) {
        sseSubscribers.delete(tenantId);
      }
    };
    request.raw.on("close", detach);
    request.raw.on("error", detach);

    if (once) {
      detach();
      subscriber.end();
    }
    return reply;
  });

  app.get(
    "/ws",
    { websocket: true },
    async (connection, request: FastifyRequest<{ Querystring: { token?: string } }>) => {
      try {
        const token = request.query.token;
        if (!token) {
          connection.socket.close(1008, "missing token");
          return;
        }
        const claims = (await app.jwt.verify<WsClaims>(token)) as WsClaims;
        if (claims.typ !== "ws") {
          connection.socket.close(1008, "invalid token type");
          return;
        }
        request.wsClaims = claims;
        const wsTopics = Array.isArray(claims.topics) ? claims.topics : [];

        const subscriber: WsSubscriber = { socket: connection.socket, topics: wsTopics };
        const set = wsSubscribers.get(claims.tenantId) ?? new Set<WsSubscriber>();
        set.add(subscriber);
        wsSubscribers.set(claims.tenantId, set);

        const welcome = createEvent({
          tenantId: claims.tenantId,
          eventType: "system.welcome",
          correlationId: request.id,
          payload: {
            userId: claims.sub,
            topics: claims.topics
          }
        });
        connection.socket.send(JSON.stringify(welcome));

        connection.socket.on("message", (raw: Buffer) => {
          const text = raw.toString("utf8");
          if (text === "ping") {
            connection.socket.send("pong");
          }
        });
        connection.socket.on("close", () => {
          const tenantSet = wsSubscribers.get(claims.tenantId);
          if (!tenantSet) return;
          tenantSet.delete(subscriber);
          if (tenantSet.size === 0) {
            wsSubscribers.delete(claims.tenantId);
          }
        });
      } catch (error) {
        app.log.warn({ error }, "ws.auth_failed");
        connection.socket.close(1008, "unauthorized");
      }
    }
  );

  // ============================================
  // Edge Gateway Heartbeat Processing
  // ============================================

  // POST /health/edge-gateway - Process edge gateway heartbeat
  // This endpoint receives heartbeat events from edge gateways
  // and publishes them as events for real-time monitoring
  app.post("/health/edge-gateway", async (request, reply) => {
    const body = request.body as {
      gatewayId: string;
      tenantId: string;
      timestamp: string;
      metrics?: {
        cpuTemperatureCelsius?: number;
        cpuUsagePercent?: number;
        memoryUsedBytes?: number;
        memoryTotalBytes?: number;
        vpnLatencyMs?: number;
        tunnelStatus?: {
          activeTunnels: number;
          failedTunnels: number;
          lastFailure?: string;
        };
        discoveredCamerasCount?: number;
        registeredCamerasCount?: number;
      };
      supervisorStatus?: {
        deviceStatus: string;
        isOnline: boolean;
        updateStatus: string;
      };
      version?: string;
    };

    if (!body.gatewayId || !body.tenantId) {
      return reply.status(400).send({
        error: "MISSING_FIELDS",
        message: "gatewayId and tenantId are required"
      });
    }

    // Determine health status based on metrics
    let healthStatus: "healthy" | "unhealthy" | "degraded" = "healthy";

    if (body.metrics) {
      if (body.metrics.cpuTemperatureCelsius && body.metrics.cpuTemperatureCelsius > 80) {
        healthStatus = "degraded";
      }
      if (body.metrics.tunnelStatus?.failedTunnels && body.metrics.tunnelStatus.failedTunnels > 0) {
        healthStatus = "degraded";
      }
      if (body.supervisorStatus && !body.supervisorStatus.isOnline) {
        healthStatus = "unhealthy";
      }
    }

    // Create and publish health event (persists to backlog + distributes to subscribers)
    const healthEvent = createEvent({
      tenantId: body.tenantId,
      eventType: "edge_gateway.health",
      correlationId: body.gatewayId,
      payload: {
        gatewayId: body.gatewayId,
        timestamp: body.timestamp,
        status: healthStatus,
        metrics: body.metrics,
        supervisorStatus: body.supervisorStatus,
        version: body.version
      }
    });

    await publishEvent(healthEvent);

    if (healthStatus === "unhealthy") {
      app.log.warn(
        { gatewayId: body.gatewayId, tenantId: body.tenantId, metrics: body.metrics },
        "edge_gateway.unhealthy"
      );
    }

    return reply.send({
      accepted: true,
      eventId: healthEvent.eventId,
      status: healthStatus
    });
  });

  // GET /health/edge-gateway/:gatewayId/history - Get heartbeat history
  app.get("/health/edge-gateway/:gatewayId/history", async (request, reply) => {
    const { gatewayId } = request.params as { gatewayId: string };
    const { limit = "50" } = request.query as { limit?: string };

    // In a production system, this would query from a time-series store
    // For now, return a placeholder response
    return reply.send({
      gatewayId,
      history: [],
      message: "Heartbeat history not yet implemented - requires time-series storage"
    });
  });

  return app;
}
