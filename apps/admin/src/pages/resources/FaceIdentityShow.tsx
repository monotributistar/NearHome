import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, DataTable, PageCard, Surface } from "@app/ui";
import {
  type FaceIdentityDetail,
  ADMIN_ROUTES,
  formatFaceIdentityName,
  getToken,
  getTenantId,
  summarizeFaceLabel,
  summarizeApiErrorResponse
} from "../../lib/admin.js";

export function FaceIdentityShow() {
  const { id } = useParams();
  const [identity, setIdentity] = useState<FaceIdentityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const identityId = id;
    const token = getToken();
    const tenantId = getTenantId();
    if (!identityId || !token || !tenantId) {
      setError("Missing auth context");
      setLoading(false);
      return;
    }
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/faces/identities/${identityId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (!res.ok) {
          setError(await summarizeApiErrorResponse(res, "No se pudo cargar el caso facial"));
          return;
        }
        const body = (await res.json()) as { data?: FaceIdentityDetail };
        setIdentity(body.data ?? null);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id]);

  if (loading) return <PageCard title="Caso Facial">Loading...</PageCard>;
  if (error || !identity) {
    return <PageCard title="Caso Facial">{error ?? "No se encontró la identidad"}</PageCard>;
  }

  return (
    <PageCard title={`Caso Facial: ${formatFaceIdentityName(identity)}`}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Surface className="border border-slate-200 bg-slate-50">
          <div className="text-xs uppercase tracking-wide text-slate-500">Estado</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{identity.status}</div>
        </Surface>
        <Surface className="border border-slate-200 bg-slate-50">
          <div className="text-xs uppercase tracking-wide text-slate-500">Caras asociadas</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{identity.memberCount}</div>
        </Surface>
        <Surface className="border border-slate-200 bg-slate-50">
          <div className="text-xs uppercase tracking-wide text-slate-500">Cámaras</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{identity.cameras.length}</div>
        </Surface>
        <Surface className="border border-slate-200 bg-slate-50">
          <div className="text-xs uppercase tracking-wide text-slate-500">Última aparición</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{identity.latestSeenAt ? new Date(identity.latestSeenAt).toLocaleString() : "-"}</div>
        </Surface>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Surface className="space-y-3">
          <div className="text-sm font-semibold text-slate-900">Historial por cámara</div>
          <DataTable>
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">Cámara</th>
                <th className="px-3 py-2">Primera vez</th>
                <th className="px-3 py-2">Última vez</th>
                <th className="px-3 py-2">Vistas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {identity.appearances.map((appearance) => (
                <tr key={appearance.cameraId}>
                  <td className="px-3 py-2">
                    <Link className="text-sm font-medium text-slate-700 underline underline-offset-2" to={ADMIN_ROUTES.resources.cameraDetail(appearance.cameraId)}>
                      {appearance.cameraName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-600">{new Date(appearance.firstSeenAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-sm text-slate-600">{new Date(appearance.lastSeenAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{appearance.sightings}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Surface>

        <Surface className="space-y-3">
          <div className="text-sm font-semibold text-slate-900">Historial de merges</div>
          {identity.mergeHistory.length === 0 ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Esta identidad todavía no participó en merges.
            </div>
          ) : (
            <div className="space-y-3">
              {identity.mergeHistory.map((entry) => (
                <Surface key={entry.id} className="border border-slate-200 bg-slate-50">
                  <div className="text-sm font-medium text-slate-900">
                    {entry.sourceIdentityId === identity.id ? "Merge saliente" : "Merge entrante"}
                  </div>
                  <div className="mt-1 text-sm text-slate-700">
                    {formatFaceIdentityName({ id: entry.sourceIdentityId, displayName: entry.sourceDisplayName })} →{" "}
                    {formatFaceIdentityName({ id: entry.targetIdentityId, displayName: entry.targetDisplayName })}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</div>
                  {entry.reason ? <div className="mt-1 text-xs text-slate-500">Motivo: {entry.reason}</div> : null}
                </Surface>
              ))}
            </div>
          )}
        </Surface>
      </div>

      <div className="mt-4">
        <div className="mb-3 text-sm font-semibold text-slate-900">Caras asociadas</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {identity.faces.map((face) => (
            <Surface key={face.id} className="border border-slate-200 bg-slate-50">
              <div className="font-medium text-slate-900">{summarizeFaceLabel(face)}</div>
              <div className="mt-1 text-xs text-slate-500">{new Date(face.frameTs).toLocaleString()}</div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge>{face.embedding?.dimensions ? `${face.embedding.dimensions}d` : "sin embedding"}</Badge>
                {face.cluster ? <Badge>{face.cluster.displayName ?? face.cluster.id}</Badge> : null}
                <Badge>
                  <Link to={ADMIN_ROUTES.resources.cameraDetail(face.cameraId)}>Ver cámara</Link>
                </Badge>
              </div>
            </Surface>
          ))}
        </div>
      </div>
    </PageCard>
  );
}
