/* ARCHIVED: models pruned in Phase 0 (Household, HouseholdMember)
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { assertRole, getTenantContext, parseListQuery, appendAuditLog, householdResponse } from "../../core/utils.js";
import { householdMemberResponse } from "../../core/responses.js";

export type HouseholdsPluginOptions = { middleware: AppMiddleware };

export const householdsPlugin: FastifyPluginAsync<HouseholdsPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;

  app.get("/households", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const { skip, take } = parseListQuery(request.query as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.household.findMany({ where: { tenantId: ctx.tenantId }, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.household.count({ where: { tenantId: ctx.tenantId } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(householdResponse), total };
  });

  app.post("/households", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const body = z.object({ name: z.string().min(2), address: z.string().optional().nullable(), notes: z.string().optional().nullable(), isActive: z.boolean().optional() }).parse(request.body);
    const row = await prisma.household.create({
      data: { tenantId: ctx.tenantId, name: body.name, address: body.address ?? null, notes: body.notes ?? null, isActive: body.isActive ?? true, createdByUserId: ctx.userId }
    });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household", action: "create", resourceId: row.id, payload: { name: row.name }, context: request.ctx });
    return { data: householdResponse(row) };
  });

  app.put("/households/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().min(2).optional(), address: z.string().nullable().optional(), notes: z.string().nullable().optional(), isActive: z.boolean().optional() }).parse(request.body ?? {});
    const existing = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household not found");
    const row = await prisma.household.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.address !== undefined ? { address: body.address } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household", action: "update", resourceId: row.id, payload: { name: row.name, isActive: row.isActive }, context: request.ctx });
    return { data: householdResponse(row) };
  });

  app.delete("/households/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { id } = request.params as { id: string };
    const existing = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household not found");
    await prisma.householdMember.deleteMany({ where: { householdId: id } });
    await prisma.household.delete({ where: { id } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household", action: "delete", resourceId: id, payload: { name: existing.name }, context: request.ctx });
    return reply.status(204).send();
  });

  app.get("/households/:id/members", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const { id } = request.params as { id: string };
    const household = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!household) throw app.httpErrors.notFound("Household not found");
    const { skip, take } = parseListQuery(request.query as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.householdMember.findMany({ where: { tenantId: ctx.tenantId, householdId: id }, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.householdMember.count({ where: { tenantId: ctx.tenantId, householdId: id } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(householdMemberResponse), total };
  });

  app.post("/households/:id/members", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const household = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!household) throw app.httpErrors.notFound("Household not found");
    const body = z.object({ fullName: z.string().min(2), relationship: z.string().min(2), phone: z.string().max(80).optional().nullable(), canViewCameras: z.boolean().optional().default(true), canReceiveAlerts: z.boolean().optional().default(true), isActive: z.boolean().optional().default(true) }).parse(request.body);
    const row = await prisma.householdMember.create({ data: { tenantId: ctx.tenantId, householdId: id, fullName: body.fullName, relationship: body.relationship, phone: body.phone ?? null, canViewCameras: body.canViewCameras, canReceiveAlerts: body.canReceiveAlerts, isActive: body.isActive, createdByUserId: ctx.userId } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household_member", action: "create", resourceId: row.id, payload: { householdId: id, fullName: row.fullName, relationship: row.relationship }, context: request.ctx });
    return { data: householdMemberResponse(row) };
  });

  app.put("/household-members/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const { id } = request.params as { id: string };
    const body = z.object({ fullName: z.string().min(2).optional(), relationship: z.string().min(2).optional(), phone: z.string().max(80).optional().nullable(), canViewCameras: z.boolean().optional(), canReceiveAlerts: z.boolean().optional(), isActive: z.boolean().optional() }).parse(request.body);
    const existing = await prisma.householdMember.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household member not found");
    const row = await prisma.householdMember.update({ where: { id }, data: { ...(body.fullName !== undefined ? { fullName: body.fullName } : {}), ...(body.relationship !== undefined ? { relationship: body.relationship } : {}), ...(body.phone !== undefined ? { phone: body.phone ?? null } : {}), ...(body.canViewCameras !== undefined ? { canViewCameras: body.canViewCameras } : {}), ...(body.canReceiveAlerts !== undefined ? { canReceiveAlerts: body.canReceiveAlerts } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household_member", action: "update", resourceId: row.id, payload: { householdId: row.householdId, fullName: row.fullName, relationship: row.relationship, isActive: row.isActive }, context: request.ctx });
    return { data: householdMemberResponse(row) };
  });

  app.delete("/household-members/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const { id } = request.params as { id: string };
    const existing = await prisma.householdMember.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household member not found");
    await prisma.householdMember.delete({ where: { id } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "household_member", action: "delete", resourceId: id, payload: { householdId: existing.householdId, fullName: existing.fullName }, context: request.ctx });
  return { data: householdMemberResponse(existing) };
});

*/