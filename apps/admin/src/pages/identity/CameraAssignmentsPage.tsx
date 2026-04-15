import { useEffect, useMemo, useState } from "react";
import { useCan, useList } from "@refinedev/core";
import { Badge, PageCard, PrimaryButton, SelectInput } from "@app/ui";
import { getToken, getTenantId, summarizeApiError } from "../../lib/admin.js";

export function CameraAssignmentsPage({ apiUrl }: { apiUrl: string }) {
  const canEdit = useCan({ resource: "users", action: "edit" }).data?.can;
  const usersList = useList({ resource: "users", pagination: { currentPage: 1, pageSize: 200, mode: "server" } } as any);
  const camerasList = useList({ resource: "cameras", pagination: { currentPage: 1, pageSize: 200, mode: "server" } } as any);
  const users = useMemo(
    () => (usersList.result?.data ?? []).filter((user: any) => ["monitor", "client_user"].includes(user.role)),
    [usersList.result?.data]
  );
  const cameras = useMemo(() => camerasList.result?.data ?? [], [camerasList.result?.data]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [assignedCameraIds, setAssignedCameraIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedUserId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiUrl}/camera-assignments?userId=${encodeURIComponent(selectedUserId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Tenant-Id": tenantId
            }
          }
        );
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`camera-assignments ${res.status}: ${body}`);
        }
        const body = await res.json();
        const ids = (body.data ?? []).map((entry: any) => String(entry.cameraId));
        setAssignedCameraIds(ids);
      } catch (cause) {
        setError(summarizeApiError(cause, "No se pudo cargar scope de cámaras"));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [apiUrl, selectedUserId]);

  const selectedUser = users.find((user: any) => user.id === selectedUserId);

  return (
    <PageCard title="Scope de cámaras por usuario">
      <div className="mb-3 text-sm opacity-70">
        Sin asignaciones explícitas, monitor/customer ven todas las cámaras del tenant. Al asignar cámaras, se aplica allowlist.
      </div>
      {!canEdit && <div className="alert alert-warning py-2 text-sm">No tenés permisos para administrar scopes.</div>}

      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2">
        <SelectInput value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} disabled={!canEdit}>
          <option value="">Seleccionar usuario</option>
          {users.map((user: any) => (
            <option key={user.id} value={user.id}>
              {user.email} ({user.role === "monitor" ? "operator" : "customer"})
            </option>
          ))}
        </SelectInput>
        <div className="rounded-box border border-base-300 px-3 py-2 text-sm">
          {selectedUser ? (
            <>
              <div>usuario: {selectedUser.email}</div>
              <div>rol: {selectedUser.role === "monitor" ? "operator" : "customer"}</div>
            </>
          ) : (
            <div>Seleccioná un usuario para editar su scope</div>
          )}
        </div>
      </div>

      {selectedUserId && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge>{assignedCameraIds.length} asignadas</Badge>
            <Badge>{cameras.length} cámaras tenant</Badge>
            {loading && <Badge>cargando...</Badge>}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {cameras.map((camera: any) => (
              <label key={camera.id} className="flex items-center gap-2 rounded-box border border-base-300 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={assignedCameraIds.includes(camera.id)}
                  onChange={(e) =>
                    setAssignedCameraIds((prev) =>
                      e.target.checked ? Array.from(new Set([...prev, camera.id])) : prev.filter((value) => value !== camera.id)
                    )
                  }
                  disabled={!canEdit || saving}
                />
                <span className="font-medium">{camera.name}</span>
                <span className="opacity-70">({camera.location || "-"})</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <PrimaryButton
              type="button"
              disabled={!canEdit || saving}
              onClick={async () => {
                const token = getToken();
                const tenantId = getTenantId();
                if (!token || !tenantId || !selectedUserId) {
                  setError("Missing auth context");
                  return;
                }
                setSaving(true);
                setError(null);
                setOk(null);
                try {
                  const res = await fetch(`${apiUrl}/camera-assignments/${encodeURIComponent(selectedUserId)}`, {
                    method: "PUT",
                    headers: {
                      "content-type": "application/json",
                      Authorization: `Bearer ${token}`,
                      "X-Tenant-Id": tenantId
                    },
                    body: JSON.stringify({ cameraIds: assignedCameraIds })
                  });
                  if (!res.ok) {
                    const body = await res.text();
                    throw new Error(`camera-assignments save ${res.status}: ${body}`);
                  }
                  setOk("Scope guardado");
                } catch (cause) {
                  setError(summarizeApiError(cause, "No se pudo guardar scope"));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Guardar scope
            </PrimaryButton>
            <button
              className="btn"
              type="button"
              disabled={!canEdit || saving}
              onClick={() => setAssignedCameraIds([])}
            >
              Limpiar (ver todas)
            </button>
          </div>
          {error && <div className="alert alert-error mt-3 py-2 text-sm">{error}</div>}
          {ok && <div className="alert alert-success mt-3 py-2 text-sm">{ok}</div>}
        </>
      )}
    </PageCard>
  );
}
