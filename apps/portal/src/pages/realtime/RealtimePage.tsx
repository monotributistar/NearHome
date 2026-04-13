import { useEffect, useRef, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, TextInput, Surface, Badge } from "@app/ui";
import { EVENT_GATEWAY_URL, toWsUrl, matchesTopics, type RealtimeEvent } from "../../lib/client.js";

export function RealtimePage({ api, tenantId }: { api: ApiClient; tenantId: string | null }) {
  const [status, setStatus] = useState<"connecting" | "connected" | "degraded" | "disconnected">("disconnected");
  const [transport, setTransport] = useState<"ws" | "sse" | "none">("none");
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [topics, setTopics] = useState("incident,detection,stream,notification");
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!tenantId) {
      setStatus("disconnected");
      setTransport("none");
      return;
    }

    stopRef.current = false;
    let wsAttempts = 0;
    let sseAttempts = 0;
    const seenIds = new Set<string>();

    const schedule = (ms: number, fn: () => void) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(fn, ms);
    };

    const pushEvents = (batch: RealtimeEvent[]) => {
      const filtered = batch.filter((event) => {
        if (seenIds.has(event.eventId)) return false;
        seenIds.add(event.eventId);
        return true;
      });
      if (!filtered.length) return;
      setEvents((prev) => [...filtered, ...prev].slice(0, 50));
    };

    const selectedTopics = topics.split(",").map((t) => t.trim()).filter(Boolean);

    const connectSse = async () => {
      if (stopRef.current) return;
      setTransport("sse");
      setStatus("degraded");
      try {
        const url = new URL("/events/stream", EVENT_GATEWAY_URL);
        url.searchParams.set("replay", "20");
        url.searchParams.set("once", "1");
        if (selectedTopics.length) url.searchParams.set("topics", selectedTopics.join(","));
        const response = await fetch(url.toString(), { headers: { "X-Tenant-Id": tenantId } });
        if (!response.ok) throw new Error(`sse ${response.status}`);
        const raw = await response.text();
        const chunks = raw.split("\n\n");
        const parsed: RealtimeEvent[] = [];
        for (const chunk of chunks) {
          const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "))?.slice(7).trim();
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6).trim();
          if (!eventLine || !dataLine) continue;
          const event = JSON.parse(dataLine) as RealtimeEvent;
          if (!matchesTopics(event.eventType, selectedTopics)) continue;
          parsed.push(event);
        }
        pushEvents(parsed);
        sseAttempts = 0;
        setStatus("connected");
        schedule(2000, connectSse);
      } catch {
        const delay = Math.min(15000, 1000 * 2 ** Math.min(sseAttempts, 4));
        sseAttempts += 1;
        setStatus("degraded");
        schedule(delay, connectSse);
      }
    };

    const connectWs = async () => {
      if (stopRef.current) return;
      setStatus("connecting");
      try {
        const tokenResponse = await api.get<any>("/events/ws-token");
        const wsUrl = new URL(toWsUrl(EVENT_GATEWAY_URL));
        wsUrl.searchParams.set("token", tokenResponse.data.token);
        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;
        ws.onopen = () => { wsAttempts = 0; setTransport("ws"); setStatus("connected"); };
        ws.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as RealtimeEvent;
            if (!matchesTopics(event.eventType, selectedTopics)) return;
            pushEvents([event]);
          } catch { /* ignore */ }
        };
        ws.onclose = () => {
          if (stopRef.current) return;
          const delay = Math.min(15000, 1000 * 2 ** Math.min(wsAttempts, 4));
          wsAttempts += 1;
          schedule(delay, connectWs);
        };
        ws.onerror = () => { if (stopRef.current) return; ws.close(); connectSse().catch(() => undefined); };
      } catch {
        connectSse().catch(() => undefined);
      }
    };

    connectWs().catch(() => undefined);

    return () => {
      stopRef.current = true;
      wsRef.current?.close();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [api, tenantId, topics]);

  return (
    <PageCard title="Realtime stream">
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <TextInput value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="topics csv" />
        <Surface className="px-3 py-2 text-sm">transport: {transport}</Surface>
        <Surface className="px-3 py-2 text-sm">tenant: {tenantId ?? "-"}</Surface>
        <Surface className="px-3 py-2 text-sm">status: {status}</Surface>
      </div>
      <div className="space-y-2">
        {events.map((event) => (
          <Surface key={event.eventId} className="bg-slate-100 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <Badge>{event.eventType}</Badge>
              <span>{new Date(event.occurredAt).toLocaleString()}</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(event.payload, null, 2)}</pre>
          </Surface>
        ))}
        {!events.length && <div className="text-sm text-slate-500">No realtime events received yet.</div>}
      </div>
    </PageCard>
  );
}
