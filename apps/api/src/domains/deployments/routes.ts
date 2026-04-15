import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { assertRole, getTenantContext, toISO, parseListQuery, hasGlobalSuperuserPrivileges } from "../../core/utils.js";

export type DeploymentsPluginOptions = { middleware: AppMiddleware };

function manifestResponse(m: any) {
  return {
    id: m.id,
    tenantId: m.tenantId ?? null,
    name: m.name,
    version: m.version,
    services: m.services,
    targetType: m.targetType,
    targetId: m.targetId ?? null,
    status: m.status,
    stagedAt: m.stagedAt ? toISO(m.stagedAt) : null,
    deployedAt: m.deployedAt ? toISO(m.deployedAt) : null,
    rolledBackAt: m.rolledBackAt ? toISO(m.rolledBackAt) : null,
    rolledBackTo: m.rolledBackTo ?? null,
    createdBy: m.createdBy,
    createdAt: toISO(m.createdAt),
    updatedAt: toISO(m.updatedAt)
  };
}

function rolloutResponse(r: any) {
  return {
    id: r.id,
    manifestId: r.manifestId,
    gatewayId: r.gatewayId,
    status: r.status,
    startedAt: r.startedAt ? toISO(r.startedAt) : null,
    completedAt: r.completedAt ? toISO(r.completedAt) : null,
    errorMessage: r.errorMessage ?? null,
    attempt: r.attempt,
    createdAt: toISO(r.createdAt),
    updatedAt: toISO(r.updatedAt)
  };
}

function fleetGroupResponse(g: any) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    tags: g.tags,
    createdAt: toISO(g.createdAt),
    updatedAt: toISO(g.updatedAt)
  };
}

export const deploymentsPlugin: FastifyPluginAsync<DeploymentsPluginOptions> = async (app, opts) => {
  const { authPreHandler, tenantScopedPreHandler } = opts.middleware;

  // ─── Deployment Manifests ─────────────────────────────────────────────────

  app.get("/ops/deployments", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const status = typeof query.status === "string" && query.status.length > 0 ? query.status : undefined;

    let tenantId: string | undefined | null;
    if (hasGlobalSuperuserPrivileges(request)) {
      // super_admin can filter by tenantId or see all
      tenantId = typeof query.tenantId === "string" && query.tenantId.length > 0 ? query.tenantId : undefined;
    } else {
      tenantId = request.ctx?.tenantId ?? undefined;
    }

    const where: any = {
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(status ? { status } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.deploymentManifest.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.deploymentManifest.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(manifestResponse), total };
  });

  app.post("/ops/deployments", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "super_admin"]);
    const body = z.object({
      name: z.string().min(1).max(100),
      version: z.string().regex(/^\d+\.\d+\.\d+/, "must be semver"),
      services: z.string(),
      targetType: z.enum(["fleet", "gateway", "platform"]),
      targetId: z.string().nullable().optional(),
      tenantId: z.string().optional()
    }).parse(request.body);

    const resolvedTenantId = hasGlobalSuperuserPrivileges(request) && body.tenantId
      ? body.tenantId
      : ctx.tenantId;

    const manifest = await prisma.deploymentManifest.create({
      data: {
        tenantId: resolvedTenantId,
        name: body.name,
        version: body.version,
        services: body.services,
        targetType: body.targetType,
        targetId: body.targetId ?? null,
        createdBy: ctx.userId,
        status: "draft"
      }
    });
    return { data: manifestResponse(manifest) };
  });

  app.get("/ops/deployments/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const manifest = await prisma.deploymentManifest.findUnique({
      where: { id },
      include: { rollouts: { orderBy: { createdAt: "asc" } } }
    });
    if (!manifest) throw app.httpErrors.notFound();
    if (!hasGlobalSuperuserPrivileges(request) && manifest.tenantId !== request.ctx?.tenantId) {
      throw app.httpErrors.forbidden();
    }
    return { data: { ...manifestResponse(manifest), rollouts: manifest.rollouts.map(rolloutResponse) } };
  });

  app.post("/ops/deployments/:id/stage", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "super_admin"]);
    const id = (request.params as { id: string }).id;

    const manifest = await prisma.deploymentManifest.findUnique({ where: { id } });
    if (!manifest) throw app.httpErrors.notFound();
    if (!hasGlobalSuperuserPrivileges(request) && manifest.tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    if (manifest.status !== "draft") throw app.httpErrors.conflict("Manifest must be in draft status to stage");

    const updated = await prisma.deploymentManifest.update({
      where: { id },
      data: { status: "staged", stagedAt: new Date() }
    });
    return { data: manifestResponse(updated) };
  });

  app.post("/ops/deployments/:id/rollout", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "super_admin"]);
    const id = (request.params as { id: string }).id;

    const manifest = await prisma.deploymentManifest.findUnique({ where: { id } });
    if (!manifest) throw app.httpErrors.notFound();
    if (!hasGlobalSuperuserPrivileges(request) && manifest.tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    if (manifest.status !== "staged") throw app.httpErrors.conflict("Manifest must be in staged status to roll out");

    // Determine gateways to deploy to based on targetType/targetId
    let gateways: { id: string }[] = [];
    if (manifest.targetType === "fleet" && manifest.targetId) {
      gateways = await prisma.edgeGateway.findMany({ where: { fleetGroupId: manifest.targetId }, select: { id: true } });
    } else if (manifest.targetType === "gateway" && manifest.targetId) {
      gateways = [{ id: manifest.targetId }];
    } else {
      // platform-wide: all gateways for tenant (or all if super_admin with no tenant)
      const tenantWhere = manifest.tenantId ? { tenantId: manifest.tenantId } : {};
      gateways = await prisma.edgeGateway.findMany({ where: tenantWhere, select: { id: true } });
    }

    // Update manifest status and create rollout records
    const [updated] = await prisma.$transaction([
      prisma.deploymentManifest.update({ where: { id }, data: { status: "rolling_out" } }),
      ...gateways.map((gw) =>
        prisma.deploymentRollout.create({
          data: { manifestId: id, gatewayId: gw.id, status: "pending" }
        })
      )
    ]);

    const rollouts = await prisma.deploymentRollout.findMany({ where: { manifestId: id }, orderBy: { createdAt: "asc" } });
    return { data: { ...manifestResponse(updated), rollouts: rollouts.map(rolloutResponse) } };
  });

  app.post("/ops/deployments/:id/rollback", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "super_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ rolledBackTo: z.string().optional() }).parse(request.body ?? {});

    const manifest = await prisma.deploymentManifest.findUnique({ where: { id } });
    if (!manifest) throw app.httpErrors.notFound();
    if (!hasGlobalSuperuserPrivileges(request) && manifest.tenantId !== ctx.tenantId) throw app.httpErrors.forbidden();
    if (!["rolling_out", "deployed", "failed"].includes(manifest.status)) {
      throw app.httpErrors.conflict("Manifest must be in rolling_out, deployed, or failed status to roll back");
    }

    const updated = await prisma.deploymentManifest.update({
      where: { id },
      data: { status: "rolled_back", rolledBackAt: new Date(), rolledBackTo: body.rolledBackTo ?? null }
    });
    return { data: manifestResponse(updated) };
  });

  app.get("/ops/deployments/:id/rollouts", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const manifest = await prisma.deploymentManifest.findUnique({ where: { id } });
    if (!manifest) throw app.httpErrors.notFound();
    if (!hasGlobalSuperuserPrivileges(request) && manifest.tenantId !== request.ctx?.tenantId) throw app.httpErrors.forbidden();

    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const [rows, total] = await Promise.all([
      prisma.deploymentRollout.findMany({ where: { manifestId: id }, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.deploymentRollout.count({ where: { manifestId: id } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(rolloutResponse), total };
  });

  // ─── Fleet Groups ─────────────────────────────────────────────────────────

  app.get("/ops/fleet-groups", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const [rows, total] = await Promise.all([
      prisma.fleetGroup.findMany({ skip, take, orderBy: { createdAt: "desc" } }),
      prisma.fleetGroup.count()
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(fleetGroupResponse), total };
  });

  app.post("/ops/fleet-groups", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    assertRole(request, ["tenant_admin", "super_admin"]);
    const body = z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional().nullable(),
      tags: z.array(z.string()).default([])
    }).parse(request.body);

    const group = await prisma.fleetGroup.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        tags: JSON.stringify(body.tags)
      }
    });
    return { data: fleetGroupResponse(group) };
  });

  app.put("/ops/fleet-groups/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    assertRole(request, ["tenant_admin", "super_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().nullable().optional(),
      tags: z.array(z.string()).optional()
    }).parse(request.body);

    const existing = await prisma.fleetGroup.findUnique({ where: { id } });
    if (!existing) throw app.httpErrors.notFound();

    const updated = await prisma.fleetGroup.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.tags !== undefined ? { tags: JSON.stringify(body.tags) } : {})
      }
    });
    return { data: fleetGroupResponse(updated) };
  });

  app.post("/ops/fleet-groups/:id/gateways", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    assertRole(request, ["tenant_admin", "super_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ gatewayId: z.string() }).parse(request.body);

    const group = await prisma.fleetGroup.findUnique({ where: { id } });
    if (!group) throw app.httpErrors.notFound();

    const gateway = await prisma.edgeGateway.findUnique({ where: { id: body.gatewayId } });
    if (!gateway) throw app.httpErrors.notFound("Gateway not found");

    const updated = await prisma.edgeGateway.update({
      where: { id: body.gatewayId },
      data: { fleetGroupId: id }
    });
    return { data: { id: updated.id, fleetGroupId: updated.fleetGroupId } };
  });

  app.delete("/ops/fleet-groups/:id/gateways/:gatewayId", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    assertRole(request, ["tenant_admin", "super_admin"]);
    const { id, gatewayId } = request.params as { id: string; gatewayId: string };

    const gateway = await prisma.edgeGateway.findUnique({ where: { id: gatewayId } });
    if (!gateway) throw app.httpErrors.notFound("Gateway not found");
    if (gateway.fleetGroupId !== id) throw app.httpErrors.conflict("Gateway is not in this fleet group");

    const updated = await prisma.edgeGateway.update({
      where: { id: gatewayId },
      data: { fleetGroupId: null }
    });
    return { data: { id: updated.id, fleetGroupId: updated.fleetGroupId } };
  });
};
