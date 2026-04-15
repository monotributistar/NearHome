import { useEffect, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, TextInput, SelectInput, DataTable, Badge, Surface } from "@app/ui";
import { formatApiError } from "../../lib/client.js";

export function PlanPage({ api }: { api: ApiClient }) {
  const [plans, setPlans] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [activeSubscription, setActiveSubscription] = useState<any>(null);
  const [planId, setPlanId] = useState("");
  const [proofImageUrl, setProofImageUrl] = useState("");
  const [proofFileName, setProofFileName] = useState("");
  const [proofMimeType, setProofMimeType] = useState("image/jpeg");
  const [proofSizeBytes, setProofSizeBytes] = useState("0");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function loadData() {
    try {
      const [plansRes, requestsRes, subscriptionsRes] = await Promise.all([
        api.get<any>("/plans"),
        api.get<any>("/subscriptions/requests", { _start: 0, _end: 20 }),
        api.get<any>("/subscriptions")
      ]);
      const plansRows = plansRes.data ?? plansRes;
      setPlans(plansRows);
      if (!planId && plansRows[0]?.id) setPlanId(plansRows[0].id);
      setRequests(requestsRes.data ?? requestsRes);
      setActiveSubscription((subscriptionsRes.data ?? subscriptionsRes)?.[0] ?? null);
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause, "Could not load plan information"));
    }
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageCard title="Plan & Subscription">
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {ok && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <Surface className="mb-4 p-4">
        <div className="text-sm font-medium text-slate-700">Current plan</div>
        <div className="mt-1 text-lg font-semibold">{activeSubscription?.plan?.name ?? "No active plan"}</div>
        <div className="text-sm text-slate-500">Status: {activeSubscription?.status ?? "-"}</div>
      </Surface>

      <div className="mb-2 text-sm font-medium text-slate-700">Request a plan upgrade</div>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-6">
        <SelectInput value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">Select plan</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>{plan.name}</option>
          ))}
        </SelectInput>
        <TextInput placeholder="Proof URL" value={proofImageUrl} onChange={(e) => setProofImageUrl(e.target.value)} />
        <TextInput placeholder="File name" value={proofFileName} onChange={(e) => setProofFileName(e.target.value)} />
        <TextInput placeholder="MIME type" value={proofMimeType} onChange={(e) => setProofMimeType(e.target.value)} />
        <TextInput placeholder="Size (bytes)" value={proofSizeBytes} onChange={(e) => setProofSizeBytes(e.target.value)} />
        <TextInput placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <PrimaryButton
        className="mb-4"
        onClick={async () => {
          if (!planId || !proofImageUrl.trim() || !proofFileName.trim()) {
            setError("Plan, proof URL, and file name are required.");
            return;
          }
          const size = Number(proofSizeBytes);
          if (!Number.isFinite(size) || size <= 0) {
            setError("Invalid file size.");
            return;
          }
          try {
            await api.post("/subscriptions/requests", {
              planId,
              notes: notes.trim() || null,
              proof: {
                imageUrl: proofImageUrl.trim(),
                fileName: proofFileName.trim(),
                mimeType: proofMimeType.trim() || "image/jpeg",
                sizeBytes: Math.trunc(size)
              }
            });
            setProofImageUrl(""); setProofFileName(""); setProofMimeType("image/jpeg"); setProofSizeBytes("0"); setNotes("");
            setOk("Request submitted for review");
            await loadData();
          } catch (cause) {
            setError(formatApiError(cause, "Could not submit request"));
          }
        }}
      >
        Submit request
      </PrimaryButton>

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Plan</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Proof</th>
            <th className="px-3 py-2">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {requests.map((request) => (
            <tr key={request.id}>
              <td className="px-3 py-2 text-sm">{new Date(request.createdAt).toLocaleString()}</td>
              <td className="px-3 py-2">{request.plan?.name ?? request.planId}</td>
              <td className="px-3 py-2"><Badge>{request.status}</Badge></td>
              <td className="px-3 py-2 text-xs">
                <a className="text-slate-700 underline underline-offset-2" href={request.proofImageUrl} target="_blank" rel="noreferrer">
                  {request.proofFileName}
                </a>
              </td>
              <td className="px-3 py-2 text-xs">{request.reviewNotes ?? request.notes ?? "-"}</td>
            </tr>
          ))}
          {!requests.length && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-sm text-slate-500">No requests yet.</td>
            </tr>
          )}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
