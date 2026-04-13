import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { LoginInputSchema, RegisterInputSchema, AddPlaceInputSchema, InviteCreateInputSchema, InviteAcceptInputSchema } from "@app/shared";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { toISO, appendAuditLog } from "../../core/utils.js";
import { ApiDomainError } from "../../core/types.js";

export type AuthPluginOptions = {
  middleware: AppMiddleware;
  superuserEmails: Set<string>;
  inviteSecret: string;
  portalBaseUrl: string;
};

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const { authPreHandler, checkLoginRateLimit, tenantScopedPreHandler } = opts.middleware;

  // ── POST /auth/login ──────────────────────────────────────────────────────
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

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post("/auth/logout", async () => ({ success: true }));

  // ── GET /auth/me ──────────────────────────────────────────────────────────
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

  // ── POST /auth/register ───────────────────────────────────────────────────
  // Self-service signup: creates User + Tenant (place) + Membership(monitor)
  app.post("/auth/register", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = RegisterInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;
    const { name, email, password, placeName, placeAddress } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiDomainError({ statusCode: 409, apiCode: "EMAIL_ALREADY_REGISTERED", message: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { user, tenant } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name, email, passwordHash, isActive: true }
      });
      const tenant = await tx.tenant.create({
        data: {
          name: placeName,
          ...(placeAddress ? { address: placeAddress } : {})
        } as any
      });
      await tx.membership.create({
        data: { tenantId: tenant.id, userId: user.id, role: "monitor" }
      });
      return { user, tenant };
    });

    await appendAuditLog({
      tenantId: tenant.id,
      actorUserId: user.id,
      resource: "auth",
      action: "register",
      resourceId: user.id,
      payload: { email, placeName, placeAddress }
    });

    const token = await reply.jwtSign({ userId: user.id }, { expiresIn: "8h" });
    reply.status(201);
    return {
      accessToken: token,
      user: { id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt), isActive: user.isActive },
      tenant: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) }
    };
  });

  // ── POST /auth/place ──────────────────────────────────────────────────────
  // Authenticated user adds another place (tenant)
  app.post("/auth/place", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = AddPlaceInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;
    const { placeName, placeAddress } = parsed.data;
    const userId = request.ctx!.userId;

    const tenant = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: placeName,
          ...(placeAddress ? { address: placeAddress } : {})
        } as any
      });
      await tx.membership.create({
        data: { tenantId: tenant.id, userId, role: "monitor" }
      });
      return tenant;
    });

    await appendAuditLog({
      tenantId: tenant.id,
      actorUserId: userId,
      resource: "place",
      action: "add",
      resourceId: tenant.id,
      payload: { placeName, placeAddress }
    });

    reply.status(201);
    return { tenant: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  // ── POST /auth/invite ─────────────────────────────────────────────────────
  // Generates a shareable invite link (tenant_admin or monitor role)
  app.post("/auth/invite", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = request.ctx!;
    if (ctx.role !== "tenant_admin" && ctx.role !== "monitor") {
      throw app.httpErrors.forbidden("Only operators and users can create invites");
    }

    const parsed = InviteCreateInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;
    const { role, label } = parsed.data;

    // Viewers (monitor) can only invite other viewers (client_user)
    if (ctx.role === "monitor" && role !== "client_user") {
      throw new ApiDomainError({ statusCode: 403, apiCode: "INVITE_ROLE_NOT_ALLOWED", message: "Users can only invite Viewers" });
    }

    const expiresIn = 7 * 24 * 60 * 60; // 7 days in seconds
    const token = await reply.jwtSign(
      { tenantId: ctx.tenantId, role, label: label ?? null, type: "invite" },
      { expiresIn }
    );
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const inviteUrl = `${opts.portalBaseUrl}/invite/${token}`;

    await appendAuditLog({
      tenantId: ctx.tenantId!,
      actorUserId: ctx.userId,
      resource: "invite",
      action: "create",
      payload: { role, label, expiresAt }
    });

    reply.status(201);
    return { token, inviteUrl, expiresAt, role };
  });

  // ── POST /auth/invite/accept ──────────────────────────────────────────────
  // Public — validates invite token, creates user + membership
  app.post("/auth/invite/accept", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = InviteAcceptInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;
    const { token, name, email, password } = parsed.data;

    let claims: { tenantId: string; role: string; type: string };
    try {
      claims = app.jwt.verify<{ tenantId: string; role: string; type: string }>(token);
      if (!claims?.tenantId || !claims?.role) throw new Error("missing fields");
    } catch {
      throw new ApiDomainError({ statusCode: 400, apiCode: "INVITE_INVALID", message: "Invite link is invalid or has expired" });
    }

    if (claims.type !== "invite") {
      throw new ApiDomainError({ statusCode: 400, apiCode: "INVITE_INVALID", message: "Invalid invite token" });
    }

    const tenant = await prisma.tenant.findFirst({ where: { id: claims.tenantId, deletedAt: null } });
    if (!tenant) {
      throw new ApiDomainError({ statusCode: 404, apiCode: "TENANT_NOT_FOUND", message: "The place this invite belongs to no longer exists" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // User already exists — just upsert membership
      const alreadyMember = await prisma.membership.findFirst({ where: { userId: existing.id, tenantId: claims.tenantId } });
      if (alreadyMember) {
        throw new ApiDomainError({ statusCode: 409, apiCode: "ALREADY_MEMBER", message: "You are already a member of this place" });
      }
      await prisma.membership.create({ data: { tenantId: claims.tenantId, userId: existing.id, role: claims.role } });

      await appendAuditLog({
        tenantId: claims.tenantId,
        actorUserId: existing.id,
        resource: "invite",
        action: "accept",
        resourceId: existing.id,
        payload: { role: claims.role, existingUser: true }
      });

      const accessToken = await reply.jwtSign({ userId: existing.id }, { expiresIn: "8h" });
      return {
        accessToken,
        user: { id: existing.id, email: existing.email, name: existing.name, createdAt: toISO(existing.createdAt), isActive: existing.isActive },
        tenant: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) },
        role: claims.role
      };
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { user } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name, email, passwordHash, isActive: true } });
      await tx.membership.create({ data: { tenantId: claims.tenantId, userId: user.id, role: claims.role } });
      return { user };
    });

    await appendAuditLog({
      tenantId: claims.tenantId,
      actorUserId: user.id,
      resource: "invite",
      action: "accept",
      resourceId: user.id,
      payload: { role: claims.role, newUser: true }
    });

    const accessToken = await reply.jwtSign({ userId: user.id }, { expiresIn: "8h" });
    reply.status(201);
    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, createdAt: toISO(user.createdAt), isActive: user.isActive },
      tenant: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) },
      role: claims.role
    };
  });
};
