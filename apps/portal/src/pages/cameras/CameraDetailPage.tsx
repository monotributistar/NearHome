import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, Badge, Surface } from "@app/ui";
import { formatApiError } from "../../lib/client.js";

export function CameraDetailPage({ api }: { api: ApiClient }) {
  const { id } = useParams();
  const [camera, setCamera] = useState<any>(null);
  const [lifecycle, setLifecycle] = useState<any>(null);
  const [token, setToken] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadCamera(cameraId: string) {
    const res = await api.get<any>(`/cameras/${cameraId}`);
    setCamera(res.data ?? res);
  }

  async function loadLifecycle(cameraId: string) {
    const res = await api.get<any>(`/cameras/${cameraId}/lifecycle`);
    setLifecycle(res.data ?? res);
  }

  async function loadSessions(cameraId: string) {
    try {
      const res = await api.get<any>("/stream-sessions", { cameraId, _start: 0, _end: 5, _sort: "createdAt", _order: "DESC" });
      setSessions(res.data ?? []);
    } catch (cause) {
      setSessions([]);
      setError(formatApiError(cause, "Could not load stream sessions"));
    }
  }

  useEffect(() => {
    if (!id) return;
    Promise.all([loadCamera(id), loadLifecycle(id), loadSessions(id)])
      .then(() => setError(null))
      .catch((cause) => setError(formatApiError(cause, "Could not load camera details")));
  }, [api, id]);

  if (!camera) return <div className="p-4">{error ? `Error: ${error}` : "Loading..."}</div>;

  return (
    <PageCard title={camera.name}>
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="space-y-2">
        <div className="rounded-lg bg-slate-100 p-8 text-center text-sm text-slate-500">Live stream preview coming soon</div>
        <div>RTSP: {camera.rtspUrl}</div>
        <div>Location: {camera.location || "-"}</div>
        <div className="flex items-center gap-2">
          <span>Lifecycle:</span>
          <Badge>{lifecycle?.currentStatus ?? camera.lifecycleStatus}</Badge>
        </div>
        <div className="flex gap-2">
          <PrimaryButton
            type="button"
            onClick={async () => {
              try {
                await api.post(`/cameras/${camera.id}/validate`, {});
                await Promise.all([loadCamera(camera.id), loadLifecycle(camera.id)]);
                setError(null);
              } catch (cause) {
                setError(formatApiError(cause, "Could not validate camera"));
              }
            }}
          >
            Validate camera
          </PrimaryButton>
          <button
            className="inline-flex items-center justify-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            type="button"
            onClick={async () => {
              try {
                await loadLifecycle(camera.id);
                setError(null);
              } catch (cause) {
                setError(formatApiError(cause, "Could not refresh health"));
              }
            }}
          >
            Refresh health
          </button>
        </div>
        <Surface className="space-y-1 bg-slate-50 p-3 text-sm">
          <div>Connectivity: {lifecycle?.healthSnapshot?.connectivity ?? "no data"}</div>
          <div>Latency: {lifecycle?.healthSnapshot?.latencyMs ?? "-"} ms</div>
          <div>Jitter: {lifecycle?.healthSnapshot?.jitterMs ?? "-"} ms</div>
          <div>Packet loss: {lifecycle?.healthSnapshot?.packetLossPct ?? "-"} %</div>
          <div>Error: {lifecycle?.healthSnapshot?.error ?? "-"}</div>
          <div>
            Last check:{" "}
            {lifecycle?.healthSnapshot?.checkedAt ? new Date(lifecycle.healthSnapshot.checkedAt).toLocaleString() : "-"}
          </div>
        </Surface>
        <PrimaryButton
          onClick={async () => {
            try {
              const res = await api.post<any>(`/cameras/${camera.id}/stream-token`);
              setToken(res);
              setSession(res.session ?? null);
              setError(null);
              await loadSessions(camera.id);
            } catch (cause) {
              setError(formatApiError(cause, "Could not issue stream token"));
            }
          }}
        >
          Get stream token
        </PrimaryButton>
        {token && (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="break-all text-xs">token: {token.token}</div>
            <div className="text-xs">expiresAt: {token.expiresAt}</div>
            {token.playbackUrl && (
              <div className="break-all text-xs">
                playbackUrl:{" "}
                <a className="text-slate-700 underline underline-offset-2" href={token.playbackUrl} target="_blank" rel="noreferrer">
                  {token.playbackUrl}
                </a>
              </div>
            )}
          </div>
        )}
        {token?.playbackUrl && (
          <div className="rounded-lg bg-slate-100 p-3">
            <div className="mb-2 text-xs text-slate-600">Playback preview</div>
            <video className="w-full rounded-lg" controls muted src={token.playbackUrl} />
          </div>
        )}
        {session && (
          <div className="space-y-2 rounded-lg bg-slate-100 p-3">
            <div className="text-sm">
              Session: <Badge data-testid="stream-session-status">{session.status}</Badge>
            </div>
            <div className="flex gap-2">
              <PrimaryButton
                data-testid="stream-activate"
                type="button"
                disabled={session.status !== "issued"}
                onClick={async () => {
                  try {
                    const res = await api.post<any>(`/stream-sessions/${session.id}/activate`, {});
                    setSession(res.data ?? res);
                    setError(null);
                    await loadSessions(camera.id);
                  } catch (cause) {
                    setError(formatApiError(cause, "Could not activate session"));
                  }
                }}
              >
                Mark active
              </PrimaryButton>
              <PrimaryButton
                data-testid="stream-end"
                type="button"
                disabled={session.status === "ended" || session.status === "expired"}
                onClick={async () => {
                  try {
                    const res = await api.post<any>(`/stream-sessions/${session.id}/end`, { reason: "portal user ended" });
                    setSession(res.data ?? res);
                    setError(null);
                    await loadSessions(camera.id);
                  } catch (cause) {
                    setError(formatApiError(cause, "Could not end session"));
                  }
                }}
              >
                End session
              </PrimaryButton>
            </div>
          </div>
        )}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Recent stream sessions</h3>
          <div className="space-y-1">
            {sessions.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-xs">
                <span className="truncate">{item.id}</span>
                <Badge>{item.status}</Badge>
              </div>
            ))}
            {!sessions.length && <div className="text-xs text-slate-500">No stream sessions yet</div>}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Lifecycle history</h3>
          <div className="space-y-1">
            {(lifecycle?.history ?? []).slice(0, 6).map((entry: any) => (
              <div key={entry.id} className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-xs">
                <span>{entry.event}</span>
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
            ))}
            {!lifecycle?.history?.length && <div className="text-xs text-slate-500">No lifecycle history.</div>}
          </div>
        </div>
      </div>
    </PageCard>
  );
}
