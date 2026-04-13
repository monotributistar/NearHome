import { z } from "zod";
import { RoleSchema } from "@app/shared";

// ─── Error classes ────────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ApiDomainError extends Error {
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

// ─── Core types ───────────────────────────────────────────────────────────────

export type Role = z.infer<typeof RoleSchema>;
export const RoleInputSchema = z.enum(["tenant_admin", "monitor", "client_user", "operator", "customer"]);
export type RoleInput = z.infer<typeof RoleInputSchema>;

export type RequestContext = {
  userId: string;
  realUserId?: string;
  tenantId?: string;
  role?: Role;
  isSuperuser?: boolean;
  isImpersonating?: boolean;
  impersonatedRole?: Role;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export type LoginBucket = {
  count: number;
  resetAt: number;
};

// ─── Detection types ──────────────────────────────────────────────────────────

export type DetectionPipelineIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type DetectionPipelineNodeCandidate = {
  nodeId: string;
  runtime: string;
  status: string;
  endpoint: string;
  maxConcurrent: number;
  queueDepth: number;
  isDrained: boolean;
  assignedTenantIds: string[];
  score: number;
};

export type DetectionStackSyncState = {
  status: "idle" | "running" | "succeeded" | "failed";
  mode: "onprem" | "onprem-remote";
  profile: string | null;
  attempt: number | null;
  maxAttempts: number;
  timeoutMs: number;
  retryDelayMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  command: string;
  logTail: string[];
  errorMessage: string | null;
};

export type DetectorFlags = {
  mediapipe: boolean;
  yolo: boolean;
  lpr: boolean;
};

export type DetectionRuntimeProvider = "yolo" | "mediapipe" | "audio_vad" | "audio_classifier";
export type DetectionTaskType =
  | "person_detection"
  | "object_detection"
  | "license_plate_detection"
  | "face_detection"
  | "pose_estimation"
  | "speech_detection"
  | "audio_event_classification"
  | "transcription";
export type DetectionQuality = "fast" | "balanced" | "accurate";

export type CameraDetectionPipeline = {
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

export type CameraDetectionProfile = {
  cameraId: string;
  tenantId: string;
  pipelines: CameraDetectionPipeline[];
  audio?: {
    enabled: boolean;
    execution: "core" | "detection_plane";
    sampleRate: number;
    channels: number;
    windowMs: number;
    overlapMs: number;
    minVolume: number;
    detectors: string[];
    transcription: {
      enabled: boolean;
      mode: "off" | "on_demand" | "rules_based";
      minConfidence: number;
    };
  };
  configVersion: number;
  updatedAt: string;
};

export type DetectionJobEffectiveConfig = {
  pipelineId?: string;
  runtimeProvider: DetectionRuntimeProvider;
  taskType: DetectionTaskType;
  quality: DetectionQuality;
  modelRef: string;
  modelCatalogEntryId?: string;
  modelDisplayName?: string;
  profileConfigVersion?: number;
  profileUpdatedAt?: string;
  schedule?: {
    mode: DetectionMode;
    frameStride: number;
  };
  thresholds?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

export type DesiredNodeCapability = {
  capabilityId: string;
  taskTypes: string[];
  qualities: DetectionQuality[];
  modelRefs: string[];
};

export type BridgeNodeCapability = {
  capabilityId: string;
  taskTypes: string[];
  models: string[];
};

export type BridgeNodeSnapshot = {
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

// ─── Camera / stream types ────────────────────────────────────────────────────

export type CameraRecordingPolicy = {
  mode: "continuous" | "event_only" | "hybrid" | "observe_only";
  eventClipPreSeconds: number;
  eventClipPostSeconds: number;
};

export type CameraNotificationRule = {
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

export type ProfileStatus = "pending" | "ready" | "error";
export type CameraLifecycleStatus = "draft" | "provisioning" | "ready" | "degraded" | "offline" | "error" | "retired";
export type StreamSessionStatus = "requested" | "issued" | "active" | "ended" | "expired";
export type TenantVpnStatus =
  | "draft"
  | "validating"
  | "provisioning"
  | "active"
  | "degraded"
  | "revoking"
  | "revoked"
  | "failed";
export type DetectionJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type DetectionMode = "realtime" | "batch";
export type DetectionSource = "snapshot" | "clip" | "range";
export type DetectionProvider = "onprem_bento" | "huggingface_space" | "external_http";

export type StreamHealthSyncStats = {
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

export type DeploymentProbeResult = {
  name: string;
  url: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  payload: Record<string, unknown> | null;
};

// ─── Face types ───────────────────────────────────────────────────────────────

export type FaceDetectionResponse = {
  id: string;
  tenantId: string;
  cameraId: string;
  observationId: string;
  detectorProvider: string;
  detectorTaskType: string;
  cropStorageKey: string | null;
  qualityScore: number | null;
  bbox: { x: number; y: number; w: number; h: number };
  frameTs: string;
  createdAt: string;
  updatedAt: string;
  embedding?: {
    id: string;
    embeddingRef: string | null;
    embeddingModelRef: string | null;
    embeddingVersion: string | null;
    qualityScore: number | null;
    vectorNorm: number | null;
    dimensions: number | null;
  };
  cluster?: {
    id: string;
    status: string;
    displayName: string | null;
    similarityScore: number | null;
  };
  identity?: {
    id: string;
    displayName: string | null;
    status: string;
  };
};

export type FaceSimilarityMatchResponse = {
  similarityScore: number;
  sameCamera: boolean;
  face: FaceDetectionResponse;
};

export type FaceIdentitySummaryResponse = {
  id: string;
  tenantId: string;
  displayName: string | null;
  status: string;
  mergedIntoIdentityId: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  latestSeenAt: string | null;
  cameras: Array<{ cameraId: string; cameraName: string; sightings: number }>;
  faces?: FaceDetectionResponse[];
};

export type FaceIdentityDetailResponse = FaceIdentitySummaryResponse & {
  appearances: Array<{
    cameraId: string;
    cameraName: string;
    firstSeenAt: string;
    lastSeenAt: string;
    sightings: number;
  }>;
  mergeHistory: Array<{
    id: string;
    sourceIdentityId: string;
    sourceDisplayName: string | null;
    targetIdentityId: string;
    targetDisplayName: string | null;
    reason: string | null;
    createdAt: string;
  }>;
};

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const CameraLifecycleStatusSchema = z.enum([
  "draft",
  "provisioning",
  "ready",
  "degraded",
  "offline",
  "error",
  "retired"
]);
export const CameraConnectivitySchema = z.enum(["online", "degraded", "offline"]);
export const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);
export const DetectionJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export const DetectionModeSchema = z.enum(["realtime", "batch"]);
export const DetectionSourceSchema = z.enum(["snapshot", "clip", "range"]);
export const DetectionProviderSchema = z.enum(["onprem_bento", "huggingface_space", "external_http"]);
export const DetectionRuntimeProviderSchema = z.enum(["yolo", "mediapipe", "audio_vad", "audio_classifier"]);
export const DetectionTaskTypeSchema = z.enum([
  "person_detection",
  "object_detection",
  "license_plate_detection",
  "face_detection",
  "pose_estimation",
  "speech_detection",
  "audio_event_classification",
  "transcription"
]);
export const DetectionQualitySchema = z.enum(["fast", "balanced", "accurate"]);
export const DetectionMediaKindSchema = z.enum(["image", "audio"]);

export const TenantVpnProviderSchema = z.enum(["wireguard", "ipsec", "tailscale", "custom"]);
export const TenantVpnTopologySchema = z.enum(["site_to_site", "hub_spoke", "mesh"]);
export const TenantVpnStatusSchema = z.enum([
  "draft",
  "validating",
  "provisioning",
  "active",
  "degraded",
  "revoking",
  "revoked",
  "failed"
]);
export const TenantNetworkSpaceStatusSchema = z.enum(["planned", "allocated", "announced", "active", "retired"]);
export const TenantNetworkSpaceTypeSchema = z.enum(["camera_lan", "edge_nodes", "operations", "reserved"]);

export const DesiredNodeCapabilitySchema = z.object({
  capabilityId: z.string(),
  taskTypes: z.array(z.string()).default([]),
  qualities: z.array(DetectionQualitySchema).default([]),
  modelRefs: z.array(z.string()).default([])
});

export const CameraDetectionPipelineSchema = z.object({
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

export const CameraDetectionProfileInputSchema = z.object({
  pipelines: z.array(CameraDetectionPipelineSchema).default([]),
  audio: z
    .object({
      enabled: z.boolean().default(false),
      execution: z.enum(["core", "detection_plane"]).default("detection_plane"),
      sampleRate: z.number().int().positive().default(16000),
      channels: z.number().int().min(1).max(2).default(1),
      windowMs: z.number().int().positive().default(500),
      overlapMs: z.number().int().nonnegative().default(250),
      minVolume: z.number().nonnegative().default(0.02),
      detectors: z.array(z.string()).default([]),
      transcription: z
        .object({
          enabled: z.boolean().default(false),
          mode: z.enum(["off", "on_demand", "rules_based"]).default("off"),
          minConfidence: z.number().min(0).max(1).default(0.75)
        })
        .default({
          enabled: false,
          mode: "off",
          minConfidence: 0.75
        })
    })
    .optional(),
  configVersion: z.number().int().positive().optional()
});

export const DetectionJobEffectiveConfigSchema = z.object({
  pipelineId: z.string().optional(),
  runtimeProvider: DetectionRuntimeProviderSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  modelRef: z.string().min(1),
  modelCatalogEntryId: z.string().optional(),
  modelDisplayName: z.string().optional(),
  profileConfigVersion: z.number().int().positive().optional(),
  profileUpdatedAt: z.string().optional(),
  schedule: z
    .object({
      mode: DetectionModeSchema,
      frameStride: z.number().int().positive()
    })
    .optional(),
  thresholds: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional()
});

export const DetectionJobCreateInputSchema = z.object({
  cameraId: z.string(),
  mode: DetectionModeSchema.default("realtime"),
  source: DetectionSourceSchema.default("snapshot"),
  provider: DetectionProviderSchema.default("onprem_bento"),
  pipelineId: z.string().min(1).optional(),
  overrides: z
    .object({
      quality: DetectionQualitySchema.optional(),
      thresholds: z.record(z.any()).optional(),
      outputs: z.record(z.any()).optional(),
      provider: DetectionProviderSchema.optional()
    })
    .optional(),
  options: z.record(z.any()).optional()
});

export const ModelCatalogEntryInputSchema = z.object({
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

export const StreamGatewayHealthSchema = z.object({
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

// ─── Fastify augmentation ────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
    requestId?: string;
    requestStartedAt?: number;
  }
}
