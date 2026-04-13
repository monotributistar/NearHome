import { useCan, useList } from "@refinedev/core";
import { Badge, DataTable, DangerButton, PageCard, PrimaryButton, Surface } from "@app/ui";
import { getToken, getTenantId } from "../../lib/admin.js";

export function SubscriptionPage({ apiUrl, onChanged }: { apiUrl: string; onChanged: () => void }) {
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
