/**
 * Detection service — encapsulates completeDetectionJob, failDetectionJob,
 * resolveDetectionJobInput, runDetectionJobPipeline, dispatchDetectionJobTemporal
 * and all supporting closures.  Created once via createDetectionService() and
 * injected into the detection routes plugin.
 */

import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { parseJson } from "../../core/utils.js";
import { ApiDomainError } from "../../core/types.js";

// ─── Schemas (local copies, mirrors of app.ts top-level consts) ───────────────

export const DetectionJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export const DetectionModeSchema = z.enum(["realtime", "batch"]);
export const DetectionSourceSchema = z.enum(["snapshot", "clip", "range"]);
export const DetectionProviderSchema = z.enum(["onprem_bento", "huggingface_space", "external_http"]);
export const DetectionRuntimeProviderSchema = z.enum(["yolo", "mediapipe", "audio_vad", "audio_classifier"]);
export const DetectionTaskTypeSchema = z.enum([
  "person_detection", "object_detection", "license_plate_detection", "face_detection",
  "pose_estimation", "speech_detection", "audio_event_classification", "transcription"
]);
export const DetectionQualitySchema = z.enum(["fast", "balanced", "accurate"]);
export const DetectionMediaKindSchema = z.enum(["image", "audio"]);

export const DetectionJobCreateInputSchema = z.object({
  cameraId: z.string(),
  mode: DetectionModeSchema.default("realtime"),
  source: DetectionSourceSchema.default("snapshot"),
  provider: DetectionProviderSchema.default("onprem_bento"),
  pipelineId: z.string().min(1).optional(),
  overrides: z.object({
    quality: DetectionQualitySchema.optional(),
    thresholds: z.record(z.any()).optional(),
    outputs: z.record(z.any()).optional(),
    provider: DetectionProviderSchema.optional()
  }).optional(),
  options: z.record(z.any()).optional()
});

const DetectionJobEffectiveConfigSchema = z.object({
  pipelineId: z.string().optional(),
  runtimeProvider: DetectionRuntimeProviderSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  modelRef: z.string().min(1),
  modelCatalogEntryId: z.string().optional(),
  modelDisplayName: z.string().optional(),
  profileConfigVersion: z.number().int().positive().optional(),
  profileUpdatedAt: z.string().optional(),
  schedule: z.object({ mode: DetectionModeSchema, frameStride: z.number().int().positive() }).optional(),
  thresholds: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional()
});

const CameraDetectionPipelineSchema = z.object({
  pipelineId: z.string().min(1),
  provider: DetectionRuntimeProviderSchema,
  taskType: DetectionTaskTypeSchema,
  quality: DetectionQualitySchema,
  enabled: z.boolean().default(true),
  schedule: z.object({ mode: DetectionModeSchema.default("realtime"), frameStride: z.number().int().positive().default(1) }).optional(),
  thresholds: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional()
});

const CameraDetectionProfileInputSchema = z.object({
  pipelines: z.array(CameraDetectionPipelineSchema).default([]),
  audio: z.object({
    enabled: z.boolean().default(false),
    execution: z.enum(["core", "detection_plane"]).default("detection_plane"),
    sampleRate: z.number().int().positive().default(16000),
    channels: z.number().int().min(1).max(2).default(1),
    windowMs: z.number().int().positive().default(500),
    overlapMs: z.number().int().nonnegative().default(250),
    minVolume: z.number().nonnegative().default(0.02),
    detectors: z.array(z.string()).default([]),
    transcription: z.object({
      enabled: z.boolean().default(false),
      mode: z.enum(["off", "on_demand", "rules_based"]).default("off"),
      minConfidence: z.number().min(0).max(1).default(0.75)
    }).default({ enabled: false, mode: "off", minConfidence: 0.75 })
  }).optional(),
  configVersion: z.number().int().positive().optional()
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function isAudioTaskType(taskType: string) {
  return taskType === "speech_detection" || taskType === "audio_event_classification" || taskType === "transcription";
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function extractDetectionJobEffectiveConfig(options: Record<string, unknown> | null | undefined) {
  if (!options) return undefined;
  const parsed = DetectionJobEffectiveConfigSchema.safeParse(options.resolvedConfig);
  return parsed.success ? parsed.data : undefined;
}

export function defaultCameraProfileData(tenantId: string, cameraId: string) {
  return {
    tenantId, cameraId,
    proxyPath: `/proxy/live/${tenantId}/${cameraId}`,
    recordingEnabled: false,
    recordingStorageKey: `s3://nearhome/${tenantId}/recordings/${cameraId}`,
    detectorConfigKey: `kv://nearhome/${tenantId}/detectors/${cameraId}/config.json`,
    detectorResultsKey: `s3://nearhome/${tenantId}/detectors/${cameraId}/results`,
    detectorFlags: JSON.stringify({ mediapipe: true, yolo: false, lpr: false }),
    zoneMap: null as string | null,
    homography: null as string | null,
    sceneTags: JSON.stringify([] as string[]),
    rulesProfile: JSON.stringify({} as Record<string, unknown>),
    detectionProfile: JSON.stringify(defaultCameraDetectionProfile(tenantId, cameraId)),
    status: "ready",
    lastHealthAt: new Date(),
    lastError: null as string | null
  };
}

export function defaultCameraDetectionProfile(tenantId: string, cameraId: string) {
  return {
    cameraId, tenantId, pipelines: [],
    audio: { enabled: false, execution: "detection_plane", sampleRate: 16000, channels: 1, windowMs: 500, overlapMs: 250, minVolume: 0.02, detectors: [], transcription: { enabled: false, mode: "off", minConfidence: 0.75 } },
    configVersion: 1,
    updatedAt: new Date().toISOString()
  };
}

export function parseCameraDetectionProfile(raw: string | null, tenantId: string, cameraId: string) {
  const fallback = defaultCameraDetectionProfile(tenantId, cameraId);
  if (!raw) return fallback;
  try {
    const source = parseJson<Record<string, unknown>>(raw);
    const parsed = CameraDetectionProfileInputSchema.partial().parse(source);
    return {
      cameraId, tenantId,
      pipelines: parsed.pipelines ?? fallback.pipelines,
      audio: parsed.audio ?? fallback.audio,
      configVersion: parsed.configVersion ?? fallback.configVersion,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt
    };
  } catch {
    return fallback;
  }
}

function toNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function resolveZoneFromProfile(zoneMapRaw: string | null, bbox: { x: number; y: number; w: number; h: number }) {
  if (!zoneMapRaw) return null;
  let zoneMap: Record<string, unknown>;
  try { zoneMap = parseJson<Record<string, unknown>>(zoneMapRaw); } catch { return null; }
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  for (const [zoneId, candidate] of Object.entries(zoneMap)) {
    if (!candidate || typeof candidate !== "object") continue;
    const shape = candidate as Record<string, unknown>;
    const xMin = toNumber(shape.xMin); const xMax = toNumber(shape.xMax);
    const yMin = toNumber(shape.yMin); const yMax = toNumber(shape.yMax);
    if (xMin === null || xMax === null || yMin === null || yMax === null) continue;
    if (centerX >= xMin && centerX <= xMax && centerY >= yMin && centerY <= yMax) return zoneId;
  }
  return null;
}

export function deriveIncidentFromDetection(args: { label: string; zoneId: string | null; location: string | null; mediaKind?: "image" | "audio" }) {
  const mediaKind = args.mediaKind ?? "image";
  const label = args.label.toLowerCase();
  const suffix = mediaKind === "audio" ? " (audio)" : "";
  if (label.includes("dog")) return { type: "dog_in_backyard", summary: `Dog detected${suffix}${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}` };
  if (label.includes("branch")) return { type: "branch_fall_backyard", summary: `Branch fall detected${suffix}${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}` };
  if (label.includes("person")) return { type: "person_approached_front_window", summary: `Person detected${suffix}${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}` };
  if (mediaKind === "audio") return { type: `audio_event_${label.replace(/[^a-z0-9]+/g, "_")}`, summary: `${args.label} detected from audio${args.location ? ` at ${args.location}` : ""}` };
  return { type: `object_detected_${label.replace(/[^a-z0-9]+/g, "_")}`, summary: `${args.label} detected${args.zoneId ? ` in zone ${args.zoneId}` : ""}${args.location ? ` at ${args.location}` : ""}` };
}

function vectorNorm(vector: number[]) {
  return Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return -1;
  const ln = vectorNorm(left); const rn = vectorNorm(right);
  if (ln === 0 || rn === 0) return -1;
  let dot = 0;
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i];
  return dot / (ln * rn);
}

export function parseEmbeddingCandidate(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const vector = value.map((e) => (typeof e === "number" && Number.isFinite(e) ? e : NaN)).filter((e) => Number.isFinite(e));
  return vector.length === value.length ? vector : null;
}

function extractFaceEmbedding(det: { attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }): number[] | null {
  return parseEmbeddingCandidate(det.attributes?.embedding) ?? parseEmbeddingCandidate(det.attributes?.faceEmbedding) ?? parseEmbeddingCandidate(det.attributes?.embeddingVector) ?? parseEmbeddingCandidate(det.providerMeta?.embedding) ?? parseEmbeddingCandidate(det.providerMeta?.faceEmbedding) ?? parseEmbeddingCandidate(det.providerMeta?.embeddingVector) ?? null;
}

function extractFaceCropStorageKey(det: { attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }): string | null {
  const c = det.attributes?.cropStorageKey ?? det.attributes?.cropRef ?? det.providerMeta?.cropStorageKey ?? det.providerMeta?.cropRef;
  return typeof c === "string" && c.length > 0 ? c : null;
}

function extractFaceQualityScore(det: { confidence?: number; attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }) {
  const c = det.attributes?.qualityScore ?? det.providerMeta?.qualityScore ?? det.confidence ?? null;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

function extractEmbeddingRef(det: { attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }) {
  const c = det.attributes?.embeddingRef ?? det.providerMeta?.embeddingRef;
  return typeof c === "string" && c.length > 0 ? c : null;
}

function extractEmbeddingModelRef(det: { attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }) {
  const c = det.attributes?.embeddingModelRef ?? det.providerMeta?.embeddingModelRef;
  return typeof c === "string" && c.length > 0 ? c : null;
}

function extractEmbeddingVersion(det: { attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> }) {
  const c = det.attributes?.embeddingVersion ?? det.providerMeta?.embeddingVersion;
  return typeof c === "string" && c.length > 0 ? c : null;
}

function averageEmbeddings(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions) return null;
  const acc = new Array<number>(dimensions).fill(0);
  let count = 0;
  for (const v of vectors) { if (v.length !== dimensions) continue; count++; for (let i = 0; i < dimensions; i++) acc[i] += v[i]; }
  if (!count) return null;
  return acc.map((v) => v / count);
}

function isFaceDetection(args: { label?: string; providerMeta?: Record<string, unknown>; jobOptions?: Record<string, unknown> | null }) {
  const label = args.label?.toLowerCase() ?? "";
  if (label.includes("face")) return true;
  if (args.providerMeta?.taskType === "face_detection") return true;
  return args.jobOptions?.taskType === "face_detection";
}

async function attachFaceArtifacts(args: {
  tx: any;
  job: { id: string; tenantId: string; cameraId: string; provider: string; options: string | null };
  observation: { id: string; frameTs: Date };
  detection: { label?: string; confidence?: number; bbox?: { x?: number; y?: number; w?: number; h?: number }; attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown> };
  bbox: { x: number; y: number; w: number; h: number };
}) {
  const jobOptions = args.job.options ? parseJson<Record<string, unknown>>(args.job.options) : null;
  if (!isFaceDetection({ label: args.detection.label, providerMeta: args.detection.providerMeta, jobOptions })) return;

  const faceDetection = await args.tx.faceDetection.create({
    data: {
      tenantId: args.job.tenantId, cameraId: args.job.cameraId, observationId: args.observation.id,
      detectorProvider: args.job.provider,
      detectorTaskType: typeof args.detection.providerMeta?.taskType === "string" ? args.detection.providerMeta.taskType : typeof jobOptions?.taskType === "string" ? jobOptions.taskType : "face_detection",
      cropStorageKey: extractFaceCropStorageKey(args.detection),
      qualityScore: extractFaceQualityScore(args.detection),
      bbox: JSON.stringify(args.bbox),
      frameTs: args.observation.frameTs
    }
  });

  const embeddingVector = extractFaceEmbedding(args.detection);
  if (!embeddingVector && !extractEmbeddingRef(args.detection)) return;

  const embedding = await args.tx.faceEmbedding.create({
    data: {
      tenantId: args.job.tenantId, faceDetectionId: faceDetection.id,
      embeddingVector: embeddingVector ? JSON.stringify(embeddingVector) : null,
      embeddingRef: extractEmbeddingRef(args.detection),
      embeddingModelRef: extractEmbeddingModelRef(args.detection),
      embeddingVersion: extractEmbeddingVersion(args.detection),
      qualityScore: extractFaceQualityScore(args.detection),
      vectorNorm: embeddingVector ? vectorNorm(embeddingVector) : null,
      dimensions: embeddingVector?.length ?? null
    }
  });

  if (!embeddingVector) return;

  const clusters = await args.tx.faceCluster.findMany({ where: { tenantId: args.job.tenantId, status: { in: ["open", "confirmed"] } } });

  let bestCluster: { id: string; centroidEmbedding: string | null; similarity: number } | undefined;
  for (const cluster of clusters) {
    if (!cluster.centroidEmbedding) continue;
    const centroid = parseEmbeddingCandidate(parseJson<unknown>(cluster.centroidEmbedding));
    if (!centroid) continue;
    const similarity = cosineSimilarity(embeddingVector, centroid);
    if (similarity >= 0.92 && (!bestCluster || similarity > bestCluster.similarity)) {
      bestCluster = { id: cluster.id, centroidEmbedding: cluster.centroidEmbedding, similarity };
    }
  }

  const clusterRecord = bestCluster
    ? await args.tx.faceCluster.findUniqueOrThrow({ where: { id: bestCluster.id } })
    : await args.tx.faceCluster.create({ data: { tenantId: args.job.tenantId, status: "open", memberCount: 0, centroidEmbedding: JSON.stringify(embeddingVector), displayName: null, confirmedIdentityId: null } });

  await args.tx.faceClusterMember.create({
    data: {
      clusterId: clusterRecord.id, tenantId: args.job.tenantId,
      faceDetectionId: faceDetection.id, faceEmbeddingId: embedding.id,
      similarityScore: bestCluster?.similarity ?? null
    }
  });

  // Update cluster centroid
  const allMembers = await args.tx.faceClusterMember.findMany({
    where: { clusterId: clusterRecord.id },
    include: { faceEmbedding: { select: { embeddingVector: true } } }
  });
  const allVectors = allMembers
    .map((m: any) => (m.faceEmbedding?.embeddingVector ? parseEmbeddingCandidate(parseJson<unknown>(m.faceEmbedding.embeddingVector)) : null))
    .filter((v: number[] | null): v is number[] => v !== null);
  const centroid = averageEmbeddings(allVectors);
  await args.tx.faceCluster.update({
    where: { id: clusterRecord.id },
    data: { memberCount: allMembers.length, centroidEmbedding: centroid ? JSON.stringify(centroid) : null }
  });
}

// ─── Service factory ──────────────────────────────────────────────────────────

export type DetectionServiceConfig = {
  eventGatewayUrl: string | null;
  eventPublishSecret: string;
  detectionBridgeUrl: string | null;
  audioDetectionRunnerUrl: string | null;
  temporalDispatchUrl: string | null;
  detectionExecutionMode: string;
};

export function createDetectionService(config: DetectionServiceConfig) {
  const { eventGatewayUrl, eventPublishSecret, detectionBridgeUrl, audioDetectionRunnerUrl, temporalDispatchUrl, detectionExecutionMode } = config;

  const publishRealtimeEvent = async (args: {
    eventType: string; tenantId: string; cameraId?: string; correlationId?: string; payload: Record<string, unknown>;
  }) => {
    if (!eventGatewayUrl) return;
    try {
      await fetch(`${eventGatewayUrl}/internal/events/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-publish-secret": eventPublishSecret },
        body: JSON.stringify(args)
      });
    } catch { /* best-effort */ }
  };

  const processIncidentNotifications = async (args: {
    jobId: string; tenantId: string; cameraId: string; cameraName: string; incidentId: string;
    incidentType: string; severity: string; summary: string; label: string; confidence: number; rulesProfileRaw: string | null;
  }) => {
    const rule = parseCameraNotificationRule(args.rulesProfileRaw);
    if (!rule.enabled) return;
    if (args.confidence < rule.minConfidence) return;
    if (rule.labels.length > 0 && !rule.labels.includes(args.label)) return;

    if (rule.cooldownSeconds > 0) {
      const threshold = new Date(Date.now() - rule.cooldownSeconds * 1000);
      const recent = await prisma.notificationDelivery.count({ where: { tenantId: args.tenantId, cameraId: args.cameraId, incident: { type: args.incidentType }, createdAt: { gte: threshold }, status: { in: ["sent", "queued"] } } });
      if (recent > 0) return;
    }

    const payload = { tenantId: args.tenantId, cameraId: args.cameraId, cameraName: args.cameraName, incidentId: args.incidentId, incidentType: args.incidentType, severity: args.severity, summary: args.summary, label: args.label, confidence: args.confidence, occurredAt: new Date().toISOString() };

    if (rule.channels.realtime) {
      await publishRealtimeEvent({ eventType: "notification.sent", tenantId: args.tenantId, cameraId: args.cameraId, correlationId: `det-${args.jobId}`, payload: { channel: "realtime", ...payload } });
      await prisma.notificationDelivery.create({ data: { tenantId: args.tenantId, cameraId: args.cameraId, incidentId: args.incidentId, channelType: "realtime", status: "sent", requestPayload: JSON.stringify(payload) } });
    }

    if (rule.channels.webhook) {
      const channels = await prisma.notificationChannel.findMany({ where: { tenantId: args.tenantId, isActive: true, type: "webhook" } });
      for (const channel of channels) {
        if (!channel.endpoint) continue;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (channel.authToken) headers.authorization = `Bearer ${channel.authToken}`;
        if (channel.headersJson) { const extra = parseJson<Record<string, string>>(channel.headersJson); for (const [k, v] of Object.entries(extra)) headers[k] = String(v); }
        let status = "sent"; let responseCode: number | null = null; let responsePayload: string | null = null; let error: string | null = null;
        try {
          const response = await fetch(channel.endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
          responseCode = response.status; responsePayload = await response.text();
          if (!response.ok) { status = "failed"; error = `webhook_http_${response.status}`; }
        } catch (cause) { status = "failed"; error = cause instanceof Error ? cause.message : "webhook_send_failed"; }
        await prisma.notificationDelivery.create({ data: { tenantId: args.tenantId, cameraId: args.cameraId, incidentId: args.incidentId, channelId: channel.id, channelType: "webhook", status, error, responseCode, requestPayload: JSON.stringify(payload), responsePayload: responsePayload ? JSON.stringify({ body: responsePayload.slice(0, 2000) }) : null } });
      }
    }

    if (rule.channels.email) {
      const channels = await prisma.notificationChannel.findMany({ where: { tenantId: args.tenantId, isActive: true, type: "email" } });
      for (const channel of channels) {
        await prisma.notificationDelivery.create({ data: { tenantId: args.tenantId, cameraId: args.cameraId, incidentId: args.incidentId, channelId: channel.id, channelType: "email", status: "queued", requestPayload: JSON.stringify({ ...payload, emailTo: channel.emailTo }) } });
      }
      await publishRealtimeEvent({ eventType: "notification.email_queued", tenantId: args.tenantId, cameraId: args.cameraId, correlationId: `det-${args.jobId}`, payload });
    }
  };

  const failDetectionJob = async (jobId: string, errorCode: string, errorMessage: string) => {
    const existing = await prisma.detectionJob.findUnique({ where: { id: jobId } });
    if (!existing) return null;
    const status = DetectionJobStatusSchema.parse(existing.status);
    if (["succeeded", "failed", "canceled"].includes(status)) return existing;
    const updated = await prisma.detectionJob.update({ where: { id: jobId }, data: { status: "failed", finishedAt: new Date(), errorCode, errorMessage } });
    if (eventGatewayUrl) {
      try {
        await fetch(`${eventGatewayUrl}/internal/events/publish`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-event-publish-secret": eventPublishSecret },
          body: JSON.stringify({ eventType: "detection.job", tenantId: updated.tenantId, cameraId: updated.cameraId, correlationId: `det-${updated.id}`, payload: { jobId: updated.id, status: updated.status, errorCode, errorMessage } })
        });
      } catch { /* best-effort */ }
    }
    return updated;
  };

  const completeDetectionJob = async (args: {
    jobId: string;
    detections: Array<{ label?: string; confidence?: number; mediaKind?: "image" | "audio"; bbox?: { x?: number; y?: number; w?: number; h?: number }; keypoints?: unknown; attributes?: Record<string, unknown>; providerMeta?: Record<string, unknown>; frameTs?: string; startedAt?: string; endedAt?: string; temporalWindow?: { startMs?: number; endMs?: number; durationMs?: number } }>;
    providerMeta?: Record<string, unknown>;
  }) => {
    const job = await prisma.detectionJob.findUnique({ where: { id: args.jobId }, include: { camera: { include: { profile: true } } } });
    if (!job) return null;
    const status = DetectionJobStatusSchema.parse(job.status);
    if (["succeeded", "failed", "canceled"].includes(status)) return job;
    if (status === "queued") {
      await prisma.detectionJob.update({ where: { id: job.id }, data: { status: "running", startedAt: new Date(), workflowId: job.workflowId ?? `inline-${job.id}` } });
    }

    const incidentsCreated: Array<{ id: string; type: string; severity: string; summary: string; cameraId: string; tenantId: string; label: string; confidence: number }> = [];

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < args.detections.length; i++) {
        const det = args.detections[i];
        const label = typeof det.label === "string" && det.label.length > 0 ? det.label : "unknown";
        const confidence = typeof det.confidence === "number" ? det.confidence : 0;
        const mediaKind = DetectionMediaKindSchema.safeParse(det.mediaKind).success ? (det.mediaKind as "image" | "audio") : "image";
        const bbox = { x: typeof det.bbox?.x === "number" ? det.bbox.x : 0, y: typeof det.bbox?.y === "number" ? det.bbox.y : 0, w: typeof det.bbox?.w === "number" ? det.bbox.w : 0.1, h: typeof det.bbox?.h === "number" ? det.bbox.h : 0.1 };
        const tsInput = typeof det.frameTs === "string" ? det.frameTs : typeof det.startedAt === "string" ? det.startedAt : undefined;
        const frameTs = tsInput ? new Date(tsInput) : new Date();
        const zoneId = mediaKind === "image" ? resolveZoneFromProfile((job.camera as any).profile?.zoneMap ?? null, bbox) : null;
        const incident = deriveIncidentFromDetection({ label, zoneId, location: job.camera.location, mediaKind });

        const observation = await tx.detectionObservation.create({
          data: { jobId: job.id, tenantId: job.tenantId, cameraId: job.cameraId, frameTs, label, confidence, bbox: JSON.stringify(bbox), keypoints: det.keypoints ? JSON.stringify(det.keypoints) : null, attributes: JSON.stringify({ ...(det.attributes ?? {}), mediaKind, ...(det.temporalWindow ? { temporalWindow: det.temporalWindow } : {}), ...(det.startedAt ? { startedAt: det.startedAt } : {}), ...(det.endedAt ? { endedAt: det.endedAt } : {}) }), providerMeta: det.providerMeta ? JSON.stringify(det.providerMeta) : args.providerMeta ? JSON.stringify(args.providerMeta) : null }
        });

        if (mediaKind === "image") {
          await attachFaceArtifacts({ tx, job, observation: { id: observation.id, frameTs }, detection: det, bbox });
        }

        const track = mediaKind === "image" ? await tx.track.create({ data: { jobId: job.id, tenantId: job.tenantId, cameraId: job.cameraId, classLabel: label, trackExternalId: `${job.id}-${i + 1}`, startedAt: frameTs, metadata: JSON.stringify({ zoneId }) } }) : null;

        if (track) {
          await tx.trackPoint.create({ data: { trackId: track.id, ts: frameTs, x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, zoneId } });
        }

        const primitive = await tx.scenePrimitiveEvent.create({ data: { tenantId: job.tenantId, cameraId: job.cameraId, jobId: job.id, type: mediaKind === "audio" ? `audio_detected.${label.toLowerCase()}` : `object_detected.${label.toLowerCase()}`, severity: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low", startedAt: frameTs, payload: JSON.stringify({ confidence, zoneId, observationId: observation.id, mediaKind }) } });

        const incidentEvent = await tx.incidentEvent.create({ data: { tenantId: job.tenantId, cameraId: job.cameraId, jobId: job.id, type: incident.type, severity: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low", status: "open", summary: incident.summary, startedAt: frameTs, payload: JSON.stringify({ label, confidence, zoneId, mediaKind }) } });

        incidentsCreated.push({ id: incidentEvent.id, type: incidentEvent.type, severity: incidentEvent.severity, summary: incidentEvent.summary, cameraId: incidentEvent.cameraId, tenantId: incidentEvent.tenantId, label, confidence });

        await tx.incidentEvidence.create({ data: { tenantId: job.tenantId, incidentId: incidentEvent.id, observationId: observation.id, trackId: track?.id ?? null, scenePrimitiveEventId: primitive.id } });
      }

      await tx.detectionJob.update({ where: { id: job.id }, data: { status: "succeeded", finishedAt: new Date(), errorCode: null, errorMessage: null } });
    });

    const updated = await prisma.detectionJob.findUnique({ where: { id: job.id } });
    if (updated && eventGatewayUrl) {
      try {
        await publishRealtimeEvent({ eventType: "detection.job", tenantId: updated.tenantId, cameraId: updated.cameraId, correlationId: `det-${updated.id}`, payload: { jobId: updated.id, status: updated.status } });
        for (const inc of incidentsCreated) {
          await publishRealtimeEvent({ eventType: "incident", tenantId: inc.tenantId, cameraId: inc.cameraId, correlationId: `det-${updated.id}`, payload: { incidentId: inc.id, type: inc.type, severity: inc.severity, summary: inc.summary, jobId: updated.id } });
          await processIncidentNotifications({ jobId: updated.id, tenantId: inc.tenantId, cameraId: inc.cameraId, cameraName: (job.camera as any).name, incidentId: inc.id, incidentType: inc.type, severity: inc.severity, summary: inc.summary, label: inc.label, confidence: inc.confidence, rulesProfileRaw: (job.camera as any).profile?.rulesProfile ?? null });
        }
      } catch { /* best-effort */ }
    }
    return updated;
  };

  const resolveCatalogModel = async (args: { runtimeProvider: string; taskType: string; quality: string }) => {
    return prisma.modelCatalogEntry.findFirst({ where: { provider: args.runtimeProvider, taskType: args.taskType, quality: args.quality, status: "active" }, orderBy: { updatedAt: "desc" } });
  };

  const resolveDetectionJobInput = async (args: {
    tenantId: string; cameraId: string; mode: string; provider: string;
    pipelineId?: string;
    overrides?: { quality?: string; thresholds?: Record<string, unknown>; outputs?: Record<string, unknown>; provider?: string };
    options?: Record<string, unknown>;
  }) => {
    const baseOptions = normalizeRecord(args.options);
    const provider = args.overrides?.provider ?? args.provider;

    if (args.pipelineId) {
      const profileRow = await prisma.cameraProfile.upsert({ where: { cameraId: args.cameraId }, update: {}, create: defaultCameraProfileData(args.tenantId, args.cameraId) as any });
      const profile = parseCameraDetectionProfile(profileRow.detectionProfile, args.tenantId, args.cameraId);
      const pipeline = profile.pipelines.find((p: any) => p.pipelineId === args.pipelineId);
      if (!pipeline) throw new ApiDomainError({ statusCode: 404, apiCode: "DETECTION_PIPELINE_NOT_FOUND", message: "Detection pipeline not found for camera", details: { cameraId: args.cameraId, pipelineId: args.pipelineId } });
      if (!pipeline.enabled) throw new ApiDomainError({ statusCode: 409, apiCode: "DETECTION_PIPELINE_DISABLED", message: "Detection pipeline is disabled", details: { cameraId: args.cameraId, pipelineId: args.pipelineId } });

      const quality = args.overrides?.quality ?? pipeline.quality;
      const catalogEntry = await resolveCatalogModel({ runtimeProvider: pipeline.provider, taskType: pipeline.taskType, quality });
      if (!catalogEntry) throw new ApiDomainError({ statusCode: 409, apiCode: "DETECTION_MODEL_NOT_CONFIGURED", message: "No active model catalog entry matches the requested detection pipeline", details: { cameraId: args.cameraId, pipelineId: args.pipelineId, provider: pipeline.provider, taskType: pipeline.taskType, quality } });

      const defaultThresholds = catalogEntry.defaults ? normalizeRecord(parseJson<unknown>(catalogEntry.defaults)) : {};
      const thresholds = { ...defaultThresholds, ...normalizeRecord(pipeline.thresholds), ...normalizeRecord(args.overrides?.thresholds), ...normalizeRecord(baseOptions.thresholds) };
      const outputs = { ...normalizeRecord(pipeline.outputs), ...normalizeRecord(args.overrides?.outputs), ...normalizeRecord(baseOptions.outputs) };
      const schedule = pipeline.schedule ?? { mode: args.mode, frameStride: 1 };
      const effectiveConfig = { pipelineId: pipeline.pipelineId, runtimeProvider: pipeline.provider, taskType: pipeline.taskType, quality, modelRef: catalogEntry.modelRef, modelCatalogEntryId: catalogEntry.id, modelDisplayName: catalogEntry.displayName, profileConfigVersion: profile.configVersion, profileUpdatedAt: profile.updatedAt, schedule, thresholds, outputs };
      const mediaKind = isAudioTaskType(pipeline.taskType) ? "audio" : "image";
      const audioExecution = mediaKind === "audio" ? ((profile.audio as any)?.execution ?? "detection_plane") : undefined;
      return { provider, mode: schedule.mode, options: { ...baseOptions, pipelineId: pipeline.pipelineId, runtimeProvider: pipeline.provider, taskType: pipeline.taskType, quality, modelRef: catalogEntry.modelRef, schedule, thresholds, outputs, mediaKind, ...(audioExecution ? { audioExecution } : {}), resolvedConfig: effectiveConfig } };
    }

    const { runtimeProvider, taskType, quality, modelRef } = baseOptions;
    if (typeof runtimeProvider === "string" && typeof taskType === "string" && typeof quality === "string" && typeof modelRef !== "string") {
      const pr = DetectionRuntimeProviderSchema.safeParse(runtimeProvider);
      const pt = DetectionTaskTypeSchema.safeParse(taskType);
      const pq = DetectionQualitySchema.safeParse(quality);
      if (pr.success && pt.success && pq.success) {
        const catalogEntry = await resolveCatalogModel({ runtimeProvider: pr.data, taskType: pt.data, quality: pq.data });
        if (!catalogEntry) throw new ApiDomainError({ statusCode: 409, apiCode: "DETECTION_MODEL_NOT_CONFIGURED", message: "No active model catalog entry matches the requested detection configuration", details: { cameraId: args.cameraId, provider: pr.data, taskType: pt.data, quality: pq.data } });
        const effectiveConfig = { runtimeProvider: pr.data, taskType: pt.data, quality: pq.data, modelRef: catalogEntry.modelRef, modelCatalogEntryId: catalogEntry.id, modelDisplayName: catalogEntry.displayName, thresholds: normalizeRecord(baseOptions.thresholds), outputs: normalizeRecord(baseOptions.outputs) };
        const mediaKind = isAudioTaskType(pt.data) ? "audio" : "image";
        const audioExecution = mediaKind === "audio" && typeof baseOptions.audioExecution === "string" ? baseOptions.audioExecution : mediaKind === "audio" ? "detection_plane" : undefined;
        return { provider, mode: args.mode, options: { ...baseOptions, modelRef: catalogEntry.modelRef, mediaKind, ...(audioExecution ? { audioExecution } : {}), resolvedConfig: effectiveConfig } };
      }
    }

    return { provider, mode: args.mode, options: baseOptions };
  };

  const runDetectionJobPipeline = async (jobId: string) => {
    if (!detectionBridgeUrl) return;
    const job = await prisma.detectionJob.findUnique({ where: { id: jobId }, include: { camera: true } });
    if (!job || (job.status as string) !== "queued") return;
    await prisma.detectionJob.update({ where: { id: job.id }, data: { status: "running", startedAt: new Date(), workflowId: detectionExecutionMode === "temporal" ? `temporal-${job.id}` : `inline-${job.id}`, runId: detectionExecutionMode === "temporal" ? `run-${Date.now()}` : null } });
    const options = job.options ? parseJson<Record<string, unknown>>(job.options) : {};
    const inferPayload = { requestId: `det-${job.id}`, jobId: job.id, tenantId: job.tenantId, cameraId: job.cameraId, taskType: typeof options.taskType === "string" ? options.taskType : "object_detection", modelRef: typeof options.modelRef === "string" ? options.modelRef : "yolo26n@1.0.0", mediaRef: { source: job.source, cameraId: job.cameraId, rtspUrl: (job.camera as any).rtspUrl }, thresholds: typeof options.thresholds === "object" && options.thresholds ? options.thresholds : {}, deadlineMs: typeof options.deadlineMs === "number" ? options.deadlineMs : 15000, priority: typeof options.priority === "number" ? options.priority : 5, provider: job.provider };
    const isAudioTask = inferPayload.taskType === "speech_detection" || inferPayload.taskType === "audio_event_classification" || inferPayload.taskType === "transcription" || (typeof options.mediaKind === "string" && options.mediaKind === "audio");
    const audioExecutionMode = typeof options.audioExecution === "string" ? options.audioExecution : "detection_plane";
    const inferUrl = isAudioTask ? audioExecutionMode === "core" ? `${detectionBridgeUrl}/v1/infer` : `${(audioDetectionRunnerUrl ?? "http://audio-detection-runner:8074").replace(/\/$/, "")}/v1/infer/audio` : `${detectionBridgeUrl}/v1/infer`;
    try {
      const response = await fetch(inferUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inferPayload) });
      if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
      const body = await response.json() as { detections?: Array<any>; providerMeta?: Record<string, unknown> };
      await completeDetectionJob({ jobId: job.id, detections: Array.isArray(body.detections) ? body.detections : [], providerMeta: body.providerMeta });
    } catch (error) {
      await failDetectionJob(job.id, "DETECTION_PIPELINE_ERROR", error instanceof Error ? error.message : "unknown error");
    }
  };

  const dispatchDetectionJobTemporal = async (jobId: string) => {
    if (!temporalDispatchUrl) throw new Error("DETECTION_TEMPORAL_DISPATCH_URL is not configured");
    const job = await prisma.detectionJob.findUnique({ where: { id: jobId }, include: { camera: true } });
    if (!job || (job.status as string) !== "queued") return;
    const options = job.options ? parseJson<Record<string, unknown>>(job.options) : {};
    const dispatchPayload = { requestId: `det-${job.id}`, jobId: job.id, tenantId: job.tenantId, cameraId: job.cameraId, mode: job.mode, source: job.source, provider: job.provider, options, mediaRef: { source: job.source, cameraId: job.cameraId, rtspUrl: (job.camera as any).rtspUrl } };
    try {
      const response = await fetch(`${temporalDispatchUrl}/v1/workflows/detection-jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dispatchPayload) });
      if (!response.ok) throw new Error(`Temporal dispatch HTTP ${response.status}`);
      const body = await response.json() as { workflowId?: string; runId?: string };
      const workflowId = typeof body.workflowId === "string" && body.workflowId.length > 0 ? body.workflowId : `det-${job.id}`;
      await prisma.detectionJob.update({ where: { id: job.id }, data: { workflowId, runId: typeof body.runId === "string" && body.runId.length > 0 ? body.runId : null } });
    } catch (error) {
      await failDetectionJob(jobId, "TEMPORAL_DISPATCH_ERROR", error instanceof Error ? error.message : "unknown error");
    }
  };

  return { completeDetectionJob, failDetectionJob, resolveDetectionJobInput, runDetectionJobPipeline, dispatchDetectionJobTemporal };
}

// ─── Camera notification rule parser ─────────────────────────────────────────

export function parseCameraNotificationRule(rulesProfileRaw: string | null) {
  const fallback = { enabled: false, minConfidence: 0.6, labels: [] as string[], cooldownSeconds: 30, channels: { realtime: true, webhook: false, email: false } };
  if (!rulesProfileRaw) return fallback;
  try {
    const parsed = parseJson<Record<string, unknown>>(rulesProfileRaw);
    const notification = parsed.notification;
    if (!notification || typeof notification !== "object") return fallback;
    const value = notification as Record<string, unknown>;
    const channelsRaw = value.channels && typeof value.channels === "object" ? (value.channels as Record<string, unknown>) : {};
    const labels = Array.isArray(value.labels) ? value.labels.filter((e): e is string => typeof e === "string" && e.trim().length > 0) : [];
    const minConfidenceRaw = typeof value.minConfidence === "number" ? value.minConfidence : fallback.minConfidence;
    const cooldownRaw = typeof value.cooldownSeconds === "number" ? Math.floor(value.cooldownSeconds) : fallback.cooldownSeconds;
    return { enabled: value.enabled === true, minConfidence: Math.max(0, Math.min(1, minConfidenceRaw)), labels, cooldownSeconds: Math.max(0, Math.min(3600, cooldownRaw)), channels: { realtime: channelsRaw.realtime !== false, webhook: channelsRaw.webhook === true, email: channelsRaw.email === true } };
  } catch { return fallback; }
}
