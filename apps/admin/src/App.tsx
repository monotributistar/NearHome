import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useCan, useDelete, useList, useUpdate, useCreate } from "@refinedev/core";
import {
  AppShell,
  PageCard,
  PrimaryButton,
  TextInput,
  SelectInput,
  DangerButton,
  Badge,
  WorkspaceShell,
  Surface,
  DataTable,
  type WorkspaceNavGroup
} from "@app/ui";
import {
  BellNotification,
  Camera,
  Group,
  HomeAlt,
  Internet,
  MediaImageList,
  Planimetry,
  Settings,
  User
} from "iconoir-react";
import Hls from "hls.js";

type AppProps = { apiUrl: string };
const EVENT_GATEWAY_URL = import.meta.env.VITE_EVENT_GATEWAY_URL ?? "http://localhost:3011";
const ADMIN_ROUTES = {
  operations: {
    control: "/operations/control",
    monitor: "/operations/monitor",
    realtime: "/operations/realtime",
    nodes: "/operations/nodes"
  },
  resources: {
    clientOverview: "/resources/client-overview",
    cameras: "/resources/cameras",
    cameraDetail: (id: string) => `/resources/cameras/${id}`,
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
  }
} as const;

type RealtimeEvent = {
  eventId: string;
  eventType: string;
  tenantId: string;
  occurredAt: string;
  sequence: number;
  payload: Record<string, unknown>;
};

type DeploymentServiceProbe = {
  name: string;
  target: string;
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
};

type DeploymentNodeItem = {
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

type OpsNodeSnapshot = {
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

type OpsNodeDesiredConfig = {
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

type OpsNodeObservedConfig = {
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

type OpsNodeConfigDiff = {
  fields?: string[];
  inSync?: boolean;
} & Record<string, unknown>;

type OpsNodeConfigEnvelope = {
  nodeId: string;
  desiredConfig: OpsNodeDesiredConfig | null;
  observedConfig: OpsNodeObservedConfig | null;
  diff: OpsNodeConfigDiff | null;
  appliedAt?: string;
  syncedBridgeTenantAssignments?: boolean;
};

type DetectionProviderRuntime = "yolo" | "mediapipe";
type DetectionTaskType = "person_detection" | "object_detection" | "license_plate_detection" | "face_detection" | "pose_estimation";
type DetectionQuality = "fast" | "balanced" | "accurate";

type CameraDetectionPipeline = {
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

type CameraDetectionProfile = {
  cameraId: string;
  tenantId: string;
  pipelines: CameraDetectionPipeline[];
  configVersion: number;
  updatedAt: string;
};

type ModelCatalogEntry = {
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

type DetectionTopologyCandidate = {
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

type DetectionTopologyPipeline = {
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

type DetectionTopology = {
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

const DETECTION_PROVIDER_OPTIONS: DetectionProviderRuntime[] = ["yolo", "mediapipe"];
const DETECTION_TASK_OPTIONS: DetectionTaskType[] = [
  "person_detection",
  "object_detection",
  "license_plate_detection",
  "face_detection",
  "pose_estimation"
];
const DETECTION_QUALITY_OPTIONS: DetectionQuality[] = ["fast", "balanced", "accurate"];

type DeploymentStatusData = {
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
};

type FaceDetectionItem = {
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

type FaceSimilarityMatch = {
  similarityScore: number;
  sameCamera: boolean;
  face: FaceDetectionItem;
};

type FaceSimilaritySearchResult = {
  sourceFaceId: string;
  tenantId: string;
  total: number;
  matches: FaceSimilarityMatch[];
};

type CameraMonitorItem = {
  id: string;
  name: string;
  location?: string | null;
  isActive: boolean;
  lifecycleStatus?: string;
};

type CameraFeedEntry = {
  playbackUrl?: string;
  expiresAt?: string;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

type CameraStreamHealth = {
  status: "healthy" | "degraded" | "offline" | "unknown";
  message: string;
  liveEdgeLagMs?: number | null;
  checkedAt?: string | null;
};

type ClientOverviewCameraRow = {
  id: string;
  name: string;
  location?: string | null;
  lifecycleStatus?: string | null;
  isActive: boolean;
  topology: DetectionTopology | null;
  topologyError?: string | null;
};

function toPlaybackPublicUrl(rawPlaybackUrl: string) {
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

function getStreamGatewayPublicBaseUrl() {
  const configuredPublicBase = import.meta.env.VITE_STREAM_GATEWAY_PUBLIC_URL?.trim();
  return configuredPublicBase || `${window.location.protocol}//${window.location.hostname}:3010`;
}

function buildPlaybackUrl(args: { tenantId: string; cameraId: string; token: string }) {
  const base = new URL(getStreamGatewayPublicBaseUrl());
  base.pathname = `/playback/${encodeURIComponent(args.tenantId)}/${encodeURIComponent(args.cameraId)}/index.m3u8`;
  base.search = `token=${encodeURIComponent(args.token)}`;
  return base.toString();
}

function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function matchesTopics(eventType: string, topics: string[]) {
  if (!topics.length) return true;
  return topics.some((topic) => eventType === topic || eventType.startsWith(`${topic}.`));
}

function getToken() {
  return localStorage.getItem("nearhome_access_token");
}

function getTenantId() {
  return localStorage.getItem("nearhome_active_tenant");
}

function getImpersonateRole() {
  return localStorage.getItem("nearhome_impersonate_role");
}

function getEffectiveRoleFromStorage() {
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

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatDetectionTask(taskType: DetectionTaskType) {
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

function formatDetectionQuality(quality: DetectionQuality) {
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

function describePipelineAudienceState(pipeline: DetectionTopologyPipeline) {
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

function getAudienceToneClasses(tone: "good" | "warn" | "bad" | "neutral") {
  if (tone === "good") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (tone === "warn") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "bad") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function summarizeFaceLabel(face: FaceDetectionItem) {
  const cropKey = face.cropStorageKey?.split("/").pop();
  if (cropKey) return cropKey;
  return `face-${face.id.slice(0, 8)}`;
}

function summarizeTopologyRisks(topology: DetectionTopology) {
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

function hasBackofficeAccess(me: any) {
  if (me?.user?.isSuperuser) return true;
  return (me?.memberships ?? []).some((membership: any) => membership.role === "tenant_admin" || membership.role === "monitor");
}

function summarizeApiError(error: unknown, fallback: string) {
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

async function summarizeApiErrorResponse(response: Response, fallback: string) {
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

function useSession(apiUrl: string) {
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

function LoginPage({ apiUrl }: { apiUrl: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@nearhome.dev");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, audience: "backoffice" })
    });

    if (!res.ok) {
      setError(res.status === 403 ? "Usuario sin acceso al backoffice" : "Credenciales inválidas");
      return;
    }

    const data = await res.json();
    localStorage.setItem("nearhome_access_token", data.accessToken);
    localStorage.removeItem("nearhome_impersonate_role");
    navigate("/");
  }

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="NearHome Admin Login">
          <form className="space-y-3" onSubmit={onSubmit}>
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
            <PrimaryButton type="submit" className="w-full">
              Login
            </PrimaryButton>
          </form>
        </PageCard>
      </div>
    </AppShell>
  );
}

function Layout({ apiUrl }: { apiUrl: string }) {
  const { loading, me, refresh } = useSession(apiUrl);
  const navigate = useNavigate();

  if (loading) return <div className="p-6">Loading...</div>;
  if (!me) return <Navigate to="/login" replace />;

  const activeTenant = getTenantId();
  const persistedImpersonationRole = getImpersonateRole();
  const role =
    me?.context?.effectiveRole ??
    (me?.user?.isSuperuser ? (persistedImpersonationRole ?? "super_admin") : me.memberships?.find((m: any) => m.tenantId === activeTenant)?.role);
  const isClientRole = role === "client_user";
  const navigation: WorkspaceNavGroup[] = isClientRole
    ? [
        {
          title: "Seguimiento",
          items: [
            { to: ADMIN_ROUTES.resources.clientOverview, label: "Resumen Cliente", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.cameras, label: "Cámaras", icon: <Camera width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.notifications, label: "Notificaciones", icon: <BellNotification width={16} height={16} /> }
          ]
        }
      ]
    : [
        {
          title: "Operaciones",
          items: [
            { to: ADMIN_ROUTES.operations.control, label: "Control Operativo", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.monitor, label: "Monitor", icon: <MediaImageList width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.realtime, label: "Tiempo Real", icon: <Internet width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.nodes, label: "Nodos", icon: <Settings width={16} height={16} /> }
          ]
        },
        {
          title: "Recursos",
          items: [
            { to: ADMIN_ROUTES.resources.clientOverview, label: "Resumen Cliente", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.cameras, label: "Cámaras", icon: <Camera width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.notifications, label: "Notificaciones", icon: <BellNotification width={16} height={16} /> }
          ]
        },
        {
          title: "Identidad y Acceso",
          items: [
            { to: ADMIN_ROUTES.identity.tenants, label: "Tenants", icon: <Group width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.users, label: "Usuarios", icon: <User width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.memberships, label: "Membresías", icon: <Group width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.cameraAssignments, label: "Scope Cámaras", icon: <Camera width={16} height={16} /> }
          ]
        },
        {
          title: "Comercial",
          items: [
            { to: ADMIN_ROUTES.commercial.plans, label: "Planes", icon: <Planimetry width={16} height={16} /> },
            { to: ADMIN_ROUTES.commercial.subscriptions, label: "Suscripciones", icon: <Planimetry width={16} height={16} /> }
          ]
        }
      ];

  return (
    <WorkspaceShell
      product="NearHome Backoffice"
      subtitle="Panel operativo para administradores y operadores"
      role={<Badge data-testid="current-role">{role ?? "no-role"}</Badge>}
      tenantSwitcher={
        <div className="flex items-center gap-2">
          <SelectInput
            className="w-[220px]"
            value={activeTenant ?? ""}
            onChange={(e) => {
              localStorage.setItem("nearhome_active_tenant", e.target.value);
              refresh();
            }}
          >
            {me.memberships?.map((m: any) => (
              <option key={m.tenantId} value={m.tenantId}>
                {m.tenant.name}
              </option>
            ))}
          </SelectInput>
          {me?.user?.isSuperuser ? (
            <SelectInput
              className="w-[190px]"
              value={persistedImpersonationRole ?? "super_admin"}
              onChange={(e) => {
                const selectedRole = e.target.value;
                if (selectedRole === "super_admin") {
                  localStorage.removeItem("nearhome_impersonate_role");
                } else {
                  localStorage.setItem("nearhome_impersonate_role", selectedRole);
                }
                refresh();
              }}
            >
              <option value="super_admin">super_admin</option>
              <option value="tenant_admin">tenant_admin</option>
              <option value="monitor">monitor</option>
              <option value="client_user">client_user</option>
            </SelectInput>
          ) : null}
        </div>
      }
      onLogout={() => {
        localStorage.removeItem("nearhome_access_token");
        localStorage.removeItem("nearhome_active_tenant");
        localStorage.removeItem("nearhome_impersonate_role");
        navigate("/login");
      }}
      navigation={navigation}
    >
      <Routes>
        <Route path="/" element={<Navigate to={isClientRole ? ADMIN_ROUTES.resources.clientOverview : ADMIN_ROUTES.operations.control} replace />} />

        <Route path={ADMIN_ROUTES.operations.control} element={<ControlPanelPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.monitor} element={<MonitorPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.nodes} element={<DetectionNodesPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.realtime} element={<RealtimePage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.resources.clientOverview} element={<ClientOverviewPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.resources.cameras} element={<CamerasPage />} />
        <Route path="/resources/cameras/:id" element={<CameraShow />} />
        <Route path={ADMIN_ROUTES.resources.notifications} element={<NotificationsPage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.identity.tenants} element={<TenantsPage />} />
        <Route path={ADMIN_ROUTES.identity.users} element={<UsersPage />} />
        <Route path={ADMIN_ROUTES.identity.memberships} element={<MembershipsPage />} />
        <Route path={ADMIN_ROUTES.identity.cameraAssignments} element={<CameraAssignmentsPage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.commercial.plans} element={<PlansPage />} />
        <Route path={ADMIN_ROUTES.commercial.subscriptions} element={<SubscriptionPage apiUrl={apiUrl} onChanged={refresh} />} />

        <Route path="/control" element={<Navigate to={ADMIN_ROUTES.operations.control} replace />} />
        <Route path="/monitor" element={<Navigate to={ADMIN_ROUTES.operations.monitor} replace />} />
        <Route path="/nodes" element={<Navigate to={ADMIN_ROUTES.operations.nodes} replace />} />
        <Route path="/realtime" element={<Navigate to={ADMIN_ROUTES.operations.realtime} replace />} />
        <Route path="/client-overview" element={<Navigate to={ADMIN_ROUTES.resources.clientOverview} replace />} />
        <Route path="/cameras" element={<Navigate to={ADMIN_ROUTES.resources.cameras} replace />} />
        <Route path="/cameras/:id" element={<LegacyCameraDetailRedirect />} />
        <Route path="/notifications" element={<Navigate to={ADMIN_ROUTES.resources.notifications} replace />} />
        <Route path="/tenants" element={<Navigate to={ADMIN_ROUTES.identity.tenants} replace />} />
        <Route path="/users" element={<Navigate to={ADMIN_ROUTES.identity.users} replace />} />
        <Route path="/memberships" element={<Navigate to={ADMIN_ROUTES.identity.memberships} replace />} />
        <Route path="/camera-assignments" element={<Navigate to={ADMIN_ROUTES.identity.cameraAssignments} replace />} />
        <Route path="/plans" element={<Navigate to={ADMIN_ROUTES.commercial.plans} replace />} />
        <Route path="/subscriptions" element={<Navigate to={ADMIN_ROUTES.commercial.subscriptions} replace />} />
      </Routes>
    </WorkspaceShell>
  );
}

function LegacyCameraDetailRedirect() {
  const { id } = useParams();
  if (!id) return <Navigate to={ADMIN_ROUTES.resources.cameras} replace />;
  return <Navigate to={ADMIN_ROUTES.resources.cameraDetail(id)} replace />;
}

function ControlPanelPage({ apiUrl }: { apiUrl: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DeploymentStatusData | null>(null);

  async function refreshStatus() {
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/deployment/status`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error(`deployment status ${res.status}`);
      const body = await res.json();
      setData(body.data as DeploymentStatusData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  if (loading && !data) return <PageCard title="Control Panel">Loading deployment status...</PageCard>;

  return (
    <div className="space-y-4">
      <PageCard title="Control Panel">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge className={data?.overallOk ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>
            overall: {data?.overallOk ? "ok" : "degraded"}
          </Badge>
          <span className="text-sm text-slate-500">
            updated: {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : "-"}
          </span>
          <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void refreshStatus()}>
            Refresh
          </PrimaryButton>
        </div>
        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <Surface className="text-sm">
            <div className="font-semibold">Services</div>
            <div>{data?.services.length ?? 0}</div>
          </Surface>
          <Surface className="text-sm">
            <div className="font-semibold">Nodes online</div>
            <div>{data?.nodes.online ?? 0}</div>
          </Surface>
          <Surface className="text-sm">
            <div className="font-semibold">Nodes degraded</div>
            <div>{data?.nodes.degraded ?? 0}</div>
          </Surface>
          <Surface className="text-sm">
            <div className="font-semibold">Nodes offline</div>
            <div>{data?.nodes.offline ?? 0}</div>
          </Surface>
          <Surface className="text-sm">
            <div className="font-semibold">Drained</div>
            <div>{data?.nodes.drained ?? 0}</div>
          </Surface>
        </div>
      </PageCard>

      <PageCard title="Service Status">
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Service</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">HTTP</th>
              <th className="px-3 py-2">Latency</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.services ?? []).map((service) => (
              <tr key={service.name}>
                <td className="px-3 py-2">{service.name}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{service.target}</td>
                <td className="px-3 py-2">
                  <Badge className={service.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>
                    {service.ok ? "ok" : "down"}
                  </Badge>
                </td>
                <td className="px-3 py-2">{service.statusCode ?? "-"}</td>
                <td className="px-3 py-2">{service.latencyMs ?? "-"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{service.error ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </PageCard>

      <PageCard title="Node Registry">
        {!data?.nodes.sourceOk && data?.nodes.sourceError && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            node source error: {data.nodes.sourceError}
          </div>
        )}
        <div className="mb-3 text-sm text-slate-600">
          total: {data?.nodes.total ?? 0} | revoked estimate: {data?.nodes.revokedEstimate ?? 0}
        </div>
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Node</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">Runtime</th>
              <th className="px-3 py-2">Endpoint</th>
              <th className="px-3 py-2">Queue</th>
              <th className="px-3 py-2">Max</th>
              <th className="px-3 py-2">Drained</th>
              <th className="px-3 py-2">Resources</th>
              <th className="px-3 py-2">Capabilities</th>
              <th className="px-3 py-2">Models</th>
              <th className="px-3 py-2">Contract</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.nodes.items ?? []).map((node, idx) => (
              <tr key={node.nodeId ?? `node-${idx}`}>
                <td className="px-3 py-2">{node.nodeId ?? "-"}</td>
                <td className="px-3 py-2">
                  <Badge
                    className={
                      node.status === "online"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : node.status === "degraded"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-rose-200 bg-rose-50 text-rose-700"
                    }
                  >
                    {node.status ?? "-"}
                  </Badge>
                </td>
                <td className="px-3 py-2">{node.tenantId ?? "-"}</td>
                <td className="px-3 py-2">{node.runtime ?? "-"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{node.endpoint ?? "-"}</td>
                <td className="px-3 py-2">{node.queueDepth ?? 0}</td>
                <td className="px-3 py-2">{node.maxConcurrent ?? 0}</td>
                <td className="px-3 py-2">{node.isDrained ? "yes" : "no"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {node.resources
                    ? Object.entries(node.resources)
                        .map(([key, value]) => `${key}:${String(value)}`)
                        .join(", ")
                    : "-"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {(node.capabilities ?? [])
                    .flatMap((cap) => cap.taskTypes ?? [])
                    .join(", ") || "-"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">{(node.models ?? []).join(", ") || "-"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{node.contractVersion ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </PageCard>

      <PageCard title="Architecture Hierarchy">
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <Surface>
            <div className="mb-1 font-semibold">Control Plane</div>
            <div>API</div>
            <div>Admin UI / Portal UI</div>
          </Surface>
          <Surface>
            <div className="mb-1 font-semibold">Data Plane</div>
            <div>Stream Gateway</div>
            <div>Vault local/remote</div>
          </Surface>
          <Surface>
            <div className="mb-1 font-semibold">Event Plane</div>
            <div>Event Gateway</div>
            <div>Realtime SSE/WS</div>
          </Surface>
          <Surface>
            <div className="mb-1 font-semibold">Detection Plane</div>
            <div>Inference Bridge</div>
            <div>Dispatcher + Temporal + Worker + Nodes</div>
          </Surface>
        </div>
      </PageCard>
    </div>
  );
}

function TenantsPage() {
  const tenantsList = useList({ resource: "tenants" } as any);
  const { result } = tenantsList;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const { mutate: remove } = useDelete();
  const [name, setName] = useState("");
  const canCreate = useCan({ resource: "tenants", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "tenants", action: "edit" }).data?.can;
  const canDelete = useCan({ resource: "tenants", action: "delete" }).data?.can;
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries((result?.data ?? []).map((t: any) => [t.id, t.name ?? ""]));
    setDrafts(nextDrafts);
  }, [result?.data]);

  return (
    <PageCard title="Tenants">
      {canCreate && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "tenants", values: { name } },
              {
                onSuccess: () => {
                  (tenantsList as any).query.refetch();
                }
              }
            );
            setName("");
          }}
        >
          <TextInput placeholder="Tenant name" value={name} onChange={(e) => setName(e.target.value)} />
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}
      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Created</th>
            {(canEdit || canDelete) && <th className="px-3 py-2">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(result?.data ?? []).map((t: any) => (
            <tr key={t.id}>
              <td className="px-3 py-2">
                {canEdit ? (
                  <TextInput
                    data-testid={`tenant-name-${t.id}`}
                    value={drafts[t.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  />
                ) : (
                  t.name
                )}
              </td>
              <td className="px-3 py-2">{new Date(t.createdAt).toLocaleString()}</td>
              {(canEdit || canDelete) && (
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {canEdit && (
                      <PrimaryButton
                        data-testid={`tenant-save-${t.id}`}
                        className="px-2 py-1 text-xs"
                        type="button"
                        onClick={() =>
                          update(
                            {
                              resource: "tenants",
                              id: t.id,
                              values: { name: drafts[t.id] ?? t.name }
                            },
                            {
                              onSuccess: () => {
                                (tenantsList as any).query.refetch();
                              }
                            }
                          )
                        }
                      >
                        Save
                      </PrimaryButton>
                    )}
                    {canDelete && (
                      <DangerButton
                        data-testid={`tenant-delete-${t.id}`}
                        className="px-2 py-1 text-xs"
                        type="button"
                        onClick={() =>
                          remove(
                            {
                              resource: "tenants",
                              id: t.id
                            },
                            {
                              onSuccess: () => {
                                (tenantsList as any).query.refetch();
                              }
                            }
                          )
                        }
                      >
                        Delete
                      </DangerButton>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </PageCard>
  );
}

function UsersPage() {
  const usersList = useList({ resource: "users" } as any);
  const result = usersList.result;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const canCreate = useCan({ resource: "users", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "users", action: "edit" }).data?.can;

  const [form, setForm] = useState({ email: "", name: "", password: "demo1234", role: "client_user" });
  const [rowDrafts, setRowDrafts] = useState<Record<string, { name: string; role: string; isActive: boolean }>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      (result?.data ?? []).map((u: any) => [
        u.id,
        {
          name: u.name ?? "",
          role: u.role ?? "client_user",
          isActive: Boolean(u.isActive)
        }
      ])
    );
    setRowDrafts(nextDrafts);
  }, [result?.data]);

  const users = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Users">
      {canCreate && (
        <form
          data-testid="users-create-form"
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "users", values: form },
              {
                onSuccess: () => {
                  setForm({ email: "", name: "", password: "demo1234", role: "client_user" });
                  (usersList as any).query.refetch();
                }
              }
            );
          }}
        >
          <TextInput
            placeholder="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <TextInput
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <TextInput
            placeholder="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
          <SelectInput value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">operator</option>
            <option value="client_user">customer</option>
          </SelectInput>
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Status</th>
            {canEdit && <th className="px-3 py-2">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u: any) => (
            <tr key={u.id}>
              <td className="px-3 py-2">{u.email}</td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <TextInput
                    data-testid={`users-name-${u.id}`}
                    value={rowDrafts[u.id]?.name ?? ""}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), name: e.target.value }
                      }))
                    }
                  />
                ) : (
                  u.name
                )}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <SelectInput
                    data-testid={`users-role-${u.id}`}
                    value={rowDrafts[u.id]?.role ?? "client_user"}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), role: e.target.value }
                      }))
                    }
                  >
                    <option value="tenant_admin">tenant_admin</option>
                    <option value="monitor">operator</option>
                    <option value="client_user">customer</option>
                  </SelectInput>
                ) : (
                  u.role
                )}
              </td>
              <td className="px-3 py-2">
                <Badge className={rowDrafts[u.id]?.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                  {rowDrafts[u.id]?.isActive ? "active" : "inactive"}
                </Badge>
              </td>
              {canEdit && (
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton
                      data-testid={`users-save-${u.id}`}
                      className="px-2 py-1 text-xs"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: {
                              name: rowDrafts[u.id]?.name,
                              role: rowDrafts[u.id]?.role
                            }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      Save
                    </PrimaryButton>
                    <PrimaryButton
                      data-testid={`users-toggle-${u.id}`}
                      className="px-2 py-1 text-xs"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: { isActive: !rowDrafts[u.id]?.isActive }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      {rowDrafts[u.id]?.isActive ? "Disable" : "Enable"}
                    </PrimaryButton>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </PageCard>
  );
}

function MembershipsPage() {
  const { result } = useList({ resource: "memberships" } as any);
  const { mutate } = useCreate();
  const canCreate = useCan({ resource: "memberships", action: "create" }).data?.can;
  const meRaw = localStorage.getItem("nearhome_me");
  const me = meRaw ? JSON.parse(meRaw) : null;
  const isSuperuser = Boolean(me?.user?.isSuperuser);
  const tenantOptions = me?.memberships ?? [];
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("client_user");
  const [tenantId, setTenantId] = useState<string>(tenantOptions[0]?.tenantId ?? "");

  useEffect(() => {
    if (!tenantId && tenantOptions[0]?.tenantId) {
      setTenantId(tenantOptions[0].tenantId);
    }
  }, [tenantId, tenantOptions]);

  return (
    <PageCard title="Memberships">
      {canCreate && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutate({ resource: "memberships", values: { userId, role, ...(isSuperuser ? { tenantId } : {}) } });
            setUserId("");
          }}
        >
          <TextInput placeholder="userId" value={userId} onChange={(e) => setUserId(e.target.value)} />
          <SelectInput value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">operator</option>
            <option value="client_user">customer</option>
          </SelectInput>
          {isSuperuser && (
            <SelectInput value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenantOptions.map((membership: any) => (
                <option key={membership.tenantId} value={membership.tenantId}>
                  {membership.tenant?.name ?? membership.tenantId}
                </option>
              ))}
            </SelectInput>
          )}
          <PrimaryButton type="submit">Assign role</PrimaryButton>
        </form>
      )}
      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Tenant</th>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(result?.data ?? []).map((m: any) => (
            <tr key={m.id}>
              <td className="px-3 py-2">{m.tenant?.name ?? m.tenantId}</td>
              <td className="px-3 py-2">{m.user?.email ?? m.userId}</td>
              <td className="px-3 py-2">{m.role}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </PageCard>
  );
}

function CameraAssignmentsPage({ apiUrl }: { apiUrl: string }) {
  const canEdit = useCan({ resource: "users", action: "edit" }).data?.can;
  const usersList = useList({ resource: "users", pagination: { currentPage: 1, pageSize: 200, mode: "server" } } as any);
  const camerasList = useList({ resource: "cameras", pagination: { currentPage: 1, pageSize: 200, mode: "server" } } as any);
  const users = useMemo(
    () => (usersList.result?.data ?? []).filter((user: any) => ["monitor", "client_user"].includes(user.role)),
    [usersList.result?.data]
  );
  const cameras = useMemo(() => camerasList.result?.data ?? [], [camerasList.result?.data]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [assignedCameraIds, setAssignedCameraIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedUserId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiUrl}/camera-assignments?userId=${encodeURIComponent(selectedUserId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Tenant-Id": tenantId
            }
          }
        );
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`camera-assignments ${res.status}: ${body}`);
        }
        const body = await res.json();
        const ids = (body.data ?? []).map((entry: any) => String(entry.cameraId));
        setAssignedCameraIds(ids);
      } catch (cause) {
        setError(summarizeApiError(cause, "No se pudo cargar scope de cámaras"));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [apiUrl, selectedUserId]);

  const selectedUser = users.find((user: any) => user.id === selectedUserId);

  return (
    <PageCard title="Scope de cámaras por usuario">
      <div className="mb-3 text-sm opacity-70">
        Sin asignaciones explícitas, monitor/customer ven todas las cámaras del tenant. Al asignar cámaras, se aplica allowlist.
      </div>
      {!canEdit && <div className="alert alert-warning py-2 text-sm">No tenés permisos para administrar scopes.</div>}

      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2">
        <SelectInput value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} disabled={!canEdit}>
          <option value="">Seleccionar usuario</option>
          {users.map((user: any) => (
            <option key={user.id} value={user.id}>
              {user.email} ({user.role === "monitor" ? "operator" : "customer"})
            </option>
          ))}
        </SelectInput>
        <div className="rounded-box border border-base-300 px-3 py-2 text-sm">
          {selectedUser ? (
            <>
              <div>usuario: {selectedUser.email}</div>
              <div>rol: {selectedUser.role === "monitor" ? "operator" : "customer"}</div>
            </>
          ) : (
            <div>Seleccioná un usuario para editar su scope</div>
          )}
        </div>
      </div>

      {selectedUserId && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge>{assignedCameraIds.length} asignadas</Badge>
            <Badge>{cameras.length} cámaras tenant</Badge>
            {loading && <Badge>cargando...</Badge>}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {cameras.map((camera: any) => (
              <label key={camera.id} className="flex items-center gap-2 rounded-box border border-base-300 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={assignedCameraIds.includes(camera.id)}
                  onChange={(e) =>
                    setAssignedCameraIds((prev) =>
                      e.target.checked ? Array.from(new Set([...prev, camera.id])) : prev.filter((value) => value !== camera.id)
                    )
                  }
                  disabled={!canEdit || saving}
                />
                <span className="font-medium">{camera.name}</span>
                <span className="opacity-70">({camera.location || "-"})</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <PrimaryButton
              type="button"
              disabled={!canEdit || saving}
              onClick={async () => {
                const token = getToken();
                const tenantId = getTenantId();
                if (!token || !tenantId || !selectedUserId) {
                  setError("Missing auth context");
                  return;
                }
                setSaving(true);
                setError(null);
                setOk(null);
                try {
                  const res = await fetch(`${apiUrl}/camera-assignments/${encodeURIComponent(selectedUserId)}`, {
                    method: "PUT",
                    headers: {
                      "content-type": "application/json",
                      Authorization: `Bearer ${token}`,
                      "X-Tenant-Id": tenantId
                    },
                    body: JSON.stringify({ cameraIds: assignedCameraIds })
                  });
                  if (!res.ok) {
                    const body = await res.text();
                    throw new Error(`camera-assignments save ${res.status}: ${body}`);
                  }
                  setOk("Scope guardado");
                } catch (cause) {
                  setError(summarizeApiError(cause, "No se pudo guardar scope"));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Guardar scope
            </PrimaryButton>
            <button
              className="btn"
              type="button"
              disabled={!canEdit || saving}
              onClick={() => setAssignedCameraIds([])}
            >
              Limpiar (ver todas)
            </button>
          </div>
          {error && <div className="alert alert-error mt-3 py-2 text-sm">{error}</div>}
          {ok && <div className="alert alert-success mt-3 py-2 text-sm">{ok}</div>}
        </>
      )}
    </PageCard>
  );
}

function ClientOverviewPage({ apiUrl }: { apiUrl: string }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ClientOverviewCameraRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "attention" | "not_configured">("all");

  async function loadOverview() {
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setError("Missing auth context");
      setLoading(false);
      return;
    }

    setRefreshing(true);
    setError(null);
    try {
      const camerasResponse = await fetch(`${apiUrl}/cameras?_start=0&_end=100&_sort=createdAt&_order=DESC`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!camerasResponse.ok) {
        throw new Error(await summarizeApiErrorResponse(camerasResponse, "No se pudo cargar el resumen de cámaras"));
      }
      const cameraBody = (await camerasResponse.json()) as { data?: any[] };
      const cameras = cameraBody.data ?? [];

      const topologyResults = await Promise.all(
        cameras.map(async (camera: any) => {
          try {
            const topologyResponse = await fetch(`${apiUrl}/cameras/${camera.id}/detection-topology`, {
              headers: {
                Authorization: `Bearer ${token}`,
                "X-Tenant-Id": tenantId
              }
            });
            if (!topologyResponse.ok) {
              return {
                id: camera.id,
                name: camera.name,
                location: camera.location,
                lifecycleStatus: camera.lifecycleStatus,
                isActive: Boolean(camera.isActive),
                topology: null,
                topologyError: await summarizeApiErrorResponse(topologyResponse, "No se pudo cargar topología")
              } satisfies ClientOverviewCameraRow;
            }
            const topologyBody = (await topologyResponse.json()) as { data?: DetectionTopology };
            return {
              id: camera.id,
              name: camera.name,
              location: camera.location,
              lifecycleStatus: camera.lifecycleStatus,
              isActive: Boolean(camera.isActive),
              topology: topologyBody.data ?? null,
              topologyError: null
            } satisfies ClientOverviewCameraRow;
          } catch (cause) {
            return {
              id: camera.id,
              name: camera.name,
              location: camera.location,
              lifecycleStatus: camera.lifecycleStatus,
              isActive: Boolean(camera.isActive),
              topology: null,
              topologyError: summarizeApiError(cause, "No se pudo cargar topología")
            } satisfies ClientOverviewCameraRow;
          }
        })
      );

      setRows(topologyResults);
    } catch (cause) {
      setError(summarizeApiError(cause, "No se pudo cargar el resumen cliente"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch =
        query.length === 0 ||
        row.name.toLowerCase().includes(query) ||
        (row.location ?? "").toLowerCase().includes(query) ||
        (row.topology?.pipelines ?? []).some((pipeline) => formatDetectionTask(pipeline.taskType).toLowerCase().includes(query));

      const state = !row.topology || row.topology.summary.totalPipelines === 0
        ? "not_configured"
        : row.topology.runnable && row.topology.inSync
          ? "ready"
          : "attention";

      const matchesStatus = statusFilter === "all" || state === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [rows, search, statusFilter]);

  const summary = useMemo(() => {
    let ready = 0;
    let attention = 0;
    let notConfigured = 0;
    const detections = new Set<string>();
    for (const row of rows) {
      if (!row.topology || row.topology.summary.totalPipelines === 0) {
        notConfigured += 1;
        continue;
      }
      if (row.topology.runnable && row.topology.inSync) ready += 1;
      else attention += 1;
      for (const pipeline of row.topology.pipelines) {
        if (pipeline.enabled) detections.add(formatDetectionTask(pipeline.taskType));
      }
    }
    return {
      total: rows.length,
      ready,
      attention,
      notConfigured,
      detections: Array.from(detections)
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <PageCard title="Resumen Cliente">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm text-slate-600">Vista resumida por tenant para seguir cobertura, capacidad y riesgos sin entrar al detalle técnico.</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
              {summary.detections.map((detection) => (
                <Badge key={detection}>{detection}</Badge>
              ))}
              {summary.detections.length === 0 ? <Badge>Sin detecciones activas</Badge> : null}
            </div>
          </div>
          <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadOverview()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </PrimaryButton>
        </div>
        {error ? <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Surface className="border border-slate-200 bg-slate-50">
            <div className="text-xs uppercase tracking-wide text-slate-500">Cámaras</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</div>
            <div className="text-xs text-slate-500">Cantidad total visible para este tenant</div>
          </Surface>
          <Surface className="border border-emerald-200 bg-emerald-50">
            <div className="text-xs uppercase tracking-wide text-emerald-700">Listas</div>
            <div className="mt-1 text-2xl font-semibold text-emerald-900">{summary.ready}</div>
            <div className="text-xs text-emerald-700">Cobertura consistente y capacidad disponible</div>
          </Surface>
          <Surface className="border border-amber-200 bg-amber-50">
            <div className="text-xs uppercase tracking-wide text-amber-700">Con atención</div>
            <div className="mt-1 text-2xl font-semibold text-amber-900">{summary.attention}</div>
            <div className="text-xs text-amber-700">Hay drift, degradación o cobertura parcial</div>
          </Surface>
          <Surface className="border border-slate-200 bg-slate-50">
            <div className="text-xs uppercase tracking-wide text-slate-500">Sin configurar</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{summary.notConfigured}</div>
            <div className="text-xs text-slate-500">No tienen pipelines de detección activos</div>
          </Surface>
        </div>
      </PageCard>

      <PageCard title="Cámaras del Tenant">
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
          <TextInput placeholder="Buscar por cámara, ubicación o detección" value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectInput value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">todos los estados</option>
            <option value="ready">listas</option>
            <option value="attention">con atención</option>
            <option value="not_configured">sin configurar</option>
          </SelectInput>
        </div>
        {loading ? (
          <div className="text-sm text-slate-500">Cargando resumen del tenant...</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {filteredRows.map((row) => {
              const state = !row.topology || row.topology.summary.totalPipelines === 0
                ? { label: "Sin configurar", tone: "neutral" as const, detail: "Todavía no hay pipelines activos para esta cámara." }
                : row.topology.runnable && row.topology.inSync
                  ? { label: "Lista", tone: "good" as const, detail: "La cobertura actual es consistente y tiene capacidad disponible." }
                  : { label: "Con atención", tone: "warn" as const, detail: summarizeTopologyRisks(row.topology).join("; ") || "Requiere revisión operativa." };
              const detections = Array.from(
                new Set((row.topology?.pipelines ?? []).filter((pipeline) => pipeline.enabled).map((pipeline) => formatDetectionTask(pipeline.taskType)))
              );
              const primaryPipelines = (row.topology?.pipelines ?? []).filter((pipeline) => pipeline.assignment.primaryNodeId);

              return (
                <Surface key={row.id} className="space-y-3 border border-slate-200">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-slate-900">{row.name}</div>
                      <div className="text-sm text-slate-600">{row.location || "Sin ubicación declarada"}</div>
                      <div className="mt-1 text-xs text-slate-500">Lifecycle {row.lifecycleStatus ?? "-"} · {row.isActive ? "Activa" : "Inactiva"}</div>
                    </div>
                    <Badge className={getAudienceToneClasses(state.tone)}>{state.label}</Badge>
                  </div>
                  <div className="text-sm text-slate-700">{row.topologyError ?? state.detail}</div>
                  <div className="flex flex-wrap gap-2">
                    {detections.map((detection) => (
                      <Badge key={`${row.id}-${detection}`}>{detection}</Badge>
                    ))}
                    {detections.length === 0 ? <Badge>Sin detecciones activas</Badge> : null}
                    {row.topology ? <Badge>{row.topology.summary.assignedPipelines}/{row.topology.summary.enabledPipelines} asignados</Badge> : null}
                  </div>
                  {primaryPipelines.length > 0 ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      Nodos primarios: {primaryPipelines.map((pipeline) => pipeline.assignment.primaryNodeId).filter(Boolean).join(", ")}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Link className="text-sm font-medium text-slate-700 underline underline-offset-2" to={ADMIN_ROUTES.resources.cameraDetail(row.id)}>
                      Ver detalle de cámara
                    </Link>
                  </div>
                </Surface>
              );
            })}
            {filteredRows.length === 0 ? (
              <Surface className="border border-slate-200 bg-slate-50">
                <div className="text-sm text-slate-600">No hay cámaras que coincidan con los filtros actuales.</div>
              </Surface>
            ) : null}
          </div>
        )}
      </PageCard>
    </div>
  );
}

function CamerasPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const canCreate = useCan({ resource: "cameras", action: "create" }).data?.can;
  const canDelete = useCan({ resource: "cameras", action: "delete" }).data?.can;
  const canEdit = useCan({ resource: "cameras", action: "edit" }).data?.can;

  const camerasList = useList({
    resource: "cameras",
    pagination: { currentPage: page, pageSize: 5, mode: "server" },
    filters: q ? [{ field: "name", operator: "contains", value: q }] : []
  } as any);
  const result = camerasList.result;

  const { mutateAsync: create } = useCreate();
  const { mutateAsync: update } = useUpdate();
  const { mutate: remove } = useDelete();

  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const totalPages = Math.max(Math.ceil((result?.total ?? 0) / 5), 1);
  const listError = (camerasList as any).query?.error;

  const rows = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Cameras">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <PrimaryButton onClick={() => (camerasList as any).query.refetch()}>Search</PrimaryButton>
      </div>
      {listError && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {summarizeApiError(listError, "No se pudo cargar cámaras")}
        </div>
      )}

      {(canCreate || canEdit) && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-12"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaveError(null);
            setSaveOk(null);
            const payload = { ...form, tags: form.tags ? form.tags.split(",").map((x) => x.trim()) : [] };
            try {
              setSaving(true);
              if (editing) {
                await update({ resource: "cameras", id: editing.id, values: payload });
                setEditing(null);
                setSaveOk("Camera actualizada");
              } else if (canCreate) {
                await create({ resource: "cameras", values: payload });
                setSaveOk("Camera creada");
              }
              setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
              await (camerasList as any).query.refetch();
            } catch (error) {
              setSaveError(summarizeApiError(error, "No se pudo guardar la cámara"));
            } finally {
              setSaving(false);
            }
          }}
        >
          <TextInput
            placeholder="name"
            value={form.name}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <textarea
            placeholder="description"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 md:col-span-3"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <TextInput
            placeholder="rtsp://usuario:password@ip:puerto/stream"
            value={form.rtspUrl}
            className="font-mono md:col-span-5"
            title={form.rtspUrl}
            onChange={(e) => setForm((f) => ({ ...f, rtspUrl: e.target.value }))}
          />
          <TextInput
            placeholder="location"
            value={form.location}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          />
          <TextInput
            placeholder="tags csv"
            value={form.tags}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
          <SelectInput
            value={String(form.isActive)}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "true" }))}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectInput>
          <PrimaryButton
            type="submit"
            className="md:col-span-2"
            disabled={saving || (editing ? !canEdit : !canCreate)}
          >
            {editing ? "Guardar cambios" : "Crear cámara"}
          </PrimaryButton>
          {editing && (
            <PrimaryButton
              type="button"
              className="md:col-span-2"
              onClick={() => {
                setEditing(null);
                setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
                setSaveError(null);
              }}
            >
              Cancelar edición
            </PrimaryButton>
          )}
          {editing && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm md:col-span-12">
              Editando cámara: <strong>{editing.name}</strong> ({editing.id})
            </div>
          )}
          {saveError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 md:col-span-12">{saveError}</div>}
          {saveOk && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 md:col-span-12">{saveOk}</div>}
        </form>
      )}

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">RTSP URL</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c: any) => (
            <tr key={c.id}>
              <td className="px-3 py-2">{c.name}</td>
              <td className="px-3 py-2">{c.location || "-"}</td>
              <td className="px-3 py-2">
                <code className="block max-w-[22rem] overflow-x-auto whitespace-nowrap text-xs">{c.rtspUrl}</code>
              </td>
              <td className="px-3 py-2">
                <Badge className={c.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                  {c.isActive ? "Active" : "Inactive"}
                </Badge>
              </td>
              <td className="px-3 py-2">
                <div className="flex gap-2">
                  <Link
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    to={ADMIN_ROUTES.resources.cameraDetail(c.id)}
                  >
                    Show
                  </Link>
                  {canEdit && (
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setEditing(c);
                        setSaveError(null);
                        setSaveOk(null);
                        setForm({
                          name: c.name,
                          description: c.description ?? "",
                          rtspUrl: c.rtspUrl,
                          location: c.location ?? "",
                          tags: (c.tags ?? []).join(","),
                          isActive: c.isActive
                        });
                      }}
                    >
                      Edit
                    </PrimaryButton>
                  )}
                  {canDelete && (
                    <DangerButton
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setSaveError(null);
                        remove(
                          { resource: "cameras", id: c.id },
                          {
                            onSuccess: () => {
                              setSaveOk("Cámara eliminada");
                              (camerasList as any).query.refetch();
                            },
                            onError: (error: any) => {
                              setSaveError(summarizeApiError(error, "No se pudo eliminar la cámara"));
                            }
                          }
                        );
                      }}
                    >
                      Delete
                    </DangerButton>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <div className="mt-4 flex items-center justify-end gap-2">
        <PrimaryButton className="px-2 py-1 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Prev
        </PrimaryButton>
        <span className="text-sm">
          Page {page} / {totalPages}
        </span>
        <PrimaryButton
          className="px-2 py-1 text-xs"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </PrimaryButton>
      </div>
    </PageCard>
  );
}

function DetectionNodesPage({ apiUrl }: { apiUrl: string }) {
  const [nodes, setNodes] = useState<OpsNodeSnapshot[]>([]);
  const [nodeConfig, setNodeConfig] = useState<OpsNodeConfigEnvelope | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [nodeSearch, setNodeSearch] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<"all" | DetectionProviderRuntime>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "degraded" | "offline">("all");
  const [loading, setLoading] = useState(true);
  const [loadingNodeConfig, setLoadingNodeConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<string[]>([]);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogProviderFilter, setCatalogProviderFilter] = useState<"all" | DetectionProviderRuntime>("all");
  const [editingCatalogId, setEditingCatalogId] = useState<string | null>(null);
  const [form, setForm] = useState({
    nodeId: "",
    tenantScope: "*",
    runtime: "mediapipe",
    endpoint: "http://inference-node-mediapipe:8092",
    maxConcurrent: 2,
    contractVersion: "1.0",
    capabilities: "pose_estimation",
    models: "mediapipe_pose@0.10.0",
    cpu: 4,
    gpu: 0,
    vramMb: 0
  });
  const [catalogForm, setCatalogForm] = useState<{
    provider: DetectionProviderRuntime;
    taskType: DetectionTaskType;
    quality: DetectionQuality;
    modelRef: string;
    displayName: string;
    cpu: number;
    gpu: number;
    vramMb: number;
    defaults: string;
    outputs: string;
    status: "active" | "disabled";
  }>({
    provider: "yolo",
    taskType: "person_detection",
    quality: "balanced",
    modelRef: "",
    displayName: "",
    cpu: 2,
    gpu: 0,
    vramMb: 0,
    defaults: "{}",
    outputs: "{}",
    status: "active"
  });

  const selectedNode = useMemo(() => nodes.find((node) => node.nodeId === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const filteredNodes = useMemo(
    () =>
      nodes.filter((node) => {
        const matchesSearch =
          nodeSearch.trim().length === 0 ||
          node.nodeId.toLowerCase().includes(nodeSearch.toLowerCase()) ||
          node.endpoint.toLowerCase().includes(nodeSearch.toLowerCase()) ||
          node.models.some((model) => model.toLowerCase().includes(nodeSearch.toLowerCase()));
        const matchesRuntime = runtimeFilter === "all" || node.runtime === runtimeFilter;
        const matchesStatus = statusFilter === "all" || node.status === statusFilter;
        return matchesSearch && matchesRuntime && matchesStatus;
      }),
    [nodeSearch, nodes, runtimeFilter, statusFilter]
  );
  const filteredCatalog = useMemo(
    () =>
      catalog.filter((entry) => {
        const matchesProvider = catalogProviderFilter === "all" || entry.provider === catalogProviderFilter;
        const needle = catalogSearch.trim().toLowerCase();
        const matchesSearch =
          needle.length === 0 ||
          entry.displayName.toLowerCase().includes(needle) ||
          entry.modelRef.toLowerCase().includes(needle) ||
          entry.taskType.toLowerCase().includes(needle);
        return matchesProvider && matchesSearch;
      }),
    [catalog, catalogProviderFilter, catalogSearch]
  );

  useEffect(() => {
    setAssignmentDraft(selectedNode?.assignedTenantIds ?? []);
  }, [selectedNodeId, selectedNode?.assignedTenantIds]);

  async function loadTenants() {
    const token = getToken();
    if (!token) return;
    try {
      const response = await fetch(`${apiUrl}/tenants`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`tenants ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ id: string; name: string }> };
      setTenantOptions(body.data ?? []);
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar tenants para asignación de nodos"));
    }
  }

  async function loadCatalog() {
    const token = getToken();
    if (!token) return;
    try {
      const response = await fetch(`${apiUrl}/ops/model-catalog`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      const body = (await response.json()) as { data?: ModelCatalogEntry[] };
      setCatalog(body.data ?? []);
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar el catálogo de modelos"));
    }
  }

  function resetCatalogForm() {
    setEditingCatalogId(null);
    setCatalogForm({
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      modelRef: "",
      displayName: "",
      cpu: 2,
      gpu: 0,
      vramMb: 0,
      defaults: "{}",
      outputs: "{}",
      status: "active"
    });
  }

  function startEditingCatalog(entry: ModelCatalogEntry) {
    setEditingCatalogId(entry.id);
    setCatalogForm({
      provider: entry.provider,
      taskType: entry.taskType,
      quality: entry.quality,
      modelRef: entry.modelRef,
      displayName: entry.displayName,
      cpu: entry.resources.cpu ?? 0,
      gpu: entry.resources.gpu ?? 0,
      vramMb: entry.resources.vramMb ?? 0,
      defaults: prettyJson(entry.defaults ?? {}),
      outputs: prettyJson(entry.outputs ?? {}),
      status: entry.status
    });
  }

  async function saveCatalogEntry(e: FormEvent) {
    e.preventDefault();
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      return;
    }
    setCatalogSaving(true);
    setError(null);
    setOk(null);
    try {
      const payload = {
        provider: catalogForm.provider,
        taskType: catalogForm.taskType,
        quality: catalogForm.quality,
        modelRef: catalogForm.modelRef,
        displayName: catalogForm.displayName,
        resources: {
          cpu: Number(catalogForm.cpu),
          gpu: Number(catalogForm.gpu),
          vramMb: Number(catalogForm.vramMb)
        },
        defaults: safeJsonParse<Record<string, unknown>>(catalogForm.defaults, {}),
        outputs: safeJsonParse<Record<string, unknown>>(catalogForm.outputs, {}),
        status: catalogForm.status
      };
      const res = await fetch(
        editingCatalogId ? `${apiUrl}/ops/model-catalog/${encodeURIComponent(editingCatalogId)}` : `${apiUrl}/ops/model-catalog`,
        {
          method: editingCatalogId ? "PUT" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`catalog save ${res.status}: ${body}`);
      }
      setOk(editingCatalogId ? "Modelo actualizado" : "Modelo creado");
      resetCatalogForm();
      await loadCatalog();
    } catch (saveError) {
      setError(summarizeApiError(saveError, "No se pudo guardar la entrada del catálogo"));
    } finally {
      setCatalogSaving(false);
    }
  }

  async function loadNodes(sync = true) {
    const token = getToken();
    if (!token) {
      setLoading(false);
      setError("Missing auth token");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes${sync ? "" : "?sync=0"}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`ops nodes ${res.status}`);
      const body = (await res.json()) as { data?: OpsNodeSnapshot[] };
      const list = body.data ?? [];
      setNodes(list);
      if (!selectedNodeId && list.length > 0) setSelectedNodeId(list[0].nodeId);
      if (selectedNodeId && !list.some((node) => node.nodeId === selectedNodeId)) {
        setSelectedNodeId(list[0]?.nodeId ?? "");
      }
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar el registry de nodos"));
    } finally {
      setLoading(false);
    }
  }

  async function loadNodeConfig(nodeId: string) {
    const token = getToken();
    if (!token || !nodeId) {
      setNodeConfig(null);
      return;
    }
    setLoadingNodeConfig(true);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/${encodeURIComponent(nodeId)}/config`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`node config ${res.status}`);
      const body = (await res.json()) as { data?: OpsNodeConfigEnvelope };
      setNodeConfig(body.data ?? null);
    } catch (loadError) {
      setNodeConfig(null);
      setError(summarizeApiError(loadError, "No se pudo cargar la configuración del nodo"));
    } finally {
      setLoadingNodeConfig(false);
    }
  }

  useEffect(() => {
    void loadTenants();
    void loadCatalog();
    void loadNodes(true);
    const id = window.setInterval(() => {
      void loadNodes(true);
    }, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  useEffect(() => {
    if (!selectedNodeId) {
      setNodeConfig(null);
      return;
    }
    void loadNodeConfig(selectedNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  async function executeNodeAction(nodeId: string, action: "drain" | "undrain" | "revoke") {
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      return;
    }
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/${encodeURIComponent(nodeId)}/${action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: action === "revoke" ? JSON.stringify({ reason: "manual_revoke_from_panel" }) : "{}"
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`node ${action} ${res.status}: ${body}`);
      }
      setOk(`Acción ${action} aplicada sobre ${nodeId}`);
      await loadNodes(true);
    } catch (actionError) {
      setError(summarizeApiError(actionError, `No se pudo ejecutar ${action}`));
    } finally {
      setSaving(false);
    }
  }

  async function provisionNode(e: FormEvent) {
    e.preventDefault();
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      return;
    }
    setSaving(true);
    setError(null);
    setOk(null);
    setEnrollmentToken(null);
    try {
      const models = form.models
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const taskTypes = form.capabilities
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const payload = {
        nodeId: form.nodeId,
        tenantScope: form.tenantScope || "*",
        runtime: form.runtime,
        transport: "http",
        endpoint: form.endpoint,
        capabilities: [
          {
            capabilityId: `${form.runtime}-default`,
            taskTypes,
            models
          }
        ],
        models,
        resources: { cpu: form.cpu, gpu: form.gpu, vramMb: form.vramMb },
        maxConcurrent: Number(form.maxConcurrent),
        contractVersion: form.contractVersion
      };
      const res = await fetch(`${apiUrl}/ops/nodes/provision`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const body = (await res.json()) as { data?: { enrollment?: { enrollmentToken?: string }; snapshot?: OpsNodeSnapshot } };
      if (!res.ok) throw new Error(JSON.stringify(body));
      const tokenValue = body.data?.enrollment?.enrollmentToken;
      if (tokenValue) setEnrollmentToken(tokenValue);
      if (body.data?.snapshot?.nodeId) setSelectedNodeId(body.data.snapshot.nodeId);
      setOk(`Nodo ${form.nodeId} provisionado`);
      await loadNodes(true);
    } catch (provisionError) {
      setError(summarizeApiError(provisionError, "No se pudo provisionar el nodo"));
    } finally {
      setSaving(false);
    }
  }

  async function saveTenantAssignments() {
    if (!selectedNode) return;
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      return;
    }
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/${encodeURIComponent(selectedNode.nodeId)}/tenants`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ tenantIds: assignmentDraft })
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`node tenants ${res.status}: ${body}`);
      setOk(`Asignación de tenants actualizada para ${selectedNode.nodeId}`);
      await loadNodes(true);
    } catch (saveError) {
      setError(summarizeApiError(saveError, "No se pudo guardar asignación de tenants"));
    } finally {
      setSaving(false);
    }
  }

  async function applyNodeConfig(syncBridgeTenantAssignments: boolean) {
    if (!selectedNode) return;
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      return;
    }
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/${encodeURIComponent(selectedNode.nodeId)}/config/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ syncBridgeTenantAssignments })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`node apply ${res.status}: ${body}`);
      }
      const body = (await res.json()) as { data?: OpsNodeConfigEnvelope };
      setNodeConfig(body.data ?? null);
      setOk(
        syncBridgeTenantAssignments
          ? `Configuración aplicada y tenant assignments sincronizados para ${selectedNode.nodeId}`
          : `Configuración aplicada para ${selectedNode.nodeId}`
      );
      await loadNodes(true);
    } catch (applyError) {
      setError(summarizeApiError(applyError, "No se pudo aplicar la configuración del nodo"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageCard title="Detection Nodes">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadNodes(true)} disabled={loading || saving}>
            Sync bridge
          </PrimaryButton>
          <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadNodes(false)} disabled={loading || saving}>
            Reload cache
          </PrimaryButton>
          <Badge>total: {nodes.length}</Badge>
          <Badge>visible: {filteredNodes.length}</Badge>
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px]">
          <TextInput placeholder="Buscar por nodeId, endpoint o modelRef" value={nodeSearch} onChange={(e) => setNodeSearch(e.target.value)} />
          <SelectInput value={runtimeFilter} onChange={(e) => setRuntimeFilter(e.target.value as "all" | DetectionProviderRuntime)}>
            <option value="all">all runtimes</option>
            {DETECTION_PROVIDER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectInput>
          <SelectInput value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "online" | "degraded" | "offline")}>
            <option value="all">all statuses</option>
            <option value="online">online</option>
            <option value="degraded">degraded</option>
            <option value="offline">offline</option>
          </SelectInput>
        </div>
        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        {ok && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}
        {enrollmentToken && (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            enrollment token: <code className="break-all">{enrollmentToken}</code>
          </div>
        )}
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Node</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Runtime</th>
              <th className="px-3 py-2">Endpoint</th>
              <th className="px-3 py-2">Tenant(s)</th>
              <th className="px-3 py-2">Queue</th>
              <th className="px-3 py-2">Drained</th>
              <th className="px-3 py-2">Models</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredNodes.map((node) => (
              <tr key={node.nodeId} className={selectedNodeId === node.nodeId ? "bg-slate-50" : ""}>
                <td className="px-3 py-2">
                  <button
                    className="text-left text-sm font-medium text-slate-700 underline underline-offset-2"
                    type="button"
                    onClick={() => setSelectedNodeId(node.nodeId)}
                  >
                    {node.nodeId}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Badge
                    className={
                      node.status === "online"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : node.status === "degraded"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-rose-200 bg-rose-50 text-rose-700"
                    }
                  >
                    {node.status}
                  </Badge>
                </td>
                <td className="px-3 py-2">{node.runtime}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{node.endpoint}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{(node.assignedTenantIds ?? []).join(", ") || node.tenantId || "*"}</td>
                <td className="px-3 py-2">
                  {node.queueDepth}/{node.maxConcurrent}
                </td>
                <td className="px-3 py-2">{node.isDrained ? "yes" : "no"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{node.models.join(", ") || "-"}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      disabled={saving}
                      onClick={() => void executeNodeAction(node.nodeId, "drain")}
                    >
                      Drain
                    </PrimaryButton>
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      disabled={saving}
                      onClick={() => void executeNodeAction(node.nodeId, "undrain")}
                    >
                      Undrain
                    </PrimaryButton>
                    <DangerButton className="px-2 py-1 text-xs" onClick={() => void executeNodeAction(node.nodeId, "revoke")}>
                      Revoke
                    </DangerButton>
                  </div>
                </td>
              </tr>
            ))}
            {filteredNodes.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-sm text-slate-500" colSpan={9}>
                  No hay nodos que coincidan con los filtros actuales.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </PageCard>

      <PageCard title="Node Provisioning">
        <form className="grid grid-cols-1 gap-2 md:grid-cols-12" onSubmit={provisionNode}>
          <TextInput
            placeholder="nodeId"
            className="md:col-span-3"
            value={form.nodeId}
            onChange={(e) => setForm((prev) => ({ ...prev, nodeId: e.target.value }))}
          />
          <TextInput
            placeholder="tenantScope (* o tenantId)"
            className="md:col-span-3"
            value={form.tenantScope}
            onChange={(e) => setForm((prev) => ({ ...prev, tenantScope: e.target.value }))}
          />
          <TextInput
            placeholder="runtime"
            className="md:col-span-2"
            value={form.runtime}
            onChange={(e) => setForm((prev) => ({ ...prev, runtime: e.target.value }))}
          />
          <TextInput
            placeholder="maxConcurrent"
            className="md:col-span-2"
            value={String(form.maxConcurrent)}
            onChange={(e) => setForm((prev) => ({ ...prev, maxConcurrent: Number(e.target.value || 1) }))}
          />
          <TextInput
            placeholder="contractVersion"
            className="md:col-span-2"
            value={form.contractVersion}
            onChange={(e) => setForm((prev) => ({ ...prev, contractVersion: e.target.value }))}
          />
          <TextInput
            placeholder="http://inference-node-mediapipe:8092"
            className="font-mono md:col-span-7"
            value={form.endpoint}
            onChange={(e) => setForm((prev) => ({ ...prev, endpoint: e.target.value }))}
          />
          <TextInput
            placeholder="taskTypes csv (pose_estimation,action_recognition)"
            className="md:col-span-5"
            value={form.capabilities}
            onChange={(e) => setForm((prev) => ({ ...prev, capabilities: e.target.value }))}
          />
          <TextInput
            placeholder="models csv"
            className="md:col-span-6"
            value={form.models}
            onChange={(e) => setForm((prev) => ({ ...prev, models: e.target.value }))}
          />
          <TextInput
            placeholder="cpu"
            className="md:col-span-2"
            value={String(form.cpu)}
            onChange={(e) => setForm((prev) => ({ ...prev, cpu: Number(e.target.value || 0) }))}
          />
          <TextInput
            placeholder="gpu"
            className="md:col-span-2"
            value={String(form.gpu)}
            onChange={(e) => setForm((prev) => ({ ...prev, gpu: Number(e.target.value || 0) }))}
          />
          <TextInput
            placeholder="vramMb"
            className="md:col-span-2"
            value={String(form.vramMb)}
            onChange={(e) => setForm((prev) => ({ ...prev, vramMb: Number(e.target.value || 0) }))}
          />
          <PrimaryButton className="md:col-span-2" type="submit" disabled={saving || !form.nodeId.trim() || !form.endpoint.trim()}>
            Provision node
          </PrimaryButton>
        </form>
      </PageCard>

      <PageCard title="Node Configuration Detail">
        {!selectedNode ? (
          <div className="text-sm text-slate-500">{loading ? "Loading..." : "Seleccioná un nodo para ver su configuración."}</div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{selectedNode.nodeId}</strong>
              <Badge>{selectedNode.status}</Badge>
              <Badge>{selectedNode.runtime}</Badge>
              <Badge>contract {selectedNode.contractVersion}</Badge>
              <Badge>
                queue {selectedNode.queueDepth}/{selectedNode.maxConcurrent}
              </Badge>
              <Badge>{selectedNode.isDrained ? "drained" : "active"}</Badge>
            </div>
            <div>endpoint: {selectedNode.endpoint}</div>
            <div>tenant(s): {(selectedNode.assignedTenantIds ?? []).join(", ") || selectedNode.tenantId || "*"}</div>
            <div>last heartbeat: {new Date(selectedNode.lastHeartbeatAt).toLocaleString()}</div>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                className="px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() => void loadNodeConfig(selectedNode.nodeId)}
                disabled={saving || loadingNodeConfig}
              >
                {loadingNodeConfig ? "Refreshing..." : "Refresh config"}
              </PrimaryButton>
              <PrimaryButton
                className="px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() => void applyNodeConfig(false)}
                disabled={saving}
              >
                Apply desired config
              </PrimaryButton>
              <PrimaryButton
                className="px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() => void applyNodeConfig(true)}
                disabled={saving}
              >
                Apply + sync tenants
              </PrimaryButton>
            </div>
            <Surface>
              <div className="mb-2 font-medium">Tenant assignment</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {tenantOptions.map((tenant) => (
                  <label key={tenant.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={assignmentDraft.includes(tenant.id)}
                      onChange={(e) =>
                        setAssignmentDraft((prev) =>
                          e.target.checked ? Array.from(new Set([...prev, tenant.id])) : prev.filter((value) => value !== tenant.id)
                        )
                      }
                    />
                    <span>{tenant.name}</span>
                    <span className="opacity-60">({tenant.id})</span>
                  </label>
                ))}
              </div>
              <div className="mt-3">
                <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void saveTenantAssignments()} disabled={saving}>
                  Guardar asignación
                </PrimaryButton>
              </div>
            </Surface>
            <Surface>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="font-medium">Desired vs observed</div>
                <Badge className={nodeConfig?.diff?.inSync ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                  {nodeConfig?.diff?.inSync ? "in sync" : "drift detected"}
                </Badge>
                {nodeConfig?.desiredConfig?.lastAppliedAt ? (
                  <span className="text-xs text-slate-500">
                    last applied {new Date(nodeConfig.desiredConfig.lastAppliedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              {loadingNodeConfig ? (
                <div className="text-xs text-slate-500">Loading config snapshot...</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Desired</div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                      {prettyJson(nodeConfig?.desiredConfig ?? null)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Observed</div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                      {prettyJson(nodeConfig?.observedConfig ?? null)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Diff</div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                      {prettyJson(nodeConfig?.diff ?? null)}
                    </pre>
                  </div>
                </div>
              )}
            </Surface>
            <div>
              resources:
              <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                {JSON.stringify(selectedNode.resources ?? {}, null, 2)}
              </pre>
            </div>
            <div>
              capabilities:
              <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                {JSON.stringify(selectedNode.capabilities ?? [], null, 2)}
              </pre>
            </div>
            <div>
              models:
              <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">
                {JSON.stringify(selectedNode.models ?? [], null, 2)}
              </pre>
            </div>
          </div>
        )}
      </PageCard>

      <PageCard title="Model Catalog Snapshot">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-sm text-slate-600">Modelos usados para resolver perfiles, jobs y topología.</div>
          <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadCatalog()} disabled={loading || saving || catalogSaving}>
            Refresh catalog
          </PrimaryButton>
        </div>
        <form className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-12" onSubmit={saveCatalogEntry}>
          <SelectInput
            className="md:col-span-2"
            value={catalogForm.provider}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, provider: e.target.value as DetectionProviderRuntime }))}
          >
            {DETECTION_PROVIDER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            className="md:col-span-2"
            value={catalogForm.taskType}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, taskType: e.target.value as DetectionTaskType }))}
          >
            {DETECTION_TASK_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            className="md:col-span-2"
            value={catalogForm.quality}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, quality: e.target.value as DetectionQuality }))}
          >
            {DETECTION_QUALITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            className="md:col-span-2"
            value={catalogForm.status}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, status: e.target.value as "active" | "disabled" }))}
          >
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </SelectInput>
          <TextInput
            className="md:col-span-4"
            placeholder="Display name"
            value={catalogForm.displayName}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, displayName: e.target.value }))}
          />
          <TextInput
            className="font-mono md:col-span-5"
            placeholder="modelRef"
            value={catalogForm.modelRef}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, modelRef: e.target.value }))}
          />
          <TextInput
            className="md:col-span-1"
            placeholder="cpu"
            value={String(catalogForm.cpu)}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, cpu: Number(e.target.value || 0) }))}
          />
          <TextInput
            className="md:col-span-1"
            placeholder="gpu"
            value={String(catalogForm.gpu)}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, gpu: Number(e.target.value || 0) }))}
          />
          <TextInput
            className="md:col-span-1"
            placeholder="vram"
            value={String(catalogForm.vramMb)}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, vramMb: Number(e.target.value || 0) }))}
          />
          <textarea
            className="min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 md:col-span-2"
            placeholder="defaults JSON"
            value={catalogForm.defaults}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, defaults: e.target.value }))}
          />
          <textarea
            className="min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200 md:col-span-2"
            placeholder="outputs JSON"
            value={catalogForm.outputs}
            onChange={(e) => setCatalogForm((prev) => ({ ...prev, outputs: e.target.value }))}
          />
          <div className="flex gap-2 md:col-span-12">
            <PrimaryButton type="submit" disabled={catalogSaving || !catalogForm.modelRef.trim() || !catalogForm.displayName.trim()}>
              {catalogSaving ? "Saving..." : editingCatalogId ? "Update model" : "Create model"}
            </PrimaryButton>
            <PrimaryButton className="bg-slate-600 hover:bg-slate-500" type="button" onClick={() => resetCatalogForm()} disabled={catalogSaving}>
              Clear
            </PrimaryButton>
          </div>
        </form>
        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
          <TextInput
            placeholder="Buscar por display name, task o modelRef"
            value={catalogSearch}
            onChange={(e) => setCatalogSearch(e.target.value)}
          />
          <SelectInput
            value={catalogProviderFilter}
            onChange={(e) => setCatalogProviderFilter(e.target.value as "all" | DetectionProviderRuntime)}
          >
            <option value="all">all providers</option>
            {DETECTION_PROVIDER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectInput>
        </div>
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Task</th>
              <th className="px-3 py-2">Quality</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Resources</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredCatalog.map((entry) => (
              <tr key={entry.id}>
                <td className="px-3 py-2">{entry.provider}</td>
                <td className="px-3 py-2">{entry.taskType}</td>
                <td className="px-3 py-2">{entry.quality}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{entry.modelRef}</td>
                <td className="px-3 py-2">
                  <Badge className={entry.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                    {entry.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">{entry.resources.cpu ?? 0} CPU / {entry.resources.gpu ?? 0} GPU</td>
                <td className="px-3 py-2">
                  <PrimaryButton className="px-2 py-1 text-xs" type="button" onClick={() => startEditingCatalog(entry)}>
                    Edit
                  </PrimaryButton>
                </td>
              </tr>
            ))}
            {filteredCatalog.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-sm text-slate-500" colSpan={7}>
                  No hay modelos en catálogo todavía.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </PageCard>
    </div>
  );
}

function CameraShow() {
  const { id } = useParams();
  const canEdit = useCan({ resource: "cameras", action: "edit" }).data?.can;
  const effectiveRole = getEffectiveRoleFromStorage();
  const canManageDetectionProfile = effectiveRole === "tenant_admin" || effectiveRole === "super_admin";
  const canManageFaceIdentity = effectiveRole === "tenant_admin" || effectiveRole === "super_admin" || effectiveRole === "monitor";
  const [camera, setCamera] = useState<any>(null);
  const [loadingCamera, setLoadingCamera] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [profileSaved, setProfileSaved] = useState(false);
  const [lifecycle, setLifecycle] = useState<any>(null);
  const [loadingLifecycle, setLoadingLifecycle] = useState(true);
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detectionProfile, setDetectionProfile] = useState<CameraDetectionProfile | null>(null);
  const [loadingDetectionProfile, setLoadingDetectionProfile] = useState(true);
  const [topology, setTopology] = useState<DetectionTopology | null>(null);
  const [loadingTopology, setLoadingTopology] = useState(true);
  const [detectionSaved, setDetectionSaved] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [faces, setFaces] = useState<FaceDetectionItem[]>([]);
  const [loadingFaces, setLoadingFaces] = useState(true);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [similarFaces, setSimilarFaces] = useState<FaceSimilaritySearchResult | null>(null);
  const [loadingSimilarFaces, setLoadingSimilarFaces] = useState(false);
  const [faceMessage, setFaceMessage] = useState<string | null>(null);
  const [faceActionMessage, setFaceActionMessage] = useState<string | null>(null);
  const [identityDraftName, setIdentityDraftName] = useState("");
  const [faceActionLoading, setFaceActionLoading] = useState(false);

  function normalizeNotificationRule(raw: any) {
    const base = raw && typeof raw === "object" ? raw : {};
    const channels = base.channels && typeof base.channels === "object" ? base.channels : {};
    return {
      enabled: base.enabled === true,
      minConfidence: typeof base.minConfidence === "number" ? base.minConfidence : 0.6,
      labels: Array.isArray(base.labels) ? base.labels.join(",") : "",
      cooldownSeconds: typeof base.cooldownSeconds === "number" ? base.cooldownSeconds : 30,
      channels: {
        realtime: channels.realtime !== false,
        webhook: channels.webhook === true,
        email: channels.email === true
      }
    };
  }

  function createEmptyPipeline(index: number): CameraDetectionPipeline {
    return {
      pipelineId: `pipeline-${index + 1}`,
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      enabled: true,
      schedule: {
        mode: "realtime",
        frameStride: 1
      },
      thresholds: {},
      outputs: {}
    };
  }

  async function loadModelCatalog() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/ops/model-catalog`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error(`model catalog ${res.status}`);
      const body = (await res.json()) as { data?: ModelCatalogEntry[] };
      setCatalog(body.data ?? []);
    } catch (loadError) {
      setActionError(summarizeApiError(loadError, "No se pudo cargar el catálogo de modelos"));
    }
  }

  async function loadDetectionProfile() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setLoadingDetectionProfile(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/detection-profile`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!res.ok) {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar detection profile"));
        return;
      }
      const body = (await res.json()) as { data?: CameraDetectionProfile };
      setDetectionProfile(body.data ?? null);
    } finally {
      setLoadingDetectionProfile(false);
    }
  }

  async function loadDetectionTopology() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setLoadingTopology(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/detection-topology`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!res.ok) {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar la topología de detección"));
        return;
      }
      const body = (await res.json()) as { data?: DetectionTopology };
      setTopology(body.data ?? null);
    } finally {
      setLoadingTopology(false);
    }
  }

  async function loadFaces(preferredFaceId?: string) {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setLoadingFaces(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/faces?_start=0&_end=12`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!res.ok) {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar la galería de caras"));
        return;
      }
      const body = (await res.json()) as { data?: FaceDetectionItem[] };
      const nextFaces = body.data ?? [];
      setFaces(nextFaces);
      const nextSelectedFaceId =
        (preferredFaceId && nextFaces.some((face) => face.id === preferredFaceId) ? preferredFaceId : null) ??
        (selectedFaceId && nextFaces.some((face) => face.id === selectedFaceId) ? selectedFaceId : null) ??
        nextFaces[0]?.id ??
        null;
      setSelectedFaceId(nextSelectedFaceId);
      if (!nextSelectedFaceId) {
        setSimilarFaces(null);
        setFaceMessage("Todavía no hay caras almacenadas para esta cámara.");
      } else if (nextFaces.length > 0) {
        setFaceMessage(null);
        await loadSimilarFaces(nextSelectedFaceId);
      }
    } finally {
      setLoadingFaces(false);
    }
  }

  async function loadSimilarFaces(faceId: string) {
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setSelectedFaceId(faceId);
    setLoadingSimilarFaces(true);
    setFaceMessage(null);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/faces/detections/${faceId}/similar?_start=0&_end=6&minSimilarity=0.7`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        }
      );
      if (res.ok) {
        const body = (await res.json()) as { data?: FaceSimilaritySearchResult };
        setSimilarFaces(body.data ?? null);
        if ((body.data?.matches ?? []).length === 0) {
          setFaceMessage("No encontramos otras caras suficientemente parecidas para esta muestra.");
        }
        return;
      }
      if (res.status === 409) {
        setSimilarFaces(null);
        setFaceMessage("La cara seleccionada todavía no tiene embedding persistido para buscar similitudes.");
        return;
      }
      setActionError(await summarizeApiErrorResponse(res, "No se pudo buscar caras similares"));
    } finally {
      setLoadingSimilarFaces(false);
    }
  }

  async function confirmSelectedClusterIdentity(payload: { identityId?: string; displayName?: string }) {
    const token = getToken();
    const tenantId = getTenantId();
    const selectedFace = faces.find((face) => face.id === selectedFaceId);
    const clusterId = selectedFace?.cluster?.id;
    if (!token || !tenantId || !clusterId) {
      setActionError("No hay un cluster disponible para confirmar");
      return;
    }
    setFaceActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/faces/clusters/${clusterId}/confirm-identity`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo confirmar la identidad"));
        return;
      }
      const body = (await res.json()) as { data?: { displayName?: string | null; id: string; memberCount?: number } };
      setFaceActionMessage(
        `Identidad confirmada: ${body.data?.displayName ?? body.data?.id} (${body.data?.memberCount ?? 0} caras asociadas)`
      );
      setIdentityDraftName(body.data?.displayName ?? "");
      await loadFaces(selectedFaceId ?? undefined);
    } finally {
      setFaceActionLoading(false);
    }
  }

  async function mergeSelectedIdentityInto(targetIdentityId: string) {
    const token = getToken();
    const tenantId = getTenantId();
    const selectedFace = faces.find((face) => face.id === selectedFaceId);
    const sourceIdentityId = selectedFace?.identity?.id;
    if (!token || !tenantId || !sourceIdentityId) {
      setActionError("No hay una identidad origen disponible para merge");
      return;
    }
    setFaceActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/faces/identities/${targetIdentityId}/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        },
        body: JSON.stringify({
          sourceIdentityId,
          reason: "merge_requested_from_camera_investigation"
        })
      });
      if (!res.ok) {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo mergear la identidad"));
        return;
      }
      const body = (await res.json()) as { data?: { displayName?: string | null; id: string; memberCount?: number } };
      setFaceActionMessage(
        `Merge aplicado hacia ${body.data?.displayName ?? body.data?.id} (${body.data?.memberCount ?? 0} caras totales)`
      );
      await loadFaces(selectedFaceId ?? undefined);
    } finally {
      setFaceActionLoading(false);
    }
  }

  async function loadCamera() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setLoadingCamera(true);
    setActionError(null);
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });
    if (res.ok) {
      const body = await res.json();
      setCamera(body.data);
    } else {
      setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar cámara"));
    }
    setLoadingCamera(false);
  }

  async function loadLifecycle() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setLoadingLifecycle(true);
    setActionError(null);
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/lifecycle`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });
    if (res.ok) {
      const body = await res.json();
      setLifecycle(body.data);
    } else {
      setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar lifecycle"));
    }
    setLoadingLifecycle(false);
  }

  useEffect(() => {
    loadCamera();
    loadLifecycle();
    void loadDetectionProfile();
    void loadDetectionTopology();
    void loadModelCatalog();
    void loadFaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }

    const loadProfile = async () => {
      setLoadingProfile(true);
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/profile`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (res.ok) {
        const body = await res.json();
        setProfile({
          ...body.data,
          notificationRule: normalizeNotificationRule(body.data?.rulesProfile?.notification)
        });
      } else {
        setActionError(await summarizeApiErrorResponse(res, "No se pudo cargar profile interno"));
      }
      setLoadingProfile(false);
    };

    loadProfile();
  }, [id]);

  if (loadingCamera || !camera) return <div className="p-4">Loading...</div>;

  const audiencePipelines = topology?.pipelines ?? [];
  const audienceRisks = topology ? summarizeTopologyRisks(topology) : [];
  const audienceOperationalPipelines = audiencePipelines.filter((pipeline) => pipeline.enabled && pipeline.assignment.status === "assigned").length;
  const audienceCoverageLabel =
    topology && topology.summary.enabledPipelines > 0
      ? `${audienceOperationalPipelines}/${topology.summary.enabledPipelines} activos`
      : "Sin pipelines activos";
  const audienceDetections = Array.from(new Set(audiencePipelines.filter((pipeline) => pipeline.enabled).map((pipeline) => formatDetectionTask(pipeline.taskType))));
  const selectedFace = faces.find((face) => face.id === selectedFaceId) ?? null;
  const selectedIdentity = selectedFace?.identity ?? null;
  const selectedCluster = selectedFace?.cluster ?? null;
  const suggestedIdentityCandidates = Array.from(
    new Map(
      (similarFaces?.matches ?? [])
        .filter((match) => match.face.identity && match.face.identity.id !== selectedIdentity?.id)
        .map((match) => [match.face.identity!.id, match.face.identity!])
    ).values()
  );

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!id || !profile) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setActionError(null);

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify({
        proxyPath: profile.proxyPath,
        recordingEnabled: profile.recordingEnabled,
        recordingStorageKey: profile.recordingStorageKey,
        detectorConfigKey: profile.detectorConfigKey,
        detectorResultsKey: profile.detectorResultsKey,
        rulesProfile: {
          ...(profile.rulesProfile ?? {}),
          notification: {
            enabled: profile.notificationRule?.enabled === true,
            minConfidence: Number(profile.notificationRule?.minConfidence ?? 0.6),
            labels: String(profile.notificationRule?.labels ?? "")
              .split(",")
              .map((label) => label.trim())
              .filter((label) => label.length > 0),
            cooldownSeconds: Number(profile.notificationRule?.cooldownSeconds ?? 30),
            channels: {
              realtime: profile.notificationRule?.channels?.realtime !== false,
              webhook: profile.notificationRule?.channels?.webhook === true,
              email: profile.notificationRule?.channels?.email === true
            }
          }
        },
        detectorFlags: profile.detectorFlags,
        status: profile.status,
        lastHealthAt: profile.lastHealthAt ?? null,
        lastError: profile.lastError ?? null
      })
    });

    if (res.ok) {
      const body = await res.json();
      setProfile(body.data);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 1200);
    } else {
      setActionError(await summarizeApiErrorResponse(res, "No se pudo guardar profile interno"));
    }
  }

  async function saveDetectionProfile(e: FormEvent) {
    e.preventDefault();
    if (!id || !detectionProfile) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setActionError(null);

    const payload = {
      pipelines: detectionProfile.pipelines.map((pipeline) => ({
        ...pipeline,
        schedule: {
          mode: pipeline.schedule?.mode ?? "realtime",
          frameStride: Number(pipeline.schedule?.frameStride ?? 1)
        },
        thresholds: pipeline.thresholds ?? {},
        outputs: pipeline.outputs ?? {}
      }))
    };

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/detection-profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const body = (await res.json()) as { data?: CameraDetectionProfile };
      setDetectionProfile(body.data ?? null);
      setDetectionSaved(true);
      setTimeout(() => setDetectionSaved(false), 1200);
      await loadDetectionTopology();
    } else {
      setActionError(await summarizeApiErrorResponse(res, "No se pudo guardar el detection profile"));
    }
  }

  async function validateDetectionProfile() {
    if (!id) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setActionError(null);

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/detection-profile/validate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });

    if (res.ok) {
      const body = (await res.json()) as { data?: { valid?: boolean; runnable?: boolean; inSync?: boolean } };
      await loadDetectionTopology();
      setValidationMessage(
        `valid=${String(body.data?.valid)} runnable=${String(body.data?.runnable)} inSync=${String(body.data?.inSync)}`
      );
      setTimeout(() => setValidationMessage(null), 2500);
    } else {
      setActionError(await summarizeApiErrorResponse(res, "No se pudo validar el detection profile"));
    }
  }

  async function lifecycleAction(action: "validate" | "retire" | "reactivate", payload?: unknown) {
    if (!id) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setActionError("Missing auth context");
      return;
    }
    setActionError(null);

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      },
      body: payload ? JSON.stringify(payload) : "{}"
    });

    if (res.ok) {
      setLifecycleMessage(`${action} executed`);
      setTimeout(() => setLifecycleMessage(null), 1200);
      await Promise.all([loadCamera(), loadLifecycle()]);
    } else {
      setActionError(await summarizeApiErrorResponse(res, `No se pudo ejecutar ${action}`));
    }
  }

  return (
    <PageCard title={`Camera: ${camera.name}`}>
      {actionError && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{actionError}</div>}
      <div className="space-y-2">
        <div>Description: {camera.description ?? "-"}</div>
        <div>RTSP: {camera.rtspUrl}</div>
        <div>Location: {camera.location ?? "-"}</div>
        <div>Tags: {(camera.tags ?? []).join(", ")}</div>
        <div>
          Lifecycle:
          <Badge className="ml-2 badge-info" data-testid="camera-lifecycle-status">
            {camera.lifecycleStatus}
          </Badge>
        </div>
        <div>Created: {new Date(camera.createdAt).toLocaleString()}</div>
      </div>
      {topology ? (
        <Surface className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Client Summary</div>
              <div className="text-lg font-semibold text-slate-900">Estado funcional de la cámara</div>
              <div className="text-sm text-slate-600">
                {audienceDetections.length > 0 ? `Detecta ${audienceDetections.join(", ")}.` : "Todavía no hay detecciones activas configuradas."}
              </div>
            </div>
            <Badge className={getAudienceToneClasses(topology.runnable && topology.inSync ? "good" : topology.valid ? "warn" : "bad")}>
              {topology.runnable && topology.inSync ? "Servicio listo" : topology.valid ? "Servicio con atención" : "Servicio incompleto"}
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Surface className="border border-slate-200 bg-slate-50">
              <div className="text-xs uppercase tracking-wide text-slate-500">Cobertura</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{audienceCoverageLabel}</div>
              <div className="text-xs text-slate-500">Pipelines habilitados con asignación efectiva</div>
            </Surface>
            <Surface className="border border-slate-200 bg-slate-50">
              <div className="text-xs uppercase tracking-wide text-slate-500">Calidad dominante</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">
                {topology.pipelines.find((pipeline) => pipeline.enabled)?.quality
                  ? formatDetectionQuality(topology.pipelines.find((pipeline) => pipeline.enabled)!.quality)
                  : "-"}
              </div>
              <div className="text-xs text-slate-500">Nivel configurado para el primer pipeline activo</div>
            </Surface>
            <Surface className="border border-slate-200 bg-slate-50">
              <div className="text-xs uppercase tracking-wide text-slate-500">Nodos candidatos</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{topology.summary.activeCandidateNodes}</div>
              <div className="text-xs text-slate-500">Capacidad disponible hoy para esta cámara</div>
            </Surface>
            <Surface className="border border-slate-200 bg-slate-50">
              <div className="text-xs uppercase tracking-wide text-slate-500">Riesgos</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{audienceRisks.length}</div>
              <div className="text-xs text-slate-500">Desvíos o degradaciones que requieren seguimiento</div>
            </Surface>
          </div>
          {audienceRisks.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Atención: {audienceRisks.join("; ")}.
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              La cámara tiene una configuración consistente y con capacidad disponible para los pipelines habilitados.
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {audiencePipelines.map((pipeline) => {
              const audienceState = describePipelineAudienceState(pipeline);
              return (
                <Surface key={`audience-${pipeline.pipelineId}`} className={`border ${getAudienceToneClasses(audienceState.tone)}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{formatDetectionTask(pipeline.taskType)}</div>
                      <div className="text-xs text-slate-600">
                        {pipeline.provider} · {formatDetectionQuality(pipeline.quality)} · {pipeline.pipelineId}
                      </div>
                    </div>
                    <Badge className={getAudienceToneClasses(audienceState.tone)}>{audienceState.label}</Badge>
                  </div>
                  <div className="mt-2 text-sm text-slate-700">{audienceState.detail}</div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                    {pipeline.resolvedModel ? <Badge>{pipeline.resolvedModel.displayName}</Badge> : <Badge>Sin modelo resuelto</Badge>}
                    <Badge>{pipeline.candidates.length} candidatos</Badge>
                    {pipeline.assignment.primaryNodeId ? <Badge>Primario: {pipeline.assignment.primaryNodeId}</Badge> : null}
                  </div>
                </Surface>
              );
            })}
            {audiencePipelines.length === 0 ? (
              <Surface className="border border-slate-200 bg-slate-50">
                <div className="text-sm text-slate-600">Esta cámara todavía no tiene pipelines de detección definidos.</div>
              </Surface>
            ) : null}
          </div>
        </Surface>
      ) : null}
      {topology ? (
        <Surface className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Pipelines</div>
            <div className="text-lg font-semibold">{topology.summary.totalPipelines}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Assigned</div>
            <div className="text-lg font-semibold">{topology.summary.assignedPipelines}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Runnable</div>
            <div className="text-lg font-semibold">{topology.summary.runnablePipelines}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Drifted</div>
            <div className="text-lg font-semibold">{topology.summary.driftedPipelines}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Candidate Nodes</div>
            <div className="text-lg font-semibold">{topology.summary.totalCandidateNodes}</div>
          </div>
        </Surface>
      ) : null}

      <div className="divider">Lifecycle</div>
      {loadingLifecycle && <div className="text-sm opacity-70">Loading lifecycle...</div>}
      {!loadingLifecycle && lifecycle && (
        <div className="space-y-3">
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div>Status: {lifecycle.currentStatus}</div>
            <div>Last transition: {lifecycle.lastTransitionAt ? new Date(lifecycle.lastTransitionAt).toLocaleString() : "-"}</div>
            <div>Last seen: {lifecycle.lastSeenAt ? new Date(lifecycle.lastSeenAt).toLocaleString() : "-"}</div>
            <div>Connectivity: {lifecycle.healthSnapshot?.connectivity ?? "-"}</div>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton data-testid="lifecycle-validate" type="button" onClick={() => lifecycleAction("validate")}>
                Validate
              </PrimaryButton>
              <button
                className="btn"
                data-testid="lifecycle-retire"
                type="button"
                onClick={() => lifecycleAction("retire")}
              >
                Retire
              </button>
              <button
                className="btn"
                data-testid="lifecycle-reactivate"
                type="button"
                onClick={() => lifecycleAction("reactivate")}
              >
                Reactivate
              </button>
            </div>
          )}
          {lifecycleMessage && <div className="text-sm text-success">{lifecycleMessage}</div>}
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {(lifecycle.history ?? []).slice(0, 8).map((entry: any) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{entry.event}</td>
                    <td>{entry.fromStatus ?? "-"}</td>
                    <td>{entry.toStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="divider">Internal Profile</div>
      {loadingProfile && <div className="text-sm opacity-70">Loading profile...</div>}
      {!loadingProfile && profile && (
        <form className="grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={saveProfile}>
          {(!profile.configComplete || profile.status !== "ready") && (
            <div className="alert alert-warning md:col-span-2" data-testid="profile-fallback-alert">
              <span>
                Fallback active: profile {profile.configComplete ? "not ready" : "incomplete"}.
                {profile.lastError ? ` ${profile.lastError}` : ""}
              </span>
            </div>
          )}
          <SelectInput
            data-testid="profile-status"
            value={profile.status ?? "pending"}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, status: e.target.value }))}
          >
            <option value="pending">pending</option>
            <option value="ready">ready</option>
            <option value="error">error</option>
          </SelectInput>
          <TextInput
            data-testid="profile-last-health-at"
            value={profile.lastHealthAt ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, lastHealthAt: e.target.value }))}
          />
          <TextInput
            data-testid="profile-proxy-path"
            value={profile.proxyPath ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, proxyPath: e.target.value }))}
          />
          <SelectInput
            data-testid="profile-recording-enabled"
            value={String(profile.recordingEnabled)}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, recordingEnabled: e.target.value === "true" }))}
          >
            <option value="true">Recording enabled</option>
            <option value="false">Recording disabled</option>
          </SelectInput>
          <TextInput
            data-testid="profile-recording-storage"
            value={profile.recordingStorageKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, recordingStorageKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-detector-config"
            value={profile.detectorConfigKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, detectorConfigKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-detector-results"
            value={profile.detectorResultsKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, detectorResultsKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-last-error"
            value={profile.lastError ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, lastError: e.target.value }))}
          />
          <div className="flex flex-wrap items-center gap-3 rounded-box border border-base-300 p-3">
            {(["mediapipe", "yolo", "lpr"] as const).map((flag) => (
              <label key={flag} className="label cursor-pointer gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={Boolean(profile.detectorFlags?.[flag])}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setProfile((prev: any) => ({
                      ...prev,
                      detectorFlags: { ...(prev.detectorFlags ?? {}), [flag]: e.target.checked }
                    }))
                  }
                />
                <span className="label-text">{flag}</span>
              </label>
            ))}
          </div>
          <div className="rounded-box border border-base-300 p-3 md:col-span-2">
            <div className="mb-2 font-medium">Notification Rule</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
              <label className="label cursor-pointer gap-2 md:col-span-1">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={Boolean(profile.notificationRule?.enabled)}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setProfile((prev: any) => ({
                      ...prev,
                      notificationRule: { ...(prev.notificationRule ?? {}), enabled: e.target.checked }
                    }))
                  }
                />
                <span className="label-text">Enabled</span>
              </label>
              <TextInput
                className="md:col-span-1"
                placeholder="min conf 0-1"
                value={String(profile.notificationRule?.minConfidence ?? 0.6)}
                disabled={!canEdit}
                onChange={(e) =>
                  setProfile((prev: any) => ({
                    ...prev,
                    notificationRule: { ...(prev.notificationRule ?? {}), minConfidence: Number(e.target.value || 0) }
                  }))
                }
              />
              <TextInput
                className="md:col-span-2"
                placeholder="labels csv (person,vehicle)"
                value={profile.notificationRule?.labels ?? ""}
                disabled={!canEdit}
                onChange={(e) =>
                  setProfile((prev: any) => ({
                    ...prev,
                    notificationRule: { ...(prev.notificationRule ?? {}), labels: e.target.value }
                  }))
                }
              />
              <TextInput
                className="md:col-span-1"
                placeholder="cooldown sec"
                value={String(profile.notificationRule?.cooldownSeconds ?? 30)}
                disabled={!canEdit}
                onChange={(e) =>
                  setProfile((prev: any) => ({
                    ...prev,
                    notificationRule: { ...(prev.notificationRule ?? {}), cooldownSeconds: Number(e.target.value || 0) }
                  }))
                }
              />
              <div className="flex items-center gap-3 md:col-span-1">
                {(["realtime", "webhook", "email"] as const).map((channel) => (
                  <label key={channel} className="label cursor-pointer gap-2">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={Boolean(profile.notificationRule?.channels?.[channel])}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setProfile((prev: any) => ({
                          ...prev,
                          notificationRule: {
                            ...(prev.notificationRule ?? {}),
                            channels: { ...(prev.notificationRule?.channels ?? {}), [channel]: e.target.checked }
                          }
                        }))
                      }
                    />
                    <span className="label-text">{channel}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          {canEdit && (
            <PrimaryButton data-testid="profile-save" type="submit" className="md:col-span-2">
              Save internal profile
            </PrimaryButton>
          )}
          {profileSaved && <div className="text-sm text-success md:col-span-2">Profile saved</div>}
        </form>
      )}

      <div className="divider">Detection Profile</div>
      {loadingDetectionProfile && <div className="text-sm opacity-70">Loading detection profile...</div>}
      {!loadingDetectionProfile && detectionProfile && (
        <form className="space-y-4" onSubmit={saveDetectionProfile}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>config v{detectionProfile.configVersion}</Badge>
            <Badge>updated {new Date(detectionProfile.updatedAt).toLocaleString()}</Badge>
            <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadDetectionProfile()}>
              Reload profile
            </PrimaryButton>
            {canManageDetectionProfile ? (
              <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void validateDetectionProfile()}>
                Validate against nodes
              </PrimaryButton>
            ) : null}
            {canManageDetectionProfile ? (
              <PrimaryButton className="px-2.5 py-1.5 text-xs" type="submit">
                Save detection profile
              </PrimaryButton>
            ) : null}
            {canManageDetectionProfile ? (
              <PrimaryButton
                className="px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() =>
                  setDetectionProfile((prev) =>
                    prev
                      ? {
                          ...prev,
                          pipelines: [...prev.pipelines, createEmptyPipeline(prev.pipelines.length)],
                          configVersion: prev.configVersion + 1
                        }
                      : prev
                  )
                }
              >
                Add pipeline
              </PrimaryButton>
            ) : null}
          </div>
          {!canManageDetectionProfile ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Vista de solo lectura para el detection profile en este rol.
            </div>
          ) : null}
          {validationMessage ? <div className="text-sm text-emerald-700">{validationMessage}</div> : null}
          {detectionSaved ? <div className="text-sm text-emerald-700">Detection profile saved</div> : null}
          <div className="space-y-3">
            {detectionProfile.pipelines.map((pipeline, index) => {
              const compatibleModels = catalog.filter(
                (entry) =>
                  entry.status === "active" &&
                  entry.provider === pipeline.provider &&
                  entry.taskType === pipeline.taskType &&
                  entry.quality === pipeline.quality
              );
              return (
                <Surface key={pipeline.pipelineId} className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{pipeline.pipelineId || `pipeline-${index + 1}`}</div>
                    <div className="flex flex-wrap gap-2">
                      <Badge>{pipeline.provider}</Badge>
                      <Badge>{pipeline.taskType}</Badge>
                      <Badge>{pipeline.quality}</Badge>
                      <Badge className={pipeline.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                        {pipeline.enabled ? "enabled" : "disabled"}
                      </Badge>
                      {canEdit ? (
                        <DangerButton
                          className="px-2 py-1 text-xs"
                          type="button"
                          onClick={() =>
                            setDetectionProfile((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    pipelines: prev.pipelines.filter((entry) => entry.pipelineId !== pipeline.pipelineId),
                                    configVersion: prev.configVersion + 1
                                  }
                                : prev
                            )
                          }
                        >
                          Remove
                        </DangerButton>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
                    <TextInput
                      value={pipeline.pipelineId}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, pipelineId: e.target.value } : entry
                                )
                              }
                            : prev
                        )
                      }
                    />
                    <SelectInput
                      value={pipeline.provider}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? { ...entry, provider: e.target.value as DetectionProviderRuntime }
                                    : entry
                                )
                              }
                            : prev
                        )
                      }
                    >
                      {DETECTION_PROVIDER_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </SelectInput>
                    <SelectInput
                      value={pipeline.taskType}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, taskType: e.target.value as DetectionTaskType } : entry
                                )
                              }
                            : prev
                        )
                      }
                    >
                      {DETECTION_TASK_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </SelectInput>
                    <SelectInput
                      value={pipeline.quality}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, quality: e.target.value as DetectionQuality } : entry
                                )
                              }
                            : prev
                        )
                      }
                    >
                      {DETECTION_QUALITY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </SelectInput>
                    <SelectInput
                      value={pipeline.schedule?.mode ?? "realtime"}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        schedule: {
                                          mode: e.target.value as "realtime" | "batch",
                                          frameStride: entry.schedule?.frameStride ?? 1
                                        }
                                      }
                                    : entry
                                )
                              }
                            : prev
                        )
                      }
                    >
                      <option value="realtime">realtime</option>
                      <option value="batch">batch</option>
                    </SelectInput>
                    <TextInput
                      value={String(pipeline.schedule?.frameStride ?? 1)}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        schedule: {
                                          mode: entry.schedule?.mode ?? "realtime",
                                          frameStride: Number(e.target.value || 1)
                                        }
                                      }
                                    : entry
                                )
                              }
                            : prev
                        )
                      }
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)]">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={pipeline.enabled}
                        disabled={!canManageDetectionProfile}
                        onChange={(e) =>
                          setDetectionProfile((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  pipelines: prev.pipelines.map((entry, entryIndex) =>
                                    entryIndex === index ? { ...entry, enabled: e.target.checked } : entry
                                  )
                                }
                              : prev
                          )
                        }
                      />
                      enabled
                    </label>
                    <textarea
                      className="min-h-28 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                      value={prettyJson(pipeline.thresholds)}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, thresholds: safeJsonParse(e.target.value, {}) } : entry
                                )
                              }
                            : prev
                        )
                      }
                    />
                    <textarea
                      className="min-h-28 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                      value={prettyJson(pipeline.outputs)}
                      disabled={!canManageDetectionProfile}
                      onChange={(e) =>
                        setDetectionProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                pipelines: prev.pipelines.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, outputs: safeJsonParse(e.target.value, {}) } : entry
                                )
                              }
                            : prev
                        )
                      }
                    />
                  </div>
                  <div className="text-xs text-slate-500">
                    matching models: {compatibleModels.map((entry) => entry.displayName).join(", ") || "none in catalog"}
                  </div>
                </Surface>
              );
            })}
            {detectionProfile.pipelines.length === 0 ? (
              <Surface>
                <div className="text-sm text-slate-500">No hay pipelines configurados para esta cámara.</div>
              </Surface>
            ) : null}
          </div>
        </form>
      )}

      <div className="divider">Detection Topology</div>
      {loadingTopology && <div className="text-sm opacity-70">Loading detection topology...</div>}
      {!loadingTopology && topology && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={topology.valid ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>
              valid {String(topology.valid)}
            </Badge>
            <Badge className={topology.runnable ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
              runnable {String(topology.runnable)}
            </Badge>
            <Badge className={topology.inSync ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
              in sync {String(topology.inSync)}
            </Badge>
            <Badge>pipelines {topology.summary.totalPipelines}</Badge>
            <Badge>assigned {topology.summary.assignedPipelines}</Badge>
            <Badge>candidate nodes {topology.summary.totalCandidateNodes}</Badge>
            <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadDetectionTopology()}>
              Refresh topology
            </PrimaryButton>
          </div>
          <div className="space-y-3">
            {topology.pipelines.map((pipeline) => (
              <Surface key={pipeline.pipelineId} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-medium">{pipeline.pipelineId}</div>
                  <Badge>{pipeline.provider}</Badge>
                  <Badge>{pipeline.taskType}</Badge>
                  <Badge>{pipeline.quality}</Badge>
                  <Badge
                    className={
                      pipeline.assignment.status === "assigned"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : pipeline.assignment.status === "degraded"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-rose-200 bg-rose-50 text-rose-700"
                    }
                  >
                    {pipeline.assignment.status}
                  </Badge>
                  {pipeline.resolvedModel ? <Badge>{pipeline.resolvedModel.displayName}</Badge> : null}
                </div>
                <div className="text-sm text-slate-600">{pipeline.assignment.reason}</div>
                {pipeline.issues.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {pipeline.issues.map((issue) => (
                      <Badge
                        key={`${pipeline.pipelineId}-${issue.code}`}
                        className={
                          issue.severity === "error"
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : issue.severity === "warning"
                              ? "border-amber-200 bg-amber-50 text-amber-700"
                              : ""
                        }
                      >
                        {issue.code}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <DataTable>
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Node</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Queue</th>
                      <th className="px-3 py-2">Endpoint</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pipeline.candidates.map((candidate) => (
                      <tr key={`${pipeline.pipelineId}-${candidate.nodeId}`}>
                        <td className="px-3 py-2">{candidate.nodeId}</td>
                        <td className="px-3 py-2">{candidate.role}</td>
                        <td className="px-3 py-2">{candidate.status}</td>
                        <td className="px-3 py-2">
                          {candidate.queueDepth}/{candidate.maxConcurrent}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">{candidate.endpoint}</td>
                      </tr>
                    ))}
                    {pipeline.candidates.length === 0 ? (
                      <tr>
                        <td className="px-3 py-4 text-sm text-slate-500" colSpan={5}>
                          No hay nodos candidatos para este pipeline.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </DataTable>
              </Surface>
            ))}
          </div>
        </div>
      )}

      <div className="divider">Face Library</div>
      {loadingFaces ? <div className="text-sm opacity-70">Loading faces...</div> : null}
      {!loadingFaces && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Surface className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-slate-900">Caras almacenadas</div>
                <div className="text-xs text-slate-500">Muestras recientes detectadas en esta cámara.</div>
              </div>
              <div className="flex gap-2">
                <Badge>{faces.length} visibles</Badge>
                <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadFaces(selectedFaceId ?? undefined)}>
                  Refresh faces
                </PrimaryButton>
              </div>
            </div>
            {faces.length === 0 ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Todavía no hay caras almacenadas para esta cámara.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {faces.map((face) => {
                  const isSelected = face.id === selectedFaceId;
                  return (
                    <button
                      key={face.id}
                      type="button"
                      className={`rounded-lg border px-4 py-3 text-left transition ${
                        isSelected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-900 hover:border-slate-400"
                      }`}
                      onClick={() => void loadSimilarFaces(face.id)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">{summarizeFaceLabel(face)}</div>
                        {face.identity ? (
                          <Badge className={isSelected ? "border-white/30 bg-white/10 text-white" : ""}>
                            {face.identity.displayName ?? face.identity.id}
                          </Badge>
                        ) : null}
                      </div>
                      <div className={`mt-2 text-xs ${isSelected ? "text-slate-200" : "text-slate-500"}`}>
                        {new Date(face.frameTs).toLocaleString()}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        {face.embedding?.dimensions ? (
                          <Badge className={isSelected ? "border-white/30 bg-white/10 text-white" : ""}>
                            embedding {face.embedding.dimensions}d
                          </Badge>
                        ) : (
                          <Badge className={isSelected ? "border-white/30 bg-white/10 text-white" : ""}>sin embedding</Badge>
                        )}
                        {face.cluster ? (
                          <Badge className={isSelected ? "border-white/30 bg-white/10 text-white" : ""}>
                            cluster {face.cluster.displayName ?? face.cluster.id.slice(0, 8)}
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Surface>

          <Surface className="space-y-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-sm font-semibold text-slate-900">Investigación facial</div>
              <div className="mt-1 text-xs text-slate-500">
                {selectedFace
                  ? `Cara base: ${summarizeFaceLabel(selectedFace)}`
                  : "Seleccioná una cara para ver cluster, identidad y acciones disponibles."}
              </div>
              {selectedFace ? (
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Cluster</div>
                    <div className="mt-1 font-medium text-slate-900">
                      {selectedCluster ? selectedCluster.displayName ?? selectedCluster.id : "Sin cluster"}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {selectedCluster ? `status ${selectedCluster.status}` : "Todavía no se agrupó con otras caras."}
                    </div>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Identidad actual</div>
                    <div className="mt-1 font-medium text-slate-900">
                      {selectedIdentity ? selectedIdentity.displayName ?? selectedIdentity.id : "Sin confirmar"}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {selectedIdentity ? `status ${selectedIdentity.status}` : "Podemos confirmarla o asociarla a una identidad existente."}
                    </div>
                  </div>
                </div>
              ) : null}
              {faceActionMessage ? (
                <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  {faceActionMessage}
                </div>
              ) : null}
              {canManageFaceIdentity && selectedCluster && !selectedIdentity ? (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                    <TextInput
                      value={identityDraftName}
                      placeholder="Nombre para la identidad"
                      onChange={(e) => setIdentityDraftName(e.target.value)}
                    />
                    <PrimaryButton
                      className="px-3 py-2 text-sm"
                      type="button"
                      disabled={faceActionLoading}
                      onClick={() =>
                        void confirmSelectedClusterIdentity({
                          displayName: identityDraftName.trim() || undefined
                        })
                      }
                    >
                      Confirmar cluster
                    </PrimaryButton>
                  </div>
                  {suggestedIdentityCandidates.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asociar a identidad existente</div>
                      <div className="flex flex-wrap gap-2">
                        {suggestedIdentityCandidates.map((identity) => (
                          <PrimaryButton
                            key={identity.id}
                            className="px-2.5 py-1.5 text-xs"
                            type="button"
                            disabled={faceActionLoading}
                            onClick={() => void confirmSelectedClusterIdentity({ identityId: identity.id })}
                          >
                            Usar {identity.displayName ?? identity.id}
                          </PrimaryButton>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {canManageFaceIdentity && selectedIdentity && suggestedIdentityCandidates.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Merges sugeridos</div>
                  <div className="flex flex-wrap gap-2">
                    {suggestedIdentityCandidates.map((identity) => (
                      <PrimaryButton
                        key={`merge-${identity.id}`}
                        className="px-2.5 py-1.5 text-xs"
                        type="button"
                        disabled={faceActionLoading}
                        onClick={() => void mergeSelectedIdentityInto(identity.id)}
                      >
                        Merge hacia {identity.displayName ?? identity.id}
                      </PrimaryButton>
                    ))}
                  </div>
                </div>
              ) : null}
              {!canManageFaceIdentity ? (
                <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                  Este rol puede investigar, pero no confirmar ni mergear identidades.
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-slate-900">Caras parecidas</div>
                <div className="text-xs text-slate-500">
                  Ranking por similitud de embedding para la cara seleccionada.
                </div>
              </div>
              {selectedFaceId ? (
                <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => void loadSimilarFaces(selectedFaceId)}>
                  Refresh matches
                </PrimaryButton>
              ) : null}
            </div>
            {loadingSimilarFaces ? <div className="text-sm opacity-70">Buscando caras similares...</div> : null}
            {faceMessage ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">{faceMessage}</div>
            ) : null}
            {!loadingSimilarFaces && similarFaces && similarFaces.matches.length > 0 ? (
              <div className="space-y-3">
                {similarFaces.matches.map((match) => (
                  <Surface key={match.face.id} className="border border-slate-200 bg-slate-50">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium text-slate-900">{summarizeFaceLabel(match.face)}</div>
                      <Badge>{(match.similarityScore * 100).toFixed(1)}%</Badge>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">{new Date(match.face.frameTs).toLocaleString()}</div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Badge>{match.sameCamera ? "misma cámara" : "otra cámara"}</Badge>
                      {match.face.identity ? <Badge>{match.face.identity.displayName ?? match.face.identity.id}</Badge> : null}
                      {match.face.cluster ? <Badge>{match.face.cluster.displayName ?? match.face.cluster.id.slice(0, 8)}</Badge> : null}
                    </div>
                    {canManageFaceIdentity && !selectedIdentity && match.face.identity ? (
                      <div className="mt-3">
                        <PrimaryButton
                          className="px-2.5 py-1.5 text-xs"
                          type="button"
                          disabled={faceActionLoading}
                          onClick={() => void confirmSelectedClusterIdentity({ identityId: match.face.identity!.id })}
                        >
                          Asociar cluster a {match.face.identity.displayName ?? match.face.identity.id}
                        </PrimaryButton>
                      </div>
                    ) : null}
                    {canManageFaceIdentity && selectedIdentity && match.face.identity && match.face.identity.id !== selectedIdentity.id ? (
                      <div className="mt-3">
                        <PrimaryButton
                          className="px-2.5 py-1.5 text-xs"
                          type="button"
                          disabled={faceActionLoading}
                          onClick={() => void mergeSelectedIdentityInto(match.face.identity!.id)}
                        >
                          Merge hacia {match.face.identity.displayName ?? match.face.identity.id}
                        </PrimaryButton>
                      </div>
                    ) : null}
                  </Surface>
                ))}
              </div>
            ) : null}
          </Surface>
        </div>
      )}
    </PageCard>
  );
}

function NotificationsPage({ apiUrl }: { apiUrl: string }) {
  const canCreate = useCan({ resource: "notifications", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "notifications", action: "edit" }).data?.can;
  const canDelete = useCan({ resource: "notifications", action: "delete" }).data?.can;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    type: "webhook",
    endpoint: "",
    emailTo: "",
    authToken: "",
    isActive: true
  });

  const channelsList = useList({
    resource: "notification-channels",
    pagination: { current: 1, pageSize: 100 }
  } as any);
  const deliveriesList = useList({
    resource: "notifications/deliveries",
    pagination: { current: 1, pageSize: 50 },
    sorters: [{ field: "createdAt", order: "desc" }]
  } as any);
  const { mutateAsync: create } = useCreate();
  const { mutateAsync: update } = useUpdate();
  const { mutate: remove } = useDelete();

  async function saveChannel(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setSaving(true);
    try {
      await create({
        resource: "notification-channels",
        values: {
          name: form.name,
          type: form.type,
          endpoint: form.type === "webhook" ? form.endpoint : undefined,
          emailTo: form.type === "email" ? form.emailTo : undefined,
          authToken: form.authToken || undefined,
          isActive: form.isActive
        }
      } as any);
      setForm({ name: "", type: "webhook", endpoint: "", emailTo: "", authToken: "", isActive: true });
      setOk("Canal creado");
      await Promise.all([(channelsList as any).query.refetch(), (deliveriesList as any).query.refetch()]);
    } catch (cause) {
      setError(summarizeApiError(cause, "No se pudo guardar el canal"));
    } finally {
      setSaving(false);
    }
  }

  const channels = ((channelsList as any).result?.data ?? []) as any[];
  const deliveries = ((deliveriesList as any).result?.data ?? []) as any[];

  return (
    <div className="space-y-4">
      <PageCard title="Notification Channels">
        {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        {ok && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}
        {canCreate && (
          <form className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-12" onSubmit={saveChannel}>
            <TextInput
              className="md:col-span-3"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            />
            <SelectInput
              className="md:col-span-2"
              value={form.type}
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
            >
              <option value="webhook">webhook</option>
              <option value="email">email</option>
            </SelectInput>
            {form.type === "webhook" ? (
              <TextInput
                className="font-mono md:col-span-4"
                placeholder="https://example/hooks/nearhome"
                value={form.endpoint}
                onChange={(e) => setForm((prev) => ({ ...prev, endpoint: e.target.value }))}
              />
            ) : (
              <TextInput
                className="md:col-span-4"
                placeholder="alerts@tenant.com"
                value={form.emailTo}
                onChange={(e) => setForm((prev) => ({ ...prev, emailTo: e.target.value }))}
              />
            )}
            <TextInput
              className="md:col-span-2"
              placeholder="Auth token"
              value={form.authToken}
              onChange={(e) => setForm((prev) => ({ ...prev, authToken: e.target.value }))}
            />
            <PrimaryButton className="md:col-span-1" type="submit" disabled={saving || !form.name.trim()}>
              Add
            </PrimaryButton>
          </form>
        )}
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Active</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td className="px-3 py-2">{channel.name}</td>
                <td className="px-3 py-2">{channel.type}</td>
                <td className="px-3 py-2 text-xs font-mono">{channel.type === "webhook" ? channel.endpoint : channel.emailTo}</td>
                <td className="px-3 py-2">{channel.isActive ? "yes" : "no"}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    {canEdit && (
                      <PrimaryButton
                        className="px-2 py-1 text-xs"
                        onClick={async () => {
                          try {
                            await update({
                              resource: "notification-channels",
                              id: channel.id,
                              values: { isActive: !channel.isActive }
                            } as any);
                            (channelsList as any).query.refetch();
                          } catch (cause) {
                            setError(summarizeApiError(cause, "No se pudo actualizar canal"));
                          }
                        }}
                      >
                        {channel.isActive ? "Disable" : "Enable"}
                      </PrimaryButton>
                    )}
                    {canDelete && (
                      <DangerButton
                        className="px-2 py-1 text-xs"
                        onClick={() => {
                          remove({ resource: "notification-channels", id: channel.id });
                          (channelsList as any).query.refetch();
                        }}
                      >
                        Delete
                      </DangerButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </PageCard>

      <PageCard title="Notification Deliveries (recent)">
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Channel</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Camera</th>
              <th className="px-3 py-2">Incident</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td className="px-3 py-2">{new Date(delivery.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{delivery.channelType}</td>
                <td className="px-3 py-2">{delivery.status}</td>
                <td className="px-3 py-2 font-mono text-xs">{delivery.cameraId}</td>
                <td className="px-3 py-2 font-mono text-xs">{delivery.incidentId}</td>
                <td className="px-3 py-2 text-xs">{delivery.error ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </PageCard>
    </div>
  );
}

function PlansPage() {
  const { result } = useList({ resource: "plans" } as any);
  return (
    <PageCard title="Plans">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(result?.data ?? []).map((p: any) => (
          <Surface key={p.id} className="p-4">
            <h3 className="text-lg font-bold">{p.name}</h3>
            <p className="text-sm text-slate-500">{p.code}</p>
            <div className="mt-2 text-sm">Max cameras: {p.limits.maxCameras}</div>
            <div className="text-sm">Retention days: {p.limits.retentionDays}</div>
            <div className="mt-2 text-sm">
              Features:{" "}
              {Object.keys(p.features)
                .filter((f) => p.features[f])
                .join(", ")}
            </div>
          </Surface>
        ))}
      </div>
    </PageCard>
  );
}

function SubscriptionPage({ apiUrl, onChanged }: { apiUrl: string; onChanged: () => void }) {
  const { result: subscription } = useList({ resource: "subscriptions" } as any);
  const { result: plans } = useList({ resource: "plans" } as any);
  const requestsList = useList({
    resource: "subscriptions/requests",
    pagination: { current: 1, pageSize: 50 },
    sorters: [{ field: "createdAt", order: "desc" }]
  } as any);
  const canEdit = useCan({ resource: "subscriptions", action: "edit" }).data?.can;

  async function activate(planId: string) {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await fetch(`${apiUrl}/tenants/${tenantId}/subscription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify({ planId })
    });
    onChanged();
    window.location.reload();
  }

  const active = subscription?.data?.[0] as any;
  const requests = ((requestsList as any).result?.data ?? []) as any[];

  async function reviewRequest(requestId: string, status: "approved" | "rejected") {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await fetch(`${apiUrl}/subscriptions/requests/${requestId}/review`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify({ status })
    });
    await Promise.all([(requestsList as any).query.refetch(), onChanged()]);
    window.location.reload();
  }

  return (
    <PageCard title="Subscription">
      {active ? (
        <Surface className="mb-4 p-4">
          <div>Current plan: {active.plan?.name}</div>
          <div>Status: {active.status}</div>
          <div>Period end: {new Date(active.currentPeriodEnd).toLocaleDateString()}</div>
        </Surface>
      ) : (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">No active subscription</div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {(plans?.data ?? []).map((p: any) => (
            <PrimaryButton key={p.id} className="px-2.5 py-1.5 text-xs" onClick={() => activate(p.id)}>
              Activate {p.name}
            </PrimaryButton>
          ))}
        </div>
      )}

      <div className="mt-6">
        <div className="mb-2 text-sm font-semibold text-slate-700">Solicitudes de suscripción</div>
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Comprobante</th>
              <th className="px-3 py-2">Notas</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.map((request) => (
              <tr key={request.id}>
                <td className="px-3 py-2 text-sm">{new Date(request.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{request.plan?.name ?? request.planId}</td>
                <td className="px-3 py-2">
                  <Badge>{request.status}</Badge>
                </td>
                <td className="px-3 py-2 text-xs">
                  <a className="text-slate-700 underline underline-offset-2" href={request.proofImageUrl} target="_blank" rel="noreferrer">
                    {request.proofFileName}
                  </a>
                </td>
                <td className="px-3 py-2 text-xs">{request.reviewNotes ?? request.notes ?? "-"}</td>
                <td className="px-3 py-2">
                  {canEdit && request.status === "pending_review" ? (
                    <div className="flex gap-2">
                      <PrimaryButton className="px-2 py-1 text-xs" onClick={() => reviewRequest(request.id, "approved")}>
                        Aprobar
                      </PrimaryButton>
                      <DangerButton className="px-2 py-1 text-xs" onClick={() => reviewRequest(request.id, "rejected")}>
                        Rechazar
                      </DangerButton>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">-</span>
                  )}
                </td>
              </tr>
            ))}
            {!requests.length && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-slate-500">
                  Sin solicitudes pendientes.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </div>
    </PageCard>
  );
}

function CameraFeedPlayer({ playbackUrl, cameraName }: { playbackUrl: string; cameraName: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      void video.play().catch(() => undefined);
      const keepNearLiveEdge = () => {
        const seekable = video.seekable;
        if (!seekable || seekable.length === 0) return;
        const liveEdge = seekable.end(seekable.length - 1);
        const lag = liveEdge - video.currentTime;
        if (lag > 1.2) {
          video.currentTime = Math.max(0, liveEdge - 0.15);
        }
      };
      const timer = window.setInterval(keepNearLiveEdge, 500);
      return () => {
        window.clearInterval(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) return;

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 2,
      maxBufferLength: 1,
      maxMaxBufferLength: 2,
      backBufferLength: 0,
      maxBufferSize: 0,
      highBufferWatchdogPeriod: 0.5
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(playbackUrl);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => undefined);
    });
    const liveEdgeTimer = window.setInterval(() => {
      const liveSyncPosition = hls.liveSyncPosition;
      if (typeof liveSyncPosition !== "number") return;
      if (liveSyncPosition - video.currentTime > 1.2) {
        video.currentTime = Math.max(0, liveSyncPosition - 0.1);
      }
    }, 500);

    return () => {
      window.clearInterval(liveEdgeTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [playbackUrl]);

  return <video ref={videoRef} className="aspect-video w-full rounded-box bg-black" controls autoPlay playsInline title={cameraName} />;
}

function MonitorPage({ apiUrl }: { apiUrl: string }) {
  const canList = useCan({ resource: "cameras", action: "list" }).data?.can;
  const [loading, setLoading] = useState(true);
  const [refreshingFeeds, setRefreshingFeeds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [cameras, setCameras] = useState<CameraMonitorItem[]>([]);
  const [feeds, setFeeds] = useState<Record<string, CameraFeedEntry>>({});
  const [streamHealth, setStreamHealth] = useState<Record<string, CameraStreamHealth>>({});

  const tenantId = getTenantId();
  const token = getToken();

  const visibleCameras = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras.filter((camera) => {
      if (onlyActive && !camera.isActive) return false;
      if (!q) return true;
      return (
        camera.name.toLowerCase().includes(q) ||
        String(camera.location ?? "")
          .toLowerCase()
          .includes(q) ||
        camera.id.toLowerCase().includes(q)
      );
    });
  }, [cameras, query, onlyActive]);

  async function loadAllCameras() {
    if (!token || !tenantId) {
      setError("Missing auth context");
      setLoading(false);
      return [];
    }

    const pageSize = 50;
    let start = 0;
    let total = Number.MAX_SAFE_INTEGER;
    const all: CameraMonitorItem[] = [];

    while (start < total) {
      const res = await fetch(`${apiUrl}/cameras?_start=${start}&_end=${start + pageSize}&_sort=createdAt&_order=DESC`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!res.ok) throw new Error(`cameras ${res.status}`);
      const payload = (await res.json()) as { data?: CameraMonitorItem[]; total?: number };
      const rows = payload.data ?? [];
      const parsedTotal = Number(payload.total ?? res.headers.get("x-total-count") ?? rows.length);
      total = Number.isFinite(parsedTotal) ? parsedTotal : rows.length;
      all.push(...rows);
      if (rows.length === 0) break;
      start += rows.length;
    }

    setCameras(all);
    return all;
  }

  async function issueFeedTokens(targetCameras: CameraMonitorItem[], opts?: { force?: boolean }) {
    if (!token || !tenantId) return;
    if (!targetCameras.length) {
      setFeeds({});
      return;
    }

    setRefreshingFeeds(true);
    const force = Boolean(opts?.force);
    const now = Date.now();
    const validThresholdMs = 45 * 1000;
    const targets = targetCameras.filter((camera) => {
      if (force) return true;
      const current = feeds[camera.id];
      if (!current?.playbackUrl || current.status !== "ready" || !current.expiresAt) return true;
      const expiresAtMs = Date.parse(current.expiresAt);
      if (Number.isNaN(expiresAtMs)) return true;
      return expiresAtMs - now <= validThresholdMs;
    });

    if (!targets.length) {
      setRefreshingFeeds(false);
      return;
    }

    setFeeds((prev) => {
      const next = { ...prev };
      for (const camera of targets) {
        next[camera.id] = { ...(next[camera.id] ?? { status: "idle" }), status: "loading", error: undefined };
      }
      return next;
    });

    const nextEntries: Record<string, CameraFeedEntry> = {};
    let reusableSessionsByCamera: Record<string, { token: string; expiresAt: string }> | null = null;
    const loadReusableSessions = async () => {
      if (reusableSessionsByCamera) return reusableSessionsByCamera;
      const statuses = ["issued", "active"];
      const map: Record<string, { token: string; expiresAt: string }> = {};
      for (const status of statuses) {
        const sessionsResponse = await fetch(
          `${apiUrl}/stream-sessions?_start=0&_end=200&_sort=createdAt&_order=DESC&status=${status}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Tenant-Id": tenantId
            }
          }
        );
        if (!sessionsResponse.ok) continue;
        const payload = (await sessionsResponse.json()) as {
          data?: Array<{ cameraId?: string; token?: string; expiresAt?: string }>;
        };
        for (const session of payload.data ?? []) {
          if (!session.cameraId || !session.token || !session.expiresAt) continue;
          const expiresAtMs = Date.parse(session.expiresAt);
          if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) continue;
          if (!map[session.cameraId]) {
            map[session.cameraId] = {
              token: session.token,
              expiresAt: session.expiresAt
            };
          }
        }
      }
      reusableSessionsByCamera = map;
      return map;
    };

    for (const camera of targets) {
      try {
        const response = await fetch(`${apiUrl}/cameras/${camera.id}/stream-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (response.status === 409) {
          const reusable = await loadReusableSessions();
          const reusableSession = reusable[camera.id];
          if (reusableSession) {
            nextEntries[camera.id] = {
              status: "ready",
              playbackUrl: buildPlaybackUrl({
                tenantId,
                cameraId: camera.id,
                token: reusableSession.token
              }),
              expiresAt: reusableSession.expiresAt
            };
            continue;
          }
        }
        if (!response.ok) throw new Error(`stream-token ${response.status}`);
        const payload = (await response.json()) as { playbackUrl?: string; expiresAt?: string };
        if (!payload.playbackUrl) {
          nextEntries[camera.id] = { status: "error", error: "No playback URL returned" };
          continue;
        }
        nextEntries[camera.id] = {
          status: "ready",
          playbackUrl: toPlaybackPublicUrl(payload.playbackUrl),
          expiresAt: payload.expiresAt
        };
      } catch (tokenError) {
        const existing = feeds[camera.id];
        if (existing?.playbackUrl && existing.status === "ready") {
          nextEntries[camera.id] = existing;
          continue;
        }
        nextEntries[camera.id] = {
          status: "error",
          error: tokenError instanceof Error ? tokenError.message : "token error"
        };
      }
    }

    setFeeds((prev) => ({ ...prev, ...nextEntries }));
    setRefreshingFeeds(false);
  }

  async function refreshStreamHealth(targetCameras: CameraMonitorItem[]) {
    if (!tenantId || !targetCameras.length) return;
    const next: Record<string, CameraStreamHealth> = {};
    await Promise.all(
      targetCameras.map(async (camera) => {
        try {
          const playbackOrigin = (() => {
            const currentPlaybackUrl = feeds[camera.id]?.playbackUrl;
            if (!currentPlaybackUrl) return null;
            try {
              return new URL(currentPlaybackUrl).origin;
            } catch {
              return null;
            }
          })();
          const baseUrl = playbackOrigin ?? getStreamGatewayPublicBaseUrl();
          const response = await fetch(
            `${baseUrl}/health/${encodeURIComponent(tenantId)}/${encodeURIComponent(camera.id)}`
          );
          if (!response.ok) {
            next[camera.id] = {
              status: "offline",
              message: response.status === 404 ? "Stream no provisionado" : `Health ${response.status}`,
              checkedAt: new Date().toISOString()
            };
            return;
          }
          const payload = (await response.json()) as {
            data?: { status?: string; health?: { connectivity?: string; error?: string | null } };
            runtime?: {
              liveEdgeLagMs?: number | null;
              liveEdgeStale?: boolean | null;
              workerState?: string | null;
              workerLastExitCode?: number | null;
              diagnostics?: string[];
            };
          };
          const diagnostics = payload.runtime?.diagnostics ?? [];
          const workerState = payload.runtime?.workerState ?? "unknown";
          const connectivity = payload.data?.health?.connectivity ?? "unknown";
          const liveEdgeLagMs = payload.runtime?.liveEdgeLagMs ?? null;
          let status: CameraStreamHealth["status"] = "healthy";
          if (payload.data?.status !== "ready" || workerState !== "running" || connectivity === "offline") {
            status = "offline";
          } else if (payload.runtime?.liveEdgeStale || connectivity === "degraded") {
            status = "degraded";
          }
          const baseMessage =
            status === "healthy"
              ? "Feed en tiempo real OK"
              : status === "degraded"
                ? "Feed con atraso o degradación"
                : "Feed caído o inestable";
          const suffix = diagnostics.length > 0 ? ` (${diagnostics.slice(0, 2).join(", ")})` : "";
          const exitSuffix =
            payload.runtime?.workerLastExitCode !== null && payload.runtime?.workerLastExitCode !== undefined
              ? ` [exit=${payload.runtime.workerLastExitCode}]`
              : "";
          next[camera.id] = {
            status,
            message: `${baseMessage}${suffix}${exitSuffix}`,
            liveEdgeLagMs,
            checkedAt: new Date().toISOString()
          };
        } catch (healthError) {
          next[camera.id] = {
            status: "unknown",
            message: healthError instanceof Error ? `Health endpoint unreachable: ${healthError.message}` : "Health check failed",
            checkedAt: new Date().toISOString()
          };
        }
      })
    );
    setStreamHealth((prev) => ({ ...prev, ...next }));
  }

  useEffect(() => {
    if (canList === false) {
      setLoading(false);
      return;
    }
    if (!token || !tenantId) {
      setLoading(false);
      setError("Missing auth context");
      return;
    }

    let canceled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const all = await loadAllCameras();
        if (canceled) return;
        await issueFeedTokens(all);
        await refreshStreamHealth(all);
      } catch (loadError) {
        if (canceled) return;
        setError(loadError instanceof Error ? loadError.message : "load error");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();

    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, canList, tenantId, token]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => {
      void issueFeedTokens(cameras);
      void refreshStreamHealth(cameras);
    }, 4 * 60 * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, apiUrl, token, tenantId]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => {
      void refreshStreamHealth(cameras);
    }, 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, tenantId]);

  if (canList === false) return <PageCard title="Monitor">No tenés permisos para listar cámaras.</PageCard>;

  return (
    <PageCard title="Monitor de cámaras (tiempo real)">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput
          className="max-w-sm"
          placeholder="Buscar por nombre, location o id"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-2.5 py-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={onlyActive}
            onChange={(event) => setOnlyActive(event.target.checked)}
          />
          <span>Solo activas</span>
        </label>
        <PrimaryButton
          className="px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => {
            void issueFeedTokens(cameras, { force: true });
            void refreshStreamHealth(cameras);
          }}
        >
          Refrescar feeds
        </PrimaryButton>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{visibleCameras.length} visibles</Badge>
        <Badge>{cameras.length} totales</Badge>
        {refreshingFeeds && <Badge className="border-amber-200 bg-amber-50 text-amber-700">actualizando tokens</Badge>}
      </div>
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {loading && <div className="text-sm text-slate-500">Cargando cámaras y sesiones...</div>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {visibleCameras.map((camera) => {
          const feed = feeds[camera.id];
          const health = streamHealth[camera.id];
          return (
            <Surface key={camera.id}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{camera.name}</div>
                <div className="flex items-center gap-1">
                  <Badge className={camera.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                    {camera.isActive ? "active" : "inactive"}
                  </Badge>
                  <Badge>{camera.lifecycleStatus ?? "unknown"}</Badge>
                </div>
              </div>
              <div className="mb-2 text-xs text-slate-600">
                <div>id: {camera.id}</div>
                <div>location: {camera.location ?? "-"}</div>
                <div>token expira: {feed?.expiresAt ? new Date(feed.expiresAt).toLocaleTimeString() : "-"}</div>
                <div>
                  stream health:{" "}
                  {health ? (
                    <span>
                      {health.status}
                      {typeof health.liveEdgeLagMs === "number" ? ` · lag ${Math.round(health.liveEdgeLagMs)}ms` : ""}
                    </span>
                  ) : (
                    "loading"
                  )}
                </div>
                {health?.message && <div>diagnóstico: {health.message}</div>}
              </div>
              {feed?.status === "ready" && feed.playbackUrl ? (
                <CameraFeedPlayer playbackUrl={feed.playbackUrl} cameraName={camera.name} />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg bg-slate-100 text-sm">
                  {feed?.status === "loading" ? "Preparando stream..." : feed?.error ?? "Feed no disponible"}
                </div>
              )}
            </Surface>
          );
        })}
      </div>
      {!loading && !visibleCameras.length && <div className="mt-3 text-sm text-slate-500">No hay cámaras para mostrar.</div>}
    </PageCard>
  );
}

function RealtimePage({ apiUrl }: { apiUrl: string }) {
  const [status, setStatus] = useState<"connecting" | "connected" | "degraded" | "disconnected">("disconnected");
  const [transport, setTransport] = useState<"ws" | "sse" | "none">("none");
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [topics, setTopics] = useState("incident,detection,stream");
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopRef = useRef(false);
  const tenantId = getTenantId();
  const token = getToken();

  useEffect(() => {
    if (!tenantId || !token) {
      setStatus("disconnected");
      setTransport("none");
      return;
    }

    stopRef.current = false;
    let wsAttempts = 0;
    let sseAttempts = 0;
    const seenIds = new Set<string>();

    const schedule = (ms: number, fn: () => void) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(fn, ms);
    };

    const pushEvents = (batch: RealtimeEvent[]) => {
      const filtered = batch.filter((event) => {
        if (seenIds.has(event.eventId)) return false;
        seenIds.add(event.eventId);
        return true;
      });
      if (!filtered.length) return;
      setEvents((prev) => [...filtered, ...prev].slice(0, 50));
    };

    const selectedTopics = topics
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean);

    const connectSse = async () => {
      if (stopRef.current) return;
      setTransport("sse");
      setStatus("degraded");
      try {
        const url = new URL("/events/stream", EVENT_GATEWAY_URL);
        url.searchParams.set("replay", "20");
        url.searchParams.set("once", "1");
        if (selectedTopics.length) {
          url.searchParams.set("topics", selectedTopics.join(","));
        }
        const response = await fetch(url.toString(), {
          headers: { "X-Tenant-Id": tenantId }
        });
        if (!response.ok) throw new Error(`sse ${response.status}`);
        const raw = await response.text();
        const chunks = raw.split("\n\n");
        const parsed: RealtimeEvent[] = [];
        for (const chunk of chunks) {
          const eventLine = chunk
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice(7)
            .trim();
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
            .trim();
          if (!eventLine || !dataLine) continue;
          const event = JSON.parse(dataLine) as RealtimeEvent;
          if (!matchesTopics(event.eventType, selectedTopics)) continue;
          parsed.push(event);
        }
        pushEvents(parsed);
        sseAttempts = 0;
        setStatus("connected");
        schedule(2000, connectSse);
      } catch {
        const delay = Math.min(15000, 1000 * 2 ** Math.min(sseAttempts, 4));
        sseAttempts += 1;
        setStatus("degraded");
        schedule(delay, connectSse);
      }
    };

    const connectWs = async () => {
      if (stopRef.current) return;
      setStatus("connecting");
      try {
        const tokenResponse = await fetch(`${apiUrl}/events/ws-token`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (!tokenResponse.ok) throw new Error(`ws-token ${tokenResponse.status}`);
        const tokenData = (await tokenResponse.json()) as { data?: { token?: string } };
        const wsToken = tokenData.data?.token;
        if (!wsToken) throw new Error("missing ws token");
        const wsUrl = new URL(toWsUrl(EVENT_GATEWAY_URL));
        wsUrl.searchParams.set("token", wsToken);
        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;
        ws.onopen = () => {
          wsAttempts = 0;
          setTransport("ws");
          setStatus("connected");
        };
        ws.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as RealtimeEvent;
            if (!matchesTopics(event.eventType, selectedTopics)) return;
            pushEvents([event]);
          } catch {
            // ignore malformed payloads
          }
        };
        ws.onclose = () => {
          if (stopRef.current) return;
          const delay = Math.min(15000, 1000 * 2 ** Math.min(wsAttempts, 4));
          wsAttempts += 1;
          schedule(delay, connectWs);
        };
        ws.onerror = () => {
          if (stopRef.current) return;
          ws.close();
          connectSse().catch(() => undefined);
        };
      } catch {
        connectSse().catch(() => undefined);
      }
    };

    connectWs().catch(() => undefined);

    return () => {
      stopRef.current = true;
      wsRef.current?.close();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [apiUrl, tenantId, token, topics]);

  return (
    <PageCard title="Realtime stream">
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <TextInput
          value={topics}
          onChange={(event) => setTopics(event.target.value)}
          placeholder="topics csv (incident,detection,stream)"
        />
        <Surface className="px-3 py-2 text-sm">transport: {transport}</Surface>
        <Surface className="px-3 py-2 text-sm">tenant: {tenantId ?? "-"}</Surface>
        <Surface className="px-3 py-2 text-sm">status: {status}</Surface>
      </div>
      <div className="space-y-2">
        {events.map((event) => (
          <Surface key={event.eventId} className="bg-slate-100 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <Badge>{event.eventType}</Badge>
              <span>{new Date(event.occurredAt).toLocaleString()}</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(event.payload, null, 2)}</pre>
          </Surface>
        ))}
        {!events.length && <div className="text-sm text-slate-500">No realtime events received yet.</div>}
      </div>
    </PageCard>
  );
}

export function App({ apiUrl }: AppProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage apiUrl={apiUrl} />} />
      <Route path="/*" element={<Layout apiUrl={apiUrl} />} />
    </Routes>
  );
}
