import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useCan } from "@refinedev/core";
import {
  PageCard,
  PrimaryButton,
  TextInput,
  SelectInput,
  DangerButton,
  Badge,
  Surface,
  DataTable
} from "@app/ui";
import {
  getToken,
  getTenantId,
  getEffectiveRoleFromStorage,
  summarizeApiError,
  summarizeApiErrorResponse,
  formatDetectionTask,
  formatDetectionQuality,
  describePipelineAudienceState,
  getAudienceToneClasses,
  summarizeFaceLabel,
  formatFaceIdentityName,
  summarizeTopologyRisks,
  DETECTION_PROVIDER_OPTIONS,
  DETECTION_TASK_OPTIONS,
  DETECTION_QUALITY_OPTIONS,
  ADMIN_ROUTES,
  type CameraDetectionProfile,
  type CameraDetectionPipeline,
  type DetectionTopology,
  type ModelCatalogEntry,
  type FaceDetectionItem,
  type FaceSimilaritySearchResult,
  type DetectionProviderRuntime,
  type DetectionTaskType,
  type DetectionQuality
} from "../../lib/admin.js";

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

export function CameraShow() {
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
                      {selectedIdentity ? (
                        <Link className="underline underline-offset-2" to={ADMIN_ROUTES.resources.faceCaseDetail(selectedIdentity.id)}>
                          {selectedIdentity.displayName ?? selectedIdentity.id}
                        </Link>
                      ) : (
                        "Sin confirmar"
                      )}
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
                      {match.face.identity ? (
                        <Badge>
                          <Link to={ADMIN_ROUTES.resources.faceCaseDetail(match.face.identity.id)}>
                            {match.face.identity.displayName ?? match.face.identity.id}
                          </Link>
                        </Badge>
                      ) : null}
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
