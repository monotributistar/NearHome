import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  summarizeApiError,
  summarizeApiErrorResponse,
  safeJsonParse,
  prettyJson,
  formatDetectionTask,
  DETECTION_PROVIDER_OPTIONS,
  DETECTION_TASK_OPTIONS,
  DETECTION_QUALITY_OPTIONS,
  type OpsNodeSnapshot,
  type OpsNodeConfigEnvelope,
  type OpsNodeDeployDefinition,
  type OpsNodeDeployBundle,
  type DetectionStackSyncState,
  type ModelCatalogEntry,
  type DetectionProviderRuntime,
  type DetectionTaskType,
  type DetectionQuality
} from "../../lib/admin.js";

export function DetectionNodesPage({ apiUrl }: { apiUrl: string }) {
  const [nodes, setNodes] = useState<OpsNodeSnapshot[]>([]);
  const [nodeConfig, setNodeConfig] = useState<OpsNodeConfigEnvelope | null>(null);
  const [deployDefinition, setDeployDefinition] = useState<OpsNodeDeployDefinition | null>(null);
  const [deployBundle, setDeployBundle] = useState<OpsNodeDeployBundle | null>(null);
  const [stackSyncState, setStackSyncState] = useState<DetectionStackSyncState | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [nodeSearch, setNodeSearch] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<"all" | DetectionProviderRuntime>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "degraded" | "offline">("all");
  const [loading, setLoading] = useState(true);
  const [loadingNodeConfig, setLoadingNodeConfig] = useState(false);
  const [loadingDeployDefinition, setLoadingDeployDefinition] = useState(false);
  const [loadingDeployBundle, setLoadingDeployBundle] = useState(false);
  const [exportingDeployBundle, setExportingDeployBundle] = useState(false);
  const [loadingStackSyncState, setLoadingStackSyncState] = useState(false);
  const [startingStackSync, setStartingStackSync] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<string[]>([]);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogProviderFilter, setCatalogProviderFilter] = useState<"all" | DetectionProviderRuntime>("all");
  const [editingCatalogId, setEditingCatalogId] = useState<string | null>(null);
  const [stackSyncForm, setStackSyncForm] = useState<{
    mode: "onprem" | "onprem-remote";
    profile: "default" | "tunnel" | "observability";
  }>({
    mode: "onprem",
    profile: "default"
  });
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
  const faceCatalogEntries = useMemo(
    () => catalog.filter((entry) => entry.taskType === "face_detection"),
    [catalog]
  );
  const faceRuntimeRows = useMemo(
    () =>
      nodes
        .map((node) => {
          const observedCapabilities = node.capabilities ?? [];
          const desiredCapabilities = nodeConfig?.desiredConfig?.nodeId === node.nodeId ? (nodeConfig.desiredConfig.capabilities ?? []) : [];
          const observedSupportsFace = observedCapabilities.some((capability) => capability.taskTypes?.includes("face_detection"));
          const desiredSupportsFace = desiredCapabilities.some((capability) => capability.taskTypes?.includes("face_detection"));
          if (!observedSupportsFace && !desiredSupportsFace) return null;
          const observedModelRefs = Array.from(
            new Set(
              observedCapabilities
                .flatMap((capability) => capability.models ?? [])
                .filter((value) => typeof value === "string" && value.length > 0)
            )
          );
          const desiredModelRefs = Array.from(
            new Set(desiredCapabilities.flatMap((capability) => capability.modelRefs ?? []).filter((value) => value.length > 0))
          );
          return {
            nodeId: node.nodeId,
            runtime: node.runtime,
            status: node.status,
            endpoint: node.endpoint,
            tenantIds: node.assignedTenantIds ?? [],
            desiredSupportsFace,
            observedSupportsFace,
            desiredModelRefs,
            observedModelRefs,
            inSync: nodeConfig?.nodeId === node.nodeId ? Boolean(nodeConfig.diff?.inSync) : undefined
          };
        })
        .filter((entry) => entry !== null),
    [nodeConfig, nodes]
  );

  useEffect(() => {
    setAssignmentDraft(selectedNode?.assignedTenantIds ?? []);
  }, [selectedNodeId, selectedNode?.assignedTenantIds]);

  useEffect(() => {
    if (!selectedNodeId) {
      setDeployDefinition(null);
      return;
    }
    void loadDeployDefinition(selectedNodeId);
  }, [selectedNodeId]);

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

  async function loadDeployDefinition(nodeId: string) {
    const token = getToken();
    if (!token) return;
    setLoadingDeployDefinition(true);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/${encodeURIComponent(nodeId)}/deploy-definition`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`node deploy definition ${res.status}`);
      const body = (await res.json()) as { data?: OpsNodeDeployDefinition };
      setDeployDefinition(body.data ?? null);
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar la definición de despliegue"));
    } finally {
      setLoadingDeployDefinition(false);
    }
  }

  async function loadDeployBundle(nodeIds?: string[]) {
    const token = getToken();
    if (!token) return;
    setLoadingDeployBundle(true);
    try {
      const query = nodeIds && nodeIds.length > 0 ? `?nodeIds=${encodeURIComponent(nodeIds.join(","))}` : "";
      const res = await fetch(`${apiUrl}/ops/nodes/deploy-bundle${query}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`node deploy bundle ${res.status}`);
      const body = (await res.json()) as { data?: OpsNodeDeployBundle };
      setDeployBundle(body.data ?? null);
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar el bundle de despliegue"));
    } finally {
      setLoadingDeployBundle(false);
    }
  }

  async function exportDeployBundle(nodeIds?: string[]) {
    const token = getToken();
    if (!token) return;
    setExportingDeployBundle(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/deploy-bundle/export`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ nodeIds: nodeIds && nodeIds.length > 0 ? nodeIds : undefined })
      });
      if (!res.ok) throw new Error(`node deploy bundle export ${res.status}`);
      const body = (await res.json()) as { data?: OpsNodeDeployBundle };
      setDeployBundle(body.data ?? null);
      if (body.data?.export?.path) {
        setOk(`Bundle exportado en ${body.data.export.path}`);
      } else {
        setOk("Bundle exportado");
      }
    } catch (exportError) {
      setError(summarizeApiError(exportError, "No se pudo exportar el bundle de despliegue"));
    } finally {
      setExportingDeployBundle(false);
    }
  }

  async function loadStackSyncState() {
    const token = getToken();
    if (!token) return;
    setLoadingStackSyncState(true);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/stack-sync-detection`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`stack sync state ${res.status}`);
      const body = (await res.json()) as { data?: DetectionStackSyncState };
      setStackSyncState(body.data ?? null);
    } catch (loadError) {
      setError(summarizeApiError(loadError, "No se pudo cargar el estado de stack sync"));
    } finally {
      setLoadingStackSyncState(false);
    }
  }

  async function triggerStackSync(dryRun: boolean) {
    const token = getToken();
    if (!token) return;
    setStartingStackSync(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`${apiUrl}/ops/nodes/stack-sync-detection`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          mode: stackSyncForm.mode,
          profile: stackSyncForm.profile === "default" ? undefined : stackSyncForm.profile,
          dryRun
        })
      });
      if (!res.ok) throw new Error(await summarizeApiErrorResponse(res, "No se pudo iniciar stack sync"));
      const body = (await res.json()) as { data?: DetectionStackSyncState };
      setStackSyncState(body.data ?? null);
      const profileLabel = stackSyncForm.profile === "default" ? "" : ` (${stackSyncForm.profile})`;
      setOk(dryRun ? `Stack sync validado en dry-run para ${stackSyncForm.mode}${profileLabel}` : `Stack sync iniciado para ${stackSyncForm.mode}${profileLabel}`);
    } catch (startError) {
      setError(summarizeApiError(startError, "No se pudo iniciar stack sync"));
    } finally {
      setStartingStackSync(false);
    }
  }

  useEffect(() => {
    void loadTenants();
    void loadCatalog();
    void loadNodes(true);
    void loadDeployBundle();
    void loadStackSyncState();
    const id = window.setInterval(() => {
      void loadNodes(true);
      void loadStackSyncState();
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
          <PrimaryButton
            className="px-2.5 py-1.5 text-xs"
            type="button"
            onClick={() => void loadDeployBundle(filteredNodes.map((node) => node.nodeId))}
            disabled={loadingDeployBundle || saving}
          >
            {loadingDeployBundle ? "Refreshing bundle..." : "Refresh deploy bundle"}
          </PrimaryButton>
          <PrimaryButton
            className="px-2.5 py-1.5 text-xs"
            type="button"
            onClick={() => void exportDeployBundle(filteredNodes.map((node) => node.nodeId))}
            disabled={exportingDeployBundle || saving}
          >
            {exportingDeployBundle ? "Exporting bundle..." : "Export bundle on server"}
          </PrimaryButton>
          <PrimaryButton
            className="px-2.5 py-1.5 text-xs"
            type="button"
            onClick={() => void loadStackSyncState()}
            disabled={loadingStackSyncState || saving}
          >
            {loadingStackSyncState ? "Refreshing stack sync..." : "Refresh stack sync"}
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

      <PageCard title="Face Detection Contract">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Surface className="space-y-3">
            <div className="text-sm font-semibold text-slate-900">Contrato operativo para `face_detection`</div>
            <div className="text-sm text-slate-600">
              Esta vista resume qué modelos de rostro están declarados en catálogo y qué nodos los publican en runtime con su
              configuración deseada y observada.
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
              Requisitos mínimos:
              <div className="mt-2 font-mono text-xs text-slate-600">
                provider=`yolo` · taskType=`face_detection` · outputs=`storeFaceCrops/storeEmbeddings`
              </div>
            </div>
            <DataTable>
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">Modelo</th>
                  <th className="px-3 py-2">Quality</th>
                  <th className="px-3 py-2">ModelRef</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {faceCatalogEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2">{entry.displayName}</td>
                    <td className="px-3 py-2">{entry.quality}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{entry.modelRef}</td>
                    <td className="px-3 py-2">
                      <Badge className={entry.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                        {entry.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {faceCatalogEntries.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-slate-500" colSpan={4}>
                      No hay entradas de catálogo para `face_detection`.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </DataTable>
          </Surface>

          <Surface className="space-y-3">
            <div className="text-sm font-semibold text-slate-900">Nodos con soporte facial</div>
            <div className="space-y-3">
              {faceRuntimeRows.map((row) => (
                <Surface key={row.nodeId} className="border border-slate-200 bg-slate-50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-900">{row.nodeId}</div>
                      <div className="text-xs text-slate-500">{row.runtime} · {row.endpoint}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge>{row.status}</Badge>
                      {row.inSync !== undefined ? (
                        <Badge className={row.inSync ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                          {row.inSync ? "in sync" : "drift"}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Desired contract</div>
                      <div className="mt-1 text-sm text-slate-700">{row.desiredSupportsFace ? "declared" : "not declared"}</div>
                      <div className="mt-2 text-xs text-slate-500">{row.desiredModelRefs.join(", ") || "sin modelRefs deseados"}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Observed runtime</div>
                      <div className="mt-1 text-sm text-slate-700">{row.observedSupportsFace ? "published" : "not published"}</div>
                      <div className="mt-2 text-xs text-slate-500">{row.observedModelRefs.join(", ") || "sin modelos observados"}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-slate-500">Tenants: {row.tenantIds.join(", ") || "*"}</div>
                </Surface>
              ))}
              {faceRuntimeRows.length === 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  No hay nodos con `face_detection` declarado u observado en este momento.
                </div>
              ) : null}
            </div>
          </Surface>
        </div>
      </PageCard>

      <PageCard title="Detection Deploy Bundle">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <Badge>nodes: {deployBundle?.nodeIds.length ?? 0}</Badge>
            <Badge>warnings: {deployBundle?.warnings.length ?? 0}</Badge>
            <span>generated: {deployBundle?.generatedAt ? new Date(deployBundle.generatedAt).toLocaleString() : "-"}</span>
          </div>
          {deployBundle?.export ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              export path: <code className="break-all">{deployBundle.export.path}</code> · bytes: {deployBundle.export.bytes} · nodes:{" "}
              {deployBundle.export.nodeCount}
            </div>
          ) : null}
          {deployBundle?.warnings && deployBundle.warnings.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {deployBundle.warnings.map((warning) => `${warning.nodeId}: ${warning.message}`).join(" | ")}
            </div>
          ) : null}
          <textarea
            className="min-h-[260px] w-full rounded-lg border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs text-slate-100"
            readOnly
            value={deployBundle?.composeYaml ?? "services:\n  {}\n"}
          />
        </div>
      </PageCard>

      <PageCard title="Detection Stack Sync">
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[180px_180px_minmax(0,1fr)]">
            <SelectInput
              value={stackSyncForm.mode}
              onChange={(e) => setStackSyncForm((prev) => ({ ...prev, mode: e.target.value as "onprem" | "onprem-remote" }))}
            >
              <option value="onprem">onprem</option>
              <option value="onprem-remote">onprem-remote</option>
            </SelectInput>
            <SelectInput
              value={stackSyncForm.profile}
              onChange={(e) =>
                setStackSyncForm((prev) => ({ ...prev, profile: e.target.value as "default" | "tunnel" | "observability" }))
              }
            >
              <option value="default">default profile</option>
              <option value="tunnel">tunnel</option>
              <option value="observability">observability</option>
            </SelectInput>
            <div className="text-sm text-slate-600">Elegí el target operativo antes de disparar el sync.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton
              className="px-2.5 py-1.5 text-xs"
              type="button"
              onClick={() => void triggerStackSync(true)}
              disabled={startingStackSync || stackSyncState?.status === "running"}
            >
              {startingStackSync ? "Starting..." : "Dry-run sync"}
            </PrimaryButton>
            <PrimaryButton
              className="px-2.5 py-1.5 text-xs"
              type="button"
              onClick={() => void triggerStackSync(false)}
              disabled={startingStackSync || stackSyncState?.status === "running"}
            >
              {startingStackSync ? "Starting..." : "Run sync"}
            </PrimaryButton>
            <Badge>{stackSyncState?.status ?? "idle"}</Badge>
            <Badge>{stackSyncState?.mode ?? "onprem"}</Badge>
            {stackSyncState?.profile ? <Badge>profile {stackSyncState.profile}</Badge> : null}
            {stackSyncState?.attempt ? <Badge>attempt {stackSyncState.attempt}/{stackSyncState.maxAttempts}</Badge> : null}
            {stackSyncState ? <Badge>timeout {stackSyncState.timeoutMs}ms</Badge> : null}
            {stackSyncState && stackSyncState.exitCode !== null ? <Badge>exit {stackSyncState.exitCode}</Badge> : null}
          </div>
          <div className="text-sm text-slate-600">
            started: {stackSyncState?.startedAt ? new Date(stackSyncState.startedAt).toLocaleString() : "-"} · finished:{" "}
            {stackSyncState?.finishedAt ? new Date(stackSyncState.finishedAt).toLocaleString() : "-"}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            command: <code className="break-all">{stackSyncState?.command ?? "bash scripts/pilot/stack-sync-detection.sh onprem"}</code>
          </div>
          {stackSyncState?.errorMessage ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{stackSyncState.errorMessage}</div>
          ) : null}
          <textarea
            className="min-h-[180px] w-full rounded-lg border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs text-slate-100"
            readOnly
            value={(stackSyncState?.logTail ?? []).join("\n")}
          />
        </div>
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
                onClick={() => void loadDeployDefinition(selectedNode.nodeId)}
                disabled={saving || loadingDeployDefinition}
              >
                {loadingDeployDefinition ? "Refreshing deploy..." : "Refresh deploy"}
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
                <div className="font-medium">Deploy definition</div>
                {deployDefinition ? <Badge>{deployDefinition.source}</Badge> : null}
                {deployDefinition ? <Badge>contract {deployDefinition.deploymentContractVersion}</Badge> : null}
              </div>
              {loadingDeployDefinition ? (
                <div className="text-xs text-slate-500">Loading deploy definition...</div>
              ) : deployDefinition ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-slate-100 p-2 text-xs">
                      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Build</div>
                      <div>service: {deployDefinition.serviceName}</div>
                      <div>image hint: {deployDefinition.imageHint}</div>
                      <div>context: {deployDefinition.build.context}</div>
                      <div>dockerfile: {deployDefinition.build.dockerfile}</div>
                      <div>ports: {deployDefinition.ports.join(", ")}</div>
                    </div>
                    <div className="rounded-lg bg-slate-100 p-2 text-xs">
                      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Dependencies</div>
                      <div>depends_on: {deployDefinition.dependsOn.join(", ") || "-"}</div>
                      <div>networks: {deployDefinition.networks.join(", ") || "-"}</div>
                      <div>warnings: {deployDefinition.warnings.join(" | ") || "none"}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Environment</div>
                      <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">{prettyJson(deployDefinition.env)}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Compose snippet</div>
                      <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">{prettyJson(deployDefinition.composeService)}</pre>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-500">No hay definición de despliegue disponible para este nodo.</div>
              )}
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
