import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { assertRole, getTenantContext, toISO, parseJson, resolveEventsFromDate } from "../../core/utils.js";

export type EventsPluginOptions = { middleware: AppMiddleware };

export const eventsPlugin: FastifyPluginAsync<EventsPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;

  app.get("/events/ws-token", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const topicsAllowed = ctx.role === "tenant_admin"
      ? ["camera.status", "stream.session", "detection.job", "detection.object", "incident", "system.alert"]
      : ["camera.status", "stream.session", "detection.job", "detection.object", "incident"];
    const expiresInSec = 60;
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const token = await reply.jwtSign({ sub: ctx.userId, tenantId: ctx.tenantId, topics: topicsAllowed, typ: "ws", exp });
    return { data: { token, tenantId: ctx.tenantId, topicsAllowed, expiresAt: new Date(exp * 1000).toISOString() } };
  });

  app.get("/events/stream", { preHandler: tenantScopedPreHandler }, async (request, reply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.write(`event: welcome\ndata: ${JSON.stringify({ eventId: `evt_${Date.now()}`, eventVersion: "1.0", eventType: "system.welcome", tenantId: ctx.tenantId, occurredAt: new Date().toISOString(), correlationId: (request as any).requestId ?? request.id, sequence: 1, payload: { message: "SSE stream ready" } })}\n\n`);
    reply.raw.end();
    return reply;
  });

  app.get("/events", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const q = request.query as Record<string, string | undefined>;
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const effectiveFrom = await resolveEventsFromDate(tenantId, from);
    const rows = await prisma.event.findMany({
      where: { tenantId, ...(q.cameraId ? { cameraId: q.cameraId } : {}), ...((effectiveFrom || to) ? { timestamp: { ...(effectiveFrom ? { gte: effectiveFrom } : {}), ...(to ? { lte: to } : {}) } } : {}) },
      orderBy: { timestamp: "desc" }, take: 200
    });
    const data = rows.map((e: any) => ({ id: e.id, tenantId: e.tenantId, cameraId: e.cameraId, type: e.type, severity: e.severity, timestamp: toISO(e.timestamp), payload: parseJson(e.payload) }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });
};
