import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import type { CameraLifecycleStatus, CameraDetectionProfile } from "../../core/types.js";
import { CameraDetectionProfileInputSchema, CameraConnectivitySchema, StreamSessionStatusSchema } from "../../core/types.js";
import { ApiDomainError } from "../../core/types.js";
import {
  assertRole, getTenantContext, toISO, parseListQuery, appendAuditLog,
  cameraResponse, profileResponse, streamSessionResponse,
  getCameraScopeForUser, assertCameraAccess,
  appendLifecycleLog, transitionCameraLifecycle,
  appendStreamSessionTransition, transitionStreamSession, expireStaleStreamSessions,
  signStreamToken, defaultCameraProfileData, isProfileConfigComplete,
  parseCameraDetectionProfile, serializeCameraDetectionProfile,
  parseCameraRecordingPolicy, parseJson,
  enforceCameraLimit, enforceStreamConcurrencyLimit,
  getEntitlementsForTenant
} from "../../core/utils.js";

export type CamerasPluginOptions = {
  middleware: AppMiddleware;
  streamGatewayUrl: string | null;
  streamGatewayPublicUrl: string | null;
  streamTokenSecret: string;
};

export const camerasPlugin: FastifyPluginAsync<CamerasPluginOptions> = async (app, opts) => {
  const { tenantScopedPreHandler } = opts.middleware;
  const { streamGatewayUrl, streamGatewayPublicUrl, streamTokenSecret } = opts;

  // ─── Camera CRUD ─────────────────────────────────────────────────────────────

  app.get("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const { skip, take, sort, order } = parseListQuery(request.query as Record<string, unknown>);
    const q = request.query as Record<string, unknown>;
    const scopedCameraIds = await getCameraScopeForUser(ctx);
    const where: any = { tenantId: ctx.tenantId, deletedAt: null, ...(q.name ? { name: { contains: String(q.name), mode: "insensitive" } } : {}), ...(q.isActive !== undefined ? { isActive: String(q.isActive) === "true" } : {}), ...(scopedCameraIds ? { id: { in: scopedCameraIds } } : {}) };
    const [rows, total] = await Promise.all([prisma.camera.findMany({ where, skip, take, orderBy: { [sort]: order }, include: { profile: true } }), prisma.camera.count({ where })]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(cameraResponse), total };
  });

  app.post("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    await enforceCameraLimit(ctx.tenantId);
    const body = z.object({ name: z.string().min(2), description: z.string().max(2000).optional(), rtspUrl: z.string().min(4), location: z.string().optional(), tags: z.array(z.string()).optional(), isActive: z.boolean().default(true) }).parse(request.body);

    const camera = await prisma.camera.create({ data: { tenantId: ctx.tenantId, name: body.name, description: body.description, rtspUrl: body.rtspUrl, location: body.location, tags: JSON.stringify(body.tags ?? []), isActive: body.isActive, lifecycleStatus: body.isActive ? "provisioning" : "draft", lastTransitionAt: new Date() } });
    await appendLifecycleLog({ tenantId: ctx.tenantId, cameraId: camera.id, fromStatus: null, toStatus: camera.lifecycleStatus as CameraLifecycleStatus, event: "camera.created", reason: body.isActive ? "active camera queued for provisioning" : "created in draft mode", actorUserId: ctx.userId });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({ where: { cameraId: camera.id }, update: {}, create: defaultCameraProfileData(ctx.tenantId, camera.id) });
      await appendLifecycleLog({ tenantId: ctx.tenantId, cameraId: camera.id, fromStatus: "provisioning", toStatus: "provisioning", event: "camera.profile_configured", reason: "profile auto-provisioned", actorUserId: ctx.userId });
    }

    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "create", resourceId: camera.id, payload: { name: camera.name, isActive: camera.isActive, lifecycleStatus: camera.lifecycleStatus }, context: request.ctx });
    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.get("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null }, include: { profile: true } });
    if (!camera) throw app.httpErrors.notFound();
    return { data: cameraResponse(camera) };
  });

  app.put("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ name: z.string().min(2), description: z.string().max(2000).optional().nullable(), rtspUrl: z.string().min(4), location: z.string().optional().nullable(), tags: z.array(z.string()).optional(), isActive: z.boolean().default(true) }).parse(request.body);

    const current = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!current) throw new Error("CAMERA_NOT_FOUND");

    const camera = await prisma.camera.update({ where: { id: current.id }, data: { name: body.name, description: body.description, rtspUrl: body.rtspUrl, location: body.location, tags: JSON.stringify(body.tags ?? []), isActive: body.isActive } });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({ where: { cameraId: camera.id }, update: {}, create: defaultCameraProfileData(camera.tenantId, camera.id) });
      if ((camera.lifecycleStatus as CameraLifecycleStatus) === "draft") {
        await transitionCameraLifecycle({ tenantId: camera.tenantId, cameraId: camera.id, toStatus: "provisioning", event: "camera.reactivated_for_provisioning", reason: "camera set active from draft", actorUserId: ctx.userId });
      }
    }
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "update", resourceId: camera.id, payload: { name: camera.name, isActive: camera.isActive, lifecycleStatus: camera.lifecycleStatus }, context: request.ctx });
    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.delete("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");
    const deleted = await prisma.camera.update({ where: { id: camera.id }, data: { deletedAt: new Date() } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "delete", resourceId: camera.id, payload: { name: camera.name, lifecycleStatus: camera.lifecycleStatus }, context: request.ctx });
    if (streamGatewayUrl) {
      try { await fetch(`${streamGatewayUrl}/deprovision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: ctx.tenantId, cameraId: camera.id }) }); } catch (error) { request.log.warn({ error, tenantId: ctx.tenantId, cameraId: camera.id }, "stream_gateway.deprovision_failed"); }
    }
    return { data: cameraResponse(deleted) };
  });

  // ─── Stream token ─────────────────────────────────────────────────────────────

  app.post("/cameras/:id/stream-token", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null }, include: { profile: true } });
    if (!camera) throw app.httpErrors.notFound();

    await expireStaleStreamSessions(ctx.tenantId);
    await enforceStreamConcurrencyLimit(ctx.tenantId);

    const expiresAt = new Date(Date.now() + 1000 * 60 * 5);
    const requested = await prisma.streamSession.create({ data: { tenantId: ctx.tenantId, cameraId: id, userId: ctx.userId, status: "requested", token: "", expiresAt, issuedAt: new Date() } });
    await appendStreamSessionTransition({ streamSessionId: requested.id, tenantId: ctx.tenantId, fromStatus: null, toStatus: "requested", event: "stream.requested", actorUserId: ctx.userId });

    const token = signStreamToken({ sub: ctx.userId, tid: ctx.tenantId, cid: id, sid: requested.id, exp: Math.floor(expiresAt.getTime() / 1000), iat: Math.floor(Date.now() / 1000), v: 1 }, streamTokenSecret);
    const session = await transitionStreamSession({ tenantId: ctx.tenantId, streamSessionId: requested.id, toStatus: "issued", event: "stream.issued", actorUserId: ctx.userId });
    const sessionWithToken = await prisma.streamSession.update({ where: { id: session.id }, data: { token } });
    const entitlements = await getEntitlementsForTenant(ctx.tenantId);
    const recordingPolicy = parseCameraRecordingPolicy(camera.profile?.rulesProfile ?? null);

    let playbackUrl: string | undefined;
    if (streamGatewayUrl) {
      try {
        const provisionResponse = await fetch(`${streamGatewayUrl}/provision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: ctx.tenantId, cameraId: id, rtspUrl: camera.rtspUrl, ...(entitlements ? { planCode: entitlements.planCode, retentionDays: (entitlements.limits as any).retentionDays } : {}), recordingMode: recordingPolicy.mode, eventClipPreSeconds: recordingPolicy.eventClipPreSeconds, eventClipPostSeconds: recordingPolicy.eventClipPostSeconds }) });
        if (!provisionResponse.ok) { const errorBody = await provisionResponse.text(); throw new Error(`stream_gateway.provision_failed status=${provisionResponse.status} body=${errorBody.slice(0, 500)}`); }
        playbackUrl = `${streamGatewayPublicUrl}/playback/${ctx.tenantId}/${id}/index.m3u8?token=${encodeURIComponent(token)}`;
      } catch (error) { request.log.warn({ error, tenantId: ctx.tenantId, cameraId: id }, "stream_gateway.provision_failed"); }
    }

    return { token, expiresAt: expiresAt.toISOString(), session: streamSessionResponse(sessionWithToken), ...(playbackUrl ? { playbackUrl } : {}) };
  });

  // ─── Event clips ──────────────────────────────────────────────────────────────

  app.get("/cameras/:id/event-clips", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    if (!streamGatewayUrl) throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    const fromDb = await prisma.event.findMany({ where: { tenantId: ctx.tenantId, cameraId: id, type: "camera.event_clip" }, orderBy: { timestamp: "desc" }, take: 500 });
    type EventClipRecord = Record<string, unknown> & { eventId: string };
    const dbClips: EventClipRecord[] = [];
    for (const entry of fromDb) {
      try {
        const payload = parseJson<Record<string, unknown>>(entry.payload);
        const eventId = typeof payload.eventId === "string" ? payload.eventId : entry.id;
        dbClips.push({ ...payload, eventId, persistedEventId: entry.id, persistedAt: toISO(entry.timestamp) });
      } catch { /* ignore */ }
    }

    let gatewayClips: Array<Record<string, unknown>> = [];
    const response = await fetch(`${streamGatewayUrl}/events/clips?tenantId=${encodeURIComponent(ctx.tenantId)}&cameraId=${encodeURIComponent(id)}`);
    if (response.ok) { const payload = (await response.json()) as { data: Array<Record<string, unknown>>; total: number }; gatewayClips = payload.data; }

    const mergedByEventId = new Map<string, Record<string, unknown>>();
    for (const clip of dbClips) mergedByEventId.set(clip.eventId, clip);
    for (const clip of gatewayClips) { const key = typeof clip.eventId === "string" ? clip.eventId : `gw-${Math.random().toString(36).slice(2, 8)}`; mergedByEventId.set(key, { ...(mergedByEventId.get(key) ?? {}), ...clip }); }
    const data = Array.from(mergedByEventId.values()).sort((a, b) => String(a.createdAt ?? a.eventTs ?? "") < String(b.createdAt ?? b.eventTs ?? "") ? 1 : -1);
    return { data, total: data.length };
  });

  app.post("/cameras/:id/event-clips", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    if (!streamGatewayUrl) throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    const body = z.object({ eventId: z.string().min(1).optional(), source: z.enum(["manual", "detection", "rule"]).optional(), eventTs: z.string().datetime().optional(), preSeconds: z.number().int().min(0).max(120).optional(), postSeconds: z.number().int().min(1).max(300).optional() }).parse(request.body ?? {});
    const response = await fetch(`${streamGatewayUrl}/events/clip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: ctx.tenantId, cameraId: id, ...body }) });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as { code?: string; message?: string; details?: unknown } | null;
      throw new ApiDomainError({ statusCode: response.status === 409 ? 409 : 502, apiCode: errorBody?.code ?? "STREAM_GATEWAY_EVENT_CLIP_ERROR", message: errorBody?.message ?? "stream gateway event clip creation failed", details: errorBody?.details });
    }
    const payload = (await response.json()) as { data: { tenantId: string; cameraId: string; eventId: string; source?: string; eventTs?: string; startedAt?: string; endedAt?: string; clipBytes?: number; sourceSegments?: string[]; playbackPath: string } };
    await prisma.event.create({ data: { tenantId: ctx.tenantId, cameraId: id, type: "camera.event_clip", severity: "info", timestamp: payload.data.eventTs ? new Date(payload.data.eventTs) : new Date(), payload: JSON.stringify(payload.data) } });

    const expiresAt = new Date(Date.now() + 1000 * 60 * 5);
    const token = signStreamToken({ sub: ctx.userId, tid: ctx.tenantId, cid: id, sid: `evtclip-${Date.now()}`, exp: Math.floor(expiresAt.getTime() / 1000), iat: Math.floor(Date.now() / 1000), v: 1 }, streamTokenSecret);
    return { data: { ...payload.data, token, expiresAt: expiresAt.toISOString(), playbackUrl: `${streamGatewayPublicUrl}${payload.data.playbackPath}?token=${encodeURIComponent(token)}` } };
  });

  // ─── Stream sessions ──────────────────────────────────────────────────────────

  app.get("/stream-sessions", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);
    const query = request.query as Record<string, unknown>;
    const { skip, take, sort, order } = parseListQuery(query);
    const cameraId = typeof query.cameraId === "string" ? query.cameraId : undefined;
    const status = StreamSessionStatusSchema.safeParse(query.status);
    const where = { tenantId: ctx.tenantId, ...(cameraId ? { cameraId } : {}), ...(status.success ? { status: status.data } : {}), ...(ctx.role === "client_user" ? { userId: ctx.userId } : {}) };
    const [data, total] = await Promise.all([prisma.streamSession.findMany({ where, skip, take, orderBy: { [sort]: order } }), prisma.streamSession.count({ where })]);
    reply.header("x-total-count", String(total));
    return { data: data.map(streamSessionResponse), total };
  });

  app.get("/stream-sessions/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);
    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({ where: { id, tenantId: ctx.tenantId, ...(ctx.role === "client_user" ? { userId: ctx.userId } : {}) } });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    const transitions = await prisma.streamSessionTransition.findMany({ where: { streamSessionId: session.id }, orderBy: { createdAt: "desc" }, take: 30 });
    return { data: { ...streamSessionResponse(session), history: transitions.map((entry) => ({ id: entry.id, fromStatus: entry.fromStatus, toStatus: entry.toStatus, event: entry.event, actorUserId: entry.actorUserId, createdAt: toISO(entry.createdAt) })) } };
  });

  app.post("/stream-sessions/:id/activate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);
    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) throw app.httpErrors.forbidden("Stream session ownership mismatch");
    const updated = await transitionStreamSession({ tenantId: ctx.tenantId, streamSessionId: id, toStatus: "active", event: "stream.activated", actorUserId: ctx.userId });
    return { data: streamSessionResponse(updated) };
  });

  app.post("/stream-sessions/:id/end", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);
    const id = (request.params as { id: string }).id;
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
    const session = await prisma.streamSession.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) throw app.httpErrors.forbidden("Stream session ownership mismatch");
    const updated = await transitionStreamSession({ tenantId: ctx.tenantId, streamSessionId: id, toStatus: "ended", event: "stream.ended", actorUserId: ctx.userId, endReason: body.reason ?? "ended by user action" });
    return { data: streamSessionResponse(updated) };
  });

  // ─── Camera profile ───────────────────────────────────────────────────────────

  app.get("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();
    const profile = await prisma.cameraProfile.upsert({ where: { cameraId: id }, update: {}, create: defaultCameraProfileData(ctx.tenantId, id) });
    return { data: profileResponse(profile) };
  });

  app.put("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ proxyPath: z.string().optional(), recordingEnabled: z.boolean().optional(), recordingStorageKey: z.string().optional(), detectorConfigKey: z.string().optional(), detectorResultsKey: z.string().optional(), zoneMap: z.record(z.any()).nullable().optional(), homography: z.record(z.any()).nullable().optional(), sceneTags: z.array(z.string()).optional(), rulesProfile: z.record(z.any()).nullable().optional(), detectorFlags: z.object({ mediapipe: z.boolean(), yolo: z.boolean(), lpr: z.boolean() }).optional(), status: z.enum(["pending", "ready", "error"]).optional(), lastHealthAt: z.string().datetime().nullable().optional(), lastError: z.string().nullable().optional() }).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "At least one profile field must be provided" }).parse(request.body);

    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    const updateData = {
      ...(body.proxyPath !== undefined ? { proxyPath: body.proxyPath } : {}),
      ...(body.recordingEnabled !== undefined ? { recordingEnabled: body.recordingEnabled } : {}),
      ...(body.recordingStorageKey !== undefined ? { recordingStorageKey: body.recordingStorageKey } : {}),
      ...(body.detectorConfigKey !== undefined ? { detectorConfigKey: body.detectorConfigKey } : {}),
      ...(body.detectorResultsKey !== undefined ? { detectorResultsKey: body.detectorResultsKey } : {}),
      ...(body.zoneMap !== undefined ? { zoneMap: body.zoneMap ? JSON.stringify(body.zoneMap) : null } : {}),
      ...(body.homography !== undefined ? { homography: body.homography ? JSON.stringify(body.homography) : null } : {}),
      ...(body.sceneTags !== undefined ? { sceneTags: JSON.stringify(body.sceneTags) } : {}),
      ...(body.rulesProfile !== undefined ? { rulesProfile: body.rulesProfile ? JSON.stringify(body.rulesProfile) : null } : {}),
      ...(body.detectorFlags !== undefined ? { detectorFlags: JSON.stringify(body.detectorFlags) } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.lastHealthAt !== undefined ? { lastHealthAt: body.lastHealthAt ? new Date(body.lastHealthAt) : null } : {}),
      ...(body.lastError !== undefined ? { lastError: body.lastError } : {})
    };
    const profile = await prisma.cameraProfile.upsert({ where: { cameraId: id }, update: updateData, create: { ...defaultCameraProfileData(ctx.tenantId, id), ...updateData } });

    const configComplete = isProfileConfigComplete(profile);
    if (!configComplete && profile.status === "ready") {
      const normalized = await prisma.cameraProfile.update({ where: { cameraId: id }, data: { status: "pending", lastError: profile.lastError ?? "incomplete profile configuration" } });
      await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera_profile", action: "update", resourceId: id, payload: { status: normalized.status, configComplete: false }, context: request.ctx });
      return { data: profileResponse(normalized) };
    }
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera_profile", action: "update", resourceId: id, payload: { status: profile.status, configComplete }, context: request.ctx });
    return { data: profileResponse(profile) };
  });

  // ─── Detection profile ────────────────────────────────────────────────────────

  app.get("/cameras/:id/detection-profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();
    const profile = await prisma.cameraProfile.upsert({ where: { cameraId: id }, update: {}, create: defaultCameraProfileData(ctx.tenantId, id) });
    return { data: parseCameraDetectionProfile(profile.detectionProfile, ctx.tenantId, id) };
  });

  app.put("/cameras/:id/detection-profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = CameraDetectionProfileInputSchema.parse(request.body ?? {});
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();
    const existing = await prisma.cameraProfile.findUnique({ where: { cameraId: id } });
    const current = parseCameraDetectionProfile(existing?.detectionProfile ?? null, ctx.tenantId, id);
    const nextProfile: CameraDetectionProfile = { cameraId: id, tenantId: ctx.tenantId, pipelines: body.pipelines, configVersion: body.configVersion ?? current.configVersion + 1, updatedAt: new Date().toISOString() };
    await prisma.cameraProfile.upsert({ where: { cameraId: id }, update: { detectionProfile: serializeCameraDetectionProfile(nextProfile) }, create: { ...defaultCameraProfileData(ctx.tenantId, id), detectionProfile: serializeCameraDetectionProfile(nextProfile) } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera_detection_profile", action: "update", resourceId: id, payload: { configVersion: nextProfile.configVersion, pipelines: nextProfile.pipelines.length }, context: request.ctx });
    return { data: nextProfile };
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  app.get("/cameras/:id/lifecycle", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");
    const [snapshot, logs] = await Promise.all([prisma.cameraHealthSnapshot.findUnique({ where: { cameraId: id } }), prisma.cameraLifecycleLog.findMany({ where: { cameraId: id }, orderBy: { createdAt: "desc" }, take: 100 })]);
    return { data: { cameraId: id, currentStatus: camera.lifecycleStatus, isActive: camera.isActive, lastSeenAt: camera.lastSeenAt ? toISO(camera.lastSeenAt) : null, lastTransitionAt: camera.lastTransitionAt ? toISO(camera.lastTransitionAt) : null, healthSnapshot: snapshot ? { id: snapshot.id, connectivity: snapshot.connectivity, latencyMs: snapshot.latencyMs, packetLossPct: snapshot.packetLossPct, jitterMs: snapshot.jitterMs, error: snapshot.error, checkedAt: toISO(snapshot.checkedAt) } : null, history: logs.map((log) => ({ id: log.id, fromStatus: log.fromStatus, toStatus: log.toStatus, event: log.event, reason: log.reason, actorUserId: log.actorUserId, createdAt: toISO(log.createdAt) })) } };
  });

  app.post("/cameras/:id/validate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ simulate: z.enum(["pass", "fail"]).optional() }).parse(request.body ?? {});
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null }, include: { profile: true } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");
    const profile = camera.profile ?? (await prisma.cameraProfile.upsert({ where: { cameraId: id }, update: {}, create: defaultCameraProfileData(ctx.tenantId, id) }));
    const shouldPass = body.simulate ? body.simulate === "pass" : isProfileConfigComplete({ proxyPath: profile.proxyPath, recordingStorageKey: profile.recordingStorageKey, detectorConfigKey: profile.detectorConfigKey, detectorResultsKey: profile.detectorResultsKey });
    const nextStatus: CameraLifecycleStatus = shouldPass ? "ready" : "error";
    const transitioned = await transitionCameraLifecycle({ tenantId: ctx.tenantId, cameraId: id, toStatus: nextStatus, event: shouldPass ? "camera.validation_passed" : "camera.validation_failed", reason: shouldPass ? "validation succeeded" : "validation failed", actorUserId: ctx.userId });
    await prisma.cameraHealthSnapshot.upsert({ where: { cameraId: id }, update: { connectivity: shouldPass ? "online" : "offline", latencyMs: shouldPass ? 95 : null, packetLossPct: shouldPass ? 0.1 : null, jitterMs: shouldPass ? 6 : null, error: shouldPass ? null : "validation failed", checkedAt: new Date() }, create: { tenantId: ctx.tenantId, cameraId: id, connectivity: shouldPass ? "online" : "offline", latencyMs: shouldPass ? 95 : null, packetLossPct: shouldPass ? 0.1 : null, jitterMs: shouldPass ? 6 : null, error: shouldPass ? null : "validation failed", checkedAt: new Date() } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: shouldPass ? "validate_pass" : "validate_fail", resourceId: id, payload: { lifecycleStatus: transitioned.lifecycleStatus }, context: request.ctx });
    return { data: cameraResponse(transitioned) };
  });

  app.post("/cameras/:id/retire", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const transitioned = await transitionCameraLifecycle({ tenantId: ctx.tenantId, cameraId: id, toStatus: "retired", event: "camera.retired", reason: "retired by admin", actorUserId: ctx.userId });
    const deactivated = await prisma.camera.update({ where: { id }, data: { isActive: false }, include: { profile: true } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "retire", resourceId: id, payload: { lifecycleStatus: transitioned.lifecycleStatus, isActive: false }, context: request.ctx });
    return { data: cameraResponse({ ...deactivated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/reactivate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const transitioned = await transitionCameraLifecycle({ tenantId: ctx.tenantId, cameraId: id, toStatus: "draft", event: "camera.reactivated", reason: "reactivated by admin", actorUserId: ctx.userId });
    const activated = await prisma.camera.update({ where: { id }, data: { isActive: true }, include: { profile: true } });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "reactivate", resourceId: id, payload: { lifecycleStatus: transitioned.lifecycleStatus, isActive: true }, context: request.ctx });
    return { data: cameraResponse({ ...activated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ connectivity: CameraConnectivitySchema, latencyMs: z.number().int().nullable().optional(), packetLossPct: z.number().min(0).max(100).nullable().optional(), jitterMs: z.number().int().nullable().optional(), error: z.string().nullable().optional() }).parse(request.body);
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");
    await prisma.cameraHealthSnapshot.upsert({ where: { cameraId: id }, update: { connectivity: body.connectivity, latencyMs: body.latencyMs ?? null, packetLossPct: body.packetLossPct ?? null, jitterMs: body.jitterMs ?? null, error: body.error ?? null, checkedAt: new Date() }, create: { tenantId: ctx.tenantId, cameraId: id, connectivity: body.connectivity, latencyMs: body.latencyMs ?? null, packetLossPct: body.packetLossPct ?? null, jitterMs: body.jitterMs ?? null, error: body.error ?? null, checkedAt: new Date() } });
    const lifecycleStatus: CameraLifecycleStatus = body.connectivity === "online" ? "ready" : body.connectivity === "degraded" ? "degraded" : "offline";
    const transitioned = await transitionCameraLifecycle({ tenantId: ctx.tenantId, cameraId: id, toStatus: lifecycleStatus, event: "camera.health_updated", reason: `connectivity=${body.connectivity}`, actorUserId: ctx.userId });
    await appendAuditLog({ tenantId: ctx.tenantId, actorUserId: ctx.userId, resource: "camera", action: "health_update", resourceId: id, payload: { connectivity: body.connectivity, lifecycleStatus: transitioned.lifecycleStatus }, context: request.ctx });
    return { data: cameraResponse(transitioned) };
  });

  app.post("/cameras/:id/sync-health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    if (!streamGatewayUrl) throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    const { syncCameraHealthFromGateway } = await import("../../core/utils.js");
    return syncCameraHealthFromGateway({ tenantId: ctx.tenantId, cameraId: id, actorUserId: ctx.userId, streamGatewayUrl });
  });
};
