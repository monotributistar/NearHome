/**
 * Domain response serializers — converts Prisma rows to API response shapes.
 * Kept separate from utils.ts to keep the file focused.
 */

import { parseJson, toISO } from "./utils.js";
import type {
  DetectionMode,
  DetectionSource,
  DetectionProvider,
  DetectionJobStatus,
  FaceDetectionResponse,
  BridgeNodeCapability,
} from "./types.js";
import { extractDetectionJobEffectiveConfig } from "./utils.js";

// ─── Household ────────────────────────────────────────────────────────────────

export function householdMemberResponse(row: {
  id: string; tenantId: string; householdId: string; fullName: string; relationship: string;
  phone: string | null; canViewCameras: boolean; canReceiveAlerts: boolean; isActive: boolean;
  createdByUserId: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id, tenantId: row.tenantId, householdId: row.householdId, fullName: row.fullName,
    relationship: row.relationship, phone: row.phone, canViewCameras: row.canViewCameras,
    canReceiveAlerts: row.canReceiveAlerts, isActive: row.isActive, createdByUserId: row.createdByUserId,
    createdAt: toISO(row.createdAt), updatedAt: toISO(row.updatedAt)
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

export function detectionJobResponse(job: {
  id: string; tenantId: string; cameraId: string; mode: string; source: string; provider: string;
  status: string; workflowId: string | null; runId: string | null; errorCode: string | null;
  errorMessage: string | null; options: string | null; queuedAt: Date; startedAt: Date | null;
  finishedAt: Date | null; canceledAt: Date | null; createdByUserId: string; createdAt: Date; updatedAt: Date;
}) {
  const options = job.options ? parseJson<Record<string, unknown>>(job.options) : null;
  return {
    id: job.id, tenantId: job.tenantId, cameraId: job.cameraId,
    mode: job.mode as DetectionMode, source: job.source as DetectionSource,
    provider: job.provider as DetectionProvider, status: job.status as DetectionJobStatus,
    workflowId: job.workflowId, runId: job.runId, errorCode: job.errorCode, errorMessage: job.errorMessage,
    options,
    effectiveConfig: extractDetectionJobEffectiveConfig(options ?? undefined),
    queuedAt: toISO(job.queuedAt),
    startedAt: job.startedAt ? toISO(job.startedAt) : null,
    finishedAt: job.finishedAt ? toISO(job.finishedAt) : null,
    canceledAt: job.canceledAt ? toISO(job.canceledAt) : null,
    createdByUserId: job.createdByUserId, createdAt: toISO(job.createdAt), updatedAt: toISO(job.updatedAt)
  };
}

export function detectionObservationResponse(observation: {
  id: string; jobId: string; tenantId: string; cameraId: string; frameTs: Date; label: string;
  confidence: number; bbox: string; keypoints: string | null; attributes: string | null;
  providerMeta: string | null; createdAt: Date;
}) {
  return {
    id: observation.id, jobId: observation.jobId, tenantId: observation.tenantId,
    cameraId: observation.cameraId, frameTs: toISO(observation.frameTs), label: observation.label,
    confidence: observation.confidence, bbox: parseJson<Record<string, number>>(observation.bbox),
    keypoints: observation.keypoints ? parseJson<Array<Record<string, number>>>(observation.keypoints) : undefined,
    attributes: observation.attributes ? parseJson<Record<string, unknown>>(observation.attributes) : undefined,
    providerMeta: observation.providerMeta ? parseJson<Record<string, unknown>>(observation.providerMeta) : undefined,
    createdAt: toISO(observation.createdAt)
  };
}

// ─── Face ────────────────────────────────────────────────────────────────────

export function faceDetectionResponse(face: {
  id: string; tenantId: string; cameraId: string; observationId: string; detectorProvider: string;
  detectorTaskType: string; cropStorageKey: string | null; qualityScore: number | null; bbox: string;
  frameTs: Date; createdAt: Date; updatedAt: Date;
  embedding?: { id: string; embeddingRef: string | null; embeddingModelRef: string | null; embeddingVersion: string | null; qualityScore: number | null; vectorNorm: number | null; dimensions: number | null } | null;
  clusterMembership?: { similarityScore: number | null; cluster: { id: string; status: string; displayName: string | null } } | null;
  identityMembership?: { identity: { id: string; displayName: string | null; status: string } } | null;
}): FaceDetectionResponse {
  return {
    id: face.id, tenantId: face.tenantId, cameraId: face.cameraId, observationId: face.observationId,
    detectorProvider: face.detectorProvider, detectorTaskType: face.detectorTaskType,
    cropStorageKey: face.cropStorageKey, qualityScore: face.qualityScore,
    bbox: parseJson<{ x: number; y: number; w: number; h: number }>(face.bbox),
    frameTs: toISO(face.frameTs), createdAt: toISO(face.createdAt), updatedAt: toISO(face.updatedAt),
    embedding: face.embedding ? { id: face.embedding.id, embeddingRef: face.embedding.embeddingRef, embeddingModelRef: face.embedding.embeddingModelRef, embeddingVersion: face.embedding.embeddingVersion, qualityScore: face.embedding.qualityScore, vectorNorm: face.embedding.vectorNorm, dimensions: face.embedding.dimensions } : undefined,
    cluster: face.clusterMembership ? { id: face.clusterMembership.cluster.id, status: face.clusterMembership.cluster.status, displayName: face.clusterMembership.cluster.displayName, similarityScore: face.clusterMembership.similarityScore } : undefined,
    identity: face.identityMembership ? { id: face.identityMembership.identity.id, displayName: face.identityMembership.identity.displayName, status: face.identityMembership.identity.status } : undefined
  };
}

export function summarizeIdentityFaces(faces: Array<FaceDetectionResponse & { cameraName?: string }>) {
  const appearancesByCamera = new Map<string, { cameraId: string; cameraName: string; firstSeenAt: string; lastSeenAt: string; sightings: number }>();
  for (const face of faces) {
    const cameraName = face.cameraName ?? face.cameraId;
    const current = appearancesByCamera.get(face.cameraId);
    if (!current) {
      appearancesByCamera.set(face.cameraId, { cameraId: face.cameraId, cameraName, firstSeenAt: face.frameTs, lastSeenAt: face.frameTs, sightings: 1 });
      continue;
    }
    current.firstSeenAt = face.frameTs < current.firstSeenAt ? face.frameTs : current.firstSeenAt;
    current.lastSeenAt = face.frameTs > current.lastSeenAt ? face.frameTs : current.lastSeenAt;
    current.sightings += 1;
  }
  const appearances = Array.from(appearancesByCamera.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const cameras = appearances.map(({ cameraId, cameraName, sightings }) => ({ cameraId, cameraName, sightings }));
  return { appearances, cameras, latestSeenAt: faces[0]?.frameTs ?? null };
}

// ─── Incidents ────────────────────────────────────────────────────────────────

export function incidentEventResponse(incident: {
  id: string; tenantId: string; cameraId: string; jobId: string | null; type: string; severity: string;
  status: string; summary: string; startedAt: Date; endedAt: Date | null; payload: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: incident.id, tenantId: incident.tenantId, cameraId: incident.cameraId, jobId: incident.jobId,
    type: incident.type, severity: incident.severity, status: incident.status, summary: incident.summary,
    startedAt: toISO(incident.startedAt), endedAt: incident.endedAt ? toISO(incident.endedAt) : null,
    payload: incident.payload ? parseJson<Record<string, unknown>>(incident.payload) : undefined,
    createdAt: toISO(incident.createdAt), updatedAt: toISO(incident.updatedAt)
  };
}

export function incidentEvidenceResponse(evidence: {
  id: string; tenantId: string; incidentId: string; observationId: string | null; trackId: string | null;
  scenePrimitiveEventId: string | null; clipUrl: string | null; snapshotUrl: string | null; createdAt: Date;
}) {
  return {
    id: evidence.id, tenantId: evidence.tenantId, incidentId: evidence.incidentId,
    observationId: evidence.observationId, trackId: evidence.trackId,
    scenePrimitiveEventId: evidence.scenePrimitiveEventId,
    clipUrl: evidence.clipUrl, snapshotUrl: evidence.snapshotUrl, createdAt: toISO(evidence.createdAt)
  };
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function notificationChannelResponse(channel: {
  id: string; tenantId: string; name: string; type: string; endpoint: string | null;
  authToken: string | null; headersJson: string | null; emailTo: string | null;
  isActive: boolean; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: channel.id, tenantId: channel.tenantId, name: channel.name, type: channel.type,
    endpoint: channel.endpoint,
    headers: channel.headersJson ? parseJson<Record<string, string>>(channel.headersJson) : undefined,
    emailTo: channel.emailTo, isActive: channel.isActive,
    hasAuthToken: Boolean(channel.authToken),
    createdAt: toISO(channel.createdAt), updatedAt: toISO(channel.updatedAt)
  };
}

export function notificationDeliveryResponse(delivery: {
  id: string; tenantId: string; cameraId: string; incidentId: string; channelId: string | null;
  channelType: string; status: string; error: string | null; responseCode: number | null;
  requestPayload: string | null; responsePayload: string | null; createdAt: Date;
}) {
  return {
    id: delivery.id, tenantId: delivery.tenantId, cameraId: delivery.cameraId,
    incidentId: delivery.incidentId, channelId: delivery.channelId, channelType: delivery.channelType,
    status: delivery.status, error: delivery.error, responseCode: delivery.responseCode,
    requestPayload: delivery.requestPayload ? parseJson<Record<string, unknown>>(delivery.requestPayload) : undefined,
    responsePayload: delivery.responsePayload ? parseJson<Record<string, unknown>>(delivery.responsePayload) : undefined,
    createdAt: toISO(delivery.createdAt)
  };
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export function subscriptionRequestResponse(row: {
  id: string; tenantId: string; planId: string; requestedByUserId: string; status: string;
  proofImageUrl: string; proofFileName: string; proofMimeType: string; proofSizeBytes: number;
  proofMetadata: string | null; notes: string | null; reviewedByUserId: string | null;
  reviewNotes: string | null; reviewedAt: Date | null; createdAt: Date; updatedAt: Date;
  plan?: { id: string; code: string; name: string } | null;
}) {
  return {
    id: row.id, tenantId: row.tenantId, planId: row.planId, requestedByUserId: row.requestedByUserId,
    status: row.status, proofImageUrl: row.proofImageUrl, proofFileName: row.proofFileName,
    proofMimeType: row.proofMimeType, proofSizeBytes: row.proofSizeBytes,
    proofMetadata: row.proofMetadata ? parseJson<Record<string, unknown>>(row.proofMetadata) : undefined,
    notes: row.notes, reviewedByUserId: row.reviewedByUserId, reviewNotes: row.reviewNotes,
    reviewedAt: row.reviewedAt ? toISO(row.reviewedAt) : null,
    createdAt: toISO(row.createdAt), updatedAt: toISO(row.updatedAt),
    plan: row.plan ?? undefined
  };
}

// ─── Ops / Inference nodes ────────────────────────────────────────────────────

export function snapshotResponse(row: {
  nodeId: string; tenantId: string | null; runtime: string; transport: string; endpoint: string;
  status: string; resources: string; capabilities: string; models: string; maxConcurrent: number;
  queueDepth: number; isDrained: boolean; lastHeartbeatAt: Date; contractVersion: string;
  createdAt: Date; updatedAt: Date; assignments?: Array<{ tenantId: string }>;
}) {
  return {
    nodeId: row.nodeId, tenantId: row.tenantId, runtime: row.runtime, transport: row.transport,
    endpoint: row.endpoint, status: row.status,
    resources: parseJson<Record<string, number>>(row.resources),
    capabilities: parseJson<BridgeNodeCapability[]>(row.capabilities),
    models: parseJson<string[]>(row.models),
    maxConcurrent: row.maxConcurrent, queueDepth: row.queueDepth, isDrained: row.isDrained,
    assignedTenantIds: Array.from(new Set((row.assignments ?? []).map((a) => a.tenantId))),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(), contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

export function modelCatalogEntryResponse(row: {
  id: string; provider: string; taskType: string; quality: string; modelRef: string;
  displayName: string; resources: string; defaults: string | null; outputs: string | null;
  status: string; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id, provider: row.provider, taskType: row.taskType, quality: row.quality,
    modelRef: row.modelRef, displayName: row.displayName,
    resources: parseJson<Record<string, number>>(row.resources),
    defaults: row.defaults ? parseJson<Record<string, unknown>>(row.defaults) : undefined,
    outputs: row.outputs ? parseJson<Record<string, unknown>>(row.outputs) : undefined,
    status: row.status, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

export function nodeObservedConfigResponse(row: {
  runtime: string; transport: string; endpoint: string; resources: string; capabilities: string;
  models: string; maxConcurrent: number; assignments?: Array<{ tenantId: string }>;
  status: string; queueDepth: number; isDrained: boolean; lastHeartbeatAt: Date; updatedAt: Date;
}) {
  return {
    runtime: row.runtime, transport: row.transport, endpoint: row.endpoint,
    resources: parseJson<Record<string, number>>(row.resources),
    capabilities: parseJson<BridgeNodeCapability[]>(row.capabilities),
    models: parseJson<string[]>(row.models),
    assignedTenantIds: Array.from(new Set((row.assignments ?? []).map((a) => a.tenantId))),
    maxConcurrent: row.maxConcurrent, status: row.status, queueDepth: row.queueDepth,
    isDrained: row.isDrained, lastHeartbeatAt: row.lastHeartbeatAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}
