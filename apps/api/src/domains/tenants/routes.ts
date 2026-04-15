import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { ApiDomainError } from "../../core/types.js";
import { TenantVpnProviderSchema, TenantVpnTopologySchema, TenantNetworkSpaceTypeSchema, TenantVpnStatusSchema } from "../../core/types.js";
import type { ParsedIpv4Cidr } from "../../core/utils.js";
import { assertRole, getTenantContext, toISO, hasGlobalSuperuserPrivileges, serializeNetworkSpace, parseIpv4Cidr, overlapsReservedIpv4, cidrOverlaps, transitionTenantVpnLifecycle, appendAuditLog, getEntitlementsForTenant, parseJson } from "../../core/utils.js";

export type TenantsPluginOptions = { middleware: AppMiddleware };

export const tenantsPlugin: FastifyPluginAsync<TenantsPluginOptions> = async (app, opts) => {
  const { authPreHandler, tenantScopedPreHandler } = opts.middleware;

  // ─── Tenants CRUD ────────────────────────────────────────────────────────────

  app.get("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    let data: Array<{ id: string; name: string; createdAt: string }> = [];
    if (hasGlobalSuperuserPrivileges(request)) {
      const tenants = await prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
      data = tenants.map((t) => ({ id: t.id, name: t.name, createdAt: toISO(t.createdAt) }));
    } else if (request.ctx?.isSuperuser && request.ctx?.tenantId) {
      const tenant = await prisma.tenant.findFirst({ where: { id: request.ctx.tenantId, deletedAt: null } });
      data = tenant ? [{ id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) }] : [];
    } else {
      const memberships = await prisma.membership.findMany({
        where: { userId: request.ctx!.userId, tenant: { deletedAt: null } },
        include: { tenant: true }
      });
      data = memberships.map((m: any) => ({ id: m.tenant.id, name: m.tenant.name, createdAt: toISO(m.tenant.createdAt) }));
    }
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const tenant = await prisma.tenant.create({ data: { name: body.name } });
    await prisma.membership.create({ data: { tenantId: tenant.id, userId: request.ctx!.userId, role: "tenant_admin" } });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.get("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (request.ctx?.isSuperuser && request.ctx?.isImpersonating) {
      if (request.ctx.tenantId !== id) throw app.httpErrors.forbidden("Impersonated context can only access active tenant");
    } else if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { tenantId: id, userId: request.ctx!.userId, tenant: { deletedAt: null } } });
      if (!membership) throw app.httpErrors.forbidden();
    }
    const tenant = await prisma.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!tenant) throw app.httpErrors.notFound();
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.put("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    if (request.ctx?.isSuperuser && request.ctx?.isImpersonating) {
      if (request.ctx.role !== "tenant_admin") throw app.httpErrors.forbidden();
      if (request.ctx.tenantId !== id) throw app.httpErrors.forbidden("Impersonated context can only edit active tenant");
    } else if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { tenantId: id, userId: request.ctx!.userId, tenant: { deletedAt: null } } });
      if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();
    }
    const tenant = await prisma.tenant.update({ where: { id }, data: { name: body.name } });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.delete("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (request.ctx?.isSuperuser && request.ctx?.isImpersonating) {
      if (request.ctx.role !== "tenant_admin") throw app.httpErrors.forbidden();
      if (request.ctx.tenantId !== id) throw app.httpErrors.forbidden("Impersonated context can only delete active tenant");
    } else if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { tenantId: id, userId: request.ctx!.userId, role: "tenant_admin", tenant: { deletedAt: null } } });
      if (!membership) throw app.httpErrors.forbidden();
    }
    const tenant = await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date() } });
    await appendAuditLog({ tenantId: id, actorUserId: request.ctx!.userId, resource: "tenant", action: "delete", resourceId: id, payload: { name: tenant.name }, context: request.ctx });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  // ─── Entitlements + Subscription ─────────────────────────────────────────────

  app.get("/tenants/:id/entitlements", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
      if (!membership) throw app.httpErrors.forbidden();
    }
    const entitlements = await getEntitlementsForTenant(tenantId);
    return { data: entitlements };
  });

  app.post("/tenants/:id/subscription", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
      if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();
    }
    const body = z.object({ planId: z.string() }).parse(request.body);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });
    const subscription = await prisma.subscription.upsert({
      where: { tenantId },
      update: { planId: plan.id, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
      create: { tenantId, planId: plan.id, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
      include: { plan: true }
    });
    await appendAuditLog({ tenantId, actorUserId: request.ctx!.userId, resource: "subscription", action: "set_plan", resourceId: subscription.id, payload: { planId: subscription.planId, status: subscription.status }, context: request.ctx });
    return {
      data: {
        id: subscription.id, tenantId: subscription.tenantId, planId: subscription.planId,
        status: subscription.status, currentPeriodStart: toISO(subscription.currentPeriodStart),
        currentPeriodEnd: toISO(subscription.currentPeriodEnd),
        plan: { id: subscription.plan.id, code: subscription.plan.code, name: subscription.plan.name, limits: parseJson(subscription.plan.limits), features: parseJson(subscription.plan.features) }
      }
    };
  });

  // ─── VPN / Network spaces ─────────────────────────────────────────────────────

  app.post("/network/tenants/:tenantId/vpns", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { tenantId } = request.params as { tenantId: string };
    if (tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();

    const body = z.object({
      name: z.string().trim().min(2),
      provider: TenantVpnProviderSchema.default("wireguard"),
      topology: TenantVpnTopologySchema.default("site_to_site"),
      networkSpaces: z.array(z.object({
        spaceType: TenantNetworkSpaceTypeSchema.default("camera_lan"),
        cidr: z.string().trim().min(3),
        gatewayIp: z.string().trim().min(3).optional(),
        dnsServers: z.array(z.string().trim().min(3)).optional(),
        isPrimary: z.boolean().optional()
      })).min(1)
    }).parse(request.body ?? {});

    const parsedSpaces = body.networkSpaces.map((space, index) => {
      const parsed = parseIpv4Cidr(space.cidr);
      if (!parsed) throw new ApiDomainError({ statusCode: 422, apiCode: "VPN_NETWORK_SPACE_INVALID", message: `invalid cidr at networkSpaces[${index}]`, details: { cidr: space.cidr, index } });
      if (overlapsReservedIpv4(parsed)) throw new ApiDomainError({ statusCode: 409, apiCode: "VPN_RESERVED_RANGE_CONFLICT", message: "network space conflicts with reserved ranges", details: { cidr: space.cidr, index } });
      return { ...space, parsed };
    });

    const existing = await prisma.tenantVpn.findFirst({ where: { tenantId, name: body.name } });
    if (existing) throw new ApiDomainError({ statusCode: 409, apiCode: "CONFLICT", message: "vpn name already exists for tenant", details: { tenantId, name: body.name } });

    const created = await prisma.$transaction(async (tx) => {
      const vpn = await tx.tenantVpn.create({ data: { tenantId, name: body.name, provider: body.provider, topology: body.topology, status: "draft" } });
      const spaces = await Promise.all(parsedSpaces.map((space) =>
        tx.tenantNetworkSpace.create({ data: { tenantId, vpnId: vpn.id, spaceType: space.spaceType, cidr: space.parsed.cidr, gatewayIp: space.gatewayIp ?? null, dnsServers: JSON.stringify(space.dnsServers ?? []), isPrimary: Boolean(space.isPrimary), status: "planned" } })
      ));
      return { vpn, spaces };
    });

    return { data: { id: created.vpn.id, tenantId: created.vpn.tenantId, name: created.vpn.name, provider: created.vpn.provider, topology: created.vpn.topology, status: created.vpn.status, createdAt: toISO(created.vpn.createdAt), networkSpaces: created.spaces.map(serializeNetworkSpace) } };
  });

  app.get("/network/tenants/:tenantId/vpns/:vpnId", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const { tenantId, vpnId } = request.params as { tenantId: string; vpnId: string };
    if (tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    const vpn = await prisma.tenantVpn.findFirst({ where: { id: vpnId, tenantId }, include: { networkSpaces: true } });
    if (!vpn) throw app.httpErrors.notFound("VPN not found");
    return { data: { id: vpn.id, tenantId: vpn.tenantId, name: vpn.name, provider: vpn.provider, topology: vpn.topology, status: vpn.status, lifecycleStatusReason: vpn.lifecycleStatusReason, credentialsRef: vpn.credentialsRef, tunnelInterface: vpn.tunnelInterface, createdAt: toISO(vpn.createdAt), updatedAt: toISO(vpn.updatedAt), activatedAt: vpn.activatedAt ? toISO(vpn.activatedAt) : null, revokedAt: vpn.revokedAt ? toISO(vpn.revokedAt) : null, networkSpaces: vpn.networkSpaces.map(serializeNetworkSpace) } };
  });

  app.post("/network/tenants/:tenantId/vpns/:vpnId/validate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { tenantId, vpnId } = request.params as { tenantId: string; vpnId: string };
    if (tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    const vpn = await prisma.tenantVpn.findFirst({ where: { id: vpnId, tenantId }, include: { networkSpaces: true } });
    if (!vpn) throw app.httpErrors.notFound("VPN not found");

    const parsedCurrent = vpn.networkSpaces.map((space, index) => {
      const parsed = parseIpv4Cidr(space.cidr);
      if (!parsed) throw new ApiDomainError({ statusCode: 422, apiCode: "VPN_NETWORK_SPACE_INVALID", message: "stored cidr is invalid", details: { vpnId, networkSpaceId: space.id, cidr: space.cidr, index } });
      if (overlapsReservedIpv4(parsed)) throw new ApiDomainError({ statusCode: 409, apiCode: "VPN_RESERVED_RANGE_CONFLICT", message: "network space conflicts with reserved ranges", details: { vpnId, networkSpaceId: space.id, cidr: space.cidr, index } });
      return { space, parsed };
    });

    const otherTenantSpaces = await prisma.tenantNetworkSpace.findMany({ where: { tenantId: { not: tenantId }, status: { not: "retired" } } });
    const parsedOthers = otherTenantSpaces.map((space) => ({ space, parsed: parseIpv4Cidr(space.cidr) })).filter((entry): entry is { space: typeof otherTenantSpaces[number]; parsed: ParsedIpv4Cidr } => Boolean(entry.parsed));

    for (const current of parsedCurrent) {
      const overlap = parsedOthers.find((entry) => cidrOverlaps(current.parsed, entry.parsed));
      if (overlap) throw new ApiDomainError({ statusCode: 409, apiCode: "VPN_CIDR_OVERLAP", message: "network space overlaps another tenant cidr", details: { vpnId, cidr: current.space.cidr, conflictWithTenantId: overlap.space.tenantId, conflictWithNetworkSpaceId: overlap.space.id, conflictWithCidr: overlap.space.cidr } });
    }

    const transitioned = await transitionTenantVpnLifecycle({ tenantId, vpnId: vpn.id, toStatus: "validating", reason: null, event: "vpn.validate", context: request.ctx, actorUserId: request.ctx?.userId });
    return { data: { vpnId: vpn.id, status: transitioned.status, checks: [{ name: "cidr_overlap", ok: true }, { name: "reserved_ranges", ok: true }] } };
  });

  app.get("/network/tenants/:tenantId/vpns/:vpnId/health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const { tenantId, vpnId } = request.params as { tenantId: string; vpnId: string };
    if (tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    const vpn = await prisma.tenantVpn.findFirst({ where: { id: vpnId, tenantId }, select: { id: true, status: true } });
    if (!vpn) throw app.httpErrors.notFound("VPN not found");
    const peers = await prisma.tenantVpnPeer.findMany({ where: { tenantId, vpnId, status: { not: "revoked" } }, select: { status: true } });
    const peerOnline = peers.filter((p) => p.status === "active").length;
    const status = TenantVpnStatusSchema.parse(vpn.status);
    const baselineLatency = status === "active" ? 32 : status === "degraded" ? 95 : status === "failed" ? 250 : 60;
    const baselineLoss = status === "active" ? 0.1 : status === "degraded" ? 1.5 : status === "failed" ? 10 : 0.5;
    return { data: { vpnId: vpn.id, status, latencyMsP95: baselineLatency, packetLossPct: baselineLoss, peerOnline, peerTotal: peers.length, checkedAt: toISO(new Date()) } };
  });
};
