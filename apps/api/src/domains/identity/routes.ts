import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { RoleInputSchema } from "../../core/types.js";
import { assertRole, getTenantContext, parseListQuery, toISO, normalizeRoleInput, appendAuditLog, hasGlobalSuperuserPrivileges } from "../../core/utils.js";

export type IdentityPluginOptions = { middleware: AppMiddleware };

export const identityPlugin: FastifyPluginAsync<IdentityPluginOptions> = async (app, opts) => {
  const { authPreHandler, tenantScopedPreHandler } = opts.middleware;

  // ─── Users ─────────────────────────────────────────────────────────────────

  app.get("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const memberships = await prisma.membership.findMany({ where: { tenantId: ctx.tenantId }, include: { user: true } });
    const data = memberships.map((m: any) => ({ id: m.user.id, email: m.user.email, name: m.user.name, createdAt: toISO(m.user.createdAt), isActive: m.user.isActive, role: m.role }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const body = z.object({ email: z.string().email(), name: z.string(), password: z.string().min(8), role: RoleInputSchema }).parse(request.body);
    // Users (monitor) can only create viewers (client_user)
    const normalizedRole = normalizeRoleInput(body.role);
    if (ctx.role === "monitor" && normalizedRole !== "client_user") {
      throw app.httpErrors.forbidden("Users can only create Viewers");
    }
    const hash = await bcrypt.hash(body.password, 12);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    const user = existing
      ? existing
      : await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: hash, isActive: true } });
    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: user.id } },
      update: { role: normalizedRole },
      create: { tenantId: ctx.tenantId, userId: user.id, role: normalizedRole }
    });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "user", action: "create", resourceId: user.id, payload: { email: user.email, role: normalizedRole, existingUser: Boolean(existing) }, context: request.ctx });
    return { data: { id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt), isActive: user.isActive, role: normalizedRole } };
  });

  app.put("/users/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional(), role: RoleInputSchema.optional() }).refine((v) => v.name !== undefined || v.isActive !== undefined || v.role !== undefined, { message: "At least one field must be provided" }).parse(request.body);
    const membership = await prisma.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: id }, include: { user: true } });
    if (!membership) throw app.httpErrors.notFound("User not found in tenant");
    // Users (monitor) can only manage viewers (client_user)
    if (ctx.role === "monitor" && membership.role !== "client_user") {
      throw app.httpErrors.forbidden("Users can only manage Viewers");
    }
    const user = await prisma.user.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) } });
    if (body.role) {
      const newRole = normalizeRoleInput(body.role);
      if (ctx.role === "monitor" && newRole !== "client_user") throw app.httpErrors.forbidden("Users can only assign Viewer role");
      await prisma.membership.update({ where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } }, data: { role: newRole } });
    }
    const updatedMembership = await prisma.membership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "user", action: body.isActive === false ? "deactivate" : "update", resourceId: id, payload: { changes: body }, context: request.ctx });
    return { data: { id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt), isActive: user.isActive, role: updatedMembership.role } };
  });

  // ─── Memberships ────────────────────────────────────────────────────────────

  app.get("/memberships", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const queryTenantId = typeof query.tenantId === "string" ? query.tenantId : undefined;
    const queryUserId = typeof query.userId === "string" ? query.userId : undefined;
    const where = hasGlobalSuperuserPrivileges(request) && !request.ctx?.tenantId
      ? { ...(queryTenantId ? { tenantId: queryTenantId } : {}), ...(queryUserId ? { userId: queryUserId } : {}), tenant: { deletedAt: null } }
      : { tenantId: getTenantContext(request).tenantId };
    assertRole(request, ["tenant_admin", "monitor"]);
    const rows = await prisma.membership.findMany({ where, include: { user: true, tenant: true }, orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }] });
    const data = rows.map((m: any) => ({ id: m.id, tenantId: m.tenantId, userId: m.userId, role: m.role, createdAt: toISO(m.createdAt), user: { id: m.user.id, email: m.user.email, name: m.user.name, createdAt: toISO(m.user.createdAt), isActive: m.user.isActive }, tenant: { id: m.tenant.id, name: m.tenant.name, createdAt: toISO(m.tenant.createdAt) } }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/memberships", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z.object({ userId: z.string(), role: RoleInputSchema, tenantId: z.string().optional() }).parse(request.body);
    const normalizedRole = normalizeRoleInput(body.role);
    const tenantId = (() => {
      if (request.ctx?.isSuperuser) return body.tenantId ?? request.ctx.tenantId;
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin"]);
      return ctx.tenantId;
    })();
    if (!tenantId) throw app.httpErrors.badRequest("tenantId required");
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true } });
    if (!tenant) throw app.httpErrors.notFound("Tenant not found");
    const membership = await prisma.membership.upsert({ where: { tenantId_userId: { tenantId, userId: body.userId } }, update: { role: normalizedRole }, create: { tenantId, userId: body.userId, role: normalizedRole } });
    await appendAuditLog({ tenantId, actorUserId: request.ctx?.userId, resource: "membership", action: "upsert", resourceId: membership.id, payload: { userId: body.userId, role: normalizedRole }, context: request.ctx });
    return { data: { id: membership.id, tenantId: membership.tenantId, userId: membership.userId, role: membership.role, createdAt: toISO(membership.createdAt) } };
  });

  // ─── Camera assignments ──────────────────────────────────────────────────────

  app.get("/camera-assignments", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const query = request.query as Record<string, unknown>;
    const userId = typeof query.userId === "string" && query.userId.length > 0 ? query.userId : undefined;
    const rows = await prisma.cameraAssignment.findMany({ where: { tenantId: ctx.tenantId, ...(userId ? { userId } : {}) }, include: { camera: true, user: true }, orderBy: [{ userId: "asc" }, { createdAt: "asc" }] });
    const data = rows.map((row) => ({ id: row.id, tenantId: row.tenantId, userId: row.userId, cameraId: row.cameraId, createdAt: toISO(row.createdAt), user: { id: row.user.id, email: row.user.email, name: row.user.name }, camera: { id: row.camera.id, name: row.camera.name, isActive: row.camera.isActive } }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.put("/camera-assignments/:userId", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { userId } = request.params as { userId: string };
    const body = z.object({ cameraIds: z.array(z.string()) }).parse(request.body ?? {});
    const membership = await prisma.membership.findFirst({ where: { tenantId: ctx.tenantId, userId }, select: { role: true } });
    if (!membership) throw app.httpErrors.notFound("User not found in tenant");
    if (!["monitor", "client_user"].includes(membership.role)) throw app.httpErrors.badRequest("Camera assignment is only supported for monitor/client_user roles");
    const dedupCameraIds = Array.from(new Set(body.cameraIds));
    if (dedupCameraIds.length > 0) {
      const existingCameras = await prisma.camera.findMany({ where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: dedupCameraIds } }, select: { id: true } });
      const existingSet = new Set(existingCameras.map((c) => c.id));
      const missing = dedupCameraIds.filter((id) => !existingSet.has(id));
      if (missing.length > 0) throw app.httpErrors.badRequest(`Unknown camera ids: ${missing.join(", ")}`);
    }
    await prisma.cameraAssignment.deleteMany({ where: { tenantId: ctx.tenantId, userId } });
    if (dedupCameraIds.length > 0) {
      await prisma.cameraAssignment.createMany({ data: dedupCameraIds.map((cameraId) => ({ tenantId: ctx.tenantId, userId, cameraId })) });
    }
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera_assignment", action: "replace", resourceId: userId, payload: { cameraIds: dedupCameraIds }, context: request.ctx });
    return { data: { tenantId: ctx.tenantId, userId, cameraIds: dedupCameraIds } };
  });

  // ─── Audit logs ───────────────────────────────────────────────────────────

  app.get("/audit-logs", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const resource = typeof query.resource === "string" ? query.resource : undefined;
    const action = typeof query.action === "string" ? query.action : undefined;
    const where = { tenantId: ctx.tenantId, ...(resource ? { resource } : {}), ...(action ? { action } : {}) };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.auditLog.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map((e) => ({ id: e.id, tenantId: e.tenantId, actorUserId: e.actorUserId, resource: e.resource, action: e.action, resourceId: e.resourceId, payload: e.payload ? JSON.parse(e.payload) : null, createdAt: toISO(e.createdAt) })), total };
  });
};
