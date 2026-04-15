import { useEffect, useState } from "react";
import { useCan, useCreate, useList } from "@refinedev/core";
import { DataTable, PageCard, PrimaryButton, SelectInput, TextInput } from "@app/ui";

export function MembershipsPage() {
  const { result } = useList({ resource: "memberships" } as any);
  const { mutate } = useCreate();
  const canCreate = useCan({ resource: "memberships", action: "create" }).data?.can;
  const meRaw = localStorage.getItem("nearhome_me");
  const me = meRaw ? JSON.parse(meRaw) : null;
  const isSuperuser = Boolean(me?.user?.isSuperuser);
  const tenantOptions = me?.memberships ?? [];
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("client_user");
  const [tenantId, setTenantId] = useState<string>(tenantOptions[0]?.tenantId ?? "");

  useEffect(() => {
    if (!tenantId && tenantOptions[0]?.tenantId) {
      setTenantId(tenantOptions[0].tenantId);
    }
  }, [tenantId, tenantOptions]);

  return (
    <PageCard title="Memberships">
      {canCreate && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutate({ resource: "memberships", values: { userId, role, ...(isSuperuser ? { tenantId } : {}) } });
            setUserId("");
          }}
        >
          <TextInput placeholder="userId" value={userId} onChange={(e) => setUserId(e.target.value)} />
          <SelectInput value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">operator</option>
            <option value="client_user">customer</option>
          </SelectInput>
          {isSuperuser && (
            <SelectInput value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenantOptions.map((membership: any) => (
                <option key={membership.tenantId} value={membership.tenantId}>
                  {membership.tenant?.name ?? membership.tenantId}
                </option>
              ))}
            </SelectInput>
          )}
          <PrimaryButton type="submit">Assign role</PrimaryButton>
        </form>
      )}
      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Tenant</th>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(result?.data ?? []).map((m: any) => (
            <tr key={m.id}>
              <td className="px-3 py-2">{m.tenant?.name ?? m.tenantId}</td>
              <td className="px-3 py-2">{m.user?.email ?? m.userId}</td>
              <td className="px-3 py-2">{m.role}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
