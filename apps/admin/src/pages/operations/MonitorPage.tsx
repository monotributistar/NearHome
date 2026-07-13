import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCan } from "@refinedev/core";
import {
  PageCard,
  PrimaryButton,
  TextInput,
  Surface,
  Badge,
  DetectionOverlay,
  useSSEDetectionFeed,
  type SSEDetection
} from "@app/ui";
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
  const eventBaseUrl = `http://localhost:8080/events`;

  // ─── SSE Detection Feed ─────────────────────────────────────────
  const { detections: sseDetections, connected: sseConnected } = useSSEDetectionFeed(
    `${eventBaseUrl}/events/stream`,
    tenantId,
    true,
    4000 // show frame for 4s before fading
  );

  // Track active frame overlay per camera (latest detection with frameUrl)
  const [frameOverlays, setFrameOverlays] = useState<
    Record<
      string,
      {
        frameUrl: string;
        detections: SSEDetection[];
        frameWidth: number;
        frameHeight: number;
        timestamp: number;
      } | null
    >
  >({});

  // When SSE detections arrive, update the frame overlay
  useEffect(() => {
    const newOverlays = { ...frameOverlays };
    let changed = false;

    for (const [camId, dets] of Object.entries(sseDetections)) {
      if (!dets || dets.length === 0) continue;
      const latest = dets[dets.length - 1];
      if (!latest.frameUrl) continue;

      // Only update if it's a new detection (different timestamp)
      const existing = newOverlays[camId];
      if (existing?.timestamp === Date.parse(latest.occurredAt)) continue;

      newOverlays[camId] = {
        frameUrl: latest.frameUrl.startsWith("http") ? latest.frameUrl : `http://localhost:8080${latest.frameUrl}`,
        detections: dets.slice(-20),
        frameWidth: latest.frameWidth,
        frameHeight: latest.frameHeight,
        timestamp: Date.parse(latest.occurredAt)
      };
      changed = true;
    }
    if (changed) setFrameOverlays(newOverlays);
  }, [sseDetections]);

  // Clear a camera's overlay (called by auto-fade or manual click)
  const clearOverlay = useCallback((camId: string) => {
    setFrameOverlays((prev) => ({ ...prev, [camId]: null }));
  }, []);

  // Auto-fade: clear overlays after they've been shown for 4s
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [camId, overlay] of Object.entries(frameOverlays)) {
      if (!overlay) continue;
      const age = Date.now() - overlay.timestamp;
      if (age > 4000) {
        timers.push(setTimeout(() => clearOverlay(camId), 100));
      }
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [frameOverlays, clearOverlay]);

  // Total active detections
  const renderDets = useMemo(
    () => Object.values(sseDetections).reduce((sum, d) => sum + (d?.length ?? 0), 0),
    [sseDetections]
  );

  // ─── Camera Loading ──────────────────────────────────────────────
  const loadCameras = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiUrl}/cameras?limit=50&active=${onlyActive ? "1" : ""}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      setCameras(body.data ?? body ?? []);
      // Initialize detector modes from camera tags
      const initialModes: Record<string, string> = {};
      for (const c of body.data ?? body ?? []) {
        const tags: string[] = Array.isArray(c.tags) ? c.tags : [];
        const detTag = tags.find((t: string) => t.startsWith("detector:"));
        initialModes[c.id] = detTag ? detTag.split(":")[1] : "yolo";
      }
      setCameraTags(initialModes);
    } catch (e: any) {
      setError(summarizeApiError(e) ?? "Error loading cameras");
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token, tenantId, onlyActive]);

  const [refreshCount, setRefreshCount] = useState(0);
  const [fullScreenCamera, setFullScreenCamera] = useState<string | null>(null);
  const [cameraTags, setCameraTags] = useState<Record<string, string>>({});

  const refreshFeeds = useCallback(async () => {
    setRefreshingFeeds(true);
    const updated: Record<string, CameraFeedEntry> = {};
    for (const camera of cameras) {
      // External HLS cameras: use rtspUrl directly
      const camTags: string[] = Array.isArray(camera.tags)
        ? camera.tags
        : typeof camera.tags === "string"
          ? JSON.parse(camera.tags)
          : [];
      const rtspUrl: string = typeof camera.rtspUrl === "string" ? camera.rtspUrl : "";
      if (camTags.includes("external-hls") && rtspUrl) {
        updated[camera.id] = { status: "ready", playbackUrl: rtspUrl, expiresAt: "", error: null };
        continue;
      }
      try {
        const resp = await fetch(`${apiUrl}/cameras/${encodeURIComponent(camera.id)}/stream-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId,
            "content-type": "application/json"
          },
          body: "{}"
        });
        if (resp.ok) {
          const feedData = await resp.json();
          updated[camera.id] = {
            status: "ready",
            playbackUrl: feedData.playbackUrl ?? "",
            expiresAt: feedData.expiresAt,
            error: null
          };
        } else {
          updated[camera.id] = { status: "error", error: `HTTP ${resp.status}` };
        }
      } catch {
        /* skip */
      }
    }
    setFeeds(updated);

    // Load stream health
    const health: Record<string, CameraStreamHealth> = {};
    for (const camera of cameras) {
      try {
        const resp = await fetch(`http://localhost:8080/stream/health/${tenantId}/${camera.id}`);
        if (resp.ok) health[camera.id] = (await resp.json()).data;
      } catch {
        /* skip */
      }
    }
    setStreamHealth(health);
    setRefreshingFeeds(false);
  }, [cameras, apiUrl, token, tenantId]);

  useEffect(() => {
    loadCameras();
  }, [loadCameras]);
  useEffect(() => {
    if (cameras.length > 0) refreshFeeds();
  }, [cameras.length]);

  // ─── Render ──────────────────────────────────────────────────────
  const visibleCameras = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras
      .filter((c) => !onlyActive || c.isActive !== false)
      .filter(
        (c) =>
          !q ||
          c.name?.toLowerCase().includes(q) ||
          c.id?.toLowerCase().includes(q) ||
          c.location?.toLowerCase().includes(q)
      );
  }, [cameras, query, onlyActive]);

  const getHealth = (id: string) => streamHealth[id];

  return (
    <PageCard title="Monitor de cámaras (tiempo real)">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TextInput placeholder="Buscar por nombre, location o id" value={query} onChange={setQuery} className="w-60" />
        <label className="flex cursor-pointer items-center gap-1 text-sm">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          Solo activas
        </label>
        <PrimaryButton onClick={refreshFeeds} disabled={refreshingFeeds}>
          {refreshingFeeds ? "Refrescando..." : "Refrescar feeds"}
        </PrimaryButton>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{visibleCameras.length} visibles</Badge>
        <Badge>{cameras.length} totales</Badge>
        {refreshingFeeds && <Badge className="border-amber-200 bg-amber-50 text-amber-700">actualizando tokens</Badge>}
        <Badge
          className={
            sseConnected
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }
        >
          {sseConnected ? "SSE conectado" : "SSE desconectado"}
        </Badge>
        {renderDets > 0 && (
          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">{renderDets} detecciones activas</Badge>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
      )}
      {loading && <div className="text-sm text-slate-500">Cargando cámaras y sesiones...</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleCameras.map((camera) => {
          const feed = feeds[camera.id];
          const health = getHealth(camera.id);
          const overlay = frameOverlays[camera.id];
          const camDets = overlay?.detections ?? [];

          return (
            <Surface key={camera.id} className="overflow-hidden p-3">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold">{camera.name}</span>
                <div className="flex gap-2 text-xs text-slate-500">
                  <button
                    className="cursor-pointer text-blue-500 hover:text-blue-700"
                    onClick={() => setFullScreenCamera(camera.id)}
                  >
                    [Full Screen]
                  </button>
                  <span className={camera.isActive === false ? "text-rose-500" : "text-emerald-600"}>
                    {camera.isActive === false ? "inactive" : "active"}
                  </span>
                  {feed?.status && (
                    <span className={feed.status === "ready" ? "text-emerald-600" : "text-amber-600"}>
                      {feed.status}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1 space-y-0.5 text-xs text-slate-400">
                <div>id: {camera.id}</div>
                {camera.location && <div>location: {camera.location}</div>}
                {/* Detector selector */}
                <div className="mt-1 flex items-center gap-1 text-xs">
                  <span className="text-slate-400">detector:</span>
                  <select
                    className="rounded border border-slate-200 bg-white px-1 py-0.5 text-xs"
                    value={cameraTags[camera.id] ?? "yolo"}
                    onChange={async (e) => {
                      const newMode = e.target.value;
                      setCameraTags((prev) => ({ ...prev, [camera.id]: newMode }));
                      // Save to API via PUT /cameras/:id (update tags)
                      try {
                        const currentTags = Array.isArray(camera.tags) ? camera.tags : [];
                        const filtered = currentTags.filter((t: string) => !t.startsWith("detector:"));
                        filtered.push(`detector:${newMode}`);
                        await fetch(`${apiUrl}/cameras/${camera.id}`, {
                          method: "PUT",
                          headers: {
                            Authorization: `Bearer ${token}`,
                            "X-Tenant-Id": tenantId,
                            "content-type": "application/json"
                          },
                          body: JSON.stringify({
                            name: camera.name,
                            rtspUrl: camera.rtspUrl,
                            tags: filtered,
                            isActive: camera.isActive
                          })
                        });
                      } catch (e) {
                        console.error("Failed to save detector mode", e);
                      }
                    }}
                  >
                    <option value="yolo">YOLO</option>
                    <option value="mediapipe">MediaPipe</option>
                    <option value="both">Both</option>
                    <option value="none">Off</option>
                  </select>
                </div>
                {feed?.expiresAt && <div>token expira: {new Date(feed.expiresAt).toLocaleTimeString()}</div>}
                {health && (
                  <>
                    <div>
                      stream health:{" "}
                      <span>
                        {health.status}
                        {typeof health.liveEdgeLagMs === "number" ? ` · lag ${Math.round(health.liveEdgeLagMs)}ms` : ""}
                      </span>
                    </div>
                    {health.message && <div>diagnóstico: {health.message}</div>}
                  </>
                )}
              </div>

              {/* Video player + detection overlay */}
              {feed?.status === "ready" && feed.playbackUrl ? (
                <div className="relative mt-2">
                  {/* Live HLS video (always playing in background) */}
                  <div
                    className={
                      overlay
                        ? "opacity-30 transition-opacity duration-500"
                        : "opacity-100 transition-opacity duration-500"
                    }
                  >
                    <CameraFeedPlayer playbackUrl={feed.playbackUrl} cameraName={camera.name} />
                  </div>

                  {/* Detected frame overlay (shows on top when detection arrives) */}
                  {overlay && (
                    <div
                      className="absolute inset-0 z-20 animate-in fade-in duration-300 cursor-pointer"
                      style={{ aspectRatio: `${overlay.frameWidth}/${overlay.frameHeight}` }}
                      onClick={() => clearOverlay(camera.id)}
                    >
                      <img
                        src={overlay.frameUrl}
                        className="h-full w-full rounded-box bg-black"
                        alt={`Detection ${camera.name}`}
                      />
                      <DetectionOverlay
                        detections={camDets}
                        width={overlay.frameWidth}
                        height={overlay.frameHeight}
                        visible={true}
                      />
                      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
                        {camDets.length} objeto{camDets.length !== 1 ? "s" : ""} · click para cerrar
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 flex aspect-video items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-400">
                  {feed?.status === "loading" ? "Preparando stream..." : (feed?.error ?? "Feed no disponible")}
                </div>
              )}
            </Surface>
          );
        })}
      </div>
      {!loading && !visibleCameras.length && (
        <div className="mt-3 text-sm text-slate-500">No hay cámaras para mostrar.</div>
      )}

      {/* ─── Full-screen modal ──────────────────────────────────── */}
      {fullScreenCamera &&
        (() => {
          const cam = [...cameras, ...visibleCameras].find((c) => c.id === fullScreenCamera);
          const feed = feeds[fullScreenCamera];
          const overlay = frameOverlays[fullScreenCamera];
          const camDets = overlay?.detections ?? [];
          if (!cam || !feed) return null;
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
              onClick={() => setFullScreenCamera(null)}
            >
              <div className="relative h-full w-full max-w-7xl p-4" onClick={(e) => e.stopPropagation()}>
                <button
                  className="absolute right-6 top-4 z-10 rounded-full bg-white/20 px-3 py-1 text-sm text-white hover:bg-white/40"
                  onClick={() => setFullScreenCamera(null)}
                >
                  Cerrar [Esc]
                </button>
                <div className="flex h-full flex-col">
                  <h2 className="mb-2 text-lg font-semibold text-white">{cam.name}</h2>
                  <div className="relative flex-1">
                    {feed?.playbackUrl && (
                      <div className={overlay ? "opacity-30" : "opacity-100"}>
                        <CameraFeedPlayer playbackUrl={feed.playbackUrl} cameraName={cam.name} />
                      </div>
                    )}
                    {overlay && (
                      <div
                        className="absolute inset-0 z-20 animate-in fade-in duration-300 cursor-pointer"
                        style={{ aspectRatio: `${overlay.frameWidth}/${overlay.frameHeight}` }}
                        onClick={() => setFullScreenCamera(null)}
                      >
                        <img src={overlay.frameUrl} className="h-full w-full" alt={`Detection ${cam.name}`} />
                        <DetectionOverlay
                          detections={camDets}
                          width={overlay.frameWidth}
                          height={overlay.frameHeight}
                          visible={true}
                        />
                        <div className="absolute bottom-4 left-4 rounded bg-black/60 px-3 py-1 text-sm text-white">
                          {camDets.length} detección(es) · click para cerrar
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* ESC key to close */}
              {(() => {
                const handler = (e: KeyboardEvent) => {
                  if (e.key === "Escape") setFullScreenCamera(null);
                };
                window.addEventListener("keydown", handler);
                setTimeout(() => window.removeEventListener("keydown", handler), 100);
                return null;
              })()}
            </div>
          );
        })()}
    </PageCard>
  );
}
