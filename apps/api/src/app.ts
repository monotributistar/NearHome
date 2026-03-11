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
const RoleInputSchema = z.enum(["tenant_admin", "monitor", "client_user", "operator", "customer"]);
type RoleInput = z.infer<typeof RoleInputSchema>;

type RequestContext = {
  userId: string;
  realUserId?: string;
  tenantId?: string;
  role?: Role;
  isSuperuser?: boolean;
  isImpersonating?: boolean;
  impersonatedRole?: Role;
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

function normalizeRoleInput(role: RoleInput): Role {
  if (role === "operator") return "monitor";
  if (role === "customer") return "client_user";
  return role;
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

type DetectionRuntimeProvider = "yolo" | "mediapipe";
type DetectionTaskType = "person_detection" | "object_detection" | "license_plate_detection" | "face_detection" | "pose_estimation";
type DetectionQuality = "fast" | "balanced" | "accurate";

type CameraDetectionPipeline = {
  pipelineId: string;
  provider: DetectionRuntimeProvider;
  taskType: DetectionTaskType;
  quality: DetectionQuality;
  enabled: boolean;
  schedule?: {
    mode: DetectionMode;
    frameStride: number;
  };
  thresholds?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

type CameraDetectionProfile = {
  cameraId: string;
  tenantId: string;
  pipelines: CameraDetectionPipeline[];
  configVersion: number;
  updatedAt: string;
};

type DesiredNodeCapability = {
  capabilityId: string;
  taskTypes: string[];
  qualities: DetectionQuality[];
  modelRefs: string[];
};

type CameraRecordingPolicy = {
  mode: "continuous" | "event_only" | "hybrid" | "observe_only";
  eventClipPreSeconds: number;
  eventClipPostSeconds: number;
};

type CameraNotificationRule = {
  enabled: boolean;
  minConfidence: number;
  labels: string[];
  cooldownSeconds: number;
  channels: {
    realtime: boolean;
    webhook: boolean;
    email: boolean;
  };
};

type ProfileStatus = "pending" | "ready" | "error";
type CameraLifecycleStatus = "draft" | "provisioning" | "ready" | "degraded" | "offline" | "error" | "retired";
type StreamSessionStatus = "requested" | "issued" | "active" | "ended" | "expired";
type DetectionJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type DetectionMode = "realtime" | "batch";
type DetectionSource = "snapshot" | "clip" | "range";
type DetectionProvider = "onprem_bento" | "huggingface_space" | "external_http";
type StreamHealthSyncStats = {
  enabled: boolean;
  inFlight: boolean;
  tenantCursors: number;
  lastRunAt: string | null;
  lastDurationMs: number;
  lastScanned: number;
  lastSynced: number;
  lastFailed: number;
  totalCycles: number;
  totalScanned: number;
  totalSynced: number;
  totalFailed: number;
  lastError: string | null;
};
type DeploymentProbeResult = {
  name: string;
  url: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  payload: Record<string, unknown> | null;
};

type BridgeNodeCapability = {
  capabilityId: string;
  taskTypes: string[];
  models: string[];
};

type BridgeNodeSnapshot = {
  nodeId: string;
  tenantId: string | null;
  tenantIds: string[];
  runtime: string;
  transport: string;
  endpoint: string;
  status: "online" | "degraded" | "offline";
  resources: Record<string, number>;
  capabilities: BridgeNodeCapability[];
  models: string[];
  maxConcurrent: number;
  queueDepth: number;
  isDrained: boolean;
  lastHeartbeatAt: Date;
  contractVersion: string;
};

const CameraLifecycleStatusSchema = z.enum(["draft", "provisioning", "ready", "degraded", "offline", "error", "retired"]);
const CameraConnectivitySchema = z.enum(["online", "degraded", "offline"]);
const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);
const DetectionJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
const DetectionModeSchema = z.enum(["realtime", "batch"]);
const DetectionSourceSchema = z.enum(["snapshot", "clip", "range"]);
const DetectionProviderSchema = z.enum(["onprem_bento", "huggingface_space", "external_http"]);
const DetectionRuntimeProviderSchema = z.enum(["yolo", "mediapipe"]);
const DetectionTaskTypeSchema = z.enum([
  "person_detection",
  "object_detection",
  "license_plate_detection",
  "face_detection",
  "pose_estimation"
]);
const DetectionQualitySchema = z.enum(["fast", "balanced", "accurate"]);
const DesiredNodeCapabilitySchema = z.object({
  capabilityId: z.string(),
  taskTypes: z.array(z.string()).default([]),
  qualities: z.array(DetectionQualitySchema).default([]),
  modelRefs: z.array(z.string()).default([])
});
const CameraDetectionPipelineSchema = z.object({
  pipelineId: z.string().min(1),
  provider: DetectionRuntimeProviderSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  enabled: z.boolean().default(true),
  schedule: z
    .object({
      mode: DetectionModeSchema.default("realtime"),
      frameStride: z.number().int().positive().default(1)
    })
    .optional(),
  thresholds: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional()
});
const CameraDetectionProfileInputSchema = z.object({
  pipelines: z.array(CameraDetectionPipelineSchema).default([]),
  configVersion: z.number().int().positive().optional()
});
const ModelCatalogEntryInputSchema = z.object({
  provider: DetectionRuntimeProviderSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  modelRef: z.string().min(1),
  displayName: z.string().min(1),
  resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
  defaults: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional(),
  status: z.enum(["active", "disabled"]).default("active")
});

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
    detectionProfile: JSON.stringify(defaultCameraDetectionProfile(tenantId, cameraId)),
    status: "ready" as ProfileStatus,
    lastHealthAt: new Date(),
    lastError: null as string | null
  };
}

function defaultCameraDetectionProfile(tenantId: string, cameraId: string): CameraDetectionProfile {
  return {
    cameraId,
    tenantId,
    pipelines: [],
    configVersion: 1,
    updatedAt: new Date().toISOString()
  };
}

function parseCameraDetectionProfile(raw: string | null, tenantId: string, cameraId: string): CameraDetectionProfile {
  const fallback = defaultCameraDetectionProfile(tenantId, cameraId);
  if (!raw) return fallback;
  try {
    const source = parseJson<Record<string, unknown>>(raw);
    const parsed = CameraDetectionProfileInputSchema.partial().parse(source);
    return {
      cameraId,
      tenantId,
      pipelines: parsed.pipelines ?? fallback.pipelines,
      configVersion: parsed.configVersion ?? fallback.configVersion,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt
    };
  } catch {
    return fallback;
  }
}

function serializeCameraDetectionProfile(profile: CameraDetectionProfile) {
  return JSON.stringify({
    pipelines: profile.pipelines,
    configVersion: profile.configVersion,
    updatedAt: profile.updatedAt
  });
}

function normalizeDesiredNodeCapabilities(
  capabilities: Array<Record<string, unknown>> | DesiredNodeCapability[]
): DesiredNodeCapability[] {
  return capabilities.map((entry, index) => {
    const raw = entry && typeof entry === "object" ? entry : {};
    const parsed = DesiredNodeCapabilitySchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return {
      capabilityId: typeof (raw as Record<string, unknown>).capabilityId === "string" ? String((raw as Record<string, unknown>).capabilityId) : `cap-${index}`,
      taskTypes: [],
      qualities: [],
      modelRefs: []
    };
  });
}

function normalizeDesiredNodeConfig(args: {
  nodeId: string;
  runtime: string;
  transport: string;
  endpoint: string;
  desiredResources: string;
  desiredModels: string;
  desiredCapabilities: string;
  desiredTenantIds: string;
  maxConcurrent: number;
  contractVersion: string;
  configVersion: number;
  lastAppliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    nodeId: args.nodeId,
    runtime: args.runtime,
    transport: args.transport,
    endpoint: args.endpoint,
    resources: parseJson<Record<string, number>>(args.desiredResources),
    capabilities: normalizeDesiredNodeCapabilities(parseJson<Array<Record<string, unknown>>>(args.desiredCapabilities)),
    models: parseJson<string[]>(args.desiredModels),
    tenantIds: parseJson<string[]>(args.desiredTenantIds),
    maxConcurrent: args.maxConcurrent,
    contractVersion: args.contractVersion,
    configVersion: args.configVersion,
    lastAppliedAt: args.lastAppliedAt ? toISO(args.lastAppliedAt) : null,
    createdAt: toISO(args.createdAt),
    updatedAt: toISO(args.updatedAt)
  };
}

function buildNodeConfigDiff(args: {
  desired: ReturnType<typeof normalizeDesiredNodeConfig> | null;
  observed:
    | {
        runtime: string;
        transport: string;
        endpoint: string;
        resources: Record<string, number>;
        capabilities: BridgeNodeCapability[];
        models: string[];
        assignedTenantIds: string[];
        maxConcurrent: number;
      }
    | null;
}) {
  if (!args.desired || !args.observed) {
    return {
      inSync: false,
      items: [
        {
          field: "presence",
          desired: Boolean(args.desired),
          observed: Boolean(args.observed)
        }
      ]
    };
  }

  const items: Array<{ field: string; desired: unknown; observed: unknown }> = [];
  const compare = (field: string, desired: unknown, observed: unknown) => {
    if (JSON.stringify(desired) !== JSON.stringify(observed)) {
      items.push({ field, desired, observed });
    }
  };

  compare("runtime", args.desired.runtime, args.observed.runtime);
  compare("transport", args.desired.transport, args.observed.transport);
  compare("endpoint", args.desired.endpoint, args.observed.endpoint);
  compare("resources", args.desired.resources, args.observed.resources);
  compare("models", args.desired.models, args.observed.models);
  compare("capabilities", args.desired.capabilities, args.observed.capabilities);
  compare("tenantIds", args.desired.tenantIds, args.observed.assignedTenantIds);
  compare("maxConcurrent", args.desired.maxConcurrent, args.observed.maxConcurrent);

  return {
    inSync: items.length === 0,
    items
  };
}

function parseCameraRecordingPolicy(rulesProfileRaw: string | null): CameraRecordingPolicy {
  const fallback: CameraRecordingPolicy = {
    mode: "continuous",
    eventClipPreSeconds: 5,
    eventClipPostSeconds: 10
  };
  if (!rulesProfileRaw) return fallback;
  try {
    const parsed = parseJson<Record<string, unknown>>(rulesProfileRaw);
    const recording = parsed.recording;
    if (!recording || typeof recording !== "object") return fallback;
    const value = recording as Record<string, unknown>;
    const mode = value.mode;
    const preSeconds = typeof value.eventClipPreSeconds === "number" ? Math.floor(value.eventClipPreSeconds) : fallback.eventClipPreSeconds;
    const postSeconds = typeof value.eventClipPostSeconds === "number" ? Math.floor(value.eventClipPostSeconds) : fallback.eventClipPostSeconds;
    return {
      mode:
        mode === "event_only" || mode === "hybrid" || mode === "continuous" || mode === "observe_only"
          ? mode
          : fallback.mode,
      eventClipPreSeconds: Math.max(0, Math.min(120, preSeconds)),
      eventClipPostSeconds: Math.max(1, Math.min(300, postSeconds))
    };
  } catch {
    return fallback;
  }
}

function parseCameraNotificationRule(rulesProfileRaw: string | null): CameraNotificationRule {
  const fallback: CameraNotificationRule = {
    enabled: false,
    minConfidence: 0.6,
    labels: [],
    cooldownSeconds: 30,
    channels: {
      realtime: true,
      webhook: false,
      email: false
    }
  };
  if (!rulesProfileRaw) return fallback;
  try {
    const parsed = parseJson<Record<string, unknown>>(rulesProfileRaw);
    const notification = parsed.notification;
    if (!notification || typeof notification !== "object") return fallback;
    const value = notification as Record<string, unknown>;
    const channelsRaw = value.channels && typeof value.channels === "object" ? (value.channels as Record<string, unknown>) : {};
    const labels = Array.isArray(value.labels) ? value.labels.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
    const minConfidenceRaw = typeof value.minConfidence === "number" ? value.minConfidence : fallback.minConfidence;
    const cooldownRaw = typeof value.cooldownSeconds === "number" ? Math.floor(value.cooldownSeconds) : fallback.cooldownSeconds;
    return {
      enabled: value.enabled === true,
      minConfidence: Math.max(0, Math.min(1, minConfidenceRaw)),
      labels,
      cooldownSeconds: Math.max(0, Math.min(3600, cooldownRaw)),
      channels: {
        realtime: channelsRaw.realtime !== false,
        webhook: channelsRaw.webhook === true,
        email: channelsRaw.email === true
      }
    };
  } catch {
    return fallback;
  }
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
  detectionProfile: string | null;
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
    detectionProfile: parseCameraDetectionProfile(profile.detectionProfile, profile.tenantId, profile.cameraId),
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
    detectionProfile: string | null;
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

function householdResponse(row: {
  id: string;
  tenantId: string;
  name: string;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    address: row.address,
    notes: row.notes,
    isActive: row.isActive,
    createdByUserId: row.createdByUserId,
    createdAt: toISO(row.createdAt),
    updatedAt: toISO(row.updatedAt)
  };
}

function householdMemberResponse(row: {
  id: string;
  tenantId: string;
  householdId: string;
  fullName: string;
  relationship: string;
  phone: string | null;
  canViewCameras: boolean;
  canReceiveAlerts: boolean;
  isActive: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    householdId: row.householdId,
    fullName: row.fullName,
    relationship: row.relationship,
    phone: row.phone,
    canViewCameras: row.canViewCameras,
    canReceiveAlerts: row.canReceiveAlerts,
    isActive: row.isActive,
    createdByUserId: row.createdByUserId,
    createdAt: toISO(row.createdAt),
    updatedAt: toISO(row.updatedAt)
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

function notificationChannelResponse(channel: {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  endpoint: string | null;
  authToken: string | null;
  headersJson: string | null;
  emailTo: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: channel.id,
    tenantId: channel.tenantId,
    name: channel.name,
    type: channel.type,
    endpoint: channel.endpoint,
    headers: channel.headersJson ? parseJson<Record<string, string>>(channel.headersJson) : undefined,
    emailTo: channel.emailTo,
    isActive: channel.isActive,
    hasAuthToken: Boolean(channel.authToken),
    createdAt: toISO(channel.createdAt),
    updatedAt: toISO(channel.updatedAt)
  };
}

function notificationDeliveryResponse(delivery: {
  id: string;
  tenantId: string;
  cameraId: string;
  incidentId: string;
  channelId: string | null;
  channelType: string;
  status: string;
  error: string | null;
  responseCode: number | null;
  requestPayload: string | null;
  responsePayload: string | null;
  createdAt: Date;
}) {
  return {
    id: delivery.id,
    tenantId: delivery.tenantId,
    cameraId: delivery.cameraId,
    incidentId: delivery.incidentId,
    channelId: delivery.channelId,
    channelType: delivery.channelType,
    status: delivery.status,
    error: delivery.error,
    responseCode: delivery.responseCode,
    requestPayload: delivery.requestPayload ? parseJson<Record<string, unknown>>(delivery.requestPayload) : undefined,
    responsePayload: delivery.responsePayload ? parseJson<Record<string, unknown>>(delivery.responsePayload) : undefined,
    createdAt: toISO(delivery.createdAt)
  };
}

function subscriptionRequestResponse(row: {
  id: string;
  tenantId: string;
  planId: string;
  requestedByUserId: string;
  status: string;
  proofImageUrl: string;
  proofFileName: string;
  proofMimeType: string;
  proofSizeBytes: number;
  proofMetadata: string | null;
  notes: string | null;
  reviewedByUserId: string | null;
  reviewNotes: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  plan?: {
    id: string;
    code: string;
    name: string;
  } | null;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    planId: row.planId,
    requestedByUserId: row.requestedByUserId,
    status: row.status,
    proofImageUrl: row.proofImageUrl,
    proofFileName: row.proofFileName,
    proofMimeType: row.proofMimeType,
    proofSizeBytes: row.proofSizeBytes,
    proofMetadata: row.proofMetadata ? parseJson<Record<string, unknown>>(row.proofMetadata) : undefined,
    notes: row.notes,
    reviewedByUserId: row.reviewedByUserId,
    reviewNotes: row.reviewNotes,
    reviewedAt: row.reviewedAt ? toISO(row.reviewedAt) : null,
    createdAt: toISO(row.createdAt),
    updatedAt: toISO(row.updatedAt),
    plan: row.plan
      ? {
          id: row.plan.id,
          code: row.plan.code,
          name: row.plan.name
        }
      : undefined
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
  if (request.ctx?.isSuperuser && !request.ctx?.isImpersonating) return;
  if (!request.ctx?.role || !roles.includes(request.ctx.role)) {
    throw new Error("FORBIDDEN_ROLE");
  }
}

function hasGlobalSuperuserPrivileges(request: FastifyRequest) {
  return Boolean(request.ctx?.isSuperuser && !request.ctx?.isImpersonating);
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

async function getCameraScopeForUser(args: { tenantId: string; userId: string; role?: Role }) {
  if (!args.role || !["monitor", "client_user"].includes(args.role)) return null;
  const assignments = await prisma.cameraAssignment.findMany({
    where: { tenantId: args.tenantId, userId: args.userId },
    select: { cameraId: true }
  });
  if (!assignments.length) return null;
  return assignments.map((assignment) => assignment.cameraId);
}

async function assertCameraAccess(args: { tenantId: string; userId: string; role?: Role; cameraId: string }) {
  const scopedCameraIds = await getCameraScopeForUser({
    tenantId: args.tenantId,
    userId: args.userId,
    role: args.role
  });
  if (!scopedCameraIds) return;
  if (!scopedCameraIds.includes(args.cameraId)) {
    throw new Error("CAMERA_NOT_FOUND");
  }
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
  context?: RequestContext;
}) {
  const actorUserId = args.actorUserId ?? args.context?.realUserId ?? args.context?.userId;
  const authContext = args.context
    ? {
        actorUserId: args.context.realUserId ?? args.context.userId,
        effectiveUserId: args.context.userId,
        effectiveRole: args.context.role ?? null,
        isSuperuser: Boolean(args.context.isSuperuser),
        isImpersonating: Boolean(args.context.isImpersonating),
        impersonatedRole: args.context.impersonatedRole ?? null,
        tenantId: args.context.tenantId ?? null
      }
    : undefined;
  const payload =
    args.payload || authContext
      ? {
          ...(args.payload ?? {}),
          ...(authContext ? { _auth: authContext } : {})
        }
      : undefined;

  await prisma.auditLog.create({
    data: {
      tenantId: args.tenantId,
      actorUserId,
      resource: args.resource,
      action: args.action,
      resourceId: args.resourceId ?? null,
      payload: payload ? JSON.stringify(payload) : null
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
  const inferenceBridgeUrl =
    process.env.INFERENCE_BRIDGE_URL?.replace(/\/$/, "") ?? detectionBridgeUrl ?? "http://inference-bridge:8090";
  const nodeAuthAdminSecret = process.env.NODE_AUTH_ADMIN_SECRET ?? "dev-node-auth-admin-secret";
  const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20);
  const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const readinessForceFail = process.env.READINESS_FORCE_FAIL === "1";
  const superuserEmails = new Set(
    (process.env.SUPERUSER_EMAILS ?? "admin@nearhome.dev")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
  const loginBuckets = new Map<string, LoginBucket>();
  let streamSyncTimer: NodeJS.Timeout | null = null;
  let streamSyncInFlight = false;
  const streamSyncCursorByTenant = new Map<string, string | null>();
  const streamSyncStats: StreamHealthSyncStats = {
    enabled: streamHealthSyncEnabled && !!streamGatewayUrl,
    inFlight: false,
    tenantCursors: 0,
    lastRunAt: null,
    lastDurationMs: 0,
    lastScanned: 0,
    lastSynced: 0,
    lastFailed: 0,
    totalCycles: 0,
    totalScanned: 0,
    totalSynced: 0,
    totalFailed: 0,
    lastError: null
  };

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

  const publishRealtimeEvent = async (args: {
    eventType: string;
    tenantId: string;
    cameraId?: string;
    correlationId?: string;
    payload: Record<string, unknown>;
  }) => {
    if (!eventGatewayUrl) return;
    try {
      await fetch(`${eventGatewayUrl}/internal/events/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-event-publish-secret": eventPublishSecret
        },
        body: JSON.stringify(args)
      });
    } catch (error) {
      app.log.warn({ error, eventType: args.eventType, tenantId: args.tenantId }, "event_gateway.publish_failed");
    }
  };

  const processIncidentNotifications = async (args: {
    jobId: string;
    tenantId: string;
    cameraId: string;
    cameraName: string;
    incidentId: string;
    incidentType: string;
    severity: string;
    summary: string;
    label: string;
    confidence: number;
    rulesProfileRaw: string | null;
  }) => {
    const rule = parseCameraNotificationRule(args.rulesProfileRaw);
    if (!rule.enabled) return;
    if (args.confidence < rule.minConfidence) return;
    if (rule.labels.length > 0 && !rule.labels.includes(args.label)) return;

    if (rule.cooldownSeconds > 0) {
      const threshold = new Date(Date.now() - rule.cooldownSeconds * 1000);
      const recent = await prisma.notificationDelivery.count({
        where: {
          tenantId: args.tenantId,
          cameraId: args.cameraId,
          incident: { type: args.incidentType },
          createdAt: { gte: threshold },
          status: { in: ["sent", "queued"] }
        }
      });
      if (recent > 0) return;
    }

    const payload = {
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      cameraName: args.cameraName,
      incidentId: args.incidentId,
      incidentType: args.incidentType,
      severity: args.severity,
      summary: args.summary,
      label: args.label,
      confidence: args.confidence,
      occurredAt: new Date().toISOString()
    };

    if (rule.channels.realtime) {
      await publishRealtimeEvent({
        eventType: "notification.sent",
        tenantId: args.tenantId,
        cameraId: args.cameraId,
        correlationId: `det-${args.jobId}`,
        payload: { channel: "realtime", ...payload }
      });
      await prisma.notificationDelivery.create({
        data: {
          tenantId: args.tenantId,
          cameraId: args.cameraId,
          incidentId: args.incidentId,
          channelType: "realtime",
          status: "sent",
          requestPayload: JSON.stringify(payload)
        }
      });
    }

    if (rule.channels.webhook) {
      const channels = await prisma.notificationChannel.findMany({
        where: {
          tenantId: args.tenantId,
          isActive: true,
          type: "webhook"
        }
      });
      for (const channel of channels) {
        if (!channel.endpoint) continue;
        const headers: Record<string, string> = {
          "content-type": "application/json"
        };
        if (channel.authToken) headers.authorization = `Bearer ${channel.authToken}`;
        if (channel.headersJson) {
          const extra = parseJson<Record<string, string>>(channel.headersJson);
          for (const [key, value] of Object.entries(extra)) headers[key] = String(value);
        }

        let status = "sent";
        let responseCode: number | null = null;
        let responsePayload: string | null = null;
        let error: string | null = null;
        try {
          const response = await fetch(channel.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          });
          responseCode = response.status;
          responsePayload = await response.text();
          if (!response.ok) {
            status = "failed";
            error = `webhook_http_${response.status}`;
          }
        } catch (cause) {
          status = "failed";
          error = cause instanceof Error ? cause.message : "webhook_send_failed";
        }

        await prisma.notificationDelivery.create({
          data: {
            tenantId: args.tenantId,
            cameraId: args.cameraId,
            incidentId: args.incidentId,
            channelId: channel.id,
            channelType: "webhook",
            status,
            error,
            responseCode,
            requestPayload: JSON.stringify(payload),
            responsePayload: responsePayload ? JSON.stringify({ body: responsePayload.slice(0, 2000) }) : null
          }
        });
      }
    }

    if (rule.channels.email) {
      const channels = await prisma.notificationChannel.findMany({
        where: {
          tenantId: args.tenantId,
          isActive: true,
          type: "email"
        }
      });
      for (const channel of channels) {
        await prisma.notificationDelivery.create({
          data: {
            tenantId: args.tenantId,
            cameraId: args.cameraId,
            incidentId: args.incidentId,
            channelId: channel.id,
            channelType: "email",
            status: "queued",
            requestPayload: JSON.stringify({
              ...payload,
              emailTo: channel.emailTo
            })
          }
        });
      }
      await publishRealtimeEvent({
        eventType: "notification.email_queued",
        tenantId: args.tenantId,
        cameraId: args.cameraId,
        correlationId: `det-${args.jobId}`,
        payload
      });
    }
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
      label: string;
      confidence: number;
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
          tenantId: incidentEvent.tenantId,
          label,
          confidence
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
        await publishRealtimeEvent({
          eventType: "detection.job",
          tenantId: updated.tenantId,
          cameraId: updated.cameraId,
          correlationId: `det-${updated.id}`,
          payload: {
            jobId: updated.id,
            status: updated.status
          }
        });
        for (const incident of incidentsCreated) {
          await publishRealtimeEvent({
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
          });
          await processIncidentNotifications({
            jobId: updated.id,
            tenantId: incident.tenantId,
            cameraId: incident.cameraId,
            cameraName: job.camera.name,
            incidentId: incident.id,
            incidentType: incident.type,
            severity: incident.severity,
            summary: incident.summary,
            label: incident.label,
            confidence: incident.confidence,
            rulesProfileRaw: job.camera.profile?.rulesProfile ?? null
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
    // Reflect request origin to avoid missing ACAO on browser preflight in on-prem setups.
    origin: true,
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
        streamSyncStats.inFlight = true;
        streamSyncStats.lastError = null;
        const cycleStartedAt = Date.now();
        let scannedInCycle = 0;
        let syncedInCycle = 0;
        let failedInCycle = 0;
        try {
          const activeTenants = await prisma.camera.findMany({
            where: { deletedAt: null, isActive: true },
            select: { tenantId: true },
            distinct: ["tenantId"],
            orderBy: { tenantId: "asc" }
          });

          for (const tenant of activeTenants) {
            const tenantId = tenant.tenantId;
            const tenantCursor = streamSyncCursorByTenant.get(tenantId) ?? null;

            // Rotate through active cameras per tenant to avoid starvation.
            let cameras = await prisma.camera.findMany({
              where: {
                deletedAt: null,
                isActive: true,
                tenantId,
                ...(tenantCursor ? { id: { gt: tenantCursor } } : {})
              },
              select: { id: true, tenantId: true },
              orderBy: { id: "asc" },
              take: streamHealthSyncBatchSize
            });

            if (cameras.length === 0) {
              streamSyncCursorByTenant.set(tenantId, null);
              cameras = await prisma.camera.findMany({
                where: { deletedAt: null, isActive: true, tenantId },
                select: { id: true, tenantId: true },
                orderBy: { id: "asc" },
                take: streamHealthSyncBatchSize
              });
            }

            if (cameras.length > 0) {
              streamSyncCursorByTenant.set(tenantId, cameras[cameras.length - 1].id);
            }

            for (const camera of cameras) {
              scannedInCycle += 1;
              try {
                await syncCameraHealthFromGateway({
                  tenantId: camera.tenantId,
                  cameraId: camera.id,
                  streamGatewayUrl
                });
                syncedInCycle += 1;
              } catch (error) {
                failedInCycle += 1;
                app.log.warn(
                  { error, tenantId: camera.tenantId, cameraId: camera.id },
                  "stream_health_sync.camera_failed"
                );
              }
            }
          }

          const activeTenantSet = new Set(activeTenants.map((tenant) => tenant.tenantId));
          for (const tenantId of streamSyncCursorByTenant.keys()) {
            if (!activeTenantSet.has(tenantId)) {
              streamSyncCursorByTenant.delete(tenantId);
            }
          }
        } finally {
          streamSyncStats.lastRunAt = new Date().toISOString();
          streamSyncStats.lastDurationMs = Date.now() - cycleStartedAt;
          streamSyncStats.lastScanned = scannedInCycle;
          streamSyncStats.lastSynced = syncedInCycle;
          streamSyncStats.lastFailed = failedInCycle;
          streamSyncStats.totalCycles += 1;
          streamSyncStats.totalScanned += scannedInCycle;
          streamSyncStats.totalSynced += syncedInCycle;
          streamSyncStats.totalFailed += failedInCycle;
          streamSyncStats.tenantCursors = streamSyncCursorByTenant.size;
          streamSyncStats.inFlight = false;
          streamSyncInFlight = false;
        }
      };

      streamSyncTimer = setInterval(() => {
        runStreamHealthSync().catch((error) => {
          streamSyncStats.lastError = error instanceof Error ? error.message : String(error);
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

    if (impersonatedRole && !isSuperuser) {
      throw app.httpErrors.forbidden("Impersonation requires superuser");
    }
    if (impersonatedRole && !tenantHeader) {
      throw app.httpErrors.badRequest("Impersonation requires X-Tenant-Id");
    }

    if (tenantHeader) {
      if (isSuperuser) {
        const tenant = await prisma.tenant.findFirst({ where: { id: tenantHeader, deletedAt: null }, select: { id: true } });
        if (!tenant) {
          throw app.httpErrors.forbidden("Invalid tenant context");
        }
        request.ctx.tenantId = tenantHeader;
        request.ctx.role = impersonatedRole ?? "tenant_admin";
        request.ctx.isImpersonating = Boolean(impersonatedRole);
        request.ctx.impersonatedRole = impersonatedRole;
      } else {
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

  const probeService = async (name: string, targetUrl: string): Promise<DeploymentProbeResult> => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(targetUrl, { signal: controller.signal });
      const latencyMs = Date.now() - startedAt;
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = await response.json();
        payload = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
      } catch {
        payload = null;
      }
      return {
        name,
        url: targetUrl,
        ok: response.ok,
        statusCode: response.status,
        latencyMs,
        error: response.ok ? null : `http_${response.status}`,
        payload
      };
    } catch (error) {
      return {
        name,
        url: targetUrl,
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        payload: null
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const normalizeBridgeNode = (nodeRaw: Record<string, unknown>): BridgeNodeSnapshot | null => {
    const nodeId = typeof nodeRaw.nodeId === "string" ? nodeRaw.nodeId : null;
    if (!nodeId) return null;
    const tenantId = typeof nodeRaw.tenantId === "string" && nodeRaw.tenantId.length > 0 ? nodeRaw.tenantId : null;
    const tenantIds = Array.isArray(nodeRaw.tenantIds)
      ? nodeRaw.tenantIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const runtime = typeof nodeRaw.runtime === "string" ? nodeRaw.runtime : "unknown";
    const transport = typeof nodeRaw.transport === "string" ? nodeRaw.transport : "http";
    const endpoint = typeof nodeRaw.endpoint === "string" ? nodeRaw.endpoint : "";
    const statusValue = typeof nodeRaw.status === "string" ? nodeRaw.status : "offline";
    const status: "online" | "degraded" | "offline" =
      statusValue === "online" || statusValue === "degraded" ? statusValue : "offline";
    const resourcesRaw =
      nodeRaw.resources && typeof nodeRaw.resources === "object"
        ? (nodeRaw.resources as Record<string, unknown>)
        : { cpu: 0, gpu: 0, vramMb: 0 };
    const resources = Object.fromEntries(
      Object.entries(resourcesRaw).map(([key, value]) => [key, Number.isFinite(Number(value)) ? Number(value) : 0])
    );
    const capabilitiesRaw = Array.isArray(nodeRaw.capabilities) ? nodeRaw.capabilities : [];
    const capabilities: BridgeNodeCapability[] = capabilitiesRaw.map((item, index) => {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        capabilityId:
          typeof entry.capabilityId === "string" && entry.capabilityId.length > 0 ? entry.capabilityId : `cap-${index}`,
        taskTypes: Array.isArray(entry.taskTypes) ? entry.taskTypes.filter((x): x is string => typeof x === "string") : [],
        models: Array.isArray(entry.models) ? entry.models.filter((x): x is string => typeof x === "string") : []
      };
    });
    const models = Array.isArray(nodeRaw.models) ? nodeRaw.models.filter((x): x is string => typeof x === "string") : [];
    const maxConcurrent = Number.isFinite(Number(nodeRaw.maxConcurrent)) ? Math.max(1, Number(nodeRaw.maxConcurrent)) : 1;
    const queueDepth = Number.isFinite(Number(nodeRaw.queueDepth)) ? Math.max(0, Number(nodeRaw.queueDepth)) : 0;
    const isDrained = nodeRaw.isDrained === true;
    const parsedHeartbeat =
      typeof nodeRaw.lastHeartbeatAt === "string" ? Date.parse(nodeRaw.lastHeartbeatAt) : Date.now();
    const lastHeartbeatAt = Number.isFinite(parsedHeartbeat) ? new Date(parsedHeartbeat) : new Date();
    const contractVersion = typeof nodeRaw.contractVersion === "string" ? nodeRaw.contractVersion : "1.0";
    return {
      nodeId,
      tenantId,
      tenantIds,
      runtime,
      transport,
      endpoint,
      status,
      resources,
      capabilities,
      models,
      maxConcurrent,
      queueDepth,
      isDrained,
      lastHeartbeatAt,
      contractVersion
    };
  };

  const snapshotResponse = (row: {
    nodeId: string;
    tenantId: string | null;
    runtime: string;
    transport: string;
    endpoint: string;
    status: string;
    resources: string;
    capabilities: string;
    models: string;
    maxConcurrent: number;
    queueDepth: number;
    isDrained: boolean;
    lastHeartbeatAt: Date;
    contractVersion: string;
    createdAt: Date;
    updatedAt: Date;
    assignments?: Array<{ tenantId: string }>;
  }) => ({
    nodeId: row.nodeId,
    tenantId: row.tenantId,
    runtime: row.runtime,
    transport: row.transport,
    endpoint: row.endpoint,
    status: row.status,
    resources: parseJson<Record<string, number>>(row.resources),
    capabilities: parseJson<BridgeNodeCapability[]>(row.capabilities),
    models: parseJson<string[]>(row.models),
    maxConcurrent: row.maxConcurrent,
    queueDepth: row.queueDepth,
    isDrained: row.isDrained,
    assignedTenantIds: Array.from(new Set((row.assignments ?? []).map((assignment) => assignment.tenantId))),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });

  const modelCatalogEntryResponse = (row: {
    id: string;
    provider: string;
    taskType: string;
    quality: string;
    modelRef: string;
    displayName: string;
    resources: string;
    defaults: string | null;
    outputs: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: row.id,
    provider: row.provider,
    taskType: row.taskType,
    quality: row.quality,
    modelRef: row.modelRef,
    displayName: row.displayName,
    resources: parseJson<Record<string, number>>(row.resources),
    defaults: row.defaults ? parseJson<Record<string, unknown>>(row.defaults) : undefined,
    outputs: row.outputs ? parseJson<Record<string, unknown>>(row.outputs) : undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });

  const nodeObservedConfigResponse = (row: {
    runtime: string;
    transport: string;
    endpoint: string;
    resources: string;
    capabilities: string;
    models: string;
    maxConcurrent: number;
    assignments?: Array<{ tenantId: string }>;
    status: string;
    queueDepth: number;
    isDrained: boolean;
    lastHeartbeatAt: Date;
    updatedAt: Date;
  }) => ({
    runtime: row.runtime,
    transport: row.transport,
    endpoint: row.endpoint,
    resources: parseJson<Record<string, number>>(row.resources),
    capabilities: parseJson<BridgeNodeCapability[]>(row.capabilities),
    models: parseJson<string[]>(row.models),
    assignedTenantIds: Array.from(new Set((row.assignments ?? []).map((assignment) => assignment.tenantId))),
    maxConcurrent: row.maxConcurrent,
    status: row.status,
    queueDepth: row.queueDepth,
    isDrained: row.isDrained,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });

  const syncInferenceNodeSnapshots = async (nodesRaw: Array<Record<string, unknown>>) => {
    const normalized = nodesRaw.map(normalizeBridgeNode).filter((item): item is BridgeNodeSnapshot => Boolean(item));
    if (!normalized.length) return;
    const tenantIds = Array.from(new Set(normalized.flatMap((node) => [node.tenantId, ...node.tenantIds]).filter((tenantId): tenantId is string => Boolean(tenantId))));
    const existingTenants = tenantIds.length
      ? await prisma.tenant.findMany({
          where: { id: { in: tenantIds }, deletedAt: null },
          select: { id: true }
        })
      : [];
    const validTenantIds = new Set(existingTenants.map((tenant) => tenant.id));

    for (const node of normalized) {
      const bridgeTenantIds = Array.from(
        new Set(
          [node.tenantId, ...node.tenantIds].filter((tenantId): tenantId is string => Boolean(tenantId && validTenantIds.has(tenantId)))
        )
      );
      const existing = await prisma.inferenceNodeSnapshot.findUnique({
        where: { nodeId: node.nodeId },
        include: { assignments: { select: { tenantId: true } } }
      });
      const existingTenantIds = existing ? existing.assignments.map((assignment) => assignment.tenantId) : [];
      const effectiveTenantIds = bridgeTenantIds.length > 0 ? bridgeTenantIds : existingTenantIds;
      const tenantId = effectiveTenantIds.length === 1 ? effectiveTenantIds[0] : null;
      await prisma.inferenceNodeSnapshot.upsert({
        where: { nodeId: node.nodeId },
        update: {
          tenantId,
          runtime: node.runtime,
          transport: node.transport,
          endpoint: node.endpoint,
          status: node.status,
          resources: JSON.stringify(node.resources),
          capabilities: JSON.stringify(node.capabilities),
          models: JSON.stringify(node.models),
          maxConcurrent: node.maxConcurrent,
          queueDepth: node.queueDepth,
          isDrained: node.isDrained,
          lastHeartbeatAt: node.lastHeartbeatAt,
          contractVersion: node.contractVersion
        },
        create: {
          nodeId: node.nodeId,
          tenantId,
          runtime: node.runtime,
          transport: node.transport,
          endpoint: node.endpoint,
          status: node.status,
          resources: JSON.stringify(node.resources),
          capabilities: JSON.stringify(node.capabilities),
          models: JSON.stringify(node.models),
          maxConcurrent: node.maxConcurrent,
          queueDepth: node.queueDepth,
          isDrained: node.isDrained,
          lastHeartbeatAt: node.lastHeartbeatAt,
          contractVersion: node.contractVersion
        }
      });
      if (bridgeTenantIds.length > 0) {
        await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId: node.nodeId } });
        await prisma.inferenceNodeTenantAssignment.createMany({
          data: bridgeTenantIds.map((resolvedTenantId) => ({ nodeId: node.nodeId, tenantId: resolvedTenantId }))
        });
      }
    }
  };

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
      const isSuperuser = superuserEmails.has(user.email.toLowerCase());
      if (!isSuperuser) {
        const elevatedRole = await prisma.membership.findFirst({
          where: {
            userId: user.id,
            role: { in: ["tenant_admin", "monitor"] },
            tenant: { deletedAt: null }
          },
          select: { id: true }
        });
        if (!elevatedRole) {
          throw new ApiDomainError({
            statusCode: 403,
            apiCode: "BACKOFFICE_ACCESS_DENIED",
            message: "Backoffice access requires admin or operator role"
          });
        }
      }
    }

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
    const effectiveRole = request.ctx?.role ?? null;
    let memberships: Array<{
      id: string;
      tenantId: string;
      userId: string;
      role: string;
      createdAt: Date;
      tenant: { id: string; name: string; createdAt: Date };
    }> = [];

    if (request.ctx?.isSuperuser) {
      const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" }
      });
      memberships = tenants.map((tenant) => ({
        id: `super-${tenant.id}`,
        tenantId: tenant.id,
        userId: user.id,
        role: request.ctx?.impersonatedRole ?? "tenant_admin",
        createdAt: tenant.createdAt,
        tenant: { id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }
      }));
    } else {
      memberships = await prisma.membership.findMany({
        where: {
          userId: user.id,
          tenant: { deletedAt: null }
        },
        include: { tenant: true },
        orderBy: { createdAt: "asc" }
      });
    }

    const activeTenantId = (request.headers["x-tenant-id"] as string | undefined) ?? memberships[0]?.tenantId;
    const activeTenant = memberships.find((m: any) => m.tenantId === activeTenantId)?.tenant;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive,
        isSuperuser: Boolean(request.ctx?.isSuperuser)
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
      entitlements: activeTenant ? await computeEntitlements(activeTenant.id) : undefined,
      context: {
        actorUserId: request.ctx?.realUserId ?? request.ctx?.userId ?? user.id,
        effectiveUserId: request.ctx?.userId ?? user.id,
        effectiveRole,
        tenantId: request.ctx?.tenantId ?? null,
        isImpersonating: Boolean(request.ctx?.isImpersonating),
        impersonatedRole: request.ctx?.impersonatedRole ?? null
      }
    };
  });

  app.get("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    let data: Array<{ id: string; name: string; createdAt: string }> = [];
    if (hasGlobalSuperuserPrivileges(request)) {
      const tenants = await prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
      data = tenants.map((tenant) => ({ id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) }));
    } else if (request.ctx?.isSuperuser && request.ctx?.tenantId) {
      const tenant = await prisma.tenant.findFirst({ where: { id: request.ctx.tenantId, deletedAt: null } });
      data = tenant ? [{ id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) }] : [];
    } else {
      const memberships = await prisma.membership.findMany({
        where: {
          userId: request.ctx!.userId,
          tenant: { deletedAt: null }
        },
        include: { tenant: true }
      });
      data = memberships.map((m: any) => ({
        id: m.tenant.id,
        name: m.tenant.name,
        createdAt: toISO(m.tenant.createdAt)
      }));
    }
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
    if (request.ctx?.isSuperuser && request.ctx?.isImpersonating) {
      if (request.ctx.tenantId !== id) throw app.httpErrors.forbidden("Impersonated context can only access active tenant");
    } else if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({
        where: {
          tenantId: id,
          userId: request.ctx!.userId,
          tenant: { deletedAt: null }
        }
      });
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
      const membership = await prisma.membership.findFirst({
        where: {
          tenantId: id,
          userId: request.ctx!.userId,
          tenant: { deletedAt: null }
        }
      });
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
      const membership = await prisma.membership.findFirst({
        where: {
          tenantId: id,
          userId: request.ctx!.userId,
          role: "tenant_admin",
          tenant: { deletedAt: null }
        }
      });
      if (!membership) throw app.httpErrors.forbidden();
    }

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
      payload: { name: tenant.name },
      context: request.ctx
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
      .object({ email: z.string().email(), name: z.string(), password: z.string().min(4), role: RoleInputSchema })
      .parse(request.body);
    const normalizedRole = normalizeRoleInput(body.role);

    const hash = await bcrypt.hash(body.password, 10);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    const user = existing
      ? existing
      : await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: hash, isActive: true } });

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: user.id } },
      update: { role: normalizedRole },
      create: { tenantId: ctx.tenantId, userId: user.id, role: normalizedRole }
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
        role: RoleInputSchema.optional()
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
        data: { role: normalizeRoleInput(body.role) }
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

  app.get("/memberships", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const queryTenantId = typeof query.tenantId === "string" ? query.tenantId : undefined;
    const queryUserId = typeof query.userId === "string" ? query.userId : undefined;

    const where =
      hasGlobalSuperuserPrivileges(request) && !request.ctx?.tenantId
        ? {
            ...(queryTenantId ? { tenantId: queryTenantId } : {}),
            ...(queryUserId ? { userId: queryUserId } : {}),
            tenant: { deletedAt: null }
          }
        : { tenantId: getTenantContext(request).tenantId };

    assertRole(request, ["tenant_admin", "monitor"]);
    const rows = await prisma.membership.findMany({
      where,
      include: { user: true, tenant: true },
      orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }]
    });
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
      },
      tenant: {
        id: m.tenant.id,
        name: m.tenant.name,
        createdAt: toISO(m.tenant.createdAt)
      }
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/memberships", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z.object({ userId: z.string(), role: RoleInputSchema, tenantId: z.string().optional() }).parse(request.body);
    const normalizedRole = normalizeRoleInput(body.role);

    const tenantId = (() => {
      if (request.ctx?.isSuperuser) {
        return body.tenantId ?? request.ctx.tenantId;
      }
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin"]);
      return ctx.tenantId;
    })();
    if (!tenantId) {
      throw app.httpErrors.badRequest("tenantId required");
    }
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true } });
    if (!tenant) {
      throw app.httpErrors.notFound("Tenant not found");
    }

    const membership = await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId, userId: body.userId } },
      update: { role: normalizedRole },
      create: { tenantId, userId: body.userId, role: normalizedRole }
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

  app.get("/households", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const name = typeof query.name === "string" && query.name.length > 0 ? query.name : undefined;
    const where = {
      tenantId: ctx.tenantId,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.household.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.household.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(householdResponse), total };
  });

  app.post("/households", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const body = z
      .object({
        name: z.string().min(2),
        address: z.string().max(250).optional().nullable(),
        notes: z.string().max(4000).optional().nullable(),
        isActive: z.boolean().optional().default(true)
      })
      .parse(request.body);
    const row = await prisma.household.create({
      data: {
        tenantId: ctx.tenantId,
        name: body.name,
        address: body.address ?? null,
        notes: body.notes ?? null,
        isActive: body.isActive,
        createdByUserId: ctx.userId
      }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household",
      action: "create",
      resourceId: row.id,
      payload: { name: row.name, isActive: row.isActive },
      context: request.ctx
    });
    return { data: householdResponse(row) };
  });

  app.put("/households/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        name: z.string().min(2).optional(),
        address: z.string().max(250).optional().nullable(),
        notes: z.string().max(4000).optional().nullable(),
        isActive: z.boolean().optional()
      })
      .refine((value) => value.name !== undefined || value.address !== undefined || value.notes !== undefined || value.isActive !== undefined, {
        message: "At least one field must be provided"
      })
      .parse(request.body);
    const existing = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household not found");
    const row = await prisma.household.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.address !== undefined ? { address: body.address ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household",
      action: "update",
      resourceId: row.id,
      payload: { name: row.name, isActive: row.isActive },
      context: request.ctx
    });
    return { data: householdResponse(row) };
  });

  app.delete("/households/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const existing = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household not found");
    await prisma.householdMember.deleteMany({ where: { tenantId: ctx.tenantId, householdId: id } });
    await prisma.household.delete({ where: { id } });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household",
      action: "delete",
      resourceId: id,
      payload: { name: existing.name },
      context: request.ctx
    });
    return { data: householdResponse(existing) };
  });

  app.get("/households/:id/members", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const household = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!household) throw app.httpErrors.notFound("Household not found");
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const [rows, total] = await Promise.all([
      prisma.householdMember.findMany({
        where: { tenantId: ctx.tenantId, householdId: id },
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.householdMember.count({ where: { tenantId: ctx.tenantId, householdId: id } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(householdMemberResponse), total };
  });

  app.post("/households/:id/members", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const household = await prisma.household.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!household) throw app.httpErrors.notFound("Household not found");
    const body = z
      .object({
        fullName: z.string().min(2),
        relationship: z.string().min(2),
        phone: z.string().max(80).optional().nullable(),
        canViewCameras: z.boolean().optional().default(true),
        canReceiveAlerts: z.boolean().optional().default(true),
        isActive: z.boolean().optional().default(true)
      })
      .parse(request.body);
    const row = await prisma.householdMember.create({
      data: {
        tenantId: ctx.tenantId,
        householdId: id,
        fullName: body.fullName,
        relationship: body.relationship,
        phone: body.phone ?? null,
        canViewCameras: body.canViewCameras,
        canReceiveAlerts: body.canReceiveAlerts,
        isActive: body.isActive,
        createdByUserId: ctx.userId
      }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household_member",
      action: "create",
      resourceId: row.id,
      payload: { householdId: id, fullName: row.fullName, relationship: row.relationship },
      context: request.ctx
    });
    return { data: householdMemberResponse(row) };
  });

  app.put("/household-members/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        fullName: z.string().min(2).optional(),
        relationship: z.string().min(2).optional(),
        phone: z.string().max(80).optional().nullable(),
        canViewCameras: z.boolean().optional(),
        canReceiveAlerts: z.boolean().optional(),
        isActive: z.boolean().optional()
      })
      .refine(
        (value) =>
          value.fullName !== undefined ||
          value.relationship !== undefined ||
          value.phone !== undefined ||
          value.canViewCameras !== undefined ||
          value.canReceiveAlerts !== undefined ||
          value.isActive !== undefined,
        { message: "At least one field must be provided" }
      )
      .parse(request.body);
    const existing = await prisma.householdMember.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household member not found");
    const row = await prisma.householdMember.update({
      where: { id },
      data: {
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.relationship !== undefined ? { relationship: body.relationship } : {}),
        ...(body.phone !== undefined ? { phone: body.phone ?? null } : {}),
        ...(body.canViewCameras !== undefined ? { canViewCameras: body.canViewCameras } : {}),
        ...(body.canReceiveAlerts !== undefined ? { canReceiveAlerts: body.canReceiveAlerts } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household_member",
      action: "update",
      resourceId: row.id,
      payload: { householdId: row.householdId, fullName: row.fullName, relationship: row.relationship, isActive: row.isActive },
      context: request.ctx
    });
    return { data: householdMemberResponse(row) };
  });

  app.delete("/household-members/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const id = (request.params as { id: string }).id;
    const existing = await prisma.householdMember.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound("Household member not found");
    await prisma.householdMember.delete({ where: { id } });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "household_member",
      action: "delete",
      resourceId: id,
      payload: { householdId: existing.householdId, fullName: existing.fullName },
      context: request.ctx
    });
    return { data: householdMemberResponse(existing) };
  });

  app.get("/camera-assignments", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const query = request.query as Record<string, unknown>;
    const userId = typeof query.userId === "string" && query.userId.length > 0 ? query.userId : undefined;
    const rows = await prisma.cameraAssignment.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(userId ? { userId } : {})
      },
      include: { camera: true, user: true },
      orderBy: [{ userId: "asc" }, { createdAt: "asc" }]
    });
    const data = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      cameraId: row.cameraId,
      createdAt: toISO(row.createdAt),
      user: {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name
      },
      camera: {
        id: row.camera.id,
        name: row.camera.name,
        isActive: row.camera.isActive
      }
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.put("/camera-assignments/:userId", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { userId } = request.params as { userId: string };
    const body = z.object({ cameraIds: z.array(z.string()) }).parse(request.body ?? {});

    const membership = await prisma.membership.findFirst({
      where: { tenantId: ctx.tenantId, userId },
      select: { role: true }
    });
    if (!membership) {
      throw app.httpErrors.notFound("User not found in tenant");
    }
    if (!["monitor", "client_user"].includes(membership.role)) {
      throw app.httpErrors.badRequest("Camera assignment is only supported for monitor/client_user roles");
    }

    const dedupCameraIds = Array.from(new Set(body.cameraIds));
    if (dedupCameraIds.length > 0) {
      const existingCameras = await prisma.camera.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: dedupCameraIds } },
        select: { id: true }
      });
      const existingSet = new Set(existingCameras.map((camera) => camera.id));
      const missing = dedupCameraIds.filter((cameraId) => !existingSet.has(cameraId));
      if (missing.length > 0) {
        throw app.httpErrors.badRequest(`Unknown camera ids: ${missing.join(", ")}`);
      }
    }

    await prisma.cameraAssignment.deleteMany({
      where: {
        tenantId: ctx.tenantId,
        userId
      }
    });
    if (dedupCameraIds.length > 0) {
      await prisma.cameraAssignment.createMany({
        data: dedupCameraIds.map((cameraId) => ({
          tenantId: ctx.tenantId,
          userId,
          cameraId
        }))
      });
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera_assignment",
      action: "replace",
      resourceId: userId,
      payload: { cameraIds: dedupCameraIds },
      context: request.ctx
    });

    return {
      data: {
        tenantId: ctx.tenantId,
        userId,
        cameraIds: dedupCameraIds
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

  app.get("/notification-channels", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const { skip, take } = parseListQuery(request.query as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.notificationChannel.findMany({
        where: { tenantId: ctx.tenantId },
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.notificationChannel.count({ where: { tenantId: ctx.tenantId } })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(notificationChannelResponse), total };
  });

  app.post("/notification-channels", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z
      .object({
        name: z.string().min(2),
        type: z.enum(["webhook", "email"]),
        endpoint: z.string().url().optional(),
        authToken: z.string().optional(),
        headers: z.record(z.string()).optional(),
        emailTo: z.string().email().optional(),
        isActive: z.boolean().optional()
      })
      .parse(request.body);
    if (body.type === "webhook" && !body.endpoint) throw app.httpErrors.badRequest("endpoint is required for webhook channel");
    if (body.type === "email" && !body.emailTo) throw app.httpErrors.badRequest("emailTo is required for email channel");

    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: ctx.tenantId,
        name: body.name,
        type: body.type,
        endpoint: body.endpoint ?? null,
        authToken: body.authToken ?? null,
        headersJson: body.headers ? JSON.stringify(body.headers) : null,
        emailTo: body.emailTo ?? null,
        isActive: body.isActive ?? true
      }
    });
    return { data: notificationChannelResponse(created) };
  });

  app.put("/notification-channels/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(2).optional(),
        endpoint: z.string().url().nullable().optional(),
        authToken: z.string().nullable().optional(),
        headers: z.record(z.string()).nullable().optional(),
        emailTo: z.string().email().nullable().optional(),
        isActive: z.boolean().optional()
      })
      .parse(request.body ?? {});

    const existing = await prisma.notificationChannel.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound();

    const updated = await prisma.notificationChannel.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.endpoint !== undefined ? { endpoint: body.endpoint } : {}),
        ...(body.authToken !== undefined ? { authToken: body.authToken } : {}),
        ...(body.headers !== undefined ? { headersJson: body.headers ? JSON.stringify(body.headers) : null } : {}),
        ...(body.emailTo !== undefined ? { emailTo: body.emailTo } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });
    return { data: notificationChannelResponse(updated) };
  });

  app.delete("/notification-channels/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const { id } = request.params as { id: string };
    const existing = await prisma.notificationChannel.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw app.httpErrors.notFound();
    await prisma.notificationChannel.delete({ where: { id } });
    return { data: { id } };
  });

  app.get("/notifications/deliveries", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const q = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(q);
    const cameraId = typeof q.cameraId === "string" && q.cameraId.length > 0 ? q.cameraId : undefined;
    const where = {
      tenantId: ctx.tenantId,
      ...(cameraId ? { cameraId } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.notificationDelivery.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.notificationDelivery.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(notificationDeliveryResponse), total };
  });

  app.get("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const { skip, take, sort, order } = parseListQuery(request.query as Record<string, unknown>);
    const q = request.query as Record<string, unknown>;
    const scopedCameraIds = await getCameraScopeForUser(ctx);

    const where: any = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      ...(q.name ? { name: { contains: String(q.name), mode: "insensitive" } } : {}),
      ...(q.isActive !== undefined ? { isActive: String(q.isActive) === "true" } : {}),
      ...(scopedCameraIds ? { id: { in: scopedCameraIds } } : {})
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
    assertRole(request, ["tenant_admin", "client_user"]);
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
      },
      context: request.ctx
    });

    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.get("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
    if (!camera) throw app.httpErrors.notFound();
    return { data: cameraResponse(camera) };
  });

  app.put("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
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
      },
      context: request.ctx
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
      },
      context: request.ctx
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
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
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
    const entitlements = await getEntitlementsForTenant(ctx.tenantId);
    const recordingPolicy = parseCameraRecordingPolicy(camera.profile?.rulesProfile ?? null);

    let playbackUrl: string | undefined;
    if (streamGatewayUrl) {
      try {
        const provisionResponse = await fetch(`${streamGatewayUrl}/provision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantId: ctx.tenantId,
            cameraId: id,
            rtspUrl: camera.rtspUrl,
            ...(entitlements ? { planCode: entitlements.planCode, retentionDays: entitlements.limits.retentionDays } : {}),
            recordingMode: recordingPolicy.mode,
            eventClipPreSeconds: recordingPolicy.eventClipPreSeconds,
            eventClipPostSeconds: recordingPolicy.eventClipPostSeconds
          })
        });
        if (!provisionResponse.ok) {
          const errorBody = await provisionResponse.text();
          throw new Error(
            `stream_gateway.provision_failed status=${provisionResponse.status} body=${errorBody.slice(0, 500)}`
          );
        }
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

  app.get("/cameras/:id/event-clips", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    if (!streamGatewayUrl) {
      throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    }
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();
    const fromDb = await prisma.event.findMany({
      where: {
        tenantId: ctx.tenantId,
        cameraId: id,
        type: "camera.event_clip"
      },
      orderBy: { timestamp: "desc" },
      take: 500
    });
    type EventClipRecord = Record<string, unknown> & { eventId: string };
    const dbClips: EventClipRecord[] = [];
    for (const entry of fromDb) {
      try {
        const payload = parseJson<Record<string, unknown>>(entry.payload);
        const eventId = typeof payload.eventId === "string" ? payload.eventId : entry.id;
        dbClips.push({
          ...payload,
          eventId,
          persistedEventId: entry.id,
          persistedAt: toISO(entry.timestamp)
        });
      } catch {
        // ignore malformed legacy payloads
      }
    }

    let gatewayClips: Array<Record<string, unknown>> = [];
    const response = await fetch(
      `${streamGatewayUrl}/events/clips?tenantId=${encodeURIComponent(ctx.tenantId)}&cameraId=${encodeURIComponent(id)}`
    );
    if (response.ok) {
      const payload = (await response.json()) as { data: Array<Record<string, unknown>>; total: number };
      gatewayClips = payload.data;
    }
    const mergedByEventId = new Map<string, Record<string, unknown>>();
    for (const clip of dbClips) {
      mergedByEventId.set(clip.eventId, clip);
    }
    for (const clip of gatewayClips) {
      const key = typeof clip.eventId === "string" ? clip.eventId : `gw-${Math.random().toString(36).slice(2, 8)}`;
      mergedByEventId.set(key, { ...(mergedByEventId.get(key) ?? {}), ...clip });
    }
    const data = Array.from(mergedByEventId.values()).sort((a, b) =>
      String(a.createdAt ?? a.eventTs ?? "") < String(b.createdAt ?? b.eventTs ?? "") ? 1 : -1
    );
    return { data, total: data.length };
  });

  app.post("/cameras/:id/event-clips", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    if (!streamGatewayUrl) {
      throw app.httpErrors.serviceUnavailable("STREAM_GATEWAY_URL is not configured");
    }
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    const body = z
      .object({
        eventId: z.string().min(1).optional(),
        source: z.enum(["manual", "detection", "rule"]).optional(),
        eventTs: z.string().datetime().optional(),
        preSeconds: z.number().int().min(0).max(120).optional(),
        postSeconds: z.number().int().min(1).max(300).optional()
      })
      .parse(request.body ?? {});

    const response = await fetch(`${streamGatewayUrl}/events/clip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        cameraId: id,
        ...body
      })
    });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as { code?: string; message?: string; details?: unknown } | null;
      throw new ApiDomainError({
        statusCode: response.status === 409 ? 409 : 502,
        apiCode: errorBody?.code ?? "STREAM_GATEWAY_EVENT_CLIP_ERROR",
        message: errorBody?.message ?? "stream gateway event clip creation failed",
        details: errorBody?.details
      });
    }
    const payload = (await response.json()) as {
      data: {
        tenantId: string;
        cameraId: string;
        eventId: string;
        source?: string;
        eventTs?: string;
        startedAt?: string;
        endedAt?: string;
        clipBytes?: number;
        sourceSegments?: string[];
        playbackPath: string;
      };
    };
    await prisma.event.create({
      data: {
        tenantId: ctx.tenantId,
        cameraId: id,
        type: "camera.event_clip",
        severity: "info",
        timestamp: payload.data.eventTs ? new Date(payload.data.eventTs) : new Date(),
        payload: JSON.stringify(payload.data)
      }
    });
    const expiresAt = new Date(Date.now() + 1000 * 60 * 5);
    const token = signStreamToken(
      {
        sub: ctx.userId,
        tid: ctx.tenantId,
        cid: id,
        sid: `evtclip-${Date.now()}`,
        exp: Math.floor(expiresAt.getTime() / 1000),
        iat: Math.floor(Date.now() / 1000),
        v: 1
      },
      streamTokenSecret
    );
    return {
      data: {
        ...payload.data,
        token,
        expiresAt: expiresAt.toISOString(),
        playbackUrl: `${streamGatewayUrl}${payload.data.playbackPath}?token=${encodeURIComponent(token)}`
      }
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
    await assertCameraAccess({ ...ctx, cameraId: id });
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
        },
        context: request.ctx
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
      },
      context: request.ctx
    });

    return { data: profileResponse(profile) };
  });

  app.get("/cameras/:id/detection-profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const profile = await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {},
      create: defaultCameraProfileData(ctx.tenantId, id)
    });
    return { data: parseCameraDetectionProfile(profile.detectionProfile, ctx.tenantId, id) };
  });

  app.put("/cameras/:id/detection-profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = CameraDetectionProfileInputSchema.parse(request.body ?? {});

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const existing = await prisma.cameraProfile.findUnique({ where: { cameraId: id } });
    const current = parseCameraDetectionProfile(existing?.detectionProfile ?? null, ctx.tenantId, id);
    const nextProfile: CameraDetectionProfile = {
      cameraId: id,
      tenantId: ctx.tenantId,
      pipelines: body.pipelines,
      configVersion: body.configVersion ?? current.configVersion + 1,
      updatedAt: new Date().toISOString()
    };

    await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {
        detectionProfile: serializeCameraDetectionProfile(nextProfile)
      },
      create: {
        ...defaultCameraProfileData(ctx.tenantId, id),
        detectionProfile: serializeCameraDetectionProfile(nextProfile)
      }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera_detection_profile",
      action: "update",
      resourceId: id,
      payload: {
        configVersion: nextProfile.configVersion,
        pipelines: nextProfile.pipelines.length
      },
      context: request.ctx
    });

    return { data: nextProfile };
  });

  app.get("/cameras/:id/lifecycle", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    await assertCameraAccess({ ...ctx, cameraId: id });

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
    assertRole(request, ["tenant_admin", "client_user"]);
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
      },
      context: request.ctx
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
      },
      context: request.ctx
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
      },
      context: request.ctx
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
      },
      context: request.ctx
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
    if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
      if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();
    }

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
      },
      context: request.ctx
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
    if (!hasGlobalSuperuserPrivileges(request)) {
      const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
      if (!membership) throw app.httpErrors.forbidden();
    }

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

  app.get("/subscriptions/requests", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const status = typeof query.status === "string" && query.status.length > 0 ? query.status : undefined;
    const where = {
      tenantId: ctx.tenantId,
      ...(status ? { status } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.subscriptionRequest.findMany({
        where,
        skip,
        take,
        include: { plan: true },
        orderBy: { createdAt: "desc" }
      }),
      prisma.subscriptionRequest.count({ where })
    ]);
    reply.header("x-total-count", String(total));
    return { data: rows.map(subscriptionRequestResponse), total };
  });

  app.post("/subscriptions/requests", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "client_user"]);
    const body = z
      .object({
        planId: z.string(),
        notes: z.string().max(2000).optional().nullable(),
        proof: z.object({
          imageUrl: z.string().min(6),
          fileName: z.string().min(1),
          mimeType: z.string().min(3),
          sizeBytes: z.number().int().positive(),
          metadata: z.record(z.any()).optional()
        })
      })
      .parse(request.body);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });
    const created = await prisma.subscriptionRequest.create({
      data: {
        tenantId: ctx.tenantId,
        planId: plan.id,
        requestedByUserId: ctx.userId,
        status: "pending_review",
        proofImageUrl: body.proof.imageUrl,
        proofFileName: body.proof.fileName,
        proofMimeType: body.proof.mimeType,
        proofSizeBytes: body.proof.sizeBytes,
        proofMetadata: body.proof.metadata ? JSON.stringify(body.proof.metadata) : null,
        notes: body.notes ?? null
      },
      include: { plan: true }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "subscription_request",
      action: "create",
      resourceId: created.id,
      payload: {
        planId: created.planId,
        status: created.status,
        proofFileName: created.proofFileName,
        proofMimeType: created.proofMimeType,
        proofSizeBytes: created.proofSizeBytes
      },
      context: request.ctx
    });

    return { data: subscriptionRequestResponse(created) };
  });

  app.put("/subscriptions/requests/:id/review", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        status: z.enum(["approved", "rejected"]),
        reviewNotes: z.string().max(2000).optional().nullable()
      })
      .parse(request.body);

    const current = await prisma.subscriptionRequest.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: { plan: true }
    });
    if (!current) throw app.httpErrors.notFound();
    if (current.status !== "pending_review") {
      throw app.httpErrors.conflict("Subscription request is not pending review");
    }

    const reviewed = await prisma.subscriptionRequest.update({
      where: { id },
      data: {
        status: body.status,
        reviewedByUserId: ctx.userId,
        reviewNotes: body.reviewNotes ?? null,
        reviewedAt: new Date()
      },
      include: { plan: true }
    });

    if (body.status === "approved") {
      await prisma.subscription.upsert({
        where: { tenantId: ctx.tenantId },
        update: {
          planId: reviewed.planId,
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
        },
        create: {
          tenantId: ctx.tenantId,
          planId: reviewed.planId,
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
        }
      });
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "subscription_request",
      action: "review",
      resourceId: reviewed.id,
      payload: {
        status: reviewed.status,
        planId: reviewed.planId
      },
      context: request.ctx
    });

    return { data: subscriptionRequestResponse(reviewed) };
  });

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
      },
      context: request.ctx
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
      resourceId: updated.id,
      context: request.ctx
    });

    return { data: detectionJobResponse(updated) };
  });

  app.get("/cameras/:id/detections", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
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

  app.get("/health", async () => ({
    ok: true,
    streamHealthSync: streamSyncStats
  }));

  app.get("/metrics", async (_request, reply) => {
    const lastRunUnix = streamSyncStats.lastRunAt ? Date.parse(streamSyncStats.lastRunAt) / 1000 : 0;
    const lines = [
      "# HELP nearhome_stream_health_sync_enabled 1 if stream health scheduler is enabled, 0 otherwise.",
      "# TYPE nearhome_stream_health_sync_enabled gauge",
      `nearhome_stream_health_sync_enabled ${streamSyncStats.enabled ? 1 : 0}`,
      "# HELP nearhome_stream_health_sync_in_flight 1 if scheduler cycle is currently running.",
      "# TYPE nearhome_stream_health_sync_in_flight gauge",
      `nearhome_stream_health_sync_in_flight ${streamSyncStats.inFlight ? 1 : 0}`,
      "# HELP nearhome_stream_health_sync_tenant_cursors Number of tenant cursors currently tracked.",
      "# TYPE nearhome_stream_health_sync_tenant_cursors gauge",
      `nearhome_stream_health_sync_tenant_cursors ${streamSyncStats.tenantCursors}`,
      "# HELP nearhome_stream_health_sync_last_run_unix_seconds Last completed sync cycle timestamp as unix seconds.",
      "# TYPE nearhome_stream_health_sync_last_run_unix_seconds gauge",
      `nearhome_stream_health_sync_last_run_unix_seconds ${lastRunUnix}`,
      "# HELP nearhome_stream_health_sync_last_duration_ms Last sync cycle duration in milliseconds.",
      "# TYPE nearhome_stream_health_sync_last_duration_ms gauge",
      `nearhome_stream_health_sync_last_duration_ms ${streamSyncStats.lastDurationMs}`,
      "# HELP nearhome_stream_health_sync_last_scanned Number of cameras scanned in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_scanned gauge",
      `nearhome_stream_health_sync_last_scanned ${streamSyncStats.lastScanned}`,
      "# HELP nearhome_stream_health_sync_last_synced Number of cameras synced in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_synced gauge",
      `nearhome_stream_health_sync_last_synced ${streamSyncStats.lastSynced}`,
      "# HELP nearhome_stream_health_sync_last_failed Number of cameras failed in last cycle.",
      "# TYPE nearhome_stream_health_sync_last_failed gauge",
      `nearhome_stream_health_sync_last_failed ${streamSyncStats.lastFailed}`,
      "# HELP nearhome_stream_health_sync_cycles_total Total scheduler cycles completed.",
      "# TYPE nearhome_stream_health_sync_cycles_total counter",
      `nearhome_stream_health_sync_cycles_total ${streamSyncStats.totalCycles}`,
      "# HELP nearhome_stream_health_sync_scanned_total Total cameras scanned across cycles.",
      "# TYPE nearhome_stream_health_sync_scanned_total counter",
      `nearhome_stream_health_sync_scanned_total ${streamSyncStats.totalScanned}`,
      "# HELP nearhome_stream_health_sync_synced_total Total cameras synced across cycles.",
      "# TYPE nearhome_stream_health_sync_synced_total counter",
      `nearhome_stream_health_sync_synced_total ${streamSyncStats.totalSynced}`,
      "# HELP nearhome_stream_health_sync_failed_total Total cameras failed across cycles.",
      "# TYPE nearhome_stream_health_sync_failed_total counter",
      `nearhome_stream_health_sync_failed_total ${streamSyncStats.totalFailed}`
    ];
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });

  app.get("/ops/deployment/status", { preHandler: authPreHandler }, async (_request: FastifyRequest) => {
    const checks: Array<Promise<DeploymentProbeResult>> = [];
    if (streamGatewayUrl) checks.push(probeService("stream-gateway", `${streamGatewayUrl}/health`));
    if (eventGatewayUrl) checks.push(probeService("event-gateway", `${eventGatewayUrl}/health`));
    checks.push(probeService("inference-bridge", `${inferenceBridgeUrl}/health`));
    if (temporalDispatchUrl) checks.push(probeService("detection-dispatcher", `${temporalDispatchUrl}/health`));

    const services = await Promise.all(checks);

    const nodesProbe = await probeService("inference-bridge-nodes", `${inferenceBridgeUrl}/v1/nodes`);
    const nodesRaw = Array.isArray(nodesProbe.payload?.data) ? (nodesProbe.payload?.data as Array<Record<string, unknown>>) : [];
    if (nodesProbe.ok && nodesRaw.length > 0) {
      try {
        await syncInferenceNodeSnapshots(nodesRaw);
      } catch (error) {
        app.log.warn({ error }, "ops.nodes.sync_failed");
      }
    }
    const totalNodes = nodesRaw.length;
    const online = nodesRaw.filter((node) => node.status === "online").length;
    const degraded = nodesRaw.filter((node) => node.status === "degraded").length;
    const offline = nodesRaw.filter((node) => node.status === "offline").length;
    const drained = nodesRaw.filter((node) => node.isDrained === true).length;

    const inferredRevoked = nodesRaw.filter((node) => node.isDrained === true && node.status === "offline").length;

    const overallOk = services.every((service) => service.ok) && nodesProbe.ok;
    return {
      data: {
        generatedAt: new Date().toISOString(),
        overallOk,
        services,
        nodes: {
          sourceOk: nodesProbe.ok,
          sourceError: nodesProbe.error,
          total: totalNodes,
          online,
          degraded,
          offline,
          drained,
          revokedEstimate: inferredRevoked,
          items: nodesRaw
        }
      }
    };
  });

  const syncNodeTenantsInBridge = async (nodeId: string, tenantIds: string[]) => {
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/tenants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-node-auth-admin-secret": nodeAuthAdminSecret
      },
      body: JSON.stringify({ tenantIds })
    });
    const raw = await response.text();
    if (response.status === 404) {
      app.log.warn({ nodeId, tenantIds }, "ops.nodes.bridge_node_not_registered_for_tenant_assignment");
      return;
    }
    if (!response.ok) {
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_TENANT_ASSIGNMENT_BRIDGE_FAILED",
        message: "Failed syncing node tenant assignment in inference bridge",
        details: { statusCode: response.status, body: raw, nodeId, tenantIds }
      });
    }
  };

  app.get("/ops/model-catalog", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const where = {
      ...(typeof query.provider === "string" ? { provider: query.provider } : {}),
      ...(typeof query.taskType === "string" ? { taskType: query.taskType } : {}),
      ...(typeof query.quality === "string" ? { quality: query.quality } : {}),
      ...(typeof query.status === "string" ? { status: query.status } : {})
    };
    const rows = await prisma.modelCatalogEntry.findMany({
      where,
      orderBy: [{ provider: "asc" }, { taskType: "asc" }, { quality: "asc" }, { displayName: "asc" }]
    });
    reply.header("x-total-count", String(rows.length));
    return { data: rows.map(modelCatalogEntryResponse), total: rows.length };
  });

  app.post("/ops/model-catalog", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can create catalog entries");
    const body = ModelCatalogEntryInputSchema.parse(request.body ?? {});
    const row = await prisma.modelCatalogEntry.create({
      data: {
        provider: body.provider,
        taskType: body.taskType,
        quality: body.quality,
        modelRef: body.modelRef,
        displayName: body.displayName,
        resources: JSON.stringify(body.resources),
        defaults: body.defaults ? JSON.stringify(body.defaults) : null,
        outputs: body.outputs ? JSON.stringify(body.outputs) : null,
        status: body.status
      }
    });
    return { data: modelCatalogEntryResponse(row) };
  });

  app.put("/ops/model-catalog/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can update catalog entries");
    const { id } = request.params as { id: string };
    const body = ModelCatalogEntryInputSchema.partial().parse(request.body ?? {});
    const row = await prisma.modelCatalogEntry.update({
      where: { id },
      data: {
        ...(body.provider !== undefined ? { provider: body.provider } : {}),
        ...(body.taskType !== undefined ? { taskType: body.taskType } : {}),
        ...(body.quality !== undefined ? { quality: body.quality } : {}),
        ...(body.modelRef !== undefined ? { modelRef: body.modelRef } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.resources !== undefined ? { resources: JSON.stringify(body.resources) } : {}),
        ...(body.defaults !== undefined ? { defaults: body.defaults ? JSON.stringify(body.defaults) : null } : {}),
        ...(body.outputs !== undefined ? { outputs: body.outputs ? JSON.stringify(body.outputs) : null } : {}),
        ...(body.status !== undefined ? { status: body.status } : {})
      }
    });
    return { data: modelCatalogEntryResponse(row) };
  });

  app.get("/ops/nodes/:nodeId/config", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const [desiredRow, observedRow] = await Promise.all([
      prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } }),
      prisma.inferenceNodeSnapshot.findUnique({
        where: { nodeId },
        include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
      })
    ]);

    if (!desiredRow && !observedRow) throw app.httpErrors.notFound("Node not found");

    const desired = desiredRow ? normalizeDesiredNodeConfig(desiredRow) : null;
    const observed = observedRow ? nodeObservedConfigResponse(observedRow) : null;
    const diff = buildNodeConfigDiff({
      desired,
      observed: observed
        ? {
            runtime: observed.runtime,
            transport: observed.transport,
            endpoint: observed.endpoint,
            resources: observed.resources,
            capabilities: observed.capabilities,
            models: observed.models,
            assignedTenantIds: observed.assignedTenantIds,
            maxConcurrent: observed.maxConcurrent
          }
        : null
    });

    return {
      data: {
        nodeId,
        desiredConfig: desired,
        observedConfig: observed,
        diff
      }
    };
  });

  app.put("/ops/nodes/:nodeId/config", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can update node config");
    const { nodeId } = request.params as { nodeId: string };
    const body = z
      .object({
        runtime: z.string().min(1),
        transport: z.enum(["http", "grpc"]).default("http"),
        endpoint: z.string().min(1),
        resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
        capabilities: z.array(DesiredNodeCapabilitySchema).default([]),
        models: z.array(z.string()).default([]),
        tenantIds: z.array(z.string()).default([]),
        maxConcurrent: z.number().int().min(1).default(1),
        contractVersion: z.string().default("1.0"),
        markApplied: z.boolean().default(false)
      })
      .parse(request.body ?? {});
    const normalizedTenantIds = Array.from(new Set(body.tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean)));
    if (normalizedTenantIds.length > 0) {
      const existingTenants = await prisma.tenant.findMany({
        where: { id: { in: normalizedTenantIds }, deletedAt: null },
        select: { id: true }
      });
      const existingIds = new Set(existingTenants.map((tenant) => tenant.id));
      const invalid = normalizedTenantIds.filter((tenantId) => !existingIds.has(tenantId));
      if (invalid.length > 0) {
        throw app.httpErrors.badRequest(`Invalid tenant ids: ${invalid.join(", ")}`);
      }
    }

    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId },
      update: {
        tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      },
      create: {
        nodeId,
        tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      }
    });
    await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId } });
    if (normalizedTenantIds.length > 0) {
      await prisma.inferenceNodeTenantAssignment.createMany({
        data: normalizedTenantIds.map((tenantId) => ({ nodeId, tenantId }))
      });
    }

    const existing = await prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } });
    const row = await prisma.inferenceNodeDesiredConfig.upsert({
      where: { nodeId },
      update: {
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(normalizedTenantIds),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: existing ? existing.configVersion + 1 : 1,
        ...(body.markApplied ? { lastAppliedAt: new Date() } : {})
      },
      create: {
        nodeId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(normalizedTenantIds),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: 1,
        ...(body.markApplied ? { lastAppliedAt: new Date() } : {})
      }
    });

    return { data: normalizeDesiredNodeConfig(row) };
  });

  app.get("/ops/nodes", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const q = request.query as { sync?: string };
    if (q.sync !== "0") {
      const nodesProbe = await probeService("inference-bridge-nodes", `${inferenceBridgeUrl}/v1/nodes`);
      const nodesRaw = Array.isArray(nodesProbe.payload?.data) ? (nodesProbe.payload?.data as Array<Record<string, unknown>>) : [];
      if (nodesProbe.ok && nodesRaw.length > 0) {
        try {
          await syncInferenceNodeSnapshots(nodesRaw);
        } catch (error) {
          app.log.warn({ error }, "ops.nodes.sync_failed");
        }
      }
    }
    const rows = await prisma.inferenceNodeSnapshot.findMany({
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } },
      orderBy: { updatedAt: "desc" }
    });
    return { data: rows.map(snapshotResponse), total: rows.length };
  });

  app.get("/ops/nodes/:nodeId", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!row) throw app.httpErrors.notFound("Node not found");
    return { data: snapshotResponse(row) };
  });

  app.get("/ops/nodes/:nodeId/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!row) throw app.httpErrors.notFound("Node not found");
    return {
      data: {
        nodeId: row.nodeId,
        tenantIds: row.assignments.map((assignment) => assignment.tenantId)
      }
    };
  });

  app.put("/ops/nodes/:nodeId/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!hasGlobalSuperuserPrivileges(request)) throw app.httpErrors.forbidden("Only superuser can assign node tenants");
    const { nodeId } = request.params as { nodeId: string };
    const body = z.object({ tenantIds: z.array(z.string().min(1)).default([]) }).parse(request.body ?? {});
    const normalizedTenantIds = Array.from(new Set(body.tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean)));

    const node = await prisma.inferenceNodeSnapshot.findUnique({ where: { nodeId }, select: { nodeId: true } });
    if (!node) throw app.httpErrors.notFound("Node not found");

    if (normalizedTenantIds.length > 0) {
      const existingTenants = await prisma.tenant.findMany({
        where: { id: { in: normalizedTenantIds }, deletedAt: null },
        select: { id: true }
      });
      const existingIds = new Set(existingTenants.map((tenant) => tenant.id));
      const invalid = normalizedTenantIds.filter((tenantId) => !existingIds.has(tenantId));
      if (invalid.length > 0) {
        throw app.httpErrors.badRequest(`Invalid tenant ids: ${invalid.join(", ")}`);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId } });
      if (normalizedTenantIds.length > 0) {
        await tx.inferenceNodeTenantAssignment.createMany({
          data: normalizedTenantIds.map((tenantId) => ({ nodeId, tenantId }))
        });
      }
      await tx.inferenceNodeSnapshot.update({
        where: { nodeId },
        data: {
          tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null
        }
      });
    });

    await syncNodeTenantsInBridge(nodeId, normalizedTenantIds);

    const updated = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!updated) throw app.httpErrors.notFound("Node not found");
    return { data: snapshotResponse(updated) };
  });

  app.post("/ops/nodes/provision", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z
      .object({
        nodeId: z.string().min(3),
        tenantScope: z.string().optional(),
        runtime: z.string().default("mediapipe"),
        transport: z.enum(["http", "grpc"]).default("http"),
        endpoint: z.string().min(1),
        capabilities: z
          .array(
            z.object({
              capabilityId: z.string(),
              taskTypes: z.array(z.string()).default([]),
              models: z.array(z.string()).default([]),
              qualities: z.array(DetectionQualitySchema).default([])
            })
          )
          .default([]),
        models: z.array(z.string()).default([]),
        resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
        maxConcurrent: z.number().int().min(1).default(1),
        contractVersion: z.string().default("1.0"),
        ttlSeconds: z.number().int().min(60).max(3600).optional()
      })
      .parse(request.body);

    const tenantId = body.tenantScope && body.tenantScope !== "*" ? body.tenantScope : null;
    if (tenantId) {
      const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true } });
      if (!tenant) throw app.httpErrors.badRequest("Invalid tenantScope");
    }

    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId: body.nodeId },
      update: {
        tenantId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      },
      create: {
        nodeId: body.nodeId,
        tenantId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      }
    });
    const existingDesired = await prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId: body.nodeId } });
    await prisma.inferenceNodeDesiredConfig.upsert({
      where: { nodeId: body.nodeId },
      update: {
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(tenantId ? [tenantId] : []),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: existingDesired ? existingDesired.configVersion + 1 : 1
      },
      create: {
        nodeId: body.nodeId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(tenantId ? [tenantId] : []),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: 1
      }
    });
    await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId: body.nodeId } });
    if (tenantId) {
      await prisma.inferenceNodeTenantAssignment.create({
        data: {
          nodeId: body.nodeId,
          tenantId
        }
      });
    }
    const snapshot = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId: body.nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });

    const response = await fetch(`${inferenceBridgeUrl}/internal/nodes/enrollment-tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-node-auth-admin-secret": nodeAuthAdminSecret
      },
      body: JSON.stringify({
        nodeId: body.nodeId,
        tenantScope: body.tenantScope ?? "*",
        ttlSeconds: body.ttlSeconds
      })
    });
    const raw = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_PROVISION_BRIDGE_FAILED",
        message: "Failed creating node enrollment token",
        details: { statusCode: response.status, body: payload ?? raw }
      });
    }
    return { data: { snapshot: snapshot ? snapshotResponse(snapshot) : null, enrollment: payload?.data ?? payload } };
  });

  app.post("/ops/nodes/:nodeId/drain", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/drain`, {
      method: "POST",
      headers: { "x-node-auth-admin-secret": nodeAuthAdminSecret }
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_DRAIN_BRIDGE_FAILED",
        message: "Failed draining node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    }
    await prisma.inferenceNodeSnapshot.updateMany({ where: { nodeId }, data: { isDrained: true } });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, isDrained: true } };
  });

  app.post("/ops/nodes/:nodeId/undrain", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/undrain`, {
      method: "POST",
      headers: { "x-node-auth-admin-secret": nodeAuthAdminSecret }
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_UNDRAIN_BRIDGE_FAILED",
        message: "Failed undraining node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    }
    await prisma.inferenceNodeSnapshot.updateMany({ where: { nodeId }, data: { isDrained: false } });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, isDrained: false } };
  });

  app.post("/ops/nodes/:nodeId/revoke", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const body = z.object({ reason: z.string().default("manual_revoke") }).parse(request.body ?? {});
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-node-auth-admin-secret": nodeAuthAdminSecret
      },
      body: JSON.stringify({ reason: body.reason })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_REVOKE_BRIDGE_FAILED",
        message: "Failed revoking node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    }
    await prisma.inferenceNodeSnapshot.updateMany({
      where: { nodeId },
      data: { status: "offline", isDrained: true, lastHeartbeatAt: new Date() }
    });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, status: "offline", isDrained: true } };
  });

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
