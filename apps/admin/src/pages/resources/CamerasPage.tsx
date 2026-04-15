import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCan, useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { Badge, DataTable, DangerButton, PageCard, PrimaryButton, SelectInput, TextInput } from "@app/ui";
import { ADMIN_ROUTES, summarizeApiError } from "../../lib/admin.js";

export function CamerasPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const canCreate = useCan({ resource: "cameras", action: "create" }).data?.can;
  const canDelete = useCan({ resource: "cameras", action: "delete" }).data?.can;
  const canEdit = useCan({ resource: "cameras", action: "edit" }).data?.can;

  const camerasList = useList({
    resource: "cameras",
    pagination: { currentPage: page, pageSize: 5, mode: "server" },
    filters: q ? [{ field: "name", operator: "contains", value: q }] : []
  } as any);
  const result = camerasList.result;

  const { mutateAsync: create } = useCreate();
  const { mutateAsync: update } = useUpdate();
  const { mutate: remove } = useDelete();

  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const totalPages = Math.max(Math.ceil((result?.total ?? 0) / 5), 1);
  const listError = (camerasList as any).query?.error;

  const rows = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Cameras">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <PrimaryButton onClick={() => (camerasList as any).query.refetch()}>Search</PrimaryButton>
      </div>
      {listError && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {summarizeApiError(listError, "No se pudo cargar cámaras")}
        </div>
      )}

      {(canCreate || canEdit) && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-12"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaveError(null);
            setSaveOk(null);
            const payload = { ...form, tags: form.tags ? form.tags.split(",").map((x) => x.trim()) : [] };
            try {
              setSaving(true);
              if (editing) {
                await update({ resource: "cameras", id: editing.id, values: payload });
                setEditing(null);
                setSaveOk("Camera actualizada");
              } else if (canCreate) {
                await create({ resource: "cameras", values: payload });
                setSaveOk("Camera creada");
              }
              setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
              await (camerasList as any).query.refetch();
            } catch (error) {
              setSaveError(summarizeApiError(error, "No se pudo guardar la cámara"));
            } finally {
              setSaving(false);
            }
          }}
        >
          <TextInput
            placeholder="name"
            value={form.name}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <textarea
            placeholder="description"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 md:col-span-3"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <TextInput
            placeholder="rtsp://usuario:password@ip:puerto/stream"
            value={form.rtspUrl}
            className="font-mono md:col-span-5"
            title={form.rtspUrl}
            onChange={(e) => setForm((f) => ({ ...f, rtspUrl: e.target.value }))}
          />
          <TextInput
            placeholder="location"
            value={form.location}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          />
          <TextInput
            placeholder="tags csv"
            value={form.tags}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
          <SelectInput
            value={String(form.isActive)}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "true" }))}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectInput>
          <PrimaryButton
            type="submit"
            className="md:col-span-2"
            disabled={saving || (editing ? !canEdit : !canCreate)}
          >
            {editing ? "Guardar cambios" : "Crear cámara"}
          </PrimaryButton>
          {editing && (
            <PrimaryButton
              type="button"
              className="md:col-span-2"
              onClick={() => {
                setEditing(null);
                setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
                setSaveError(null);
              }}
            >
              Cancelar edición
            </PrimaryButton>
          )}
          {editing && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm md:col-span-12">
              Editando cámara: <strong>{editing.name}</strong> ({editing.id})
            </div>
          )}
          {saveError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 md:col-span-12">{saveError}</div>}
          {saveOk && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 md:col-span-12">{saveOk}</div>}
        </form>
      )}

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">RTSP URL</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c: any) => (
            <tr key={c.id}>
              <td className="px-3 py-2">{c.name}</td>
              <td className="px-3 py-2">{c.location || "-"}</td>
              <td className="px-3 py-2">
                <code className="block max-w-[22rem] overflow-x-auto whitespace-nowrap text-xs">{c.rtspUrl}</code>
              </td>
              <td className="px-3 py-2">
                <Badge className={c.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                  {c.isActive ? "Active" : "Inactive"}
                </Badge>
              </td>
              <td className="px-3 py-2">
                <div className="flex gap-2">
                  <Link
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    to={ADMIN_ROUTES.resources.cameraDetail(c.id)}
                  >
                    Show
                  </Link>
                  {canEdit && (
                    <PrimaryButton
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setEditing(c);
                        setSaveError(null);
                        setSaveOk(null);
                        setForm({
                          name: c.name,
                          description: c.description ?? "",
                          rtspUrl: c.rtspUrl,
                          location: c.location ?? "",
                          tags: (c.tags ?? []).join(","),
                          isActive: c.isActive
                        });
                      }}
                    >
                      Edit
                    </PrimaryButton>
                  )}
                  {canDelete && (
                    <DangerButton
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setSaveError(null);
                        remove(
                          { resource: "cameras", id: c.id },
                          {
                            onSuccess: () => {
                              setSaveOk("Cámara eliminada");
                              (camerasList as any).query.refetch();
                            },
                            onError: (error: any) => {
                              setSaveError(summarizeApiError(error, "No se pudo eliminar la cámara"));
                            }
                          }
                        );
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
