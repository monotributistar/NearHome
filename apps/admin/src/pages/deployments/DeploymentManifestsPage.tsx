import { useState, useEffect, useCallback } from "react";
import { Badge, DataTable, PageCard, PrimaryButton, Surface, TextInput } from "@app/ui";
import { getToken, getTenantId } from "../../lib/admin.js";

type ManifestStatus = "draft" | "staged" | "rolling_out" | "deployed" | "rolled_back" | "failed";
type TargetType = "platform" | "fleet" | "gateway";

type DeploymentManifest = {
  id: string;
  name: string;
  version: string;
  status: ManifestStatus;
  targetType: TargetType;
  services: unknown;
  createdAt: string;
};

function statusBadgeClass(status: ManifestStatus): string {
  switch (status) {
    case "draft": return "bg-slate-100 text-slate-600";
    case "staged": return "bg-blue-100 text-blue-700";
    case "rolling_out": return "bg-amber-100 text-amber-700";
    case "deployed": return "bg-emerald-100 text-emerald-700";
    case "rolled_back": return "bg-slate-200 text-slate-500";
    case "failed": return "bg-red-100 text-red-700";
    default: return "bg-slate-100 text-slate-600";
  }
}

function apiHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  const tenantId = getTenantId();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  return headers;
}

export function DeploymentManifestsPage({ apiUrl }: { apiUrl: string }) {
  const [manifests, setManifests] = useState<DeploymentManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formVersion, setFormVersion] = useState("1.0.0");
  const [formTargetType, setFormTargetType] = useState<TargetType>("platform");
  const [formServices, setFormServices] = useState("{}");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/deployments`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const items: DeploymentManifest[] = Array.isArray(payload) ? payload : (payload.data ?? []);
      setManifests(items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    let parsedServices: unknown;
    try {
      parsedServices = JSON.parse(formServices);
    } catch {
      setFormError("Services must be valid JSON.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/ops/deployments`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ name: formName, version: formVersion, targetType: formTargetType, services: parsedServices })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* */ }
        throw new Error(msg);
      }
      setFormName("");
      setFormVersion("1.0.0");
      setFormTargetType("platform");
      setFormServices("{}");
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function doAction(id: string, action: "stage" | "rollout" | "rollback") {
    setActionError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/deployments/${id}/${action}`, {
        method: "POST",
        headers: apiHeaders()
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* */ }
        throw new Error(msg);
      }
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <PageCard title="Deployment Manifests">
      <Surface className="mb-6 p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">New Manifest</div>
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Name</label>
              <TextInput
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="my-manifest"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Version</label>
              <TextInput
                value={formVersion}
                onChange={(e) => setFormVersion(e.target.value)}
                placeholder="1.0.0"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Target Type</label>
              <select
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                value={formTargetType}
                onChange={(e) => setFormTargetType(e.target.value as TargetType)}
              >
                <option value="platform">platform</option>
                <option value="fleet">fleet</option>
                <option value="gateway">gateway</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600">Services (JSON)</label>
            <textarea
              className="min-h-[80px] rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
              value={formServices}
              onChange={(e) => setFormServices(e.target.value)}
              placeholder='{"api": {"image": "nearhome/api:1.0.0"}}'
            />
          </div>
          {formError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
          )}
          <div>
            <PrimaryButton type="submit" disabled={submitting} className="px-4 py-2 text-sm">
              {submitting ? "Creating..." : "Create Manifest"}
            </PrimaryButton>
          </div>
        </form>
      </Surface>

      {actionError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
      )}

      {loading ? (
        <div className="py-6 text-center text-sm text-slate-500">Loading manifests...</div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : (
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Version</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Target</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {manifests.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 text-sm font-medium text-slate-800">{m.name}</td>
                <td className="px-3 py-2 text-sm text-slate-600">{m.version}</td>
                <td className="px-3 py-2">
                  <Badge className={statusBadgeClass(m.status)}>{m.status}</Badge>
                </td>
                <td className="px-3 py-2 text-sm text-slate-600">{m.targetType}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{new Date(m.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1.5">
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      disabled={m.status !== "draft"}
                      onClick={() => doAction(m.id, "stage")}
                    >
                      Stage
                    </PrimaryButton>
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      disabled={m.status !== "staged"}
                      onClick={() => doAction(m.id, "rollout")}
                    >
                      Rollout
                    </PrimaryButton>
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      disabled={!["rolling_out", "deployed"].includes(m.status)}
                      onClick={() => doAction(m.id, "rollback")}
                    >
                      Rollback
                    </PrimaryButton>
                  </div>
                </td>
              </tr>
            ))}
            {!manifests.length && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-slate-500">
                  No manifests found.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      )}
    </PageCard>
  );
}
