import { useCallback, useEffect, useRef, useState } from "react";

export interface Detection {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
}

interface UseDetectionFeedOptions {
  inferenceUrl: string;
  intervalMs?: number;
  enabled?: boolean;
}

/**
 * Captures frames from a <video> element and sends them to inference-bridge.
 * Returns real-time detections for overlay rendering.
 */
export function useDetectionFeed({
  inferenceUrl,
  intervalMs = 1000,
  enabled = false,
}: UseDetectionFeedOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  const captureAndSend = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match canvas size to video
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8)
    );
    if (!blob) return;

    const formData = new FormData();
    formData.append("file", blob, "frame.jpg");
    formData.append("frameTs", String(Date.now()));

    try {
      setLoading(true);
      const resp = await fetch(inferenceUrl, { method: "POST", body: formData });
      if (!resp.ok) {
        if (resp.status === 503 || resp.status === 502) {
          setError("Detection service warming up...");
        } else {
          setError(`Detection error: ${resp.status}`);
        }
        return;
      }
      const data = await resp.json();
      if (data.status === "cold_start") {
        setError("Detection warming up (cold start)...");
        return;
      }
      if (data.detections?.length > 0) {
        setDetections(
          data.detections.map((d: any) => ({
            label: d.label ?? "unknown",
            confidence: d.confidence ?? 0,
            bbox: d.bbox ?? { x: 0, y: 0, w: 0.1, h: 0.1 },
          }))
        );
      }
      setError(null);
      setFrameCount((c) => c + 1);
    } catch (e: any) {
      setError(e.message ?? "Detection request failed");
    } finally {
      setLoading(false);
    }
  }, [inferenceUrl]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setDetections([]);
      setError(null);
      return;
    }

    // Create canvas if needed
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }

    timerRef.current = setInterval(captureAndSend, intervalMs);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, intervalMs, captureAndSend]);

  return {
    videoRef,
    detections,
    error,
    loading,
    frameCount,
  };
}
