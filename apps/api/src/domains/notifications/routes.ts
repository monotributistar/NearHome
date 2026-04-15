import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { assertRole, getTenantContext, parseListQuery } from "../../core/utils.js";
import { notificationChannelResponse, notificationDeliveryResponse } from "../../core/responses.js";

export type NotificationsPluginOptions = { middleware: AppMiddleware };

export const notificationsPlugin: FastifyPluginAsync<NotificationsPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;

  app.get("/notification-channels", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const { skip, take } = parseListQuery(request.query as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.notificationChannel.findMany({ where: { tenantId: ctx.tenantId }, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.notificationChannel.count({ where: { tenantId: ctx.tenantId } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(notificationChannelResponse), total };
  });

  app.post("/notification-channels", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z.object({ name: z.string().min(2), type: z.enum(["webhook", "email"]), endpoint: z.string().url().optional(), authToken: z.string().optional(), headers: z.record(z.string()).optional(), emailTo: z.string().email().optional(), isActive: z.boolean().optional() }).parse(request.body);
    if (body.type === "webhook" && !body.endpoint) throw app.httpErrors.badRequest("endpoint is required for webhook channel");
    if (body.type === "email" && !body.emailTo) throw app.httpErrors.badRequest("emailTo is required for email channel");
    const created = await prisma.notificationChannel.create({ data: { tenantId: ctx.tenantId, name: body.name, type: body.type, endpoint: body.endpoint ?? null, authToken: body.authToken ?? null, headersJson: body.headers ? JSON.stringify(body.headers) : null, emailTo: body.emailTo ?? null, isActive: body.isActive ?? true } });
    return { data: notificationChannelResponse(created) };
  });

  app.put("/notification-channels/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().min(2).optional(), endpoint: z.string().url().nullable().optional(), authToken: z.string().nullable().optional(), headers: z.record(z.string()).nullable().optional(), emailTo: z.string().email().nullable().optional(), isActive: z.boolean().optional() }).parse(request.body ?? {});
    const existing = await prisma.notificationChannel.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound();
    const updated = await prisma.notificationChannel.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.endpoint !== undefined ? { endpoint: body.endpoint } : {}), ...(body.authToken !== undefined ? { authToken: body.authToken } : {}), ...(body.headers !== undefined ? { headersJson: body.headers ? JSON.stringify(body.headers) : null } : {}), ...(body.emailTo !== undefined ? { emailTo: body.emailTo } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) } });
    return { data: notificationChannelResponse(updated) };
  });

  app.delete("/notification-channels/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { id } = request.params as { id: string };
    const existing = await prisma.notificationChannel.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound();
    await prisma.notificationChannel.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.get("/notifications/deliveries", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const incidentId = typeof query.incidentId === "string" ? query.incidentId : undefined;
    const where = { tenantId: ctx.tenantId, ...(incidentId ? { incidentId } : {}) };
    const [rows, total] = await Promise.all([
      prisma.notificationDelivery.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.notificationDelivery.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(notificationDeliveryResponse), total };
  });
};
