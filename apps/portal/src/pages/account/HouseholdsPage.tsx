import { useEffect, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, TextInput, SelectInput, DataTable, Badge } from "@app/ui";
import { formatApiError } from "../../lib/client.js";

export function HouseholdsPage({ api }: { api: ApiClient }) {
  const [households, setHouseholds] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [householdForm, setHouseholdForm] = useState({ name: "", address: "", notes: "" });
  const [memberForm, setMemberForm] = useState({
    fullName: "", relationship: "", phone: "", canViewCameras: true, canReceiveAlerts: true, isActive: true
  });

  async function loadHouseholds() {
    try {
      const res = await api.get<any>("/households", { _start: 0, _end: 100 });
      const rows = res.data ?? res;
      setHouseholds(rows);
      setError(null);
      if (!selectedHouseholdId && rows[0]?.id) setSelectedHouseholdId(rows[0].id);
    } catch (cause) {
      setError(formatApiError(cause, "Could not load households"));
    }
  }

  async function loadMembers(householdId: string) {
    if (!householdId) { setMembers([]); return; }
    try {
      const res = await api.get<any>(`/households/${householdId}/members`, { _start: 0, _end: 200 });
      setMembers(res.data ?? res);
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause, "Could not load members"));
    }
  }

  useEffect(() => { void loadHouseholds(); }, [api]);
  useEffect(() => { void loadMembers(selectedHouseholdId); }, [selectedHouseholdId]);

  return (
    <PageCard title="Households & Members">
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {ok && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-5">
        <TextInput placeholder="Household name" value={householdForm.name} onChange={(e) => setHouseholdForm((p) => ({ ...p, name: e.target.value }))} />
        <TextInput placeholder="Address" value={householdForm.address} onChange={(e) => setHouseholdForm((p) => ({ ...p, address: e.target.value }))} />
        <TextInput placeholder="Notes" value={householdForm.notes} onChange={(e) => setHouseholdForm((p) => ({ ...p, notes: e.target.value }))} />
        <PrimaryButton
          onClick={async () => {
            try {
              const created = await api.post<any>("/households", {
                name: householdForm.name,
                address: householdForm.address || null,
                notes: householdForm.notes || null
              });
              const row = created.data ?? created;
              setHouseholdForm({ name: "", address: "", notes: "" });
              setSelectedHouseholdId(row.id);
              setOk("Household created");
              await loadHouseholds();
            } catch (cause) {
              setError(formatApiError(cause, "Could not create household"));
            }
          }}
        >
          Create
        </PrimaryButton>
        <PrimaryButton
          onClick={async () => {
            if (!selectedHouseholdId) return;
            try {
              await api.delete(`/households/${selectedHouseholdId}`);
              setSelectedHouseholdId("");
              setMembers([]);
              setOk("Household deleted");
              await loadHouseholds();
            } catch (cause) {
              setError(formatApiError(cause, "Could not delete household"));
            }
          }}
        >
          Delete selected
        </PrimaryButton>
      </div>

      <div className="mb-4">
        <SelectInput value={selectedHouseholdId} onChange={(e) => setSelectedHouseholdId(e.target.value)} className="max-w-md">
          <option value="">Select household</option>
          {households.map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </SelectInput>
      </div>

      {selectedHouseholdId && (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-7">
            <TextInput placeholder="Full name" value={memberForm.fullName} onChange={(e) => setMemberForm((p) => ({ ...p, fullName: e.target.value }))} />
            <TextInput placeholder="Relationship" value={memberForm.relationship} onChange={(e) => setMemberForm((p) => ({ ...p, relationship: e.target.value }))} />
            <TextInput placeholder="Phone" value={memberForm.phone} onChange={(e) => setMemberForm((p) => ({ ...p, phone: e.target.value }))} />
            <SelectInput value={String(memberForm.canViewCameras)} onChange={(e) => setMemberForm((p) => ({ ...p, canViewCameras: e.target.value === "true" }))}>
              <option value="true">Can view cameras</option>
              <option value="false">No cameras</option>
            </SelectInput>
            <SelectInput value={String(memberForm.canReceiveAlerts)} onChange={(e) => setMemberForm((p) => ({ ...p, canReceiveAlerts: e.target.value === "true" }))}>
              <option value="true">Receives alerts</option>
              <option value="false">No alerts</option>
            </SelectInput>
            <SelectInput value={String(memberForm.isActive)} onChange={(e) => setMemberForm((p) => ({ ...p, isActive: e.target.value === "true" }))}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </SelectInput>
            <PrimaryButton
              onClick={async () => {
                try {
                  await api.post(`/households/${selectedHouseholdId}/members`, {
                    fullName: memberForm.fullName,
                    relationship: memberForm.relationship,
                    phone: memberForm.phone || null,
                    canViewCameras: memberForm.canViewCameras,
                    canReceiveAlerts: memberForm.canReceiveAlerts,
                    isActive: memberForm.isActive
                  });
                  setMemberForm({ fullName: "", relationship: "", phone: "", canViewCameras: true, canReceiveAlerts: true, isActive: true });
                  setOk("Member added");
                  await loadMembers(selectedHouseholdId);
                } catch (cause) {
                  setError(formatApiError(cause, "Could not add member"));
                }
              }}
            >
              Add member
            </PrimaryButton>
          </div>

          <DataTable>
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Relationship</th>
                <th className="px-3 py-2">Permissions</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="px-3 py-2">{member.fullName}</td>
                  <td className="px-3 py-2">{member.relationship}</td>
                  <td className="px-3 py-2 text-xs">
                    cam:{member.canViewCameras ? "yes" : "no"} | alerts:{member.canReceiveAlerts ? "yes" : "no"}
                  </td>
                  <td className="px-3 py-2"><Badge>{member.isActive ? "active" : "inactive"}</Badge></td>
                  <td className="px-3 py-2">
                    <PrimaryButton
                      onClick={async () => {
                        try {
                          await api.delete(`/household-members/${member.id}`);
                          setOk("Member removed");
                          await loadMembers(selectedHouseholdId);
                        } catch (cause) {
                          setError(formatApiError(cause, "Could not remove member"));
                        }
                      }}
                    >
                      Remove
                    </PrimaryButton>
                  </td>
                </tr>
              ))}
              {!members.length && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-sm text-slate-500">No members in this household.</td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </>
      )}
    </PageCard>
  );
}
