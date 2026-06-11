import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { getTenantContext, assertRole } from "../../core/utils.js";

export const sitesPlugin: FastifyPluginAsync = async (app) => {
  const { tenantScopedPreHandler } = (app as any).opts?.middleware || { tenantScopedPreHandler: (_req: any, _rep: any) => {} };

  app.get("/sites", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const rows = await prisma.site.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
    });
    return { data: rows, total: rows.length };
  });

  app.post("/sites", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z.object({
      name: z.string().min(2),
      address: z.string().optional(),
    }).parse(request.body);

    const site = await prisma.site.create({
      data: { tenantId: ctx.tenantId, name: body.name, address: body.address },
    });
    return { data: site };
  });

  app.get("/sites/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const id = (request.params as { id: string }).id;
    const site = await prisma.site.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: { edgeGateways: true, networkSpaces: true },
    });
    if (!site) throw (app as any).httpErrors.notFound();
    return { data: site };
  });

  app.put("/sites/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({
      name: z.string().min(2).optional(),
      address: z.string().optional().nullable(),
    }).parse(request.body);

    const site = await prisma.site.update({
      where: { id, tenantId: ctx.tenantId },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.address !== undefined ? { address: body.address } : {}) },
    });
    return { data: site };
  });

  app.delete("/sites/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    await prisma.site.delete({ where: { id, tenantId: ctx.tenantId } });
    return { data: { deleted: true } };
  });
};
