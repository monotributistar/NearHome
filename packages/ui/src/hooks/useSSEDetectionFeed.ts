import { useCallback, useEffect, useRef, useState } from "react";

export interface SSEDetection {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  cameraId: string;
  tenantId: string;
  frameTimestamp: string;
  occurredAt: string;
}

interface SSEDetectionFeedResult {
  detections: Record<string, SSEDetection[]>;
  getDetections: (cameraId: string) => SSEDetection[];
  clearDetections: (cameraId?: string) => void;
  connected: boolean;
  error: string | null;
}

/**
 * Subscribes to detection.object events via SSE (fetch-based, supports custom headers).
 * Returns latest detections per camera with auto-fade after fadeAfterMs.
 */
export function useSSEDetectionFeed(
  sseUrl: string,
  tenantId: string,
  enabled = true,
  fadeAfterMs = 3000
): SSEDetectionFeedResult {
  const [detections, setDetections] = useState<Record<string, SSEDetection[]>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fadeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !tenantId || !sseUrl) return;

    let reconnectPending = false;

    const connect = async () => {
      if (abortRef.current) abortRef.current.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const resp = await fetch(sseUrl, {
          headers: {
            "X-Tenant-Id": tenantId,
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          },
          signal: abort.signal,
        });

        if (!resp.ok) {
          setError(`SSE connection failed: ${resp.status}`);
          setConnected(false);
          scheduleReconnect();
          return;
        }

        if (!resp.body) {
          setError("No response body for SSE");
          setConnected(false);
          return;
        }

        setConnected(true);
        setError(null);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? ""; // keep incomplete event in buffer

          for (const event of events) {
            const lines = event.split("\n");
            let eventType = "";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) dataStr = line.slice(6);
            }

            if (eventType === "detection.object" && dataStr) {
              try {
                const data = JSON.parse(dataStr);
                const camId = data.cameraId;
                if (!camId) continue;

                const detection: SSEDetection = {
                  label: data.payload?.label ?? "unknown",
                  confidence: data.payload?.confidence ?? 0,
                  bbox: data.payload?.bbox ?? { x: 0, y: 0, w: 0.1, h: 0.1 },
                  cameraId: camId,
                  tenantId: data.tenantId,
                  frameTimestamp: data.payload?.frameTimestamp,
                  occurredAt: data.occurredAt,
                };

                const key = `${camId}-${data.eventId}`;
                const existing = fadeTimers.current.get(key);
                if (existing) clearTimeout(existing);

                setDetections((prev) => {
                  const camDets = [...(prev[camId] ?? []), detection].slice(-5);
                  return { ...prev, [camId]: camDets };
                });

                const timer = setTimeout(() => {
                  setDetections((prev) => {
                    const camDets = (prev[camId] ?? []).filter(
                      (d) => d.occurredAt !== detection.occurredAt
                    );
                    return camDets.length > 0
                      ? { ...prev, [camId]: camDets }
                      : { ...prev, [camId]: [] };
                  });
                  fadeTimers.current.delete(key);
                }, fadeAfterMs);
                fadeTimers.current.set(key, timer);
              } catch {
                // skip parse errors
              }
            }
          }
        }

        setConnected(false);
        scheduleReconnect();
      } catch (err: any) {
        if (err.name === "AbortError") return;
        setError(`SSE error: ${err.message}`);
        setConnected(false);
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (reconnectPending) return;
      reconnectPending = true;
      reconnectTimer.current = setTimeout(() => {
        reconnectPending = false;
        connect();
      }, 5000);
    };

    connect();

    return () => {
      reconnectPending = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (abortRef.current) abortRef.current.abort();
      for (const timer of fadeTimers.current.values()) clearTimeout(timer);
      fadeTimers.current.clear();
    };
  }, [enabled, tenantId, sseUrl, fadeAfterMs]);

  const getDetections = useCallback(
    (cameraId: string): SSEDetection[] => detections[cameraId] ?? [],
    [detections]
  );

  const clearDetections = useCallback((cameraId?: string) => {
    setDetections((prev) => {
      if (cameraId) {
        const { [cameraId]: _, ...rest } = prev;
        return rest;
      }
      return {};
    });
  }, []);

  return { detections, getDetections, clearDetections, connected, error };
}
