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

declare module "fastify" {
  interface FastifyRequest {
    wsClaims?: WsClaims;
  }
}

const tenantSequence = new Map<string, number>();

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

export async function buildApp() {
  const app = Fastify({ logger: true });
  const jwtSecret = process.env.JWT_SECRET ?? "dev-super-secret";

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: jwtSecret });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, service: "event-gateway" }));

  app.get("/events/stream", async (request, reply) => {
    const tenantId = request.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      reply.status(400);
      return { code: "BAD_REQUEST", message: "X-Tenant-Id required" };
    }

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");

    const event = createEvent({
      tenantId,
      eventType: "system.welcome",
      correlationId: request.id,
      payload: { message: "SSE stream ready" }
    });
    reply.raw.write(`event: ${event.eventType}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    reply.raw.end();
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
      } catch (error) {
        app.log.warn({ error }, "ws.auth_failed");
        connection.socket.close(1008, "unauthorized");
      }
    }
  );

  return app;
}
