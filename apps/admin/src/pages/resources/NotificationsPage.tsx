import { useState, type FormEvent } from "react";
import { useCan, useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { Badge, DataTable, DangerButton, PageCard, PrimaryButton, SelectInput, TextInput } from "@app/ui";
import { summarizeApiError } from "../../lib/admin.js";

export function NotificationsPage({ apiUrl }: { apiUrl: string }) {
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
