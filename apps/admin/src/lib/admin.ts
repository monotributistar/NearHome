import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export const EVENT_GATEWAY_URL = import.meta.env.VITE_EVENT_GATEWAY_URL ?? "http://localhost:3011";

export const ADMIN_ROUTES = {
  operations: {
    control: "/operations/control",
    monitor: "/operations/monitor",
    realtime: "/operations/realtime",
    nodes: "/operations/nodes"
  },
  resources: {
    clientOverview: "/resources/client-overview",
    faceCases: "/resources/faces",
    cameras: "/resources/cameras",
    cameraDetail: (id: string) => `/resources/cameras/${id}`,
    faceCaseDetail: (id: string) => `/resources/faces/${id}`,
    notifications: "/resources/notifications"
  },
  identity: {
    tenants: "/identity/tenants",
    users: "/identity/users",
    memberships: "/identity/memberships",
    cameraAssignments: "/identity/camera-assignments"
  },
  commercial: {
    plans: "/commercial/plans",
    subscriptions: "/commercial/subscriptions"
  },
  deployments: {
    manifests: "/deployments/manifests",
    fleetGroups: "/deployments/fleet-groups"
  }
} as const;

export type RealtimeEvent = {
  eventId: string;
  eventType: string;
  tenantId: string;
  occurredAt: string;
  sequence: number;
  payload: Record<string, unknown>;
};

export type DeploymentServiceProbe = {
  name: string;
  target: string;
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
};

export type DeploymentNodeItem = {
  nodeId?: string;
  status?: "online" | "degraded" | "offline" | string;
  tenantId?: string | null;
  tenantIds?: string[];
  runtime?: string;
  endpoint?: string;
  maxConcurrent?: number;
  isDrained?: boolean;
  queueDepth?: number;
  resources?: Record<string, unknown>;
  contractVersion?: string;
  capabilities?: Array<{ taskTypes?: string[] }>;
  models?: string[];
};

export type OpsNodeSnapshot = {
  nodeId: string;
  tenantId: string | null;
  assignedTenantIds?: string[];
  runtime: string;
  transport: string;
  endpoint: string;
  status: string;
  resources: Record<string, number>;
  capabilities: Array<{ capabilityId: string; taskTypes: string[]; models: string[] }>;
  models: string[];
  maxConcurrent: number;
  queueDepth: number;
  isDrained: boolean;
  lastHeartbeatAt: string;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type OpsNodeDesiredConfig = {
  nodeId: string;
  runtime: string;
  transport: "http" | "grpc";
  endpoint: string;
  resources: Record<string, number>;
  capabilities: Array<{ capabilityId: string; taskTypes: string[]; qualities?: string[]; modelRefs?: string[] }>;
  models: string[];
  tenantIds: string[];
  maxConcurrent: number;
  contractVersion: string;
  configVersion: number;
  lastAppliedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpsNodeObservedConfig = {
  runtime: string;
  transport: "http" | "grpc";
  endpoint: string;
  resources: Record<string, number>;
  capabilities: Array<{ capabilityId?: string; taskTypes?: string[]; qualities?: string[]; models?: string[]; modelRefs?: string[] }>;
  models: string[];
  assignedTenantIds: string[];
  maxConcurrent: number;
  status: string;
  queueDepth: number;
  isDrained: boolean;
  lastHeartbeatAt: string;
  updatedAt: string;
};

export type OpsNodeConfigDiff = {
  fields?: string[];
  inSync?: boolean;
} & Record<string, unknown>;

export type OpsNodeConfigEnvelope = {
  nodeId: string;
  desiredConfig: OpsNodeDesiredConfig | null;
  observedConfig: OpsNodeObservedConfig | null;
  diff: OpsNodeConfigDiff | null;
  appliedAt?: string;
  syncedBridgeTenantAssignments?: boolean;
};

export type OpsNodeDeployDefinition = {
  nodeId: string;
  source: "desired" | "observed";
  runtime: string;
  serviceName: string;
  deploymentContractVersion: string;
  imageHint: string;
  build: {
    context: string;
    dockerfile: string;
  };
  env: Record<string, string>;
  ports: string[];
  dependsOn: string[];
  networks: string[];
  warnings: string[];
  composeService: Record<string, unknown>;
};

export type OpsNodeDeployBundle = {
  generatedAt: string;
  nodeIds: string[];
  warnings: Array<{ nodeId: string; message: string }>;
  composeYaml: string;
  definitions: OpsNodeDeployDefinition[];
  export?: {
    path: string;
    bytes: number;
    nodeCount: number;
    warningCount: number;
    generatedAt: string;
  };
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

export type DetectionProviderRuntime = "yolo" | "mediapipe";
export type DetectionTaskType = "person_detection" | "object_detection" | "license_plate_detection" | "face_detection" | "pose_estimation";
export type DetectionQuality = "fast" | "balanced" | "accurate";

export type CameraDetectionPipeline = {
  pipelineId: string;
  provider: DetectionProviderRuntime;
  taskType: DetectionTaskType;
  quality: DetectionQuality;
  enabled: boolean;
  schedule?: {
    mode: "realtime" | "batch";
    frameStride: number;
  };
  thresholds?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

export type CameraDetectionProfile = {
  cameraId: string;
  tenantId: string;
  pipelines: CameraDetectionPipeline[];
  configVersion: number;
  updatedAt: string;
};

export type ModelCatalogEntry = {
  id: string;
  provider: DetectionProviderRuntime;
  taskType: DetectionTaskType;
  quality: DetectionQuality;
  modelRef: string;
  displayName: string;
  resources: Record<string, number>;
  defaults?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type DetectionTopologyCandidate = {
  nodeId: string;
  runtime: string;
  status: "online" | "degraded" | "offline";
  endpoint: string;
  maxConcurrent: number;
  queueDepth: number;
  isDrained: boolean;
  assignedTenantIds: string[];
  score: number;
  role: "primary" | "candidate" | "fallback";
};

export type DetectionTopologyPipeline = {
  pipelineId: string;
  provider: DetectionProviderRuntime;
  taskType: DetectionTaskType;
  quality: DetectionQuality;
  enabled: boolean;
  valid: boolean;
  runnable: boolean;
  inSync: boolean;
  resolvedModel: {
    id: string;
    modelRef: string;
    displayName: string;
    provider: DetectionProviderRuntime;
    taskType: DetectionTaskType;
    quality: DetectionQuality;
  } | null;
  assignment: {
    status: "assigned" | "degraded" | "unassigned" | "disabled";
    reason: string;
    primaryNodeId: string | null;
  };
  candidates: DetectionTopologyCandidate[];
  issues: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
};

export type DetectionTopology = {
  cameraId: string;
  tenantId: string;
  configVersion: number;
  updatedAt: string;
  valid: boolean;
  runnable: boolean;
  inSync: boolean;
  summary: {
    totalPipelines: number;
    enabledPipelines: number;
    validPipelines: number;
    runnablePipelines: number;
    driftedPipelines: number;
    assignedPipelines: number;
    degradedAssignments: number;
    totalCandidateNodes: number;
    activeCandidateNodes: number;
  };
  pipelines: DetectionTopologyPipeline[];
};

export const DETECTION_PROVIDER_OPTIONS: DetectionProviderRuntime[] = ["yolo", "mediapipe"];
export const DETECTION_TASK_OPTIONS: DetectionTaskType[] = [
  "person_detection",
  "object_detection",
  "license_plate_detection",
  "face_detection",
  "pose_estimation"
];
export const DETECTION_QUALITY_OPTIONS: DetectionQuality[] = ["fast", "balanced", "accurate"];

export type DeploymentStatusData = {
  generatedAt: string;
  overallOk: boolean;
  services: DeploymentServiceProbe[];
  nodes: {
    sourceOk: boolean;
    sourceError?: string | null;
    total: number;
    online: number;
    degraded: number;
    offline: number;
    drained: number;
    revokedEstimate: number;
    items: DeploymentNodeItem[];
  };
  topology: {
    tenants: Array<{
      tenantId: string;
      tenantName: string;
      cameras: Array<{
        cameraId: string;
        name: string;
        location?: string | null;
        isActive: boolean;
        lifecycleStatus: string;
        profile: { status: string; lastHealthAt?: string | null; lastError?: string | null } | null;
        health: { connectivity: string; latencyMs?: number | null; error?: string | null; checkedAt: string } | null;
      }>;
    }>;
  };
};

export type FaceDetectionItem = {
  id: string;
  tenantId: string;
  cameraId: string;
  observationId: string;
  detectorProvider: string;
  detectorTaskType: string;
  cropStorageKey?: string | null;
  qualityScore?: number | null;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  frameTs: string;
  createdAt: string;
  updatedAt: string;
  embedding?: {
    id: string;
    embeddingRef?: string | null;
    embeddingModelRef?: string | null;
    embeddingVersion?: string | null;
    qualityScore?: number | null;
    vectorNorm?: number | null;
    dimensions?: number | null;
  };
  cluster?: {
    id: string;
    status: string;
    displayName?: string | null;
    similarityScore?: number | null;
  };
  identity?: {
    id: string;
    displayName?: string | null;
    status: string;
  };
};

export type FaceSimilarityMatch = {
  similarityScore: number;
  sameCamera: boolean;
  face: FaceDetectionItem;
};

export type FaceSimilaritySearchResult = {
  sourceFaceId: string;
  tenantId: string;
  total: number;
  matches: FaceSimilarityMatch[];
};

export type FaceIdentitySummary = {
  id: string;
  tenantId: string;
  displayName?: string | null;
  status: string;
  mergedIntoIdentityId?: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  latestSeenAt?: string | null;
  cameras: Array<{ cameraId: string; cameraName: string; sightings: number }>;
  faces?: FaceDetectionItem[];
};

export type FaceIdentityDetail = FaceIdentitySummary & {
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
    sourceDisplayName?: string | null;
    targetIdentityId: string;
    targetDisplayName?: string | null;
    reason?: string | null;
    createdAt: string;
  }>;
  faces: FaceDetectionItem[];
};

export type CameraMonitorItem = {
  id: string;
  name: string;
  location?: string | null;
  isActive: boolean;
  lifecycleStatus?: string;
};

export type CameraFeedEntry = {
  playbackUrl?: string;
  expiresAt?: string;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

export type CameraStreamHealth = {
  status: "healthy" | "degraded" | "offline" | "unknown";
  message: string;
  liveEdgeLagMs?: number | null;
  checkedAt?: string | null;
};

export type ClientOverviewCameraRow = {
  id: string;
  name: string;
  location?: string | null;
  lifecycleStatus?: string | null;
  isActive: boolean;
  topology: DetectionTopology | null;
  topologyError?: string | null;
};

export function toPlaybackPublicUrl(rawPlaybackUrl: string) {
  const configuredPublicBase = import.meta.env.VITE_STREAM_GATEWAY_PUBLIC_URL?.trim();
  const fallbackPublicBase = `${window.location.protocol}//${window.location.hostname}:3010`;
  try {
    const url = new URL(rawPlaybackUrl);
    if (configuredPublicBase) {
      const publicBase = new URL(configuredPublicBase);
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
      return url.toString();
    }
    if (url.hostname === "stream-gateway") {
      const publicBase = new URL(fallbackPublicBase);
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
    }
    return url.toString();
  } catch {
    return rawPlaybackUrl;
  }
}

export function getStreamGatewayPublicBaseUrl() {
  const configuredPublicBase = import.meta.env.VITE_STREAM_GATEWAY_PUBLIC_URL?.trim();
  return configuredPublicBase || `${window.location.protocol}//${window.location.hostname}:3010`;
}

export function buildPlaybackUrl(args: { tenantId: string; cameraId: string; token: string }) {
  const base = new URL(getStreamGatewayPublicBaseUrl());
  base.pathname = `/playback/${encodeURIComponent(args.tenantId)}/${encodeURIComponent(args.cameraId)}/index.m3u8`;
  base.search = `token=${encodeURIComponent(args.token)}`;
  return base.toString();
}

export function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

export function matchesTopics(eventType: string, topics: string[]) {
  if (!topics.length) return true;
  return topics.some((topic) => eventType === topic || eventType.startsWith(`${topic}.`));
}

export function getToken() {
  return localStorage.getItem("nearhome_access_token");
}

export function getTenantId() {
  return localStorage.getItem("nearhome_active_tenant");
}

export function getImpersonateRole() {
  return localStorage.getItem("nearhome_impersonate_role");
}

export function getEffectiveRoleFromStorage() {
  const meRaw = localStorage.getItem("nearhome_me");
  if (!meRaw) return null;
  try {
    const me = JSON.parse(meRaw) as {
      context?: { effectiveRole?: string | null };
      user?: { isSuperuser?: boolean };
      memberships?: Array<{ tenantId: string; role: string }>;
    };
    if (me.context?.effectiveRole) return me.context.effectiveRole;
    if (me.user?.isSuperuser) return getImpersonateRole() ?? "super_admin";
    const activeTenant = getTenantId();
    return me.memberships?.find((membership) => membership.tenantId === activeTenant)?.role ?? null;
  } catch {
    return null;
  }
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

export function formatDetectionTask(taskType: DetectionTaskType) {
  switch (taskType) {
    case "person_detection":
      return "Personas";
    case "object_detection":
      return "Objetos";
    case "license_plate_detection":
      return "Patentes";
    case "face_detection":
      return "Caras";
    case "pose_estimation":
      return "Postura";
    default:
      return taskType;
  }
}

export function formatDetectionQuality(quality: DetectionQuality) {
  switch (quality) {
    case "fast":
      return "Rápida";
    case "balanced":
      return "Balanceada";
    case "accurate":
      return "Precisa";
    default:
      return quality;
  }
}

export function describePipelineAudienceState(pipeline: DetectionTopologyPipeline) {
  if (!pipeline.enabled) {
    return {
      tone: "neutral",
      label: "Desactivado",
      detail: "Este análisis está configurado pero hoy no corre sobre la cámara."
    } as const;
  }
  if (pipeline.assignment.status === "assigned" && pipeline.valid && pipeline.runnable && pipeline.inSync) {
    return {
      tone: "good",
      label: "Operativo",
      detail: pipeline.assignment.primaryNodeId
        ? `Corriendo sobre ${pipeline.assignment.primaryNodeId} con ${formatDetectionQuality(pipeline.quality).toLowerCase()}.`
        : "La detección está resuelta y lista para producción."
    } as const;
  }
  if (pipeline.assignment.status === "degraded" || !pipeline.inSync) {
    return {
      tone: "warn",
      label: "Con riesgo",
      detail: pipeline.assignment.reason || "Hay drift entre configuración y nodos disponibles."
    } as const;
  }
  return {
    tone: "bad",
    label: "Sin cobertura",
    detail: pipeline.assignment.reason || "No hay capacidad compatible para este pipeline."
  } as const;
}

export function getAudienceToneClasses(tone: "good" | "warn" | "bad" | "neutral") {
  if (tone === "good") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (tone === "warn") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "bad") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function summarizeFaceLabel(face: FaceDetectionItem) {
  const cropKey = face.cropStorageKey?.split("/").pop();
  if (cropKey) return cropKey;
  return `face-${face.id.slice(0, 8)}`;
}

export function formatFaceIdentityName(identity: { id: string; displayName?: string | null }) {
  return identity.displayName?.trim() || identity.id;
}

export function summarizeTopologyRisks(topology: DetectionTopology) {
  const items: string[] = [];
  if (topology.summary.driftedPipelines > 0) {
    items.push(`${topology.summary.driftedPipelines} pipeline${topology.summary.driftedPipelines === 1 ? "" : "s"} con drift de configuración`);
  }
  if (topology.summary.degradedAssignments > 0) {
    items.push(`${topology.summary.degradedAssignments} pipeline${topology.summary.degradedAssignments === 1 ? "" : "s"} operando con degradación`);
  }
  if (!topology.runnable) {
    items.push("la cámara no tiene cobertura completa con los nodos actuales");
  }
  return items;
}

export function hasBackofficeAccess(me: any) {
  if (me?.user?.isSuperuser) return true;
  return (me?.memberships ?? []).some((membership: any) => membership.role === "tenant_admin" || membership.role === "monitor");
}

export function summarizeApiError(error: unknown, fallback: string) {
  const err = error as {
    message?: string;
    statusCode?: number;
    response?: { status?: number; data?: unknown };
    data?: unknown;
  };
  const status = err.response?.status ?? err.statusCode;
  const payload = (err.response?.data ?? err.data) as
    | { code?: unknown; message?: unknown; details?: unknown }
    | string
    | undefined;

  if (payload && typeof payload === "object") {
    const code = typeof payload.code === "string" ? payload.code : null;
    const message = typeof payload.message === "string" ? payload.message : null;
    const details =
      payload.details !== undefined
        ? typeof payload.details === "string"
          ? payload.details
          : JSON.stringify(payload.details)
        : null;
    const parts = [code, message, details].filter(Boolean) as string[];
    if (parts.length > 0) return status ? `[${status}] ${parts.join(" | ")}` : parts.join(" | ");
  }

  if (typeof payload === "string" && payload.trim().length > 0) {
    return status ? `[${status}] ${payload}` : payload;
  }
  if (err.message && err.message.trim().length > 0) {
    return status ? `[${status}] ${err.message}` : err.message;
  }
  return status ? `[${status}] ${fallback}` : fallback;
}

export async function summarizeApiErrorResponse(response: Response, fallback: string) {
  let payload: { code?: unknown; message?: unknown; details?: unknown } | null = null;
  let text = "";
  try {
    payload = (await response.json()) as { code?: unknown; message?: unknown; details?: unknown };
  } catch {
    text = await response.text();
  }
  const code = typeof payload?.code === "string" ? payload.code : null;
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : text.trim().length > 0
        ? text
        : fallback;
  const details =
    payload?.details !== undefined
      ? typeof payload.details === "string"
        ? payload.details
        : JSON.stringify(payload.details)
      : null;
  const parts = [code, message, details].filter(Boolean).join(" | ");
  return `[${response.status}] ${parts || fallback}`;
}

export function useSession(apiUrl: string) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<any>(null);
  const navigate = useNavigate();

  const refresh = async () => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      setMe(null);
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(getTenantId() ? { "X-Tenant-Id": getTenantId()! } : {}),
          ...(getImpersonateRole() ? { "X-Impersonate-Role": getImpersonateRole()! } : {})
        }
      });
      if (!res.ok) {
        localStorage.removeItem("nearhome_access_token");
        localStorage.removeItem("nearhome_active_tenant");
        localStorage.removeItem("nearhome_impersonate_role");
        setMe(null);
        setLoading(false);
        navigate("/login");
        return;
      }

      const data = await res.json();
      if (!hasBackofficeAccess(data)) {
        localStorage.removeItem("nearhome_access_token");
        localStorage.removeItem("nearhome_active_tenant");
        localStorage.removeItem("nearhome_impersonate_role");
        setMe(null);
        setLoading(false);
        navigate("/login");
        return;
      }
      localStorage.setItem("nearhome_me", JSON.stringify(data));
      if (!getTenantId() && data.memberships?.[0]?.tenantId) {
        localStorage.setItem("nearhome_active_tenant", data.memberships[0].tenantId);
      }
      setMe(data);
      setLoading(false);
    } catch {
      localStorage.removeItem("nearhome_access_token");
      localStorage.removeItem("nearhome_active_tenant");
      localStorage.removeItem("nearhome_impersonate_role");
      setMe(null);
      setLoading(false);
      navigate("/login");
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { loading, me, refresh };
}
