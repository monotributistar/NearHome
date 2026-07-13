import { useEffect, useState } from "react";
import { Badge, DataTable, PageCard, PrimaryButton, Surface } from "@app/ui";
import { type DeploymentStatusData, getToken, summarizeApiError } from "../../lib/admin.js";

export function ControlPanelPage({ apiUrl }: { apiUrl: string }) {
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

      <PageCard title="Mapa Operativo">
        <p className="mb-4 text-sm text-slate-600">
          Flujo visible: servicios de plataforma → nodos de inferencia → clientes → cámaras. Se actualiza cada 15 segundos.
        </p>
        <div className="grid gap-4 xl:grid-cols-[minmax(220px,0.8fr)_minmax(240px,0.9fr)_minmax(360px,1.5fr)]">
          <Surface>
            <div className="mb-3 font-semibold">Servicios</div>
            <div className="space-y-2">
              {(data?.services ?? []).map((service) => (
                <div key={service.name} className="rounded border border-slate-200 px-2.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{service.name}</span>
                    <span className={service.ok ? "text-emerald-700" : "text-rose-700"}>{service.ok ? "activo" : "caído"}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{service.latencyMs ?? "-"} ms</div>
                </div>
              ))}
            </div>
          </Surface>
          <Surface>
            <div className="mb-3 font-semibold">Nodos</div>
            <div className="space-y-2">
              {(data?.nodes.items ?? []).map((node, index) => (
                <div key={node.nodeId ?? `map-node-${index}`} className="rounded border border-slate-200 px-2.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{node.nodeId ?? "sin id"}</span>
                    <span className={node.status === "online" ? "text-emerald-700" : node.status === "degraded" ? "text-amber-700" : "text-rose-700"}>{node.status ?? "offline"}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{node.runtime ?? "-"} · cola {node.queueDepth ?? 0}/{node.maxConcurrent ?? 0}</div>
                </div>
              ))}
              {data?.nodes.items.length === 0 && <div className="text-sm text-slate-500">Sin nodos registrados.</div>}
            </div>
          </Surface>
          <div className="space-y-3">
            {(data?.topology?.tenants ?? []).map((tenant) => (
              <Surface key={tenant.tenantId}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="font-semibold">{tenant.tenantName}</div>
                  <Badge>{tenant.cameras.length} cámaras</Badge>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {tenant.cameras.map((camera) => {
                    const healthy = camera.health?.connectivity === "online" || camera.health?.connectivity === "healthy";
                    const state = !camera.isActive ? "inactiva" : healthy ? "online" : camera.health?.connectivity ?? camera.lifecycleStatus;
                    return (
                      <div key={camera.cameraId} className="rounded border border-slate-200 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{camera.name}</span>
                          <span className={healthy ? "text-emerald-700" : "text-amber-700"}>{state}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{camera.location ?? "sin ubicación"} · {camera.health?.latencyMs ?? "-"} ms</div>
                        {camera.profile?.lastError && <div className="mt-1 text-xs text-rose-700">{camera.profile.lastError}</div>}
                      </div>
                    );
                  })}
                </div>
              </Surface>
            ))}
            {(data?.topology?.tenants.length ?? 0) === 0 && <Surface className="text-sm text-slate-500">Sin clientes o cámaras para mostrar.</Surface>}
          </div>
        </div>
      </PageCard>
    </div>
  );
}
