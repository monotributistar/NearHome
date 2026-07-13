import { useState, useEffect, useCallback } from "react";
import { DataTable, PageCard, PrimaryButton, Surface, TextInput } from "@app/ui";
import { getToken, getTenantId } from "../../lib/admin.js";

type FleetGroup = {
  id: string;
  name: string;
  description?: string | null;
  tags?: string[];
  gatewayCount?: number;
  createdAt: string;
};

function apiHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  const tenantId = getTenantId();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  return headers;
}

export function FleetGroupsPage({ apiUrl }: { apiUrl: string }) {
  const [groups, setGroups] = useState<FleetGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTags, setFormTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [addGatewayGroupId, setAddGatewayGroupId] = useState<string | null>(null);
  const [gatewayIdInput, setGatewayIdInput] = useState("");
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewaySaving, setGatewaySaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/fleet-groups`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const items: FleetGroup[] = Array.isArray(payload) ? payload : (payload.data ?? []);
      setGroups(items);
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
    const tags = formTags.trim() ? formTags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    setSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/ops/fleet-groups`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          name: formName,
          ...(formDescription.trim() ? { description: formDescription.trim() } : {}),
          ...(tags.length ? { tags } : {})
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* */ }
        throw new Error(msg);
      }
      setFormName("");
      setFormDescription("");
      setFormTags("");
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(group: FleetGroup) {
    setEditingId(group.id);
    setEditName(group.name);
    setEditDescription(group.description ?? "");
    setEditError(null);
  }

  async function saveEdit(id: string) {
    setEditError(null);
    setEditSaving(true);
    try {
      const res = await fetch(`${apiUrl}/ops/fleet-groups/${id}`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({
          name: editName,
          ...(editDescription.trim() ? { description: editDescription.trim() } : { description: null })
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* */ }
        throw new Error(msg);
      }
      setEditingId(null);
      await load();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditSaving(false);
    }
  }

  async function addGateway(groupId: string) {
    setGatewayError(null);
    if (!gatewayIdInput.trim()) return;
    setGatewaySaving(true);
    try {
      const res = await fetch(`${apiUrl}/ops/fleet-groups/${groupId}/gateways`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ gatewayId: gatewayIdInput.trim() })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* */ }
        throw new Error(msg);
      }
      setAddGatewayGroupId(null);
      setGatewayIdInput("");
      await load();
    } catch (e) {
      setGatewayError((e as Error).message);
    } finally {
      setGatewaySaving(false);
    }
  }

  return (
    <PageCard title="Fleet Groups">
      <Surface className="mb-6 p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">New Group</div>
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Name</label>
              <TextInput
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="production-fleet"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Description (optional)</label>
              <TextInput
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Main production fleet"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-600">Tags (comma-separated)</label>
              <TextInput
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="prod, region-ar"
              />
            </div>
          </div>
          {formError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
          )}
          <div>
            <PrimaryButton type="submit" disabled={submitting} className="px-4 py-2 text-sm">
              {submitting ? "Creating..." : "Create Group"}
            </PrimaryButton>
          </div>
        </form>
      </Surface>

      {loading ? (
        <div className="py-6 text-center text-sm text-slate-500">Loading fleet groups...</div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : (
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">Gateways</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((g) => (
              <>
                <tr key={g.id}>
                  <td className="px-3 py-2">
                    {editingId === g.id ? (
                      <TextInput value={editName} onChange={(e) => setEditName(e.target.value)} className="w-40" />
                    ) : (
                      <span className="text-sm font-medium text-slate-800">{g.name}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {editingId === g.id ? (
                      <TextInput value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="w-48" placeholder="Description" />
                    ) : (
                      <span className="text-sm text-slate-600">{g.description ?? "-"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-600">{g.gatewayCount ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{new Date(g.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      {editingId === g.id ? (
                        <>
                          <PrimaryButton className="px-2 py-1 text-xs" disabled={editSaving} onClick={() => saveEdit(g.id)}>
                            {editSaving ? "Saving..." : "Save"}
                          </PrimaryButton>
                          <button
                            className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <PrimaryButton className="px-2 py-1 text-xs" onClick={() => startEdit(g)}>
                            Edit
                          </PrimaryButton>
                          <PrimaryButton
                            className="px-2 py-1 text-xs"
                            onClick={() => {
                              setAddGatewayGroupId(g.id);
                              setGatewayIdInput("");
                              setGatewayError(null);
                            }}
                          >
                            Add Gateway
                          </PrimaryButton>
                        </>
                      )}
                    </div>
                    {editingId === g.id && editError && (
                      <div className="mt-1 text-xs text-red-600">{editError}</div>
                    )}
                  </td>
                </tr>
                {addGatewayGroupId === g.id && (
                  <tr key={`${g.id}-add-gw`}>
                    <td colSpan={5} className="bg-slate-50 px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-600">Gateway ID:</span>
                        <TextInput
                          value={gatewayIdInput}
                          onChange={(e) => setGatewayIdInput(e.target.value)}
                          placeholder="gw-xxxxxxxx"
                          className="w-56"
                        />
                        <PrimaryButton className="px-2 py-1 text-xs" disabled={gatewaySaving} onClick={() => addGateway(g.id)}>
                          {gatewaySaving ? "Adding..." : "Add"}
                        </PrimaryButton>
                        <button
                          className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                          onClick={() => { setAddGatewayGroupId(null); setGatewayError(null); }}
                        >
                          Cancel
                        </button>
                        {gatewayError && <span className="text-xs text-red-600">{gatewayError}</span>}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!groups.length && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-sm text-slate-500">
                  No fleet groups found.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      )}
    </PageCard>
  );
}
