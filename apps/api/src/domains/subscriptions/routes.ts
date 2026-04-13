import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { assertRole, getTenantContext, toISO, parseListQuery, appendAuditLog, parseJson } from "../../core/utils.js";
import { subscriptionRequestResponse } from "../../core/responses.js";

export type SubscriptionsPluginOptions = { middleware: AppMiddleware };

export const subscriptionsPlugin: FastifyPluginAsync<SubscriptionsPluginOptions> = async (app, opts) => {
  const { authPreHandler, tenantScopedPreHandler } = opts.middleware;

  app.get("/plans", { preHandler: authPreHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const plans = await prisma.plan.findMany({ orderBy: { createdAt: "asc" } });
    const data = plans.map((p: any) => ({ id: p.id, code: p.code, name: p.name, limits: parseJson(p.limits), features: parseJson(p.features) }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.get("/subscriptions", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = getTenantContext(request);
    const row = await prisma.subscription.findFirst({ where: { tenantId }, include: { plan: true } });
    const data = row ? [{
      id: row.id, tenantId: row.tenantId, planId: row.planId, status: row.status,
      currentPeriodStart: toISO(row.currentPeriodStart), currentPeriodEnd: toISO(row.currentPeriodEnd),
      plan: { id: row.plan.id, code: row.plan.code, name: row.plan.name, limits: parseJson(row.plan.limits), features: parseJson(row.plan.features) }
    }] : [];
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.get("/subscriptions/requests", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const status = typeof query.status === "string" && query.status.length > 0 ? query.status : undefined;
    const where = { tenantId: ctx.tenantId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.subscriptionRequest.findMany({ where, skip, take, include: { plan: true }, orderBy: { createdAt: "desc" } }),
      prisma.subscriptionRequest.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(subscriptionRequestResponse), total };
  });

  app.post("/subscriptions/requests", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const body = z.object({
      planId: z.string(),
      notes: z.string().max(2000).optional().nullable(),
      proof: z.object({ imageUrl: z.string().min(6), fileName: z.string().min(1), mimeType: z.string().min(3), sizeBytes: z.number().int().positive(), metadata: z.record(z.any()).optional() })
    }).parse(request.body);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });
    const created = await prisma.subscriptionRequest.create({
      data: { tenantId: ctx.tenantId, planId: plan.id, requestedByUserId: ctx.userId, status: "pending_review", proofImageUrl: body.proof.imageUrl, proofFileName: body.proof.fileName, proofMimeType: body.proof.mimeType, proofSizeBytes: body.proof.sizeBytes, proofMetadata: body.proof.metadata ? JSON.stringify(body.proof.metadata) : null, notes: body.notes ?? null },
      include: { plan: true }
    });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "subscription_request", action: "create", resourceId: created.id, payload: { planId: created.planId, status: created.status, proofFileName: created.proofFileName, proofMimeType: created.proofMimeType, proofSizeBytes: created.proofSizeBytes }, context: request.ctx });
    return { data: subscriptionRequestResponse(created) };
  });

  app.put("/subscriptions/requests/:id/review", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ status: z.enum(["approved", "rejected"]), reviewNotes: z.string().max(2000).optional().nullable() }).parse(request.body);

    const current = await prisma.subscriptionRequest.findFirst({ where: { id, tenantId: ctx.tenantId }, include: { plan: true } });
    if (!current) throw app.httpErrors.notFound();
    if (current.status !== "pending_review") throw app.httpErrors.conflict("Subscription request is not pending review");

    const reviewed = await prisma.subscriptionRequest.update({
      where: { id },
      data: { status: body.status, reviewedByUserId: ctx.userId, reviewNotes: body.reviewNotes ?? null, reviewedAt: new Date() },
      include: { plan: true }
    });

    if (body.status === "approved") {
      await prisma.subscription.upsert({
        where: { tenantId: ctx.tenantId },
        update: { planId: reviewed.planId, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
        create: { tenantId: ctx.tenantId, planId: reviewed.planId, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) }
      });
    }

    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "subscription_request", action: "review", resourceId: reviewed.id, payload: { status: reviewed.status, planId: reviewed.planId }, context: request.ctx });
    return { data: subscriptionRequestResponse(reviewed) };
  });
};
