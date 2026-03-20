import { AudioWindowSampleSchema, DetectionEventSchema, ImageFrameSampleSchema, type DetectorPlugin, type ImageFrameSample } from "@app/shared";
import { describe, expect, it } from "vitest";

import { AudioTemporalAggregator } from "../src/audio/aggregator.js";
import { RmsGate } from "../src/audio/gate.js";

describe("audio runner primitives", () => {
  it("applies RMS gate", () => {
    const gate = new RmsGate({ minVolume: 0.05 });
    expect(gate.shouldPass(0.01)).toBe(false);
    expect(gate.shouldPass(0.08)).toBe(true);
  });

  it("validates audio window sample schema", () => {
    const ok = AudioWindowSampleSchema.safeParse({
      sampleId: "s1",
      tenantId: "t1",
      cameraId: "c1",
      mediaKind: "audio",
      startedAt: "2026-03-19T10:00:00.000Z",
      endedAt: "2026-03-19T10:00:00.500Z",
      sampleRate: 16000,
      channels: 1,
      windowMs: 500,
      overlapMs: 250,
      rms: 0.14
    });
    expect(ok.success).toBe(true);

    const invalid = AudioWindowSampleSchema.safeParse({
      sampleId: "s1",
      tenantId: "t1",
      cameraId: "c1",
      mediaKind: "audio",
      startedAt: "2026-03-19T10:00:00.000Z",
      endedAt: "2026-03-19T10:00:00.500Z",
      sampleRate: 16000,
      channels: 1,
      windowMs: 500,
      overlapMs: 500,
      rms: 0.14
    });
    expect(invalid.success).toBe(false);
  });

  it("keeps detection event compatibility for audio without bbox", () => {
    const event = DetectionEventSchema.parse({
      eventId: "evt-a1",
      eventVersion: "1.0",
      mediaKind: "audio",
      tenantId: "t1",
      cameraId: "c1",
      label: "loud_noise",
      confidence: 0.88,
      startedAt: "2026-03-19T10:00:00.000Z",
      endedAt: "2026-03-19T10:00:00.500Z",
      temporalWindow: { startMs: 0, endMs: 500, durationMs: 500 }
    });
    expect(event.bbox).toBeUndefined();
  });

  it("aggregates contiguous audio events", () => {
    const aggregator = new AudioTemporalAggregator({ maxGapMs: 500 });
    const first = DetectionEventSchema.parse({
      eventId: "evt-1",
      eventVersion: "1.0",
      mediaKind: "audio",
      tenantId: "t1",
      cameraId: "c1",
      label: "speech",
      confidence: 0.6,
      startedAt: "2026-03-19T10:00:00.000Z",
      endedAt: "2026-03-19T10:00:00.300Z"
    });
    const second = DetectionEventSchema.parse({
      eventId: "evt-2",
      eventVersion: "1.0",
      mediaKind: "audio",
      tenantId: "t1",
      cameraId: "c1",
      label: "speech",
      confidence: 0.9,
      startedAt: "2026-03-19T10:00:00.500Z",
      endedAt: "2026-03-19T10:00:00.900Z"
    });

    expect(aggregator.ingest(first)).toEqual([]);
    expect(aggregator.ingest(second)).toEqual([]);
    const out = aggregator.flush();
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
  });

  it("preserves legacy image plugin contract compatibility", async () => {
    const imagePlugin: DetectorPlugin<ImageFrameSample> = {
      pluginId: "legacy-image-plugin",
      supports: "image",
      async detect(sample) {
        return [
          {
            eventId: `evt-${sample.sampleId}`,
            eventVersion: "1.0",
            mediaKind: "image",
            tenantId: sample.tenantId,
            cameraId: sample.cameraId,
            label: "person",
            confidence: 0.9,
            startedAt: sample.startedAt,
            bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.5 }
          }
        ];
      }
    };

    const sample = ImageFrameSampleSchema.parse({
      sampleId: "img-1",
      tenantId: "t1",
      cameraId: "c1",
      mediaKind: "image",
      startedAt: "2026-03-19T10:00:00.000Z",
      endedAt: "2026-03-19T10:00:00.000Z",
      frameTs: "2026-03-19T10:00:00.000Z",
      image: { uri: "rtsp://cam/frame.jpg" }
    });

    const result = await imagePlugin.detect(sample, { tenantId: "t1", cameraId: "c1" });
    expect(result).toHaveLength(1);
    expect(result[0].mediaKind).toBe("image");
    expect(result[0].bbox).toBeTruthy();
  });
});
