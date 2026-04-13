import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, PageCard, PrimaryButton, SelectInput, Surface, TextInput } from "@app/ui";
import {
  type ClientOverviewCameraRow,
  type DetectionTopology,
  ADMIN_ROUTES,
  formatDetectionTask,
  getAudienceToneClasses,
  getToken,
  getTenantId,
  summarizeApiError,
  summarizeApiErrorResponse,
  summarizeTopologyRisks
} from "../../lib/admin.js";

export function ClientOverviewPage({ apiUrl }: { apiUrl: string }) {
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
