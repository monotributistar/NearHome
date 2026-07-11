import { useCallback, useEffect, useRef, useState } from "react";

export interface SSEDetection {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  cameraId: string;
  tenantId: string;
  frameTimestamp: string;
  occurredAt: string;
  frameWidth: number;
  frameHeight: number;
  frameUrl: string;
}

interface SSEDetectionFeedResult {
  detections: Record<string, SSEDetection[]>;
  getDetections: (cameraId: string) => SSEDetection[];
  clearDetections: (cameraId?: string) => void;
  connected: boolean;
}

/**
 * Subscribes to detection.object events via native EventSource.
 * Tenant ID passed as query param (no custom headers needed).
 */
export function useSSEDetectionFeed(
  sseUrl: string,
  tenantId: string,
  enabled = true,
  fadeAfterMs = 3000
): SSEDetectionFeedResult {
  const [detections, setDetections] = useState<Record<string, SSEDetection[]>>({});
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const fadeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!enabled || !tenantId || !sseUrl) return;

    const url = `${sseUrl}?tenantId=${encodeURIComponent(tenantId)}&topics=detection.object`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener("detection.object", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const camId = data.cameraId;
        if (!camId) return;

        // Support both single and batch events
        const detectionsList = data.payload?.detections
          ? data.payload.detections // batch format: {detections: [...]}
          : [data.payload]; // single format: {label, confidence, ...}

        for (const det of detectionsList) {
          const detection: SSEDetection = {
            label: det?.label ?? "unknown",
            confidence: det?.confidence ?? 0,
            bbox: det?.bbox ?? { x: 0, y: 0, w: 0.1, h: 0.1 },
            cameraId: camId,
            tenantId: data.tenantId,
            frameTimestamp: data.payload?.frameTimestamp,
            occurredAt: data.occurredAt,
            frameWidth: data.payload?.frameWidth ?? 640,
            frameHeight: data.payload?.frameHeight ?? 480,
            frameUrl: data.payload?.frameUrl ?? ""
          };

          const key = `${camId}-${data.eventId ?? detection.occurredAt}`;
          const existing = fadeTimers.current.get(key);
          if (existing) clearTimeout(existing);

          setDetections((prev) => {
            const camDets = [...(prev[camId] ?? []), detection].slice(-20);
            return { ...prev, [camId]: camDets };
          });

          const timer = setTimeout(() => {
            setDetections((prev) => {
              const camDets = (prev[camId] ?? []).filter((d) => d.occurredAt !== detection.occurredAt);
              return camDets.length > 0 ? { ...prev, [camId]: camDets } : { ...prev, [camId]: [] };
            });
            fadeTimers.current.delete(key);
          }, fadeAfterMs);
          fadeTimers.current.set(key, timer);
        }
      } catch (e) {
        // skip
      }
    });

    return () => {
      es.close();
      for (const timer of fadeTimers.current.values()) clearTimeout(timer);
      fadeTimers.current.clear();
      setConnected(false);
    };
  }, [enabled, tenantId, sseUrl, fadeAfterMs]);

  const getDetections = useCallback((cameraId: string): SSEDetection[] => detections[cameraId] ?? [], [detections]);

  const clearDetections = useCallback((cameraId?: string) => {
    setDetections((prev) => {
      if (cameraId) {
        const { [cameraId]: _, ...rest } = prev;
        return rest;
      }
      return {};
    });
  }, []);

  return { detections, getDetections, clearDetections, connected };
}
