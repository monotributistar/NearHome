import { useEffect, useMemo, useState } from "react";
import { useCan, useCreate, useList, useUpdate } from "@refinedev/core";
import { Badge, DataTable, PageCard, PrimaryButton, SelectInput, TextInput } from "@app/ui";

export function UsersPage() {
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const usersList = useList({
    resource: "users",
    pagination: { currentPage: page, pageSize, mode: "server" }
  } as any);
  const result = usersList.result;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const canCreate = useCan({ resource: "users", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "users", action: "edit" }).data?.can;

  const [form, setForm] = useState({ email: "", name: "", password: "demo1234", role: "client_user" });
  const [rowDrafts, setRowDrafts] = useState<Record<string, { name: string; role: string; isActive: boolean }>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      (result?.data ?? []).map((u: any) => [
        u.id,
        {
          name: u.name ?? "",
          role: u.role ?? "client_user",
          isActive: Boolean(u.isActive)
        }
      ])
    );
    setRowDrafts(nextDrafts);
  }, [result?.data]);

  const users = useMemo(() => result?.data ?? [], [result?.data]);
  const total = result?.total ?? users.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <PageCard title="Users">
      {canCreate && (
        <form
          data-testid="users-create-form"
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "users", values: form },
              {
                onSuccess: () => {
                  setForm({ email: "", name: "", password: "demo1234", role: "client_user" });
                  (usersList as any).query.refetch();
                }
              }
            );
          }}
        >
          <TextInput
            placeholder="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <TextInput
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <TextInput
            placeholder="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
          <SelectInput value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">operator</option>
            <option value="client_user">customer</option>
          </SelectInput>
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Status</th>
            {canEdit && <th className="px-3 py-2">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u: any) => (
            <tr key={u.id}>
              <td className="px-3 py-2">{u.email}</td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <TextInput
                    data-testid={`users-name-${u.id}`}
                    value={rowDrafts[u.id]?.name ?? ""}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), name: e.target.value }
                      }))
                    }
                  />
                ) : (
                  u.name
                )}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <SelectInput
                    data-testid={`users-role-${u.id}`}
                    value={rowDrafts[u.id]?.role ?? "client_user"}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), role: e.target.value }
                      }))
                    }
                  >
                    <option value="tenant_admin">tenant_admin</option>
                    <option value="monitor">operator</option>
                    <option value="client_user">customer</option>
                  </SelectInput>
                ) : (
                  u.role
                )}
              </td>
              <td className="px-3 py-2">
                <Badge className={rowDrafts[u.id]?.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                  {rowDrafts[u.id]?.isActive ? "active" : "inactive"}
                </Badge>
              </td>
              {canEdit && (
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton
                      data-testid={`users-save-${u.id}`}
                      className="px-2 py-1 text-xs"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: {
                              name: rowDrafts[u.id]?.name,
                              role: rowDrafts[u.id]?.role
                            }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      Save
                    </PrimaryButton>
                    <PrimaryButton
                      data-testid={`users-toggle-${u.id}`}
                      className="px-2 py-1 text-xs"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: { isActive: !rowDrafts[u.id]?.isActive }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      {rowDrafts[u.id]?.isActive ? "Disable" : "Enable"}
                    </PrimaryButton>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>

      <div className="mt-4 flex items-center justify-end gap-2">
        <PrimaryButton className="px-2 py-1 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Prev
        </PrimaryButton>
        <span className="text-sm">
          Page {page} / {totalPages}
        </span>
        <PrimaryButton
          className="px-2 py-1 text-xs"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </PrimaryButton>
      </div>
    </PageCard>
  );
}
