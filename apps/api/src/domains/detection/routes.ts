import { z } from "zod";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import {
  getTenantContext,
  parseListQuery,
  appendAuditLog,
  parseJson,
  toISO,
  assertRole,
  assertCameraAccess
} from "../../core/utils.js";
import { ApiDomainError } from "../../core/types.js";
import {
  detectionJobResponse,
  detectionObservationResponse,
  faceDetectionResponse,
  summarizeIdentityFaces,
  incidentEventResponse,
  incidentEvidenceResponse
} from "../../core/responses.js";
import {
  DetectionJobCreateInputSchema,
  DetectionJobStatusSchema,
  DetectionMediaKindSchema,
  createDetectionService,
  parseEmbeddingCandidate,
  cosineSimilarity,
  type DetectionServiceConfig
} from "./service.js";

export type DetectionPluginOptions = {
  middleware: AppMiddleware;
} & DetectionServiceConfig & {
    detectionCallbackSecret: string;
  };

type FaceSimilarityMatchResponse = {
  similarityScore: number;
  sameCamera: boolean;
  face: ReturnType<typeof faceDetectionResponse>;
};

const prismaUnsafe = prisma as any;

export const detectionPlugin: FastifyPluginAsync<DetectionPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;
  const { detectionCallbackSecret, detectionExecutionMode } = opts;
  const svc = createDetectionService({
    eventGatewayUrl: opts.eventGatewayUrl,
    eventPublishSecret: opts.eventPublishSecret,
    detectionBridgeUrl: opts.detectionBridgeUrl,
    audioDetectionRunnerUrl: opts.audioDetectionRunnerUrl,
    temporalDispatchUrl: opts.temporalDispatchUrl,
    detectionExecutionMode: opts.detectionExecutionMode
  });

  // ─── Internal: store detection observation (from detector service) ──────

  app.post("/internal/detections/observations", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z
      .object({
        tenantId: z.string().min(1),
        cameraId: z.string().min(1),
        label: z.string().min(1),
        confidence: z.number().min(0).max(1),
        bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
        frameUrl: z.string().optional(),
        frameTimestamp: z.string().optional()
      })
      .parse(request.body);

    const frameTs = body.frameTimestamp ? new Date(body.frameTimestamp) : new Date();

    // Create or reuse an auto-detection job for this camera/tenant
    const jobId = `auto-${body.tenantId}-${body.cameraId}`;
    await prisma.detectionJob.upsert({
      where: { id: jobId },
      create: {
        id: jobId,
        tenantId: body.tenantId,
        cameraId: body.cameraId,
        status: "completed",
        mode: "realtime",
        source: "detector-service",
        provider: "yolo-local",
        createdByUserId:
          body.tenantId === "tenant-a-oficinas" ? "cmnm61o6n000cw1x6u49orma0" : "cmnm61o6n000ew1x65p0tolne",
        startedAt: new Date(),
        finishedAt: new Date()
      },
      update: { finishedAt: new Date() }
    });

    const observation = await prisma.detectionObservation.create({
      data: {
        jobId,
        tenantId: body.tenantId,
        cameraId: body.cameraId,
        frameTs,
        label: body.label,
        confidence: body.confidence,
        bbox: JSON.stringify(body.bbox),
        providerMeta: body.frameUrl ? JSON.stringify({ frameUrl: body.frameUrl }) : undefined
      }
    });

    return { data: detectionObservationResponse(observation) };
  });

  // ─── Internal: batch store multiple detection observations ────────────

  app.post("/internal/detections/observations/batch", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z
      .object({
        tenantId: z.string().min(1),
        cameraId: z.string().min(1),
        frameUrl: z.string().optional(),
        frameTimestamp: z.string().optional(),
        observations: z
          .array(
            z.object({
              label: z.string().min(1),
              confidence: z.number().min(0).max(1),
              bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
            })
          )
          .min(1)
          .max(50)
      })
      .parse(request.body);

    const frameTs = body.frameTimestamp ? new Date(body.frameTimestamp) : new Date();
    const jobId = `auto-${body.tenantId}-${body.cameraId}`;
    const job = await prisma.detectionJob.upsert({
      where: { id: jobId },
      create: {
        id: jobId,
        tenantId: body.tenantId,
        cameraId: body.cameraId,
        status: "completed",
        mode: "realtime",
        source: "detector-service",
        provider: "yolo-local",
        createdByUserId:
          body.tenantId === "tenant-a-oficinas" ? "cmnm61o6n000cw1x6u49orma0" : "cmnm61o6n000ew1x65p0tolne",
        startedAt: new Date(),
        finishedAt: new Date()
      },
      update: { finishedAt: new Date() }
    });

    const meta = body.frameUrl ? JSON.stringify({ frameUrl: body.frameUrl }) : undefined;
    const rows = await prisma.$transaction(
      body.observations.map((obs) =>
        prisma.detectionObservation.create({
          data: {
            jobId,
            tenantId: body.tenantId,
            cameraId: body.cameraId,
            frameTs,
            label: obs.label,
            confidence: obs.confidence,
            bbox: JSON.stringify(obs.bbox),
            providerMeta: meta
          }
        })
      )
    );

    return { data: rows.map(detectionObservationResponse), count: rows.length };
  });

  app.post("/internal/detections/jobs/:id/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const providedSecret = request.headers["x-detection-callback-secret"];
    if (providedSecret !== detectionCallbackSecret) throw app.httpErrors.unauthorized("invalid callback secret");

    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        detections: z
          .array(
            z.object({
              label: z.string().optional(),
              confidence: z.number().optional(),
              mediaKind: DetectionMediaKindSchema.optional(),
              bbox: z
                .object({
                  x: z.number().optional(),
                  y: z.number().optional(),
                  w: z.number().optional(),
                  h: z.number().optional()
                })
                .optional(),
              keypoints: z.unknown().optional(),
              attributes: z.record(z.any()).optional(),
              providerMeta: z.record(z.any()).optional(),
              frameTs: z.string().optional(),
              startedAt: z.string().optional(),
              endedAt: z.string().optional(),
              temporalWindow: z
                .object({
                  startMs: z.number().int().nonnegative().optional(),
                  endMs: z.number().int().nonnegative().optional(),
                  durationMs: z.number().int().positive().optional()
                })
                .optional()
            })
          )
          .default([]),
        providerMeta: z.record(z.any()).optional()
      })
      .parse(request.body);

    const job = await svc.completeDetectionJob({
      jobId: id,
      detections: body.detections,
      providerMeta: body.providerMeta
    });
    if (!job) throw app.httpErrors.notFound();
    reply.code(200);
    return { data: detectionJobResponse(job) };
  });

  app.post("/internal/detections/jobs/:id/fail", async (request: FastifyRequest, reply: FastifyReply) => {
    const providedSecret = request.headers["x-detection-callback-secret"];
    if (providedSecret !== detectionCallbackSecret) throw app.httpErrors.unauthorized("invalid callback secret");

    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        errorCode: z.string().default("DETECTION_WORKFLOW_ERROR"),
        errorMessage: z.string().default("workflow failed")
      })
      .parse(request.body);

    const job = await svc.failDetectionJob(id, body.errorCode, body.errorMessage);
    if (!job) throw app.httpErrors.notFound();
    reply.code(200);
    return { data: detectionJobResponse(job) };
  });

  // ─── Detection jobs ───────────────────────────────────────────────────────

  app.post("/detections/jobs", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);

    const body = DetectionJobCreateInputSchema.parse(request.body ?? {});
    const camera = await prisma.camera.findFirst({
      where: { id: body.cameraId, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const resolved = await svc.resolveDetectionJobInput({
      tenantId: ctx.tenantId,
      cameraId: camera.id,
      mode: body.mode,
      provider: body.provider,
      pipelineId: body.pipelineId,
      overrides: body.overrides,
      options: body.options
    });

    const job = await prisma.detectionJob.create({
      data: {
        tenantId: ctx.tenantId,
        cameraId: camera.id,
        mode: resolved.mode,
        source: body.source,
        provider: resolved.provider,
        status: "queued",
        options: JSON.stringify(resolved.options),
        createdByUserId: ctx.userId
      }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "detection_job",
      action: "create",
      resourceId: job.id,
      payload: {
        cameraId: job.cameraId,
        mode: job.mode,
        source: job.source,
        provider: job.provider,
        pipelineId: body.pipelineId ?? null
      },
      context: (request as any).ctx
    });

    if (detectionExecutionMode === "temporal") {
      void svc.dispatchDetectionJobTemporal(job.id);
    } else if (opts.detectionBridgeUrl) {
      void svc.runDetectionJobPipeline(job.id);
    }

    return { data: detectionJobResponse(job) };
  });

  app.get("/detections/jobs/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const job = await prisma.detectionJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw app.httpErrors.notFound();
    return { data: detectionJobResponse(job) };
  });

  app.get(
    "/detections/jobs/:id/results",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const id = (request.params as { id: string }).id;
      const job = await prisma.detectionJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!job) throw app.httpErrors.notFound();
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const [rows, total] = await Promise.all([
        prisma.detectionObservation.findMany({
          where: { jobId: id, tenantId: ctx.tenantId },
          orderBy: { frameTs: "desc" },
          skip,
          take
        }),
        prisma.detectionObservation.count({ where: { jobId: id, tenantId: ctx.tenantId } })
      ]);
      reply.header("x-total-count", String(total));
      return { data: rows.map(detectionObservationResponse), total, job: detectionJobResponse(job) };
    }
  );

  app.post("/detections/jobs/:id/cancel", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const id = (request.params as { id: string }).id;
    const job = await prisma.detectionJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw app.httpErrors.notFound();
    const status = DetectionJobStatusSchema.parse(job.status);
    if (!["queued", "running"].includes(status)) return { data: detectionJobResponse(job) };
    const updated = await prisma.detectionJob.update({
      where: { id: job.id },
      data: { status: "canceled", canceledAt: new Date(), finishedAt: new Date() }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "detection_job",
      action: "cancel",
      resourceId: updated.id,
      context: (request as any).ctx
    });
    return { data: detectionJobResponse(updated) };
  });

  // ─── Camera detections + faces ────────────────────────────────────────────

  app.get(
    "/cameras/:id/detections",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const cameraId = (request.params as { id: string }).id;
      await assertCameraAccess({ ...ctx, cameraId });
      const camera = await prisma.camera.findFirst({
        where: { id: cameraId, tenantId: ctx.tenantId, deletedAt: null }
      });
      if (!camera) throw app.httpErrors.notFound();
      const query = request.query as Record<string, unknown>;
      const { skip, take, order, sort } = parseListQuery(query);
      const from = typeof query.from === "string" ? new Date(query.from) : undefined;
      const to = typeof query.to === "string" ? new Date(query.to) : undefined;
      const label = typeof query.label === "string" ? query.label : undefined;
      const minConfidence = typeof query.minConfidence === "string" ? Number(query.minConfidence) : undefined;
      const orderByKey = sort === "confidence" ? "confidence" : "frameTs";
      const where = {
        tenantId: ctx.tenantId,
        cameraId,
        ...(label ? { label } : {}),
        ...(Number.isFinite(minConfidence) ? { confidence: { gte: minConfidence as number } } : {}),
        ...(from || to ? { frameTs: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {})
      };
      const [rows, total] = await Promise.all([
        prisma.detectionObservation.findMany({ where, orderBy: { [orderByKey]: order }, skip, take }),
        prisma.detectionObservation.count({ where })
      ]);
      reply.header("x-total-count", String(total));
      return { data: rows.map(detectionObservationResponse), total };
    }
  );

  app.get(
    "/cameras/:id/faces",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const cameraId = (request.params as { id: string }).id;
      await assertCameraAccess({ ...ctx, cameraId });
      const camera = await prisma.camera.findFirst({
        where: { id: cameraId, tenantId: ctx.tenantId, deletedAt: null }
      });
      if (!camera) throw app.httpErrors.notFound();
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const clusterId = typeof query.clusterId === "string" ? query.clusterId : undefined;
      const identityId = typeof query.identityId === "string" ? query.identityId : undefined;
      const where = {
        tenantId: ctx.tenantId,
        cameraId,
        ...(clusterId ? { clusterMembership: { clusterId } } : {}),
        ...(identityId ? { identityMembership: { identityId } } : {})
      };
      const [rows, total] = await Promise.all([
        prismaUnsafe.faceDetection.findMany({
          where,
          include: {
            embedding: true,
            clusterMembership: { include: { cluster: true } },
            identityMembership: { include: { identity: true } }
          },
          orderBy: { frameTs: "desc" },
          skip,
          take
        }),
        prismaUnsafe.faceDetection.count({ where })
      ]);
      reply.header("x-total-count", String(total));
      return { data: rows.map(faceDetectionResponse), total };
    }
  );

  // ─── Face similarity ──────────────────────────────────────────────────────

  app.get(
    "/faces/detections/:id/similar",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const id = (request.params as { id: string }).id;
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const minSimilarity = Math.max(-1, Math.min(1, Number(query.minSimilarity ?? 0.7)));
      const sameCameraOnly = String(query.sameCameraOnly ?? "false").toLowerCase() === "true";

      const sourceFace = await prismaUnsafe.faceDetection.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: {
          embedding: true,
          clusterMembership: { include: { cluster: true } },
          identityMembership: { include: { identity: true } }
        }
      });
      if (!sourceFace) throw app.httpErrors.notFound();
      if (!sourceFace.embedding?.embeddingVector) {
        throw new ApiDomainError({
          statusCode: 409,
          apiCode: "FACE_SIMILARITY_UNAVAILABLE",
          message: "The requested face does not have a stored embedding vector",
          details: { faceDetectionId: id }
        });
      }

      const sourceVector = parseEmbeddingCandidate(parseJson<unknown>(sourceFace.embedding.embeddingVector));
      if (!sourceVector) {
        throw new ApiDomainError({
          statusCode: 409,
          apiCode: "FACE_SIMILARITY_UNAVAILABLE",
          message: "The requested face embedding vector is invalid",
          details: { faceDetectionId: id }
        });
      }

      const candidateRows = await prismaUnsafe.faceDetection.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { not: id },
          ...(sameCameraOnly ? { cameraId: sourceFace.cameraId } : {}),
          embedding: { embeddingVector: { not: null } }
        },
        include: {
          embedding: true,
          clusterMembership: { include: { cluster: true } },
          identityMembership: { include: { identity: true } }
        }
      });

      const rankedMatches = (candidateRows as Array<any>)
        .reduce((acc: FaceSimilarityMatchResponse[], candidate: any) => {
          const rawVector = candidate.embedding?.embeddingVector;
          if (!rawVector) return acc;
          const candidateVector = parseEmbeddingCandidate(parseJson<unknown>(rawVector));
          if (!candidateVector) return acc;
          const similarityScore = cosineSimilarity(sourceVector, candidateVector);
          if (similarityScore < minSimilarity) return acc;
          acc.push({
            similarityScore,
            sameCamera: candidate.cameraId === sourceFace.cameraId,
            face: faceDetectionResponse(candidate)
          });
          return acc;
        }, [])
        .sort((a: FaceSimilarityMatchResponse, b: FaceSimilarityMatchResponse) => {
          if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;
          return b.face.frameTs.localeCompare(a.face.frameTs);
        });

      const pagedMatches = rankedMatches.slice(skip, skip + take);
      reply.header("x-total-count", String(rankedMatches.length));
      return {
        data: {
          sourceFaceId: sourceFace.id,
          tenantId: ctx.tenantId,
          total: rankedMatches.length,
          matches: pagedMatches
        }
      };
    }
  );

  // ─── Face clusters ────────────────────────────────────────────────────────

  app.get(
    "/faces/clusters",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const status = typeof query.status === "string" ? query.status : undefined;
      const where = { tenantId: ctx.tenantId, ...(status ? { status } : {}) };
      const [rows, total] = await Promise.all([
        prismaUnsafe.faceCluster.findMany({
          where,
          include: {
            members: {
              orderBy: { createdAt: "desc" },
              take: 6,
              include: {
                faceDetection: {
                  include: {
                    embedding: true,
                    clusterMembership: { include: { cluster: true } },
                    identityMembership: { include: { identity: true } }
                  }
                }
              }
            }
          },
          orderBy: { updatedAt: "desc" },
          skip,
          take
        }),
        prismaUnsafe.faceCluster.count({ where })
      ]);
      reply.header("x-total-count", String(total));
      return {
        data: rows.map((cluster: any) => ({
          id: cluster.id,
          tenantId: cluster.tenantId,
          status: cluster.status,
          displayName: cluster.displayName,
          memberCount: cluster.memberCount,
          confirmedIdentityId: cluster.confirmedIdentityId,
          createdAt: toISO(cluster.createdAt),
          updatedAt: toISO(cluster.updatedAt),
          faces: cluster.members.map((m: any) => faceDetectionResponse(m.faceDetection))
        })),
        total
      };
    }
  );

  app.post(
    "/faces/clusters/:id/confirm-identity",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor"]);
      const id = (request.params as { id: string }).id;
      const body = z
        .object({ identityId: z.string().optional(), displayName: z.string().min(1).max(120).optional() })
        .parse(request.body);

      const cluster = await prismaUnsafe.faceCluster.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: { members: { include: { faceDetection: true, faceEmbedding: true } } }
      });
      if (!cluster) throw app.httpErrors.notFound();

      const identity = body.identityId
        ? await prismaUnsafe.faceIdentity.findFirst({
            where: { id: body.identityId, tenantId: ctx.tenantId, mergedIntoIdentityId: null }
          })
        : null;
      if (body.identityId && !identity) throw app.httpErrors.notFound("identity not found");

      const resolvedIdentity =
        identity ??
        (await prismaUnsafe.faceIdentity.create({
          data: {
            tenantId: ctx.tenantId,
            displayName: body.displayName ?? cluster.displayName ?? `Identity ${cluster.id.slice(-6)}`,
            status: "confirmed"
          }
        }));

      await prisma.$transaction(async (tx) => {
        const faceTx = tx as any;
        await faceTx.faceCluster.update({
          where: { id: cluster.id },
          data: {
            confirmedIdentityId: resolvedIdentity.id,
            status: "confirmed",
            displayName: body.displayName ?? cluster.displayName
          }
        });
        await faceTx.faceIdentity.update({
          where: { id: resolvedIdentity.id },
          data: { status: "confirmed", displayName: body.displayName ?? resolvedIdentity.displayName }
        });
        for (const member of cluster.members) {
          await faceTx.faceIdentityMember.upsert({
            where: { faceDetectionId: member.faceDetectionId },
            update: {
              identityId: resolvedIdentity.id,
              faceEmbeddingId: member.faceEmbeddingId,
              sourceClusterId: cluster.id
            },
            create: {
              tenantId: ctx.tenantId,
              identityId: resolvedIdentity.id,
              faceDetectionId: member.faceDetectionId,
              faceEmbeddingId: member.faceEmbeddingId,
              sourceClusterId: cluster.id
            }
          });
        }
      });

      await appendAuditLog({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        resource: "face_cluster",
        action: "confirm_identity",
        resourceId: cluster.id,
        payload: { identityId: resolvedIdentity.id, memberCount: cluster.members.length },
        context: (request as any).ctx
      });

      const updated = await prismaUnsafe.faceIdentity.findUniqueOrThrow({
        where: { id: resolvedIdentity.id },
        include: {
          members: {
            include: {
              faceDetection: {
                include: {
                  embedding: true,
                  clusterMembership: { include: { cluster: true } },
                  identityMembership: { include: { identity: true } }
                }
              }
            }
          }
        }
      });
      return {
        data: {
          id: updated.id,
          tenantId: updated.tenantId,
          displayName: updated.displayName,
          status: updated.status,
          mergedIntoIdentityId: updated.mergedIntoIdentityId,
          createdAt: toISO(updated.createdAt),
          updatedAt: toISO(updated.updatedAt),
          memberCount: updated.members.length,
          faces: updated.members.map((m: any) => faceDetectionResponse(m.faceDetection))
        }
      };
    }
  );

  // ─── Face identities ──────────────────────────────────────────────────────

  app.get(
    "/faces/identities",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const status = typeof query.status === "string" ? query.status : undefined;
      const includeMerged = String(query.includeMerged ?? "false").toLowerCase() === "true";
      const where = {
        tenantId: ctx.tenantId,
        ...(status ? { status } : {}),
        ...(includeMerged ? {} : { mergedIntoIdentityId: null })
      };
      const [rows, total] = await Promise.all([
        prismaUnsafe.faceIdentity.findMany({
          where,
          include: {
            members: {
              include: {
                faceDetection: {
                  include: {
                    embedding: true,
                    clusterMembership: { include: { cluster: true } },
                    identityMembership: { include: { identity: true } },
                    camera: true
                  }
                }
              }
            }
          },
          orderBy: { updatedAt: "desc" },
          skip,
          take
        }),
        prismaUnsafe.faceIdentity.count({ where })
      ]);
      reply.header("x-total-count", String(total));
      return {
        data: rows.map((identity: any) => {
          const faces = identity.members
            .map((m: any) => ({
              ...faceDetectionResponse(m.faceDetection),
              cameraName: m.faceDetection.camera?.name ?? m.faceDetection.cameraId
            }))
            .sort((a: any, b: any) => b.frameTs.localeCompare(a.frameTs));
          const summary = summarizeIdentityFaces(faces);
          return {
            id: identity.id,
            tenantId: identity.tenantId,
            displayName: identity.displayName,
            status: identity.status,
            mergedIntoIdentityId: identity.mergedIntoIdentityId,
            createdAt: toISO(identity.createdAt),
            updatedAt: toISO(identity.updatedAt),
            memberCount: identity.members.length,
            latestSeenAt: summary.latestSeenAt,
            cameras: summary.cameras,
            faces: faces.slice(0, 6)
          };
        }),
        total
      };
    }
  );

  app.get("/faces/identities/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const identity = await prismaUnsafe.faceIdentity.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: {
        members: {
          include: {
            faceDetection: {
              include: {
                camera: true,
                embedding: true,
                clusterMembership: { include: { cluster: true } },
                identityMembership: { include: { identity: true } }
              }
            }
          },
          orderBy: { faceDetection: { frameTs: "desc" } }
        },
        sourceMergeLogs: { include: { targetIdentity: true }, orderBy: { createdAt: "desc" } },
        targetMergeLogs: { include: { sourceIdentity: true }, orderBy: { createdAt: "desc" } }
      }
    });
    if (!identity) throw app.httpErrors.notFound();

    const faces = identity.members
      .map((m: any) => ({
        ...faceDetectionResponse(m.faceDetection),
        cameraName: m.faceDetection.camera?.name ?? m.faceDetection.cameraId
      }))
      .sort((a: any, b: any) => b.frameTs.localeCompare(a.frameTs));
    const summary = summarizeIdentityFaces(faces);
    const mergeHistory = [
      ...identity.sourceMergeLogs.map((e: any) => ({
        id: e.id,
        sourceIdentityId: e.sourceIdentityId,
        sourceDisplayName: identity.displayName,
        targetIdentityId: e.targetIdentityId,
        targetDisplayName: e.targetIdentity?.displayName ?? null,
        reason: e.reason ?? null,
        createdAt: toISO(e.createdAt)
      })),
      ...identity.targetMergeLogs.map((e: any) => ({
        id: e.id,
        sourceIdentityId: e.sourceIdentityId,
        sourceDisplayName: e.sourceIdentity?.displayName ?? null,
        targetIdentityId: e.targetIdentityId,
        targetDisplayName: identity.displayName,
        reason: e.reason ?? null,
        createdAt: toISO(e.createdAt)
      }))
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      data: {
        id: identity.id,
        tenantId: identity.tenantId,
        displayName: identity.displayName,
        status: identity.status,
        mergedIntoIdentityId: identity.mergedIntoIdentityId,
        createdAt: toISO(identity.createdAt),
        updatedAt: toISO(identity.updatedAt),
        memberCount: identity.members.length,
        latestSeenAt: summary.latestSeenAt,
        cameras: summary.cameras,
        faces,
        appearances: summary.appearances,
        mergeHistory
      }
    };
  });

  app.post("/faces/identities/:id/merge", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const targetIdentityId = (request.params as { id: string }).id;
    const body = z.object({ sourceIdentityId: z.string(), reason: z.string().max(500).optional() }).parse(request.body);
    if (body.sourceIdentityId === targetIdentityId) throw app.httpErrors.badRequest("source and target must differ");

    const [targetIdentity, sourceIdentity] = await Promise.all([
      prismaUnsafe.faceIdentity.findFirst({
        where: { id: targetIdentityId, tenantId: ctx.tenantId, mergedIntoIdentityId: null }
      }),
      prismaUnsafe.faceIdentity.findFirst({
        where: { id: body.sourceIdentityId, tenantId: ctx.tenantId, mergedIntoIdentityId: null },
        include: { members: true }
      })
    ]);
    if (!targetIdentity || !sourceIdentity) throw app.httpErrors.notFound();

    await prisma.$transaction(async (tx) => {
      const faceTx = tx as any;
      for (const member of sourceIdentity.members) {
        await faceTx.faceIdentityMember.update({
          where: { faceDetectionId: member.faceDetectionId },
          data: { identityId: targetIdentity.id }
        });
      }
      await faceTx.faceCluster.updateMany({
        where: { tenantId: ctx.tenantId, confirmedIdentityId: sourceIdentity.id },
        data: { confirmedIdentityId: targetIdentity.id }
      });
      await faceTx.faceIdentity.update({
        where: { id: sourceIdentity.id },
        data: { status: "merged", mergedIntoIdentityId: targetIdentity.id }
      });
      await faceTx.faceIdentity.update({ where: { id: targetIdentity.id }, data: { status: "confirmed" } });
      await faceTx.faceIdentityMergeLog.create({
        data: {
          tenantId: ctx.tenantId,
          sourceIdentityId: sourceIdentity.id,
          targetIdentityId: targetIdentity.id,
          actorUserId: ctx.userId,
          reason: body.reason ?? null
        }
      });
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "face_identity",
      action: "merge",
      resourceId: targetIdentity.id,
      payload: { sourceIdentityId: sourceIdentity.id, targetIdentityId: targetIdentity.id },
      context: (request as any).ctx
    });

    const merged = await prismaUnsafe.faceIdentity.findUniqueOrThrow({
      where: { id: targetIdentity.id },
      include: {
        members: {
          include: {
            faceDetection: {
              include: {
                embedding: true,
                clusterMembership: { include: { cluster: true } },
                identityMembership: { include: { identity: true } }
              }
            }
          }
        }
      }
    });
    return {
      data: {
        id: merged.id,
        tenantId: merged.tenantId,
        displayName: merged.displayName,
        status: merged.status,
        mergedIntoIdentityId: merged.mergedIntoIdentityId,
        createdAt: toISO(merged.createdAt),
        updatedAt: toISO(merged.updatedAt),
        memberCount: merged.members.length,
        faces: merged.members.map((m: any) => faceDetectionResponse(m.faceDetection))
      }
    };
  });

  // ─── Incidents ────────────────────────────────────────────────────────────

  app.get(
    "/incidents",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const query = request.query as Record<string, unknown>;
      const { skip, take, sort, order } = parseListQuery(query);
      const cameraId = typeof query.cameraId === "string" ? query.cameraId : undefined;
      const status = typeof query.status === "string" ? query.status : undefined;
      const where = { tenantId: ctx.tenantId, ...(cameraId ? { cameraId } : {}), ...(status ? { status } : {}) };
      const orderByKey = sort === "createdAt" ? "createdAt" : "startedAt";
      const [rows, total] = await Promise.all([
        prisma.incidentEvent.findMany({ where, orderBy: { [orderByKey]: order }, skip, take }),
        prisma.incidentEvent.count({ where })
      ]);
      reply.header("x-total-count", String(total));
      return { data: rows.map(incidentEventResponse), total };
    }
  );

  app.get("/incidents/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const incident = await prisma.incidentEvent.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!incident) throw app.httpErrors.notFound();
    return { data: incidentEventResponse(incident) };
  });

  app.get(
    "/incidents/:id/evidence",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor", "client_user"]);
      const id = (request.params as { id: string }).id;
      const incident = await prisma.incidentEvent.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!incident) throw app.httpErrors.notFound();
      const query = request.query as Record<string, unknown>;
      const { skip, take } = parseListQuery(query);
      const [rows, total] = await Promise.all([
        prisma.incidentEvidence.findMany({
          where: { incidentId: id, tenantId: ctx.tenantId },
          orderBy: { createdAt: "desc" },
          skip,
          take
        }),
        prisma.incidentEvidence.count({ where: { incidentId: id, tenantId: ctx.tenantId } })
      ]);
      reply.header("x-total-count", String(total));
      return { data: rows.map(incidentEvidenceResponse), total };
    }
  );
};
