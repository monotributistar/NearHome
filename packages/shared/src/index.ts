import { z } from "zod";

export const RoleSchema = z.enum(["tenant_admin", "monitor", "client_user"]);
export type Role = z.infer<typeof RoleSchema>;

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string()
});

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string(),
  isActive: z.boolean()
});

export const MembershipSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  role: RoleSchema,
  createdAt: z.string(),
  user: UserSchema.optional(),
  tenant: TenantSchema.optional()
});

export const CameraSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  rtspUrl: z.string(),
  location: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  isActive: z.boolean(),
  lifecycleStatus: z.enum(["draft", "provisioning", "ready", "degraded", "offline", "error", "retired"]),
  lastSeenAt: z.string().nullable().optional(),
  lastTransitionAt: z.string().nullable().optional(),
  createdAt: z.string(),
  profile: z
    .object({
      id: z.string(),
      cameraId: z.string(),
      tenantId: z.string(),
      proxyPath: z.string(),
      recordingEnabled: z.boolean(),
      recordingStorageKey: z.string(),
      detectorConfigKey: z.string(),
      detectorResultsKey: z.string(),
      detectorFlags: z.object({
        mediapipe: z.boolean(),
        yolo: z.boolean(),
        lpr: z.boolean()
      }),
      zoneMap: z.record(z.any()).optional(),
      homography: z.record(z.any()).optional(),
      sceneTags: z.array(z.string()).optional(),
      rulesProfile: z.record(z.any()).optional(),
      detectionProfile: z
        .object({
          pipelines: z
            .array(
              z.object({
                pipelineId: z.string(),
                provider: z.enum(["yolo", "mediapipe"]),
                taskType: z.enum([
                  "person_detection",
                  "object_detection",
                  "license_plate_detection",
                  "face_detection",
                  "pose_estimation"
                ]),
                quality: z.enum(["fast", "balanced", "accurate"]),
                enabled: z.boolean(),
                schedule: z
                  .object({
                    mode: z.enum(["realtime", "batch"]).default("realtime"),
                    frameStride: z.number().int().positive().default(1)
                  })
                  .optional(),
                thresholds: z.record(z.any()).optional(),
                outputs: z.record(z.any()).optional()
              })
            )
            .default([]),
          configVersion: z.number().int().positive().default(1),
          updatedAt: z.string().optional()
        })
        .optional(),
      status: z.enum(["pending", "ready", "error"]),
      configComplete: z.boolean(),
      lastHealthAt: z.string().nullable().optional(),
      lastError: z.string().nullable().optional(),
      createdAt: z.string(),
      updatedAt: z.string()
    })
    .optional()
});

export const PlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  limits: z.object({
    maxCameras: z.number(),
    retentionDays: z.number(),
    maxConcurrentStreams: z.number()
  }),
  features: z.object({
    mediapipe: z.boolean(),
    yolo: z.boolean(),
    lpr: z.boolean()
  })
});

export const SubscriptionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  planId: z.string(),
  status: z.enum(["active", "past_due", "canceled"]),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  plan: PlanSchema.optional()
});

export const EntitlementsSchema = z.object({
  planCode: z.string(),
  limits: PlanSchema.shape.limits,
  features: PlanSchema.shape.features
});

export const EventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  timestamp: z.string(),
  payload: z.record(z.any()).optional()
});

export const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);

export const StreamSessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  userId: z.string(),
  status: StreamSessionStatusSchema,
  token: z.string(),
  expiresAt: z.string(),
  issuedAt: z.string(),
  activatedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  endReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const DetectionJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export const DetectionJobModeSchema = z.enum(["realtime", "batch"]);
export const DetectionJobSourceSchema = z.enum(["snapshot", "clip", "range"]);
export const DetectionProviderSchema = z.enum(["onprem_bento", "huggingface_space", "external_http"]);

export const DetectionJobSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  mode: DetectionJobModeSchema,
  source: DetectionJobSourceSchema,
  provider: DetectionProviderSchema,
  status: DetectionJobStatusSchema,
  workflowId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  options: z.record(z.any()).nullable().optional(),
  queuedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  canceledAt: z.string().nullable().optional(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const DetectionObservationSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  frameTs: z.string(),
  label: z.string(),
  confidence: z.number(),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number()
  }),
  keypoints: z.array(z.object({ x: z.number(), y: z.number(), score: z.number().optional() })).optional(),
  attributes: z.record(z.any()).optional(),
  providerMeta: z.record(z.any()).optional(),
  createdAt: z.string()
});

export const TrackSchema = z.object({
  id: z.string(),
  jobId: z.string().nullable().optional(),
  tenantId: z.string(),
  cameraId: z.string(),
  classLabel: z.string(),
  trackExternalId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TrackPointSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  ts: z.string(),
  x: z.number(),
  y: z.number(),
  zoneId: z.string().nullable().optional(),
  speed: z.number().nullable().optional(),
  createdAt: z.string()
});

export const ScenePrimitiveEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  jobId: z.string().nullable().optional(),
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  payload: z.record(z.any()).optional(),
  createdAt: z.string()
});

export const IncidentEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  jobId: z.string().nullable().optional(),
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  status: z.enum(["open", "acknowledged", "resolved"]),
  summary: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  payload: z.record(z.any()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const IncidentEvidenceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  incidentId: z.string(),
  observationId: z.string().nullable().optional(),
  trackId: z.string().nullable().optional(),
  scenePrimitiveEventId: z.string().nullable().optional(),
  clipUrl: z.string().nullable().optional(),
  snapshotUrl: z.string().nullable().optional(),
  createdAt: z.string()
});

export const NodeCapabilitySchema = z.object({
  capabilityId: z.string(),
  taskTypes: z.array(z.string()),
  models: z.array(z.string())
});

export const DetectionProviderRuntimeSchema = z.enum(["yolo", "mediapipe"]);
export const DetectionTaskTypeSchema = z.enum([
  "person_detection",
  "object_detection",
  "license_plate_detection",
  "face_detection",
  "pose_estimation"
]);
export const DetectionQualitySchema = z.enum(["fast", "balanced", "accurate"]);

export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  provider: DetectionProviderRuntimeSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  modelRef: z.string(),
  displayName: z.string(),
  resources: z.record(z.number()),
  defaults: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional(),
  status: z.enum(["active", "disabled"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const CameraDetectionPipelineSchema = z.object({
  pipelineId: z.string(),
  provider: DetectionProviderRuntimeSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  enabled: z.boolean(),
  schedule: z
    .object({
      mode: z.enum(["realtime", "batch"]).default("realtime"),
      frameStride: z.number().int().positive().default(1)
    })
    .optional(),
  thresholds: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional()
});

export const CameraDetectionProfileSchema = z.object({
  cameraId: z.string(),
  tenantId: z.string(),
  pipelines: z.array(CameraDetectionPipelineSchema).default([]),
  configVersion: z.number().int().positive(),
  updatedAt: z.string()
});

export const InferenceNodeDesiredConfigSchema = z.object({
  nodeId: z.string(),
  runtime: z.string(),
  transport: z.enum(["http", "grpc"]),
  endpoint: z.string(),
  resources: z.record(z.number()),
  capabilities: z.array(
    z.object({
      capabilityId: z.string(),
      taskTypes: z.array(z.string()).default([]),
      qualities: z.array(DetectionQualitySchema).default([]),
      modelRefs: z.array(z.string()).default([])
    })
  ),
  models: z.array(z.string()),
  tenantIds: z.array(z.string()).default([]),
  maxConcurrent: z.number().int().positive(),
  contractVersion: z.string(),
  configVersion: z.number().int().positive(),
  lastAppliedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const InferenceNodeSchema = z.object({
  nodeId: z.string(),
  tenantId: z.string().nullable().optional(),
  runtime: z.string(),
  transport: z.enum(["http", "grpc"]),
  endpoint: z.string(),
  status: z.enum(["online", "degraded", "offline"]),
  resources: z.object({
    cpu: z.number().int().nonnegative(),
    gpu: z.number().int().nonnegative(),
    vramMb: z.number().int().nonnegative()
  }),
  capabilities: z.array(NodeCapabilitySchema),
  models: z.array(z.string()),
  maxConcurrent: z.number().int().positive(),
  queueDepth: z.number().int().nonnegative(),
  isDrained: z.boolean().default(false),
  lastHeartbeatAt: z.string(),
  contractVersion: z.string()
});

export const EventEnvelopeSchema = z.object({
  eventId: z.string(),
  eventVersion: z.string(),
  eventType: z.string(),
  tenantId: z.string(),
  cameraId: z.string().optional(),
  occurredAt: z.string(),
  correlationId: z.string(),
  sequence: z.number().int().nonnegative(),
  payload: z.record(z.any())
});

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4),
  audience: z.enum(["backoffice", "portal"]).optional()
});

export const MeResponseSchema = z.object({
  user: UserSchema,
  memberships: z.array(MembershipSchema),
  activeTenant: TenantSchema.optional(),
  entitlements: EntitlementsSchema.optional()
});

export type Tenant = z.infer<typeof TenantSchema>;
export type User = z.infer<typeof UserSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type Entitlements = z.infer<typeof EntitlementsSchema>;
export type Event = z.infer<typeof EventSchema>;
export type StreamSession = z.infer<typeof StreamSessionSchema>;
export type DetectionJob = z.infer<typeof DetectionJobSchema>;
export type DetectionObservation = z.infer<typeof DetectionObservationSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type TrackPoint = z.infer<typeof TrackPointSchema>;
export type ScenePrimitiveEvent = z.infer<typeof ScenePrimitiveEventSchema>;
export type IncidentEvent = z.infer<typeof IncidentEventSchema>;
export type IncidentEvidence = z.infer<typeof IncidentEvidenceSchema>;
export type InferenceNode = z.infer<typeof InferenceNodeSchema>;
export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
export type CameraDetectionPipeline = z.infer<typeof CameraDetectionPipelineSchema>;
export type CameraDetectionProfile = z.infer<typeof CameraDetectionProfileSchema>;
export type InferenceNodeDesiredConfig = z.infer<typeof InferenceNodeDesiredConfigSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
