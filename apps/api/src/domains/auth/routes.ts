import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { LoginInputSchema } from "@app/shared";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { toISO } from "../../core/utils.js";
import { ApiDomainError } from "../../core/types.js";

export type AuthPluginOptions = {
  middleware: AppMiddleware;
  superuserEmails: Set<string>;
};

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const { authPreHandler, checkLoginRateLimit } = opts.middleware;

  app.post("/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    checkLoginRateLimit(request);
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;
    const { email, password, audience } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) throw app.httpErrors.unauthorized("Invalid credentials");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw app.httpErrors.unauthorized("Invalid credentials");

    if (audience === "backoffice") {
      const isSuperuser = opts.superuserEmails.has(user.email.toLowerCase());
      if (!isSuperuser) {
        const elevatedRole = await prisma.membership.findFirst({
          where: { userId: user.id, role: { in: ["tenant_admin", "monitor"] }, tenant: { deletedAt: null } },
          select: { id: true }
        });
        if (!elevatedRole) {
          throw new ApiDomainError({ statusCode: 403, apiCode: "BACKOFFICE_ACCESS_DENIED", message: "Backoffice access requires admin or operator role" });
        }
      }
    }

    const token = await reply.jwtSign({ userId: user.id }, { expiresIn: "8h" });
    return { accessToken: token, user: { id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt), isActive: user.isActive } };
  });

  app.post("/auth/logout", async () => ({ success: true }));

  app.get("/auth/me", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.ctx!.userId } });
    const effectiveRole = request.ctx?.role ?? null;
    let memberships: Array<any> = [];

    if (request.ctx?.isSuperuser) {
      const tenants = await prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
      memberships = tenants.map((tenant) => ({
        id: `super-${tenant.id}`, tenantId: tenant.id, userId: user.id,
        role: request.ctx?.impersonatedRole ?? "tenant_admin", createdAt: tenant.createdAt,
        tenant: { id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }
      }));
    } else {
      memberships = await prisma.membership.findMany({
        where: { userId: user.id, tenant: { deletedAt: null } },
        include: { tenant: true },
        orderBy: [{ tenant: { createdAt: "asc" } }, { createdAt: "asc" }]
      });
    }

    const activeTenantId = (request.headers["x-tenant-id"] as string | undefined) ?? memberships[0]?.tenantId;
    const activeTenant = memberships.find((m: any) => m.tenantId === activeTenantId)?.tenant;

    return {
      user: {
        id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt),
        isActive: user.isActive, isSuperuser: Boolean(request.ctx?.isSuperuser)
      },
      effectiveRole,
      activeTenantId: activeTenantId ?? null,
      activeTenant: activeTenant ? { id: activeTenant.id, name: activeTenant.name, createdAt: toISO(activeTenant.createdAt) } : null,
      memberships: memberships.map((m: any) => ({
        id: m.id, tenantId: m.tenantId, userId: m.userId, role: m.role, createdAt: toISO(m.createdAt),
        tenant: { id: m.tenant.id, name: m.tenant.name, createdAt: toISO(m.tenant.createdAt) }
      }))
    };
  });
};
