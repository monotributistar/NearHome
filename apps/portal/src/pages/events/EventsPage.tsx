import { useEffect, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, TextInput, DataTable, Badge } from "@app/ui";

export function EventsPage({ api }: { api: ApiClient }) {
  const [events, setEvents] = useState<any[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function search() {
    const res = await api.get<any>("/events", {
      cameraId: cameraId || undefined,
      from: from || undefined,
      to: to || undefined
    });
    setEvents(res.data ?? res);
  }

  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageCard title="Events">
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <TextInput placeholder="cameraId" value={cameraId} onChange={(e) => setCameraId(e.target.value)} />
        <TextInput type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextInput type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        <PrimaryButton onClick={search}>Filter</PrimaryButton>
      </div>
      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Camera</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Severity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((e) => (
            <tr key={e.id}>
              <td className="px-3 py-2">{new Date(e.timestamp).toLocaleString()}</td>
              <td className="px-3 py-2">{e.cameraId}</td>
              <td className="px-3 py-2">{e.type}</td>
              <td className="px-3 py-2">
                <Badge
                  className={
                    e.severity === "high"
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : e.severity === "medium"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }
                >
                  {e.severity}
                </Badge>
              </td>
            </tr>
          ))}
          {!events.length && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-center text-sm text-slate-500">No events found.</td>
            </tr>
          )}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
