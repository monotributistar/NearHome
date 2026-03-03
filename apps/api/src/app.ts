import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { EntitlementsSchema, LoginInputSchema, RoleSchema } from "@app/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";

type Role = z.infer<typeof RoleSchema>;

type RequestContext = {
  userId: string;
  tenantId?: string;
  role?: Role;
};

type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

class ApiDomainError extends Error {
  statusCode: number;
  apiCode: string;
  details?: unknown;

  constructor(args: { statusCode: number; apiCode: string; message: string; details?: unknown }) {
    super(args.message);
    this.name = "ApiDomainError";
    this.statusCode = args.statusCode;
    this.apiCode = args.apiCode;
    this.details = args.details;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
    requestId?: string;
    requestStartedAt?: number;
  }
}

const prisma = new PrismaClient();

type LoginBucket = {
  count: number;
  resetAt: number;
};

function statusToCode(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 422) return "UNPROCESSABLE_ENTITY";
  if (statusCode === 429) return "TOO_MANY_REQUESTS";
  return "INTERNAL_SERVER_ERROR";
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function signStreamToken(payload: Record<string, unknown>, secret: string) {
  const serializedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(serializedPayload).digest("base64url");
  return `${serializedPayload}.${signature}`;
}

function toISO(date: Date) {
  return date.toISOString();
}

function parseListQuery(query: Record<string, unknown>) {
  const start = Number(query._start ?? 0);
  const end = Number(query._end ?? start + 10);
  const sort = String(query._sort ?? "createdAt");
  const order = String(query._order ?? "DESC").toLowerCase() === "asc" ? "asc" : "desc";
  return { skip: start, take: Math.max(end - start, 1), sort, order };
}

type DetectorFlags = {
  mediapipe: boolean;
  yolo: boolean;
  lpr: boolean;
};

type ProfileStatus = "pending" | "ready" | "error";
type CameraLifecycleStatus = "draft" | "provisioning" | "ready" | "degraded" | "offline" | "error" | "retired";
type StreamSessionStatus = "requested" | "issued" | "active" | "ended" | "expired";
type DetectionJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type DetectionMode = "realtime" | "batch";
type DetectionSource = "snapshot" | "clip" | "range";
type DetectionProvider = "onprem_bento" | "huggingface_space" | "external_http";

const CameraLifecycleStatusSchema = z.enum(["draft", "provisioning", "ready", "degraded", "offline", "error", "retired"]);
const CameraConnectivitySchema = z.enum(["online", "degraded", "offline"]);
const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);
const DetectionJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
const DetectionModeSchema = z.enum(["realtime", "batch"]);
const DetectionSourceSchema = z.enum(["snapshot", "clip", "range"]);
const DetectionProviderSchema = z.enum(["onprem_bento", "huggingface_space", "external_http"]);

function canTransitionCameraLifecycle(from: CameraLifecycleStatus, to: CameraLifecycleStatus) {
  const allowed: Record<CameraLifecycleStatus, CameraLifecycleStatus[]> = {
    draft: ["provisioning", "ready", "retired", "error"],
    provisioning: ["ready", "error", "retired"],
    ready: ["degraded", "offline", "error", "retired"],
    degraded: ["ready", "offline", "error", "retired"],
    offline: ["ready", "degraded", "error", "retired"],
    error: ["draft", "provisioning", "ready", "retired"],
    retired: ["draft"]
  };
  return allowed[from].includes(to);
}

function lifecycleFromConnectivity(connectivity: "online" | "degraded" | "offline"): CameraLifecycleStatus {
  if (connectivity === "online") return "ready";
  if (connectivity === "degraded") return "degraded";
  return "offline";
}

function isProfileConfigComplete(profile: {
  proxyPath: string;
  recordingStorageKey: string;
  detectorConfigKey: string;
  detectorResultsKey: string;
}) {
  return (
    profile.proxyPath.trim().length > 0 &&
    profile.recordingStorageKey.trim().length > 0 &&
    profile.detectorConfigKey.trim().length > 0 &&
    profile.detectorResultsKey.trim().length > 0
  );
}

function defaultCameraProfileData(tenantId: string, cameraId: string) {
  return {
    tenantId,
    cameraId,
    proxyPath: `/proxy/live/${tenantId}/${cameraId}`,
    recordingEnabled: false,
    recordingStorageKey: `s3://nearhome/${tenantId}/recordings/${cameraId}`,
    detectorConfigKey: `kv://nearhome/${tenantId}/detectors/${cameraId}/config.json`,
    detectorResultsKey: `s3://nearhome/${tenantId}/detectors/${cameraId}/results`,
    detectorFlags: JSON.stringify({ mediapipe: true, yolo: false, lpr: false } satisfies DetectorFlags),
    zoneMap: null as string | null,
    homography: null as string | null,
    sceneTags: JSON.stringify([] as string[]),
    rulesProfile: JSON.stringify({} as Record<string, unknown>),
    status: "ready" as ProfileStatus,
    lastHealthAt: new Date(),
    lastError: null as string | null
  };
}

function profileResponse(profile: {
  id: string;
  tenantId: string;
  cameraId: string;
  proxyPath: string;
  recordingEnabled: boolean;
  recordingStorageKey: string;
  detectorConfigKey: string;
  detectorResultsKey: string;
  detectorFlags: string;
  zoneMap: string | null;
  homography: string | null;
  sceneTags: string | null;
  rulesProfile: string | null;
  status: string;
  lastHealthAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const configComplete = isProfileConfigComplete(profile);
  return {
    id: profile.id,
    tenantId: profile.tenantId,
    cameraId: profile.cameraId,
    proxyPath: profile.proxyPath,
    recordingEnabled: profile.recordingEnabled,
    recordingStorageKey: profile.recordingStorageKey,
    detectorConfigKey: profile.detectorConfigKey,
    detectorResultsKey: profile.detectorResultsKey,
    detectorFlags: parseJson<DetectorFlags>(profile.detectorFlags),
    zoneMap: profile.zoneMap ? parseJson<Record<string, unknown>>(profile.zoneMap) : undefined,
    homography: profile.homography ? parseJson<Record<string, unknown>>(profile.homography) : undefined,
    sceneTags: profile.sceneTags ? parseJson<string[]>(profile.sceneTags) : undefined,
    rulesProfile: profile.rulesProfile ? parseJson<Record<string, unknown>>(profile.rulesProfile) : undefined,
    status: profile.status as ProfileStatus,
    configComplete,
    lastHealthAt: profile.lastHealthAt ? toISO(profile.lastHealthAt) : null,
    lastError: profile.lastError,
    createdAt: toISO(profile.createdAt),
    updatedAt: toISO(profile.updatedAt)
  };
}

function cameraResponse(camera: {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  rtspUrl: string;
  location: string | null;
  tags: string;
  isActive: boolean;
  lifecycleStatus: string;
  lastSeenAt: Date | null;
  lastTransitionAt: Date | null;
  createdAt: Date;
  profile?: {
    id: string;
    tenantId: string;
    cameraId: string;
    proxyPath: string;
    recordingEnabled: boolean;
    recordingStorageKey: string;
    detectorConfigKey: string;
    detectorResultsKey: string;
    detectorFlags: string;
    zoneMap: string | null;
    homography: string | null;
    sceneTags: string | null;
    rulesProfile: string | null;
    status: string;
    lastHealthAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}) {
  return {
    id: camera.id,
    tenantId: camera.tenantId,
    name: camera.name,
    description: camera.description,
    rtspUrl: camera.rtspUrl,
    location: camera.location,
    tags: parseJson<string[]>(camera.tags),
    isActive: camera.isActive,
    lifecycleStatus: camera.lifecycleStatus as CameraLifecycleStatus,
    lastSeenAt: camera.lastSeenAt ? toISO(camera.lastSeenAt) : null,
    lastTransitionAt: camera.lastTransitionAt ? toISO(camera.lastTransitionAt) : null,
    createdAt: toISO(camera.createdAt),
    ...(camera.profile ? { profile: profileResponse(camera.profile) } : {})
  };
}

function streamSessionResponse(session: {
  id: string;
  tenantId: string;
  cameraId: string;
  userId: string;
  status: string;
  token: string;
  expiresAt: Date;
  issuedAt: Date;
  activatedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: session.id,
    tenantId: session.tenantId,
    cameraId: session.cameraId,
    userId: session.userId,
    status: session.status as StreamSessionStatus,
    token: session.token,
    expiresAt: toISO(session.expiresAt),
    issuedAt: toISO(session.issuedAt),
    activatedAt: session.activatedAt ? toISO(session.activatedAt) : null,
    endedAt: session.endedAt ? toISO(session.endedAt) : null,
    endReason: session.endReason,
    createdAt: toISO(session.createdAt),
    updatedAt: toISO(session.updatedAt)
  };
}

function canTransitionStreamSession(from: StreamSessionStatus, to: StreamSessionStatus) {
  const allowed: Record<StreamSessionStatus, StreamSessionStatus[]> = {
    requested: ["issued", "ended", "expired"],
    issued: ["active", "ended", "expired"],
    active: ["ended", "expired"],
    ended: [],
    expired: []
  };
  return allowed[from].includes(to);
}

function auditLogResponse(entry: {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  resource: string;
  action: string;
  resourceId: string | null;
  payload: string | null;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    resource: entry.resource,
    action: entry.action,
    resourceId: entry.resourceId,
    payload: entry.payload ? parseJson<Record<string, unknown>>(entry.payload) : null,
    createdAt: toISO(entry.createdAt)
  };
}

function detectionJobResponse(job: {
  id: string;
  tenantId: string;
  cameraId: string;
  mode: string;
  source: string;
  provider: string;
  status: string;
  workflowId: string | null;
  runId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  options: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  canceledAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    cameraId: job.cameraId,
    mode: job.mode as DetectionMode,
    source: job.source as DetectionSource,
    provider: job.provider as DetectionProvider,
    status: job.status as DetectionJobStatus,
    workflowId: job.workflowId,
    runId: job.runId,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    options: job.options ? parseJson<Record<string, unknown>>(job.options) : null,
    queuedAt: toISO(job.queuedAt),
    startedAt: job.startedAt ? toISO(job.startedAt) : null,
    finishedAt: job.finishedAt ? toISO(job.finishedAt) : null,
    canceledAt: job.canceledAt ? toISO(job.canceledAt) : null,
    createdByUserId: job.createdByUserId,
    createdAt: toISO(job.createdAt),
    updatedAt: toISO(job.updatedAt)
  };
}

function detectionObservationResponse(observation: {
  id: string;
  jobId: string;
  tenantId: string;
  cameraId: string;
  frameTs: Date;
  label: string;
  confidence: number;
  bbox: string;
  keypoints: string | null;
  attributes: string | null;
  providerMeta: string | null;
  createdAt: Date;
}) {
  return {
    id: observation.id,
    jobId: observation.jobId,
    tenantId: observation.tenantId,
    cameraId: observation.cameraId,
    frameTs: toISO(observation.frameTs),
    label: observation.label,
    confidence: observation.confidence,
    bbox: parseJson<Record<string, number>>(observation.bbox),
    keypoints: observation.keypoints ? parseJson<Array<Record<string, number>>>(observation.keypoints) : undefined,
    attributes: observation.attributes ? parseJson<Record<string, unknown>>(observation.attributes) : undefined,
    providerMeta: observation.providerMeta ? parseJson<Record<string, unknown>>(observation.providerMeta) : undefined,
    createdAt: toISO(observation.createdAt)
  };
}

function incidentEventResponse(incident: {
  id: string;
  tenantId: string;
  cameraId: string;
  jobId: string | null;
  type: string;
  severity: string;
  status: string;
  summary: string;
  startedAt: Date;
  endedAt: Date | null;
  payload: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: incident.id,
    tenantId: incident.tenantId,
    cameraId: incident.cameraId,
    jobId: incident.jobId,
    type: incident.type,
    severity: incident.severity,
    status: incident.status,
    summary: incident.summary,
    startedAt: toISO(incident.startedAt),
    endedAt: incident.endedAt ? toISO(incident.endedAt) : null,
    payload: incident.payload ? parseJson<Record<string, unknown>>(incident.payload) : undefined,
    createdAt: toISO(incident.createdAt),
    updatedAt: toISO(incident.updatedAt)
  };
}

function incidentEvidenceResponse(evidence: {
  id: string;
  tenantId: string;
  incidentId: string;
  observationId: string | null;
  trackId: string | null;
  scenePrimitiveEventId: string | null;
  clipUrl: string | null;
  snapshotUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: evidence.id,
    tenantId: evidence.tenantId,
    incidentId: evidence.incidentId,
    observationId: evidence.observationId,
    trackId: evidence.trackId,
    scenePrimitiveEventId: evidence.scenePrimitiveEventId,
    clipUrl: evidence.clipUrl,
    snapshotUrl: evidence.snapshotUrl,
    createdAt: toISO(evidence.createdAt)
  };
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveZoneFromProfile(zoneMapRaw: string | null, bbox: { x: number; y: number; w: number; h: number }) {
  if (!zoneMapRaw) return null;
  let zoneMap: Record<string, unknown>;
  try {
    zoneMap = parseJson<Record<string, unknown>>(zoneMapRaw);
  } catch {
    return null;
  }

  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  for (const [zoneId, candidate] of Object.entries(zoneMap)) {
    if (!candidate || typeof candidate !== "object") continue;
    const shape = candidate as Record<string, unknown>;
    const xMin = toNumber(shape.xMin);
    const xMax = toNumber(shape.xMax);
    const yMin = toNumber(shape.yMin);
    const yMax = toNumber(shape.yMax);
    if (xMin === null || xMax === null || yMin === null || yMax === null) continue;
    if (centerX >= xMin && centerX <= xMax && centerY >= yMin && centerY <= yMax) {
      return zoneId;
    }
  }
  return null;
}

function deriveIncidentFromDetection(args: { label: string; zoneId: string | null; location: string | null }) {
  const label = args.label.toLowerCase();
  if (label.includes("dog")) {
    return {
      type: "dog_in_backyard",
      summary: `Dog detected${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}`
    };
  }
  if (label.includes("branch")) {
    return {
      type: "branch_fall_backyard",
      summary: `Branch fall detected${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}`
    };
  }
  if (label.includes("person")) {
    return {
      type: "person_approached_front_window",
      summary: `Person detected${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}`
    };
  }
  return {
    type: `object_detected_${label.replace(/[^a-z0-9]+/g, "_")}`,
    summary: `${args.label} detected${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}`
  };
}

async function computeEntitlements(tenantId: string) {
  const subscription = await prisma.subscription.findFirst({
    where: { tenantId, status: "active" },
    include: { plan: true }
  });

  if (!subscription) return null;

  return EntitlementsSchema.parse({
    planCode: subscription.plan.code,
    limits: parseJson(subscription.plan.limits),
    features: parseJson(subscription.plan.features)
  });
}

async function getEntitlementsForTenant(tenantId: string) {
  return computeEntitlements(tenantId);
}

async function enforceCameraLimit(tenantId: string) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return;

  const current = await prisma.camera.count({
    where: {
      tenantId,
      deletedAt: null
    }
  });
  const maxAllowed = entitlements.limits.maxCameras;
  if (current >= maxAllowed) {
    throw new ApiDomainError({
      statusCode: 409,
      apiCode: "ENTITLEMENT_LIMIT_EXCEEDED",
      message: "Camera limit reached for active plan",
      details: { limit: "maxCameras", current, maxAllowed, tenantId, planCode: entitlements.planCode }
    });
  }
}

async function enforceStreamConcurrencyLimit(tenantId: string) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return;

  const now = new Date();
  const inUse = await prisma.streamSession.count({
    where: {
      tenantId,
      status: { in: ["requested", "issued", "active"] },
      expiresAt: { gte: now }
    }
  });
  const maxAllowed = entitlements.limits.maxConcurrentStreams;
  if (inUse >= maxAllowed) {
    throw new ApiDomainError({
      statusCode: 409,
      apiCode: "ENTITLEMENT_LIMIT_EXCEEDED",
      message: "Concurrent stream limit reached for active plan",
      details: { limit: "maxConcurrentStreams", current: inUse, maxAllowed, tenantId, planCode: entitlements.planCode }
    });
  }
}

async function resolveEventsFromDate(tenantId: string, requestedFrom?: Date) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return requestedFrom;

  const minAllowedFrom = new Date(Date.now() - entitlements.limits.retentionDays * 24 * 60 * 60 * 1000);
  if (requestedFrom && requestedFrom < minAllowedFrom) {
    throw new ApiDomainError({
      statusCode: 422,
      apiCode: "ENTITLEMENT_RETENTION_EXCEEDED",
      message: "Requested date range exceeds plan retention window",
      details: {
        limit: "retentionDays",
        maxAllowedDays: entitlements.limits.retentionDays,
        minAllowedFrom: minAllowedFrom.toISOString(),
        requestedFrom: requestedFrom.toISOString(),
        tenantId,
        planCode: entitlements.planCode
      }
    });
  }

  return requestedFrom ?? minAllowedFrom;
}

function assertRole(request: FastifyRequest, roles: Role[]) {
  if (!request.ctx?.role || !roles.includes(request.ctx.role)) {
    throw new Error("FORBIDDEN_ROLE");
  }
}

function getTenantContext(request: FastifyRequest): { userId: string; tenantId: string; role?: Role } {
  if (!request.ctx?.tenantId) {
    throw new Error("MISSING_TENANT");
  }
  return {
    userId: request.ctx.userId,
    tenantId: request.ctx.tenantId,
    role: request.ctx.role
  };
}

async function appendLifecycleLog(args: {
  tenantId: string;
  cameraId: string;
  fromStatus: CameraLifecycleStatus | null;
  toStatus: CameraLifecycleStatus;
  event: string;
  reason?: string | null;
  actorUserId?: string;
}) {
  await prisma.cameraLifecycleLog.create({
    data: {
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      event: args.event,
      reason: args.reason ?? null,
      actorUserId: args.actorUserId
    }
  });
}

async function transitionCameraLifecycle(args: {
  tenantId: string;
  cameraId: string;
  toStatus: CameraLifecycleStatus;
  event: string;
  reason?: string | null;
  actorUserId?: string;
}) {
  const camera = await prisma.camera.findFirst({ where: { id: args.cameraId, tenantId: args.tenantId, deletedAt: null } });
  if (!camera) throw new Error("CAMERA_NOT_FOUND");
  const fromStatus = camera.lifecycleStatus as CameraLifecycleStatus;

  if (fromStatus !== args.toStatus && !canTransitionCameraLifecycle(fromStatus, args.toStatus)) {
    throw new Error("INVALID_LIFECYCLE_TRANSITION");
  }

  const updated = await prisma.camera.update({
    where: { id: camera.id },
    data: {
      lifecycleStatus: args.toStatus,
      lastTransitionAt: new Date(),
      ...(args.toStatus === "ready" ? { lastSeenAt: new Date() } : {})
    },
    include: { profile: true }
  });

  await appendLifecycleLog({
    tenantId: args.tenantId,
    cameraId: camera.id,
    fromStatus,
    toStatus: args.toStatus,
    event: args.event,
    reason: args.reason,
    actorUserId: args.actorUserId
  });

  return updated;
}

async function appendStreamSessionTransition(args: {
  streamSessionId: string;
  tenantId: string;
  fromStatus: StreamSessionStatus | null;
  toStatus: StreamSessionStatus;
  event: string;
  actorUserId?: string;
}) {
  await prisma.streamSessionTransition.create({
    data: {
      streamSessionId: args.streamSessionId,
      tenantId: args.tenantId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      event: args.event,
      actorUserId: args.actorUserId
    }
  });
}

async function transitionStreamSession(args: {
  tenantId: string;
  streamSessionId: string;
  toStatus: StreamSessionStatus;
  event: string;
  actorUserId?: string;
  endReason?: string | null;
}) {
  const session = await prisma.streamSession.findFirst({
    where: { id: args.streamSessionId, tenantId: args.tenantId }
  });
  if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");

  const fromStatus = session.status as StreamSessionStatus;
  if (fromStatus !== args.toStatus && !canTransitionStreamSession(fromStatus, args.toStatus)) {
    throw new Error("INVALID_STREAM_SESSION_TRANSITION");
  }

  const now = new Date();
  const updated = await prisma.streamSession.update({
    where: { id: session.id },
    data: {
      status: args.toStatus,
      ...(args.toStatus === "active" ? { activatedAt: now } : {}),
      ...(args.toStatus === "ended" || args.toStatus === "expired" ? { endedAt: now } : {}),
      ...(args.toStatus === "ended" ? { endReason: args.endReason ?? "ended by user action" } : {})
    }
  });

  await appendStreamSessionTransition({
    streamSessionId: session.id,
    tenantId: args.tenantId,
    fromStatus,
    toStatus: args.toStatus,
    event: args.event,
    actorUserId: args.actorUserId
  });

  return updated;
}

async function expireStaleStreamSessions(tenantId: string) {
  const stale = await prisma.streamSession.findMany({
    where: {
      tenantId,
      status: { in: ["requested", "issued", "active"] },
      expiresAt: { lt: new Date() }
    }
  });
  for (const session of stale) {
    await transitionStreamSession({
      tenantId,
      streamSessionId: session.id,
      toStatus: "expired",
      event: "stream.expired"
    });
  }
}

async function appendAuditLog(args: {
  tenantId: string;
  actorUserId?: string;
  resource: string;
  action: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      resource: args.resource,
      action: args.action,
      resourceId: args.resourceId ?? null,
      payload: args.payload ? JSON.stringify(args.payload) : null
    }
  });
}

const StreamGatewayHealthSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(["provisioning", "ready", "stopped"]),
    health: z.object({
      connectivity: CameraConnectivitySchema,
      latencyMs: z.number().nullable(),
      packetLossPct: z.number().nullable(),
      jitterMs: z.number().nullable(),
      error: z.string().nullable(),
      checkedAt: z.string()
    })
  })
});

async function syncCameraHealthFromGateway(args: {
  tenantId: string;
  cameraId: string;
  actorUserId?: string;
  streamGatewayUrl: string;
}) {
  const camera = await prisma.camera.findFirst({
    where: { id: args.cameraId, tenantId: args.tenantId, deletedAt: null }
  });
  if (!camera) throw new Error("CAMERA_NOT_FOUND");

  const response = await fetch(`${args.streamGatewayUrl}/health/${args.tenantId}/${args.cameraId}`);
  let connectivity: "online" | "degraded" | "offline" = "offline";
  let latencyMs: number | null = null;
  let packetLossPct: number | null = null;
  let jitterMs: number | null = null;
  let healthError: string | null = null;

  if (response.ok) {
    const payload = StreamGatewayHealthSchema.parse(await response.json());
    connectivity = payload.data.status === "provisioning" ? "degraded" : payload.data.health.connectivity;
    latencyMs = payload.data.health.latencyMs;
    packetLossPct = payload.data.health.packetLossPct;
    jitterMs = payload.data.health.jitterMs;
    healthError = payload.data.health.error;
  } else {
    connectivity = "offline";
    healthError = response.status === 404 ? "not_provisioned" : "stream_gateway_unreachable";
  }

  await prisma.cameraHealthSnapshot.upsert({
    where: { cameraId: args.cameraId },
    update: {
      connectivity,
      latencyMs,
      packetLossPct,
      jitterMs,
      error: healthError,
      checkedAt: new Date()
    },
    create: {
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      connectivity,
      latencyMs,
      packetLossPct,
      jitterMs,
      error: healthError,
      checkedAt: new Date()
    }
  });

  let nextLifecycle = lifecycleFromConnectivity(connectivity);
  const currentLifecycle = camera.lifecycleStatus as CameraLifecycleStatus;
  if (currentLifecycle === "retired") {
    nextLifecycle = "retired";
  } else if (currentLifecycle === "draft" && nextLifecycle !== "ready") {
    nextLifecycle = "error";
  } else if (!canTransitionCameraLifecycle(currentLifecycle, nextLifecycle)) {
    nextLifecycle = currentLifecycle;
  }

  const transitioned = await transitionCameraLifecycle({
    tenantId: args.tenantId,
    cameraId: args.cameraId,
    toStatus: nextLifecycle,
    event: "camera.health_synced",
    reason: `source=stream-gateway connectivity=${connectivity}`,
    actorUserId: args.actorUserId
  });

  await appendAuditLog({
    tenantId: args.tenantId,
    actorUserId: args.actorUserId,
    resource: "camera",
    action: "health_sync",
    resourceId: args.cameraId,
    payload: {
      connectivity,
      lifecycleStatus: transitioned.lifecycleStatus
    }
  });

  return {
    data: cameraResponse(transitioned),
    sync: {
      source: "stream-gateway" as const,
      connectivity,
      error: healthError
    }
  };
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  const jwtSecret = process.env.JWT_SECRET ?? "dev-super-secret";
  const streamTokenSecret = process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret";
  const streamGatewayUrl = process.env.STREAM_GATEWAY_URL?.replace(/\/$/, "") ?? null;
  const detectionBridgeUrl = process.env.DETECTION_BRIDGE_URL?.replace(/\/$/, "") ?? null;
  const temporalDispatchUrl = process.env.DETECTION_TEMPORAL_DISPATCH_URL?.replace(/\/$/, "") ?? null;
  const detectionCallbackSecret = process.env.DETECTION_CALLBACK_SECRET ?? "dev-detection-callback-secret";
  const eventGatewayUrl = process.env.EVENT_GATEWAY_URL?.replace(/\/$/, "") ?? null;
  const eventPublishSecret = process.env.EVENT_PUBLISH_SECRET ?? "dev-event-publish-secret";
  const detectionExecutionMode = process.env.DETECTION_EXECUTION_MODE ?? "inline";
  const streamHealthSyncEnabled = process.env.STREAM_HEALTH_SYNC_ENABLED === "1";
  const streamHealthSyncIntervalMs = Number(process.env.STREAM_HEALTH_SYNC_INTERVAL_MS ?? 30_000);
  const streamHealthSyncBatchSize = Number(process.env.STREAM_HEALTH_SYNC_BATCH_SIZE ?? 100);
  const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20);
  const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const readinessForceFail = process.env.READINESS_FORCE_FAIL === "1";
  const loginBuckets = new Map<string, LoginBucket>();
  let streamSyncTimer: NodeJS.Timeout | null = null;
  let streamSyncInFlight = false;

  const failDetectionJob = async (jobId: string, errorCode: string, errorMessage: string) => {
    const existing = await prisma.detectionJob.findUnique({ where: { id: jobId } });
    if (!existing) return null;
    const status = DetectionJobStatusSchema.parse(existing.status);
    if (["succeeded", "failed", "canceled"].includes(status)) return existing;
    const updated = await prisma.detectionJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorCode,
        errorMessage
      }
    });
    if (eventGatewayUrl) {
      try {
        await fetch(`${eventGatewayUrl}/internal/events/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-event-publish-secret": eventPublishSecret
          },
          body: JSON.stringify({
            eventType: "detection.job",
            tenantId: updated.tenantId,
            cameraId: updated.cameraId,
            correlationId: `det-${updated.id}`,
            payload: {
              jobId: updated.id,
              status: updated.status,
              errorCode,
              errorMessage
            }
          })
        });
      } catch (error) {
        app.log.warn({ error, jobId: updated.id }, "event_gateway.publish_failed");
      }
    }
    return updated;
  };

  const completeDetectionJob = async (args: {
    jobId: string;
    detections: Array<{
      label?: string;
      confidence?: number;
      bbox?: { x?: number; y?: number; w?: number; h?: number };
      keypoints?: unknown;
      attributes?: Record<string, unknown>;
      providerMeta?: Record<string, unknown>;
      frameTs?: string;
    }>;
    providerMeta?: Record<string, unknown>;
  }) => {
    const job = await prisma.detectionJob.findUnique({
      where: { id: args.jobId },
      include: {
        camera: {
          include: { profile: true }
        }
      }
    });
    if (!job) return null;
    const status = DetectionJobStatusSchema.parse(job.status);
    if (["succeeded", "failed", "canceled"].includes(status)) return job;
    if (status === "queued") {
      await prisma.detectionJob.update({
        where: { id: job.id },
        data: {
          status: "running",
          startedAt: new Date(),
          workflowId: job.workflowId ?? `inline-${job.id}`
        }
      });
    }

    const incidentsCreated: Array<{
      id: string;
      type: string;
      severity: string;
      summary: string;
      cameraId: string;
      tenantId: string;
    }> = [];

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < args.detections.length; i += 1) {
        const det = args.detections[i];
        const label = typeof det.label === "string" && det.label.length > 0 ? det.label : "unknown";
        const confidence = typeof det.confidence === "number" ? det.confidence : 0;
        const bbox = {
          x: typeof det.bbox?.x === "number" ? det.bbox.x : 0,
          y: typeof det.bbox?.y === "number" ? det.bbox.y : 0,
          w: typeof det.bbox?.w === "number" ? det.bbox.w : 0.1,
          h: typeof det.bbox?.h === "number" ? det.bbox.h : 0.1
        };
        const frameTs = typeof det.frameTs === "string" ? new Date(det.frameTs) : new Date();
        const zoneId = resolveZoneFromProfile(job.camera.profile?.zoneMap ?? null, bbox);
        const incident = deriveIncidentFromDetection({ label, zoneId, location: job.camera.location });

        const observation = await tx.detectionObservation.create({
          data: {
            jobId: job.id,
            tenantId: job.tenantId,
            cameraId: job.cameraId,
            frameTs,
            label,
            confidence,
            bbox: JSON.stringify(bbox),
            keypoints: det.keypoints ? JSON.stringify(det.keypoints) : null,
            attributes: det.attributes ? JSON.stringify(det.attributes) : null,
            providerMeta: det.providerMeta
              ? JSON.stringify(det.providerMeta)
              : args.providerMeta
                ? JSON.stringify(args.providerMeta)
                : null
          }
        });

        const track = await tx.track.create({
          data: {
            jobId: job.id,
            tenantId: job.tenantId,
            cameraId: job.cameraId,
            classLabel: label,
            trackExternalId: `${job.id}-${i + 1}`,
            startedAt: frameTs,
            metadata: JSON.stringify({ zoneId })
          }
        });

        await tx.trackPoint.create({
          data: {
            trackId: track.id,
            ts: frameTs,
            x: bbox.x + bbox.w / 2,
            y: bbox.y + bbox.h / 2,
            zoneId
          }
        });

        const primitive = await tx.scenePrimitiveEvent.create({
          data: {
            tenantId: job.tenantId,
            cameraId: job.cameraId,
            jobId: job.id,
            type: `object_detected.${label.toLowerCase()}`,
            severity: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low",
            startedAt: frameTs,
            payload: JSON.stringify({
              confidence,
              zoneId,
              observationId: observation.id
            })
          }
        });

        const incidentEvent = await tx.incidentEvent.create({
          data: {
            tenantId: job.tenantId,
            cameraId: job.cameraId,
            jobId: job.id,
            type: incident.type,
            severity: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low",
            status: "open",
            summary: incident.summary,
            startedAt: frameTs,
            payload: JSON.stringify({
              label,
              confidence,
              zoneId
            })
          }
        });
        incidentsCreated.push({
          id: incidentEvent.id,
          type: incidentEvent.type,
          severity: incidentEvent.severity,
          summary: incidentEvent.summary,
          cameraId: incidentEvent.cameraId,
          tenantId: incidentEvent.tenantId
        });

        await tx.incidentEvidence.create({
          data: {
            tenantId: job.tenantId,
            incidentId: incidentEvent.id,
            observationId: observation.id,
            trackId: track.id,
            scenePrimitiveEventId: primitive.id
          }
        });
      }

      await tx.detectionJob.update({
        where: { id: job.id },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null
        }
      });
    });

    const updated = await prisma.detectionJob.findUnique({ where: { id: job.id } });
    if (updated && eventGatewayUrl) {
      try {
        await fetch(`${eventGatewayUrl}/internal/events/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-event-publish-secret": eventPublishSecret
          },
          body: JSON.stringify({
            eventType: "detection.job",
            tenantId: updated.tenantId,
            cameraId: updated.cameraId,
            correlationId: `det-${updated.id}`,
            payload: {
              jobId: updated.id,
              status: updated.status
            }
          })
        });
        for (const incident of incidentsCreated) {
          await fetch(`${eventGatewayUrl}/internal/events/publish`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-event-publish-secret": eventPublishSecret
            },
            body: JSON.stringify({
              eventType: "incident",
              tenantId: incident.tenantId,
              cameraId: incident.cameraId,
              correlationId: `det-${updated.id}`,
              payload: {
                incidentId: incident.id,
                type: incident.type,
                severity: incident.severity,
                summary: incident.summary,
                jobId: updated.id
              }
            })
          });
        }
      } catch (error) {
        app.log.warn({ error, jobId: updated.id }, "event_gateway.publish_failed");
      }
    }

    return updated;
  };

  const runDetectionJobPipeline = async (jobId: string) => {
    if (!detectionBridgeUrl) return;
    const job = await prisma.detectionJob.findUnique({
      where: { id: jobId },
      include: {
        camera: true
      }
    });
    if (!job) return;
    if ((job.status as DetectionJobStatus) !== "queued") return;

    await prisma.detectionJob.update({
      where: { id: job.id },
      data: {
        status: "running",
        startedAt: new Date(),
        workflowId: detectionExecutionMode === "temporal" ? `temporal-${job.id}` : `inline-${job.id}`,
        runId: detectionExecutionMode === "temporal" ? `run-${Date.now()}` : null
      }
    });

    const options = job.options ? parseJson<Record<string, unknown>>(job.options) : {};
    const inferPayload = {
      requestId: `det-${job.id}`,
      jobId: job.id,
      tenantId: job.tenantId,
      cameraId: job.cameraId,
      taskType: typeof options.taskType === "string" ? options.taskType : "object_detection",
      modelRef: typeof options.modelRef === "string" ? options.modelRef : "yolo26n@1.0.0",
      mediaRef: {
        source: job.source,
        cameraId: job.cameraId,
        rtspUrl: job.camera.rtspUrl
      },
      thresholds: typeof options.thresholds === "object" && options.thresholds ? options.thresholds : {},
      deadlineMs: typeof options.deadlineMs === "number" ? options.deadlineMs : 15000,
      priority: typeof options.priority === "number" ? options.priority : 5,
      provider: job.provider
    };

    try {
      const response = await fetch(`${detectionBridgeUrl}/v1/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inferPayload)
      });
      if (!response.ok) {
        throw new Error(`Bridge HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        detections?: Array<{
          label?: string;
          confidence?: number;
          bbox?: { x?: number; y?: number; w?: number; h?: number };
          keypoints?: unknown;
          attributes?: Record<string, unknown>;
          providerMeta?: Record<string, unknown>;
        }>;
        providerMeta?: Record<string, unknown>;
      };
      const detections = Array.isArray(body.detections) ? body.detections : [];
      await completeDetectionJob({
        jobId: job.id,
        detections,
        providerMeta: body.providerMeta
      });
    } catch (error) {
      app.log.error({ error, jobId: job.id }, "detection.pipeline_failed");
      await failDetectionJob(
        job.id,
        "DETECTION_PIPELINE_ERROR",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  };

  const dispatchDetectionJobTemporal = async (jobId: string) => {
    if (!temporalDispatchUrl) {
      throw new Error("DETECTION_TEMPORAL_DISPATCH_URL is not configured");
    }

    const job = await prisma.detectionJob.findUnique({
      where: { id: jobId },
      include: {
        camera: true
      }
    });
    if (!job) return;
    if ((job.status as DetectionJobStatus) !== "queued") return;

    const options = job.options ? parseJson<Record<string, unknown>>(job.options) : {};
    const dispatchPayload = {
      requestId: `det-${job.id}`,
      jobId: job.id,
      tenantId: job.tenantId,
      cameraId: job.cameraId,
      mode: job.mode,
      source: job.source,
      provider: job.provider,
      options,
      mediaRef: {
        source: job.source,
        cameraId: job.cameraId,
        rtspUrl: job.camera.rtspUrl
      }
    };

    try {
      const response = await fetch(`${temporalDispatchUrl}/v1/workflows/detection-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dispatchPayload)
      });
      if (!response.ok) {
        throw new Error(`Temporal dispatch HTTP ${response.status}`);
      }

      const body = (await response.json()) as { workflowId?: string; runId?: string; taskQueue?: string };
      const workflowId =
        typeof body.workflowId === "string" && body.workflowId.length > 0 ? body.workflowId : `det-${job.id}`;

      await prisma.detectionJob.update({
        where: { id: job.id },
        data: {
          workflowId,
          runId: typeof body.runId === "string" && body.runId.length > 0 ? body.runId : null
        }
      });
    } catch (error) {
      app.log.error({ error, jobId: job.id }, "detection.temporal_dispatch_failed");
      await prisma.detectionJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorCode: "TEMPORAL_DISPATCH_ERROR",
          errorMessage: error instanceof Error ? error.message : "unknown error"
        }
      });
    }
  };

  await app.register(cors, {
    origin: [
      process.env.CORS_ORIGIN_ADMIN ?? "http://localhost:5173",
      process.env.CORS_ORIGIN_PORTAL ?? "http://localhost:5174"
    ],
    credentials: true
  });

  await app.register(jwt, { secret: jwtSecret });
  await app.register(sensible);

  app.addHook("onRequest", async (request, reply) => {
    const incomingRequestId = request.headers["x-request-id"];
    const requestId =
      typeof incomingRequestId === "string" && incomingRequestId.trim().length > 0 ? incomingRequestId.trim() : request.id;
    request.requestId = requestId;
    request.requestStartedAt = Date.now();
    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (request, reply) => {
    const latencyMs = request.requestStartedAt ? Date.now() - request.requestStartedAt : undefined;
    request.log.info(
      {
        requestId: request.requestId ?? request.id,
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        latencyMs,
        tenantId: request.ctx?.tenantId ?? null,
        userId: request.ctx?.userId ?? null
      },
      "request.summary"
    );
  });

  if (streamHealthSyncEnabled) {
    if (!streamGatewayUrl) {
      app.log.warn("stream health sync is enabled but STREAM_GATEWAY_URL is missing");
    } else {
      const runStreamHealthSync = async () => {
        if (streamSyncInFlight) return;
        streamSyncInFlight = true;
        try {
          const cameras = await prisma.camera.findMany({
            where: { deletedAt: null, isActive: true },
            select: { id: true, tenantId: true },
            take: streamHealthSyncBatchSize
          });
          for (const camera of cameras) {
            try {
              await syncCameraHealthFromGateway({
                tenantId: camera.tenantId,
                cameraId: camera.id,
                streamGatewayUrl
              });
            } catch (error) {
              app.log.warn(
                { error, tenantId: camera.tenantId, cameraId: camera.id },
                "stream_health_sync.camera_failed"
              );
            }
          }
        } finally {
          streamSyncInFlight = false;
        }
      };

      streamSyncTimer = setInterval(() => {
        runStreamHealthSync().catch((error) => {
          app.log.error({ error }, "stream_health_sync.loop_failed");
        });
      }, streamHealthSyncIntervalMs);
      streamSyncTimer.unref?.();
    }
  }

  app.addHook("onClose", async () => {
    if (streamSyncTimer) {
      clearInterval(streamSyncTimer);
      streamSyncTimer = null;
    }
  });

  app.all("/v1/*", async (request, reply) => {
    const targetUrl = request.url.replace(/^\/v1/, "") || "/";
    const proxied = (await app.inject({
      method: request.method as any,
      url: targetUrl,
      headers: request.headers as Record<string, string>,
      payload: request.body as any
    })) as any;

    const ignoredHeaders = new Set(["content-length", "transfer-encoding", "connection"]);
    for (const [key, value] of Object.entries(proxied.headers)) {
      if (!ignoredHeaders.has(key.toLowerCase()) && value !== undefined) {
        reply.header(key, value as string);
      }
    }

    reply.status(proxied.statusCode).send(proxied.body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = {
      code: "NOT_FOUND",
      message: "Route not found"
    };
    reply.status(404).send(body);
  });

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    let statusCode = (err.statusCode ?? 500) as number;

    if (error instanceof z.ZodError) {
      statusCode = 400;
    }
    if (err.message === "MISSING_TENANT") {
      statusCode = 400;
    }
    if (err.message === "FORBIDDEN_ROLE") {
      statusCode = 403;
    }
    if (err.message === "INVALID_LIFECYCLE_TRANSITION") {
      statusCode = 400;
    }
    if (err.message === "CAMERA_NOT_FOUND") {
      statusCode = 404;
    }
    if (err.message === "STREAM_SESSION_NOT_FOUND") {
      statusCode = 404;
    }
    if (err.message === "INVALID_STREAM_SESSION_TRANSITION") {
      statusCode = 400;
    }
    if (error instanceof ApiDomainError) {
      statusCode = error.statusCode;
    }

    const code = error instanceof z.ZodError ? "VALIDATION_ERROR" : error instanceof ApiDomainError ? error.apiCode : statusToCode(statusCode);
    const defaultMessage = statusCode >= 500 ? "Internal server error" : "Request failed";

    const body: ApiErrorBody = {
      code,
      message:
        err.message === "MISSING_TENANT"
          ? "X-Tenant-Id required"
          : err.message === "FORBIDDEN_ROLE"
            ? "Insufficient permissions"
            : err.message === "INVALID_LIFECYCLE_TRANSITION"
              ? "Invalid camera lifecycle transition"
              : err.message === "CAMERA_NOT_FOUND"
                ? "Camera not found"
              : err.message === "STREAM_SESSION_NOT_FOUND"
                  ? "Stream session not found"
                  : err.message === "INVALID_STREAM_SESSION_TRANSITION"
                    ? "Invalid stream session transition"
                    : error instanceof ApiDomainError
                      ? error.message
            : error instanceof z.ZodError
              ? "Validation failed"
              : err.message || defaultMessage
    };

    if (error instanceof z.ZodError) {
      body.details = error.flatten();
    } else if (error instanceof ApiDomainError) {
      body.details = error.details;
    } else if (err.code === "P2025") {
      body.code = "NOT_FOUND";
      body.message = "Resource not found";
    }

    reply.status(statusCode).send(body);
  });

  const authPreHandler = async (request: FastifyRequest) => {
    await request.jwtVerify<{ userId: string }>();
    const payload = request.user as { userId: string };
    request.ctx = { userId: payload.userId };

    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    if (tenantHeader) {
      const membership = await prisma.membership.findFirst({
        where: {
          tenantId: tenantHeader,
          userId: payload.userId,
          tenant: { deletedAt: null }
        }
      });

      if (!membership) {
        throw app.httpErrors.forbidden("Invalid tenant context");
      }

      request.ctx.tenantId = tenantHeader;
      request.ctx.role = membership.role as Role;
    }
  };

  const tenantScopedPreHandler = async (request: FastifyRequest) => {
    await authPreHandler(request);
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    if (!tenantHeader) {
      throw new Error("MISSING_TENANT");
    }
  };

  const checkLoginRateLimit = (request: FastifyRequest) => {
    const forwarded = request.headers["x-forwarded-for"];
    const ipCandidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const key =
      (typeof ipCandidate === "string" ? ipCandidate.split(",")[0]?.trim() : undefined) || request.ip || "unknown";
    const now = Date.now();
    const bucket = loginBuckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      loginBuckets.set(key, { count: 1, resetAt: now + loginRateLimitWindowMs });
      return;
    }

    if (bucket.count >= loginRateLimitMax) {
      throw app.httpErrors.tooManyRequests("Too many login attempts");
    }

    bucket.count += 1;
  };

  app.post("/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    checkLoginRateLimit(request);

    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) throw app.httpErrors.unauthorized("Invalid credentials");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw app.httpErrors.unauthorized("Invalid credentials");

    const token = await reply.jwtSign({ userId: user.id }, { expiresIn: "8h" });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      }
    };
  });

  app.post("/auth/logout", async () => ({ success: true }));

  app.get("/auth/me", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.ctx!.userId } });
    const memberships = await prisma.membership.findMany({
      where: {
        userId: user.id,
        tenant: { deletedAt: null }
      },
      include: { tenant: true },
      orderBy: { createdAt: "asc" }
    });

    const activeTenantId = (request.headers["x-tenant-id"] as string | undefined) ?? memberships[0]?.tenantId;
    const activeTenant = memberships.find((m: any) => m.tenantId === activeTenantId)?.tenant;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      },
      memberships: memberships.map((m: any) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        role: m.role,
        createdAt: toISO(m.createdAt),
        tenant: { id: m.tenant.id, name: m.tenant.name, createdAt: toISO(m.tenant.createdAt) }
      })),
      activeTenant: activeTenant
        ? { id: activeTenant.id, name: activeTenant.name, createdAt: toISO(activeTenant.createdAt) }
        : undefined,
      entitlements: activeTenant ? await computeEntitlements(activeTenant.id) : undefined
    };
  });

  app.get("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const memberships = await prisma.membership.findMany({
      where: {
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      },
      include: { tenant: true }
    });
    const data = memberships.map((m: any) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      createdAt: toISO(m.tenant.createdAt)
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const tenant = await prisma.tenant.create({ data: { name: body.name } });
    await prisma.membership.create({
      data: { tenantId: tenant.id, userId: request.ctx!.userId, role: "tenant_admin" }
    });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.get("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      }
    });
    if (!membership) throw app.httpErrors.forbidden();
    const tenant = await prisma.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!tenant) throw app.httpErrors.notFound();
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.put("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      }
    });
    if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();
    const tenant = await prisma.tenant.update({ where: { id }, data: { name: body.name } });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.delete("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        role: "tenant_admin",
        tenant: { deletedAt: null }
      }
    });
    if (!membership) throw app.httpErrors.forbidden();

    const tenant = await prisma.tenant.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    await appendAuditLog({
      tenantId: id,
      actorUserId: request.ctx!.userId,
      resource: "tenant",
      action: "delete",
      resourceId: id,
      payload: { name: tenant.name }
    });

    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.get("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const memberships = await prisma.membership.findMany({
      where: { tenantId: ctx.tenantId },
      include: { user: true }
    });
    const data = memberships.map((m: any) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      createdAt: toISO(m.user.createdAt),
      isActive: m.user.isActive,
      role: m.role
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z
      .object({ email: z.string().email(), name: z.string(), password: z.string().min(4), role: RoleSchema })
      .parse(request.body);

    const hash = await bcrypt.hash(body.password, 10);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    const user = existing
      ? existing
      : await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: hash, isActive: true } });

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: user.id } },
      update: { role: body.role },
      create: { tenantId: ctx.tenantId, userId: user.id, role: body.role }
    });

    return {
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      }
    };
  });

  app.put("/users/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        name: z.string().min(1).optional(),
        isActive: z.boolean().optional(),
        role: RoleSchema.optional()
      })
      .refine((value) => value.name !== undefined || value.isActive !== undefined || value.role !== undefined, {
        message: "At least one field must be provided"
      })
      .parse(request.body);

    const membership = await prisma.membership.findFirst({
      where: { tenantId: ctx.tenantId, userId: id },
      include: { user: true }
    });
    if (!membership) throw app.httpErrors.notFound("User not found in tenant");

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });

    if (body.role) {
      await prisma.membership.update({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } },
        data: { role: body.role }
      });
    }

    const updatedMembership = await prisma.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } }
    });

    return {
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive,
        role: updatedMembership.role
      }
    };
  });

  app.get(
    "/memberships",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor"]);
      const rows = await prisma.membership.findMany({ where: { tenantId: ctx.tenantId }, include: { user: true } });
      const data = rows.map((m: any) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        role: m.role,
        createdAt: toISO(m.createdAt),
        user: {
          id: m.user.id,
          email: m.user.email,
          name: m.user.name,
          createdAt: toISO(m.user.createdAt),
          isActive: m.user.isActive
        }
      }));
      reply.header("x-total-count", String(data.length));
      return { data, total: data.length };
    }
  );

  app.post("/memberships", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z.object({ userId: z.string(), role: RoleSchema }).parse(request.body);
    const membership = await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: body.userId } },
      update: { role: body.role },
      create: { tenantId: ctx.tenantId, userId: body.userId, role: body.role }
    });
    return {
      data: {
        id: membership.id,
        tenantId: membership.tenantId,
        userId: membership.userId,
        role: membership.role,
        createdAt: toISO(membership.createdAt)
      }
    };
  });

  app.get("/audit-logs", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const resource = typeof query.resource === "string" ? query.resource : undefined;
    const action = typeof query.action === "string" ? query.action : undefined;

    const where = {
      tenantId: ctx.tenantId,
      ...(resource ? { resource } : {}),
      ...(action ? { action } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.auditLog.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: rows.map(auditLogResponse), total };
  });

  app.get("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const { skip, take, sort, order } = parseListQuery(request.query as Record<string, unknown>);
    const q = request.query as Record<string, unknown>;

    const where: any = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      ...(q.name ? { name: { contains: String(q.name), mode: "insensitive" } } : {}),
      ...(q.isActive !== undefined ? { isActive: String(q.isActive) === "true" } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.camera.findMany({ where, skip, take, orderBy: { [sort]: order }, include: { profile: true } }),
      prisma.camera.count({ where })
    ]);

    const data = rows.map(cameraResponse);
    reply.header("x-total-count", String(total));
    return { data, total };
  });

  app.post("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    await enforceCameraLimit(ctx.tenantId);
    const body = z
      .object({
        name: z.string().min(2),
        description: z.string().max(2000).optional(),
        rtspUrl: z.string().min(4),
        location: z.string().optional(),
        tags: z.array(z.string()).optional(),
        isActive: z.boolean().default(true)
      })
      .parse(request.body);

    const camera = await prisma.camera.create({
      data: {
        tenantId: ctx.tenantId,
        name: body.name,
        description: body.description,
        rtspUrl: body.rtspUrl,
        location: body.location,
        tags: JSON.stringify(body.tags ?? []),
        isActive: body.isActive,
        lifecycleStatus: body.isActive ? "provisioning" : "draft",
        lastTransitionAt: new Date()
      }
    });

    await appendLifecycleLog({
      tenantId: ctx.tenantId,
      cameraId: camera.id,
      fromStatus: null,
      toStatus: camera.lifecycleStatus as CameraLifecycleStatus,
      event: "camera.created",
      reason: body.isActive ? "active camera queued for provisioning" : "created in draft mode",
      actorUserId: ctx.userId
    });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({
        where: { cameraId: camera.id },
        update: {},
        create: defaultCameraProfileData(ctx.tenantId, camera.id)
      });
      await appendLifecycleLog({
        tenantId: ctx.tenantId,
        cameraId: camera.id,
        fromStatus: "provisioning",
        toStatus: "provisioning",
        event: "camera.profile_configured",
        reason: "profile auto-provisioned",
        actorUserId: ctx.userId
      });
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "create",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        isActive: camera.isActive,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.get("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
    if (!camera) throw app.httpErrors.notFound();
    return { data: cameraResponse(camera) };
  });

  app.put("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        name: z.string().min(2),
        description: z.string().max(2000).optional().nullable(),
        rtspUrl: z.string().min(4),
        location: z.string().optional().nullable(),
        tags: z.array(z.string()).optional(),
        isActive: z.boolean().default(true)
      })
      .parse(request.body);

    const current = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!current) throw new Error("CAMERA_NOT_FOUND");

    const camera = await prisma.camera.update({
      where: { id: current.id },
      data: {
        name: body.name,
        description: body.description,
        rtspUrl: body.rtspUrl,
        location: body.location,
        tags: JSON.stringify(body.tags ?? []),
        isActive: body.isActive
      }
    });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({
        where: { cameraId: camera.id },
        update: {},
        create: defaultCameraProfileData(camera.tenantId, camera.id)
      });
      if ((camera.lifecycleStatus as CameraLifecycleStatus) === "draft") {
        await transitionCameraLifecycle({
          tenantId: camera.tenantId,
          cameraId: camera.id,
          toStatus: "provisioning",
          event: "camera.reactivated_for_provisioning",
          reason: "camera set active from draft",
          actorUserId: ctx.userId
        });
      }
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "update",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        isActive: camera.isActive,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

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
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "delete",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

    if (streamGatewayUrl) {
      try {
        await fetch(`${streamGatewayUrl}/deprovision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: ctx.tenantId, cameraId: camera.id })
        });
      } catch (error) {
        request.log.warn({ error, tenantId: ctx.tenantId, cameraId: camera.id }, "stream_gateway.deprovision_failed");
      }
    }
    return { data: cameraResponse(deleted) };
  });

  app.post("/cameras/:id/stream-token", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    await expireStaleStreamSessions(ctx.tenantId);
    await enforceStreamConcurrencyLimit(ctx.tenantId);

    const expiresAt = new Date(Date.now() + 1000 * 60 * 5);
    const requested = await prisma.streamSession.create({
      data: {
        tenantId: ctx.tenantId,
        cameraId: id,
        userId: ctx.userId,
        status: "requested",
        token: "",
        expiresAt,
        issuedAt: new Date()
      }
    });
    await appendStreamSessionTransition({
      streamSessionId: requested.id,
      tenantId: ctx.tenantId,
      fromStatus: null,
      toStatus: "requested",
      event: "stream.requested",
      actorUserId: ctx.userId
    });
    const token = signStreamToken(
      {
        sub: ctx.userId,
        tid: ctx.tenantId,
        cid: id,
        sid: requested.id,
        exp: Math.floor(expiresAt.getTime() / 1000),
        iat: Math.floor(Date.now() / 1000),
        v: 1
      },
      streamTokenSecret
    );
    const session = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: requested.id,
      toStatus: "issued",
      event: "stream.issued",
      actorUserId: ctx.userId
    });
    const sessionWithToken = await prisma.streamSession.update({
      where: { id: session.id },
      data: { token }
    });

    let playbackUrl: string | undefined;
    if (streamGatewayUrl) {
      try {
        await fetch(`${streamGatewayUrl}/provision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantId: ctx.tenantId,
            cameraId: id,
            rtspUrl: camera.rtspUrl
          })
        });
        playbackUrl = `${streamGatewayUrl}/playback/${ctx.tenantId}/${id}/index.m3u8?token=${encodeURIComponent(token)}`;
      } catch (error) {
        request.log.warn({ error, tenantId: ctx.tenantId, cameraId: id }, "stream_gateway.provision_failed");
      }
    }

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      session: streamSessionResponse(sessionWithToken),
      ...(playbackUrl ? { playbackUrl } : {})
    };
  });

  app.get("/stream-sessions", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const query = request.query as Record<string, unknown>;
    const { skip, take, sort, order } = parseListQuery(query);
    const cameraId = typeof query.cameraId === "string" ? query.cameraId : undefined;
    const status = StreamSessionStatusSchema.safeParse(query.status);

    const where = {
      tenantId: ctx.tenantId,
      ...(cameraId ? { cameraId } : {}),
      ...(status.success ? { status: status.data } : {}),
      ...(ctx.role === "client_user" ? { userId: ctx.userId } : {})
    };

    const [data, total] = await Promise.all([
      prisma.streamSession.findMany({
        where,
        skip,
        take,
        orderBy: { [sort]: order }
      }),
      prisma.streamSession.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: data.map(streamSessionResponse), total };
  });

  app.get("/stream-sessions/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        ...(ctx.role === "client_user" ? { userId: ctx.userId } : {})
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");

    const transitions = await prisma.streamSessionTransition.findMany({
      where: { streamSessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    return {
      data: {
        ...streamSessionResponse(session),
        history: transitions.map((entry) => ({
          id: entry.id,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          event: entry.event,
          actorUserId: entry.actorUserId,
          createdAt: toISO(entry.createdAt)
        }))
      }
    };
  });

  app.post("/stream-sessions/:id/activate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) {
      throw app.httpErrors.forbidden("Stream session ownership mismatch");
    }

    const updated = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: id,
      toStatus: "active",
      event: "stream.activated",
      actorUserId: ctx.userId
    });
    return { data: streamSessionResponse(updated) };
  });

  app.post("/stream-sessions/:id/end", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) {
      throw app.httpErrors.forbidden("Stream session ownership mismatch");
    }

    const updated = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: id,
      toStatus: "ended",
      event: "stream.ended",
      actorUserId: ctx.userId,
      endReason: body.reason ?? "ended by user action"
    });
    return { data: streamSessionResponse(updated) };
  });

  app.get("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const profile = await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {},
      create: defaultCameraProfileData(ctx.tenantId, id)
    });
    return { data: profileResponse(profile) };
  });

  app.put("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        proxyPath: z.string().optional(),
        recordingEnabled: z.boolean().optional(),
        recordingStorageKey: z.string().optional(),
        detectorConfigKey: z.string().optional(),
        detectorResultsKey: z.string().optional(),
        zoneMap: z.record(z.any()).nullable().optional(),
        homography: z.record(z.any()).nullable().optional(),
        sceneTags: z.array(z.string()).optional(),
        rulesProfile: z.record(z.any()).nullable().optional(),
        detectorFlags: z
          .object({
            mediapipe: z.boolean(),
            yolo: z.boolean(),
            lpr: z.boolean()
          })
          .optional(),
        status: z.enum(["pending", "ready", "error"]).optional(),
        lastHealthAt: z.string().datetime().nullable().optional(),
        lastError: z.string().nullable().optional()
      })
      .refine(
        (value) =>
          value.proxyPath !== undefined ||
          value.recordingEnabled !== undefined ||
          value.recordingStorageKey !== undefined ||
          value.detectorConfigKey !== undefined ||
          value.detectorResultsKey !== undefined ||
          value.zoneMap !== undefined ||
          value.homography !== undefined ||
          value.sceneTags !== undefined ||
          value.rulesProfile !== undefined ||
          value.detectorFlags !== undefined ||
          value.status !== undefined ||
          value.lastHealthAt !== undefined ||
          value.lastError !== undefined,
        { message: "At least one profile field must be provided" }
      )
      .parse(request.body);

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const profile = await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {
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
      },
      create: {
        ...defaultCameraProfileData(ctx.tenantId, id),
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
      }
    });

    const configComplete = isProfileConfigComplete(profile);
    if (!configComplete && profile.status === "ready") {
      const normalized = await prisma.cameraProfile.update({
        where: { cameraId: id },
        data: {
          status: "pending",
          lastError: profile.lastError ?? "incomplete profile configuration"
        }
      });
      await appendAuditLog({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        resource: "camera_profile",
        action: "update",
        resourceId: id,
        payload: {
          status: normalized.status,
          configComplete: false
        }
      });
      return { data: profileResponse(normalized) };
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera_profile",
      action: "update",
      resourceId: id,
      payload: {
        status: profile.status,
        configComplete
      }
    });

    return { data: profileResponse(profile) };
  });

  app.get("/cameras/:id/lifecycle", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    const [snapshot, logs] = await Promise.all([
      prisma.cameraHealthSnapshot.findUnique({ where: { cameraId: id } }),
      prisma.cameraLifecycleLog.findMany({ where: { cameraId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    ]);

    return {
      data: {
        cameraId: id,
        currentStatus: camera.lifecycleStatus,
        isActive: camera.isActive,
        lastSeenAt: camera.lastSeenAt ? toISO(camera.lastSeenAt) : null,
        lastTransitionAt: camera.lastTransitionAt ? toISO(camera.lastTransitionAt) : null,
        healthSnapshot: snapshot
          ? {
              id: snapshot.id,
              connectivity: snapshot.connectivity,
              latencyMs: snapshot.latencyMs,
              packetLossPct: snapshot.packetLossPct,
              jitterMs: snapshot.jitterMs,
              error: snapshot.error,
              checkedAt: toISO(snapshot.checkedAt)
            }
          : null,
        history: logs.map((log) => ({
          id: log.id,
          fromStatus: log.fromStatus,
          toStatus: log.toStatus,
          event: log.event,
          reason: log.reason,
          actorUserId: log.actorUserId,
          createdAt: toISO(log.createdAt)
        }))
      }
    };
  });

  app.post("/cameras/:id/validate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ simulate: z.enum(["pass", "fail"]).optional() }).parse(request.body ?? {});

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    const profile =
      camera.profile ??
      (await prisma.cameraProfile.upsert({
        where: { cameraId: id },
        update: {},
        create: defaultCameraProfileData(ctx.tenantId, id)
      }));

    const shouldPass = body.simulate
      ? body.simulate === "pass"
      : isProfileConfigComplete({
          proxyPath: profile.proxyPath,
          recordingStorageKey: profile.recordingStorageKey,
          detectorConfigKey: profile.detectorConfigKey,
          detectorResultsKey: profile.detectorResultsKey
        });

    const nextStatus: CameraLifecycleStatus = shouldPass ? "ready" : "error";
    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: nextStatus,
      event: shouldPass ? "camera.validation_passed" : "camera.validation_failed",
      reason: shouldPass ? "validation succeeded" : "validation failed",
      actorUserId: ctx.userId
    });

    await prisma.cameraHealthSnapshot.upsert({
      where: { cameraId: id },
      update: {
        connectivity: shouldPass ? "online" : "offline",
        latencyMs: shouldPass ? 95 : null,
        packetLossPct: shouldPass ? 0.1 : null,
        jitterMs: shouldPass ? 6 : null,
        error: shouldPass ? null : "validation failed",
        checkedAt: new Date()
      },
      create: {
        tenantId: ctx.tenantId,
        cameraId: id,
        connectivity: shouldPass ? "online" : "offline",
        latencyMs: shouldPass ? 95 : null,
        packetLossPct: shouldPass ? 0.1 : null,
        jitterMs: shouldPass ? 6 : null,
        error: shouldPass ? null : "validation failed",
        checkedAt: new Date()
      }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: shouldPass ? "validate_pass" : "validate_fail",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus
      }
    });

    return { data: cameraResponse(transitioned) };
  });

  app.post("/cameras/:id/retire", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: "retired",
      event: "camera.retired",
      reason: "retired by admin",
      actorUserId: ctx.userId
    });

    const deactivated = await prisma.camera.update({
      where: { id },
      data: { isActive: false },
      include: { profile: true }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "retire",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus,
        isActive: false
      }
    });

    return { data: cameraResponse({ ...deactivated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/reactivate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: "draft",
      event: "camera.reactivated",
      reason: "reactivated by admin",
      actorUserId: ctx.userId
    });

    const activated = await prisma.camera.update({
      where: { id },
      data: { isActive: true },
      include: { profile: true }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "reactivate",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus,
        isActive: true
      }
    });

    return { data: cameraResponse({ ...activated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        connectivity: CameraConnectivitySchema,
        latencyMs: z.number().int().nullable().optional(),
        packetLossPct: z.number().min(0).max(100).nullable().optional(),
        jitterMs: z.number().int().nullable().optional(),
        error: z.string().nullable().optional()
      })
      .parse(request.body);

    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    await prisma.cameraHealthSnapshot.upsert({
      where: { cameraId: id },
      update: {
        connectivity: body.connectivity,
        latencyMs: body.latencyMs ?? null,
        packetLossPct: body.packetLossPct ?? null,
        jitterMs: body.jitterMs ?? null,
        error: body.error ?? null,
        checkedAt: new Date()
      },
      create: {
        tenantId: ctx.tenantId,
        cameraId: id,
        connectivity: body.connectivity,
        latencyMs: body.latencyMs ?? null,
        packetLossPct: body.packetLossPct ?? null,
        jitterMs: body.jitterMs ?? null,
        error: body.error ?? null,
        checkedAt: new Date()
      }
    });

    const lifecycleStatus: CameraLifecycleStatus =
      body.connectivity === "online" ? "ready" : body.connectivity === "degraded" ? "degraded" : "offline";

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: lifecycleStatus,
      event: "camera.health_updated",
      reason: `connectivity=${body.connectivity}`,
      actorUserId: ctx.userId
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "health_update",
      resourceId: id,
      payload: {
        connectivity: body.connectivity,
        lifecycleStatus: transitioned.lifecycleStatus
      }
    });

    return { data: cameraResponse(transitioned) };
  });

  app.post("/cameras/:id/sync-health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    if (!streamGatewayUrl) {
      throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    }
    return syncCameraHealthFromGateway({
      tenantId: ctx.tenantId,
      cameraId: id,
      actorUserId: ctx.userId,
      streamGatewayUrl
    });
  });

  app.get("/plans", { preHandler: authPreHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const plans = await prisma.plan.findMany({ orderBy: { createdAt: "asc" } });
    const data = plans.map((p: any) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      limits: parseJson(p.limits),
      features: parseJson(p.features)
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/tenants/:id/subscription", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
    if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();

    const body = z.object({ planId: z.string() }).parse(request.body);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });

    const subscription = await prisma.subscription.upsert({
      where: { tenantId },
      update: {
        planId: plan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      },
      create: {
        tenantId,
        planId: plan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      },
      include: { plan: true }
    });

    await appendAuditLog({
      tenantId,
      actorUserId: request.ctx!.userId,
      resource: "subscription",
      action: "set_plan",
      resourceId: subscription.id,
      payload: {
        planId: subscription.planId,
        status: subscription.status
      }
    });

    return {
      data: {
        id: subscription.id,
        tenantId: subscription.tenantId,
        planId: subscription.planId,
        status: subscription.status,
        currentPeriodStart: toISO(subscription.currentPeriodStart),
        currentPeriodEnd: toISO(subscription.currentPeriodEnd),
        plan: {
          id: subscription.plan.id,
          code: subscription.plan.code,
          name: subscription.plan.name,
          limits: parseJson(subscription.plan.limits),
          features: parseJson(subscription.plan.features)
        }
      }
    };
  });

  app.get("/tenants/:id/entitlements", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
    if (!membership) throw app.httpErrors.forbidden();

    const entitlements = await getEntitlementsForTenant(tenantId);
    return { data: entitlements };
  });

  app.get(
    "/subscriptions",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getTenantContext(request);
      const row = await prisma.subscription.findFirst({ where: { tenantId }, include: { plan: true } });

      const data = row
        ? [
            {
              id: row.id,
              tenantId: row.tenantId,
              planId: row.planId,
              status: row.status,
              currentPeriodStart: toISO(row.currentPeriodStart),
              currentPeriodEnd: toISO(row.currentPeriodEnd),
              plan: {
                id: row.plan.id,
                code: row.plan.code,
                name: row.plan.name,
                limits: parseJson(row.plan.limits),
                features: parseJson(row.plan.features)
              }
            }
          ]
        : [];

      reply.header("x-total-count", String(data.length));
      return { data, total: data.length };
    }
  );

  app.post("/internal/detections/jobs/:id/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const providedSecret = request.headers["x-detection-callback-secret"];
    if (providedSecret !== detectionCallbackSecret) {
      throw app.httpErrors.unauthorized("invalid callback secret");
    }

    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        detections: z
          .array(
            z.object({
              label: z.string().optional(),
              confidence: z.number().optional(),
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
              frameTs: z.string().optional()
            })
          )
          .default([]),
        providerMeta: z.record(z.any()).optional()
      })
      .parse(request.body);

    const job = await completeDetectionJob({
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
    if (providedSecret !== detectionCallbackSecret) {
      throw app.httpErrors.unauthorized("invalid callback secret");
    }

    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        errorCode: z.string().default("DETECTION_WORKFLOW_ERROR"),
        errorMessage: z.string().default("workflow failed")
      })
      .parse(request.body);

    const job = await failDetectionJob(id, body.errorCode, body.errorMessage);
    if (!job) throw app.httpErrors.notFound();
    reply.code(200);
    return { data: detectionJobResponse(job) };
  });

  app.post("/detections/jobs", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);

    const body = z
      .object({
        cameraId: z.string(),
        mode: DetectionModeSchema.default("realtime"),
        source: DetectionSourceSchema.default("snapshot"),
        provider: DetectionProviderSchema.default("onprem_bento"),
        options: z.record(z.any()).optional()
      })
      .parse(request.body);

    const camera = await prisma.camera.findFirst({
      where: { id: body.cameraId, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const job = await prisma.detectionJob.create({
      data: {
        tenantId: ctx.tenantId,
        cameraId: camera.id,
        mode: body.mode,
        source: body.source,
        provider: body.provider,
        status: "queued",
        options: body.options ? JSON.stringify(body.options) : null,
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
        provider: job.provider
      }
    });

    if (detectionExecutionMode === "temporal") {
      void dispatchDetectionJobTemporal(job.id);
    } else if (detectionBridgeUrl) {
      void runDetectionJobPipeline(job.id);
    }

    return { data: detectionJobResponse(job) };
  });

  app.get("/detections/jobs/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const job = await prisma.detectionJob.findFirst({
      where: { id, tenantId: ctx.tenantId }
    });
    if (!job) throw app.httpErrors.notFound();
    return { data: detectionJobResponse(job) };
  });

  app.get("/detections/jobs/:id/results", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;

    const job = await prisma.detectionJob.findFirst({
      where: { id, tenantId: ctx.tenantId }
    });
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
    return { data: rows.map(detectionObservationResponse), total };
  });

  app.post("/detections/jobs/:id/cancel", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const id = (request.params as { id: string }).id;

    const job = await prisma.detectionJob.findFirst({
      where: { id, tenantId: ctx.tenantId }
    });
    if (!job) throw app.httpErrors.notFound();

    const status = DetectionJobStatusSchema.parse(job.status);
    if (!["queued", "running"].includes(status)) {
      return { data: detectionJobResponse(job) };
    }

    const updated = await prisma.detectionJob.update({
      where: { id: job.id },
      data: {
        status: "canceled",
        canceledAt: new Date(),
        finishedAt: new Date()
      }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "detection_job",
      action: "cancel",
      resourceId: updated.id
    });

    return { data: detectionJobResponse(updated) };
  });

  app.get("/cameras/:id/detections", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const cameraId = (request.params as { id: string }).id;
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
      ...(from || to
        ? {
            frameTs: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {})
            }
          }
        : {})
    };

    const [rows, total] = await Promise.all([
      prisma.detectionObservation.findMany({
        where,
        orderBy: { [orderByKey]: order },
        skip,
        take
      }),
      prisma.detectionObservation.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: rows.map(detectionObservationResponse), total };
  });

  app.get("/incidents", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take, sort, order } = parseListQuery(query);
    const cameraId = typeof query.cameraId === "string" ? query.cameraId : undefined;
    const status = typeof query.status === "string" ? query.status : undefined;

    const where = {
      tenantId: ctx.tenantId,
      ...(cameraId ? { cameraId } : {}),
      ...(status ? { status } : {})
    };
    const orderByKey = sort === "createdAt" ? "createdAt" : "startedAt";

    const [rows, total] = await Promise.all([
      prisma.incidentEvent.findMany({
        where,
        orderBy: { [orderByKey]: order },
        skip,
        take
      }),
      prisma.incidentEvent.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: rows.map(incidentEventResponse), total };
  });

  app.get("/incidents/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const incident = await prisma.incidentEvent.findFirst({
      where: { id, tenantId: ctx.tenantId }
    });
    if (!incident) throw app.httpErrors.notFound();
    return { data: incidentEventResponse(incident) };
  });

  app.get("/incidents/:id/evidence", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const incident = await prisma.incidentEvent.findFirst({
      where: { id, tenantId: ctx.tenantId }
    });
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
  });

  app.get("/events/ws-token", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const topicsAllowed =
      ctx.role === "tenant_admin"
        ? ["camera.status", "stream.session", "detection.job", "detection.object", "incident", "system.alert"]
        : ["camera.status", "stream.session", "detection.job", "detection.object", "incident"];
    const expiresInSec = 60;
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const token = await reply.jwtSign({
      sub: ctx.userId,
      tenantId: ctx.tenantId,
      topics: topicsAllowed,
      typ: "ws",
      exp
    });

    return {
      data: {
        token,
        tenantId: ctx.tenantId,
        topicsAllowed,
        expiresAt: new Date(exp * 1000).toISOString()
      }
    };
  });

  app.get("/events/stream", { preHandler: tenantScopedPreHandler }, async (request, reply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.write(
      `event: welcome\ndata: ${JSON.stringify({
        eventId: `evt_${Date.now()}`,
        eventVersion: "1.0",
        eventType: "system.welcome",
        tenantId: ctx.tenantId,
        occurredAt: new Date().toISOString(),
        correlationId: request.requestId ?? request.id,
        sequence: 1,
        payload: { message: "SSE stream ready" }
      })}\n\n`
    );
    reply.raw.end();
    return reply;
  });

  app.get("/events", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const q = request.query as Record<string, string | undefined>;
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const effectiveFrom = await resolveEventsFromDate(tenantId, from);

    const rows = await prisma.event.findMany({
      where: {
        tenantId,
        ...(q.cameraId ? { cameraId: q.cameraId } : {}),
        ...(effectiveFrom || to
          ? {
              timestamp: {
                ...(effectiveFrom ? { gte: effectiveFrom } : {}),
                ...(to ? { lte: to } : {})
              }
            }
          : {})
      },
      orderBy: { timestamp: "desc" },
      take: 200
    });

    const data = rows.map((e: any) => ({
      id: e.id,
      tenantId: e.tenantId,
      cameraId: e.cameraId,
      type: e.type,
      severity: e.severity,
      timestamp: toISO(e.timestamp),
      payload: parseJson(e.payload)
    }));

    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/readiness", async (request, reply) => {
    if (readinessForceFail) {
      reply.status(503);
      return {
        ok: false,
        db: "down",
        reason: "forced_failure",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        db: "up",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    } catch {
      reply.status(503);
      return {
        ok: false,
        db: "down",
        reason: "db_unreachable",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    }
  });

  return app;
}
