import { useEffect, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, Badge, Surface } from "@app/ui";

interface DashboardStats {
  totalDetections24h: number;
  incidentsOpen: number;
  camerasOnline: number;
  recentDetections: Array<{
    id: string;
    label: string;
    confidence: number;
    cameraId: string;
    cameraName: string;
    timestamp: string;
  }>;
  hourlyHistory: Array<{ hour: string; count: number }>;
}

export function DashboardPage({ api }: { api: ApiClient }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        // Fetch recent detections
        const detResp = await api.get<any>("/detections/observations", {
          _sort: "frameTs",
          _order: "DESC",
          _start: 0,
          _end: 20,
        });
        const observations = detResp.data ?? [];

        // Fetch open incidents
        const incResp = await api.get<any>("/events", {
          _sort: "timestamp",
          _order: "DESC",
          _start: 0,
          _end: 50,
        });
        const events = incResp.data ?? [];

        // Fetch cameras
        const camResp = await api.get<any>("/cameras", {
          _start: 0,
          _end: 100,
        });
        const cameras = camResp.data ?? [];

        const now = Date.now();
        const last24h = observations.filter(
          (o: any) => now - new Date(o.frameTs).getTime() < 24 * 3600 * 1000
        );

        const recentDetections = last24h.slice(0, 10).map((o: any) => ({
          id: o.id,
          label: o.label ?? "unknown",
          confidence: o.confidence ?? 0,
          cameraId: o.cameraId,
          cameraName: cameras.find((c: any) => c.id === o.cameraId)?.name ?? o.cameraId,
          timestamp: o.frameTs,
        }));

        // Hourly breakdown
        const hourlyMap: Record<string, number> = {};
        for (const o of last24h) {
          const h = new Date(o.frameTs).getHours().toString().padStart(2, "0");
          hourlyMap[h] = (hourlyMap[h] || 0) + 1;
        }
        const hourlyHistory = Array.from({ length: 24 }, (_, i) => ({
          hour: i.toString().padStart(2, "0"),
          count: hourlyMap[i.toString().padStart(2, "0")] || 0,
        }));

        setStats({
          totalDetections24h: last24h.length,
          incidentsOpen: events.filter((e: any) => e.type?.includes("incident")).length,
          camerasOnline: cameras.filter((c: any) => c.lifecycleStatus === "ready").length,
          recentDetections,
          hourlyHistory,
        });
      } catch (e) {
        console.error("Dashboard load error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [api]);

  if (loading) return <div className="p-4 text-slate-500">Loading dashboard...</div>;
  if (!stats) return <div className="p-4 text-rose-500">Failed to load dashboard data.</div>;

  const maxHourly = Math.max(1, ...stats.hourlyHistory.map((h) => h.count));

  return (
    <div className="space-y-4">
      <PageCard title="Dashboard">
        {/* KPI cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Surface className="bg-blue-50 text-center">
            <div className="text-3xl font-bold text-blue-700">{stats.totalDetections24h}</div>
            <div className="text-xs text-blue-600">Detections (24h)</div>
          </Surface>
          <Surface className="bg-amber-50 text-center">
            <div className="text-3xl font-bold text-amber-700">{stats.incidentsOpen}</div>
            <div className="text-xs text-amber-600">Open Incidents</div>
          </Surface>
          <Surface className="bg-green-50 text-center">
            <div className="text-3xl font-bold text-green-700">{stats.camerasOnline}</div>
            <div className="text-xs text-green-600">Cameras Online</div>
          </Surface>
        </div>

        {/* Hourly bar chart (mini) */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Detections per hour (24h)</h3>
          <div className="flex items-end gap-0.5" style={{ height: 80 }}>
            {stats.hourlyHistory.map((h) => (
              <div
                key={h.hour}
                className="flex-1 rounded-t bg-blue-500 transition hover:bg-blue-600"
                style={{ height: `${(h.count / maxHourly) * 100}%`, minHeight: h.count > 0 ? 4 : 1 }}
                title={`${h.hour}:00 — ${h.count} detections`}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </div>
      </PageCard>

      {/* Recent detections */}
      <PageCard title="Recent Detections">
        {stats.recentDetections.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No detections in the last 24 hours.</div>
        ) : (
          <div className="space-y-2">
            {stats.recentDetections.map((det) => (
              <div
                key={det.id}
                className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">
                    {det.label}
                    <span className="ml-2 text-xs text-slate-500">{det.cameraName}</span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {new Date(det.timestamp).toLocaleString()}
                  </div>
                </div>
                <Badge>{Math.round(det.confidence * 100)}%</Badge>
              </div>
            ))}
          </div>
        )}
      </PageCard>
    </div>
  );
}
