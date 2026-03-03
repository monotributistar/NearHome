import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";
import type { FastifyRequest } from "fastify";

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
const MAX_BACKLOG_PER_TENANT = 200;

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

function addBacklogEvent(event: OutboundEvent) {
  const events = tenantBacklog.get(event.tenantId) ?? [];
  events.push(event);
  if (events.length > MAX_BACKLOG_PER_TENANT) {
    events.splice(0, events.length - MAX_BACKLOG_PER_TENANT);
  }
  tenantBacklog.set(event.tenantId, events);
}

function publishEvent(event: OutboundEvent) {
  addBacklogEvent(event);

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
      occurredAt: typeof body.occurredAt === "string" && body.occurredAt.length > 0 ? body.occurredAt : new Date().toISOString(),
      correlationId: typeof body.correlationId === "string" && body.correlationId.length > 0 ? body.correlationId : request.id,
      sequence: typeof body.sequence === "number" ? body.sequence : nextSequence(tenantId),
      payload: typeof body.payload === "object" && body.payload ? (body.payload as Record<string, unknown>) : {}
    };

    publishEvent(event);
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
      const backlog = tenantBacklog.get(tenantId) ?? [];
      const replay = backlog.slice(Math.max(0, backlog.length - replayRequested));
      for (const event of replay) {
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

  return app;
}
