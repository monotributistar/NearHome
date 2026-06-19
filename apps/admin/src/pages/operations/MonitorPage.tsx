import { useEffect, useMemo, useRef, useState } from "react";
import { useCan } from "@refinedev/core";
import { PageCard, PrimaryButton, TextInput, Surface, Badge, DetectionOverlay, useSSEDetectionFeed } from "@app/ui";
import {
  getToken,
  getTenantId,
  buildPlaybackUrl,
  toPlaybackPublicUrl,
  getStreamGatewayPublicBaseUrl,
  summarizeApiError,
  type CameraMonitorItem,
  type CameraFeedEntry,
  type CameraStreamHealth
} from "../../lib/admin.js";
import { CameraFeedPlayer } from "../../components/CameraFeedPlayer.js";

export function MonitorPage({ apiUrl }: { apiUrl: string }) {
  const canList = useCan({ resource: "cameras", action: "list" }).data?.can;
  const [loading, setLoading] = useState(true);
  const [refreshingFeeds, setRefreshingFeeds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [cameras, setCameras] = useState<CameraMonitorItem[]>([]);
  const [feeds, setFeeds] = useState<Record<string, CameraFeedEntry>>({});
  const [streamHealth, setStreamHealth] = useState<Record<string, CameraStreamHealth>>({});

  const tenantId = getTenantId();
  const token = getToken();
  const eventBaseUrl = getStreamGatewayPublicBaseUrl().replace("/stream", "/events");

  // SSE detection feed
  const { detections: sseDetections, connected: sseConnected, error: sseError } = useSSEDetectionFeed(
    `${eventBaseUrl}/events/stream`,
    tenantId,
    true,
    3000
  );

  const visibleCameras = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras.filter((camera) => {
      if (onlyActive && !camera.isActive) return false;
      if (!q) return true;
      return (
        camera.name.toLowerCase().includes(q) ||
        String(camera.location ?? "").toLowerCase().includes(q) ||
        camera.id.toLowerCase().includes(q)
      );
    });
  }, [cameras, query, onlyActive]);

  async function loadAllCameras() {
    if (!token || !tenantId) { setError("Missing auth context"); setLoading(false); return []; }
    const pageSize = 50;
    let start = 0;
    let total = Number.MAX_SAFE_INTEGER;
    const all: CameraMonitorItem[] = [];
    while (start < total) {
      const res = await fetch(`${apiUrl}/cameras?_start=${start}&_end=${start + pageSize}&_sort=createdAt&_order=DESC`, {
        headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId }
      });
      if (!res.ok) throw new Error(`cameras ${res.status}`);
      const payload = (await res.json()) as { data?: CameraMonitorItem[]; total?: number };
      const rows = payload.data ?? [];
      const parsedTotal = Number(payload.total ?? res.headers.get("x-total-count") ?? rows.length);
      total = Number.isFinite(parsedTotal) ? parsedTotal : rows.length;
      all.push(...rows);
      if (rows.length === 0) break;
      start += rows.length;
    }
    setCameras(all);
    return all;
  }

  async function issueFeedTokens(targetCameras: CameraMonitorItem[], opts?: { force?: boolean }) {
    if (!token || !tenantId) return;
    if (!targetCameras.length) { setFeeds({}); return; }
    setRefreshingFeeds(true);
    const force = Boolean(opts?.force);
    const now = Date.now();
    const validThresholdMs = 45 * 1000;
    const targets = targetCameras.filter((camera) => {
      if (force) return true;
      const current = feeds[camera.id];
      if (!current?.playbackUrl || current.status !== "ready" || !current.expiresAt) return true;
      const expiresAtMs = Date.parse(current.expiresAt);
      if (Number.isNaN(expiresAtMs)) return true;
      return expiresAtMs - now <= validThresholdMs;
    });
    if (!targets.length) { setRefreshingFeeds(false); return; }
    setFeeds((prev) => {
      const next = { ...prev };
      for (const camera of targets) {
        next[camera.id] = { ...(next[camera.id] ?? { status: "idle" }), status: "loading", error: undefined };
      }
      return next;
    });
    const nextEntries: Record<string, CameraFeedEntry> = {};
    let reusableSessionsByCamera: Record<string, { token: string; expiresAt: string }> | null = null;
    const loadReusableSessions = async () => {
      if (reusableSessionsByCamera) return reusableSessionsByCamera;
      const statuses = ["issued", "active"];
      const map: Record<string, { token: string; expiresAt: string }> = {};
      for (const status of statuses) {
        const sessionsResponse = await fetch(
          `${apiUrl}/stream-sessions?_start=0&_end=200&_sort=createdAt&_order=DESC&status=${status}`,
          { headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId } }
        );
        if (!sessionsResponse.ok) continue;
        const payload = (await sessionsResponse.json()) as { data?: Array<{ cameraId?: string; token?: string; expiresAt?: string }> };
        for (const session of payload.data ?? []) {
          if (!session.cameraId || !session.token || !session.expiresAt) continue;
          const expiresAtMs = Date.parse(session.expiresAt);
          if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) continue;
          if (!map[session.cameraId]) map[session.cameraId] = { token: session.token, expiresAt: session.expiresAt };
        }
      }
      reusableSessionsByCamera = map;
      return map;
    };
    for (const camera of targets) {
      try {
        const response = await fetch(`${apiUrl}/cameras/${camera.id}/stream-token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId }
        });
        if (response.status === 409) {
          const reusable = await loadReusableSessions();
          const reusableSession = reusable[camera.id];
          if (reusableSession) {
            nextEntries[camera.id] = {
              status: "ready",
              playbackUrl: buildPlaybackUrl({ tenantId, cameraId: camera.id, token: reusableSession.token }),
              expiresAt: reusableSession.expiresAt
            };
            continue;
          }
        }
        if (!response.ok) throw new Error(`stream-token ${response.status}`);
        const payload = (await response.json()) as { playbackUrl?: string; expiresAt?: string };
        if (!payload.playbackUrl) { nextEntries[camera.id] = { status: "error", error: "No playback URL returned" }; continue; }
        nextEntries[camera.id] = { status: "ready", playbackUrl: toPlaybackPublicUrl(payload.playbackUrl), expiresAt: payload.expiresAt };
      } catch (tokenError) {
        const existing = feeds[camera.id];
        if (existing?.playbackUrl && existing.status === "ready") { nextEntries[camera.id] = existing; continue; }
        nextEntries[camera.id] = { status: "error", error: tokenError instanceof Error ? tokenError.message : "token error" };
      }
    }
    setFeeds((prev) => ({ ...prev, ...nextEntries }));
    setRefreshingFeeds(false);
  }

  async function refreshStreamHealth(targetCameras: CameraMonitorItem[]) {
    if (!tenantId || !targetCameras.length) return;
    const next: Record<string, CameraStreamHealth> = {};
    await Promise.all(
      targetCameras.map(async (camera) => {
        try {
          const playbackOrigin = (() => {
            const currentPlaybackUrl = feeds[camera.id]?.playbackUrl;
            if (!currentPlaybackUrl) return null;
            try { return new URL(currentPlaybackUrl).origin; } catch { return null; }
          })();
          const baseUrl = playbackOrigin ?? getStreamGatewayPublicBaseUrl();
          const response = await fetch(`${baseUrl}/health/${encodeURIComponent(tenantId)}/${encodeURIComponent(camera.id)}`);
          if (!response.ok) {
            next[camera.id] = {
              status: "offline",
              message: response.status === 404 ? "Stream no provisionado" : `Health ${response.status}`,
              checkedAt: new Date().toISOString()
            };
            return;
          }
          const payload = (await response.json()) as {
            data?: { status?: string; health?: { connectivity?: string; error?: string | null } };
            runtime?: { liveEdgeLagMs?: number | null; liveEdgeStale?: boolean | null; workerState?: string | null; workerLastExitCode?: number | null; diagnostics?: string[] };
          };
          const diagnostics = payload.runtime?.diagnostics ?? [];
          const workerState = payload.runtime?.workerState ?? "unknown";
          const connectivity = payload.data?.health?.connectivity ?? "unknown";
          const liveEdgeLagMs = payload.runtime?.liveEdgeLagMs ?? null;
          let status: CameraStreamHealth["status"] = "healthy";
          if (payload.data?.status !== "ready" || workerState !== "running" || connectivity === "offline") status = "offline";
          else if (payload.runtime?.liveEdgeStale || connectivity === "degraded") status = "degraded";
          const baseMessage = status === "healthy" ? "Feed en tiempo real OK" : status === "degraded" ? "Feed con atraso o degradación" : "Feed caído o inestable";
          const suffix = diagnostics.length > 0 ? ` (${diagnostics.slice(0, 2).join(", ")})` : "";
          const exitSuffix = payload.runtime?.workerLastExitCode !== null && payload.runtime?.workerLastExitCode !== undefined
            ? ` [exit=${payload.runtime.workerLastExitCode}]` : "";
          next[camera.id] = { status, message: `${baseMessage}${suffix}${exitSuffix}`, liveEdgeLagMs, checkedAt: new Date().toISOString() };
        } catch (healthError) {
          next[camera.id] = {
            status: "unknown",
            message: healthError instanceof Error ? `Health endpoint unreachable: ${healthError.message}` : "Health check failed",
            checkedAt: new Date().toISOString()
          };
        }
      })
    );
    setStreamHealth((prev) => ({ ...prev, ...next }));
  }

  useEffect(() => {
    if (canList === false) { setLoading(false); return; }
    if (!token || !tenantId) { setLoading(false); setError("Missing auth context"); return; }
    let canceled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const all = await loadAllCameras();
        if (canceled) return;
        await issueFeedTokens(all);
        await refreshStreamHealth(all);
      } catch (loadError) {
        if (canceled) return;
        setError(loadError instanceof Error ? loadError.message : "load error");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();
    return () => { canceled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, canList, tenantId, token]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => { void issueFeedTokens(cameras); void refreshStreamHealth(cameras); }, 4 * 60 * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, apiUrl, token, tenantId]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => { void refreshStreamHealth(cameras); }, 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, tenantId]);

  if (canList === false) return <PageCard title="Monitor">No tenés permisos para listar cámaras.</PageCard>;

  return (
    <PageCard title="Monitor de cámaras (tiempo real)">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput className="max-w-sm" placeholder="Buscar por nombre, location o id" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-2.5 py-2 text-sm">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          <span>Solo activas</span>
        </label>
        <PrimaryButton className="px-2.5 py-1.5 text-xs" type="button" onClick={() => { void issueFeedTokens(cameras, { force: true }); void refreshStreamHealth(cameras); }}>
          Refrescar feeds
        </PrimaryButton>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{visibleCameras.length} visibles</Badge>
        <Badge>{cameras.length} totales</Badge>
        {refreshingFeeds && <Badge className="border-amber-200 bg-amber-50 text-amber-700">actualizando tokens</Badge>}
        <Badge className={sseConnected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>
          {sseConnected ? "SSE conectado" : "SSE desconectado"}
        </Badge>
      </div>
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {loading && <div className="text-sm text-slate-500">Cargando cámaras y sesiones...</div>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {visibleCameras.map((camera) => {
          const feed = feeds[camera.id];
          const health = streamHealth[camera.id];
          return (
            <Surface key={camera.id}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{camera.name}</div>
                <div className="flex items-center gap-1">
                  <Badge className={camera.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>{camera.isActive ? "active" : "inactive"}</Badge>
                  <Badge>{camera.lifecycleStatus ?? "unknown"}</Badge>
                </div>
              </div>
              <div className="mb-2 text-xs text-slate-600">
                <div>id: {camera.id}</div>
                <div>location: {camera.location ?? "-"}</div>
                <div>token expira: {feed?.expiresAt ? new Date(feed.expiresAt).toLocaleTimeString() : "-"}</div>
                <div>
                  stream health:{" "}
                  {health ? (
                    <span>{health.status}{typeof health.liveEdgeLagMs === "number" ? ` · lag ${Math.round(health.liveEdgeLagMs)}ms` : ""}</span>
                  ) : "loading"}
                </div>
                {health?.message && <div>diagnóstico: {health.message}</div>}
              </div>
              {feed?.status === "ready" && feed.playbackUrl ? (
                <div className="relative">
                  <CameraFeedPlayer playbackUrl={feed.playbackUrl} cameraName={camera.name} />
                  <DetectionOverlay
                    detections={sseDetections[camera.id] ?? []}
                    width={640}
                    height={480}
                    visible={true}
                  />
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg bg-slate-100 text-sm">
                  {feed?.status === "loading" ? "Preparando stream..." : feed?.error ?? "Feed no disponible"}
                </div>
              )}
            </Surface>
          );
        })}
      </div>
      {!loading && !visibleCameras.length && <div className="mt-3 text-sm text-slate-500">No hay cámaras para mostrar.</div>}
    </PageCard>
  );
}
