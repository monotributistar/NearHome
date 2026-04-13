import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./prisma.js";
import type { Role, LoginBucket } from "./types.js";

export type MiddlewareConfig = {
  superuserEmails: Set<string>;
  loginBuckets: Map<string, LoginBucket>;
  loginRateLimitMax: number;
  loginRateLimitWindowMs: number;
};

export function createMiddleware(app: FastifyInstance, config: MiddlewareConfig) {
  const { superuserEmails, loginBuckets, loginRateLimitMax, loginRateLimitWindowMs } = config;

  const authPreHandler = async (request: FastifyRequest) => {
    await request.jwtVerify<{ userId: string }>();
    const payload = request.user as { userId: string };
    const authUser = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { email: true, isActive: true }
    });
    if (!authUser || !authUser.isActive) {
      throw app.httpErrors.unauthorized("User inactive or not found");
    }
    const isSuperuser = superuserEmails.has(authUser.email.toLowerCase());
    request.ctx = { userId: payload.userId, realUserId: payload.userId, isSuperuser };

    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const rawImpersonateRole = request.headers["x-impersonate-role"];
    const impersonateRoleHeader = Array.isArray(rawImpersonateRole) ? rawImpersonateRole[0] : rawImpersonateRole;
    const impersonatedRole = impersonateRoleHeader
      ? z.enum(["tenant_admin", "monitor", "client_user"]).parse(impersonateRoleHeader)
      : undefined;

    if (impersonatedRole && !isSuperuser) throw app.httpErrors.forbidden("Impersonation requires superuser");
    if (impersonatedRole && !tenantHeader) throw app.httpErrors.badRequest("Impersonation requires X-Tenant-Id");

    if (tenantHeader) {
      if (isSuperuser) {
        const tenant = await prisma.tenant.findFirst({ where: { id: tenantHeader, deletedAt: null }, select: { id: true } });
        if (!tenant) throw app.httpErrors.forbidden("Invalid tenant context");
        request.ctx.tenantId = tenantHeader;
        request.ctx.role = impersonatedRole ?? "tenant_admin";
        request.ctx.isImpersonating = Boolean(impersonatedRole);
        request.ctx.impersonatedRole = impersonatedRole;
      } else {
        const membership = await prisma.membership.findFirst({
          where: { tenantId: tenantHeader, userId: payload.userId, tenant: { deletedAt: null } }
        });
        if (!membership) throw app.httpErrors.forbidden("Invalid tenant context");
        request.ctx.tenantId = tenantHeader;
        request.ctx.role = membership.role as Role;
      }
    }
  };

  const tenantScopedPreHandler = async (request: FastifyRequest) => {
    await authPreHandler(request);
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    if (!tenantHeader) throw new Error("MISSING_TENANT");
  };

  const checkLoginRateLimit = (request: FastifyRequest) => {
    const forwarded = request.headers["x-forwarded-for"];
    const ipCandidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const key = (typeof ipCandidate === "string" ? ipCandidate.split(",")[0]?.trim() : undefined) || request.ip || "unknown";
    const now = Date.now();
    const bucket = loginBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      loginBuckets.set(key, { count: 1, resetAt: now + loginRateLimitWindowMs });
      return;
    }
    if (bucket.count >= loginRateLimitMax) throw app.httpErrors.tooManyRequests("Too many login attempts");
    bucket.count += 1;
  };

  return { authPreHandler, tenantScopedPreHandler, checkLoginRateLimit };
}

export type AppMiddleware = ReturnType<typeof createMiddleware>;
