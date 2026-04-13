import { useEffect, useState } from "react";
import { useCan, useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { DataTable, DangerButton, PageCard, PrimaryButton, TextInput } from "@app/ui";

export function TenantsPage() {
  const tenantsList = useList({ resource: "tenants" } as any);
  const { result } = tenantsList;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const { mutate: remove } = useDelete();
  const [name, setName] = useState("");
  const canCreate = useCan({ resource: "tenants", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "tenants", action: "edit" }).data?.can;
  const canDelete = useCan({ resource: "tenants", action: "delete" }).data?.can;
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries((result?.data ?? []).map((t: any) => [t.id, t.name ?? ""]));
    setDrafts(nextDrafts);
  }, [result?.data]);

  return (
    <PageCard title="Tenants">
      {canCreate && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "tenants", values: { name } },
              {
                onSuccess: () => {
                  (tenantsList as any).query.refetch();
                }
              }
            );
            setName("");
          }}
        >
          <TextInput placeholder="Tenant name" value={name} onChange={(e) => setName(e.target.value)} />
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}
      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Created</th>
            {(canEdit || canDelete) && <th className="px-3 py-2">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(result?.data ?? []).map((t: any) => (
            <tr key={t.id}>
              <td className="px-3 py-2">
                {canEdit ? (
                  <TextInput
                    data-testid={`tenant-name-${t.id}`}
                    value={drafts[t.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  />
                ) : (
                  t.name
                )}
              </td>
              <td className="px-3 py-2">{new Date(t.createdAt).toLocaleString()}</td>
              {(canEdit || canDelete) && (
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {canEdit && (
                      <PrimaryButton
                        data-testid={`tenant-save-${t.id}`}
                        className="px-2 py-1 text-xs"
                        type="button"
                        onClick={() =>
                          update(
                            {
                              resource: "tenants",
                              id: t.id,
                              values: { name: drafts[t.id] ?? t.name }
                            },
                            {
                              onSuccess: () => {
                                (tenantsList as any).query.refetch();
                              }
                            }
                          )
                        }
                      >
                        Save
                      </PrimaryButton>
                    )}
                    {canDelete && (
                      <DangerButton
                        data-testid={`tenant-delete-${t.id}`}
                        className="px-2 py-1 text-xs"
                        type="button"
                        onClick={() =>
                          remove(
                            {
                              resource: "tenants",
                              id: t.id
                            },
                            {
                              onSuccess: () => {
                                (tenantsList as any).query.refetch();
                              }
                            }
                          )
                        }
                      >
                        Delete
                      </DangerButton>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
