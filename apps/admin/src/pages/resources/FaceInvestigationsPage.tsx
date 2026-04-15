import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, DataTable, PageCard, SelectInput, TextInput } from "@app/ui";
import {
  type FaceIdentitySummary,
  ADMIN_ROUTES,
  formatFaceIdentityName,
  getToken,
  getTenantId,
  summarizeApiErrorResponse
} from "../../lib/admin.js";

export function FaceInvestigationsPage({ apiUrl }: { apiUrl: string }) {
  const [rows, setRows] = useState<FaceIdentitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | "confirmed" | "merged">("active");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) {
      setError("Missing auth context");
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ _start: "0", _end: "50" });
        if (statusFilter === "merged") {
          params.set("status", "merged");
          params.set("includeMerged", "true");
        } else if (statusFilter === "confirmed") {
          params.set("status", "confirmed");
        }
        const res = await fetch(`${apiUrl}/faces/identities?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (!res.ok) {
          setError(await summarizeApiErrorResponse(res, "No se pudo cargar identidades"));
          return;
        }
        const body = (await res.json()) as { data?: FaceIdentitySummary[] };
        const fetched = body.data ?? [];
        setRows(
          statusFilter === "active" ? fetched.filter((item) => item.status !== "merged" && !item.mergedIntoIdentityId) : fetched
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [apiUrl, statusFilter]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (!normalizedQuery) return true;
    const inIdentity = formatFaceIdentityName(row).toLowerCase().includes(normalizedQuery);
    const inCameras = row.cameras.some((camera) => camera.cameraName.toLowerCase().includes(normalizedQuery));
    return inIdentity || inCameras;
  });

  return (
    <PageCard title="Identidades Faciales">
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
        <TextInput
          placeholder="Buscar por identidad o cámara"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectInput value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
          <option value="active">activas</option>
          <option value="confirmed">confirmadas</option>
          <option value="merged">mergeadas</option>
          <option value="all">todas</option>
        </SelectInput>
      </div>
      {error ? <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
      {loading ? (
        <div className="text-sm opacity-70">Loading facial identities...</div>
      ) : (
        <DataTable>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Identidad</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Apariciones</th>
              <th className="px-3 py-2">Cámaras</th>
              <th className="px-3 py-2">Última vez</th>
              <th className="px-3 py-2">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{formatFaceIdentityName(row)}</div>
                  <div className="text-xs text-slate-500">{row.id}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge className={row.status === "merged" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>
                    {row.status}
                  </Badge>
                </td>
                <td className="px-3 py-2">{row.memberCount}</td>
                <td className="px-3 py-2 text-sm text-slate-600">
                  {row.cameras.map((camera) => `${camera.cameraName} (${camera.sightings})`).join(", ") || "-"}
                </td>
                <td className="px-3 py-2 text-sm text-slate-600">{row.latestSeenAt ? new Date(row.latestSeenAt).toLocaleString() : "-"}</td>
                <td className="px-3 py-2">
                  <Link className="text-sm font-medium text-slate-700 underline underline-offset-2" to={ADMIN_ROUTES.resources.faceCaseDetail(row.id)}>
                    Ver caso
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-sm text-slate-500" colSpan={6}>
                  No hay identidades para este filtro.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      )}
    </PageCard>
  );
}
