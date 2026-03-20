import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("audio-detection-runner", () => {
  it("returns health", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, service: "audio-detection-runner" });
    } finally {
      await app.close();
    }
  });

  it("runs audio inference and emits audio detections", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/infer/audio",
        payload: {
          requestId: "req-1",
          jobId: "job-1",
          tenantId: "tenant-a",
          cameraId: "camera-1",
          taskType: "audio_event_classification",
          modelRef: "audio-mvp@0.1.0",
          mediaRef: {
            source: "rtsp",
            rtspUrl: "rtsp://demo/camera-1",
            rmsHint: 0.18,
            peakDbfsHint: -10
          },
          options: {
            minVolume: 0.05,
            windowMs: 500,
            overlapMs: 250
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ detections: Array<{ label: string; mediaKind: string }> }>();
      expect(body.detections.some((item) => item.mediaKind === "audio")).toBe(true);
      expect(body.detections.some((item) => item.label === "loud_noise")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
