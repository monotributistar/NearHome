import Fastify from "fastify";
import { z } from "zod";

import { AudioPipeline } from "./audio/pipeline.js";
import { MockAudioClassifierPlugin, MockVadAdapter, VadDetectorPlugin } from "./audio/plugins.js";
import { FallbackAudioSourceAdapter, FfmpegRtspAudioSourceAdapter, RtspAudioSourceStubAdapter } from "./audio/source.js";

const InferAudioRequestSchema = z.object({
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  tenantId: z.string().min(1),
  cameraId: z.string().min(1),
  taskType: z.string().default("audio_event_classification"),
  modelRef: z.string().default("audio-mvp@0.1.0"),
  mediaRef: z.record(z.any()).default({}),
  thresholds: z.record(z.any()).default({}),
  options: z.record(z.any()).default({}),
  provider: z.string().default("audio_runner")
});

class MockSpeechTranscriptionHook {
  async transcribe(): Promise<string | null> {
    return "[mock] speech detected";
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  const sourceAdapter = new FallbackAudioSourceAdapter(
    new FfmpegRtspAudioSourceAdapter(),
    new RtspAudioSourceStubAdapter()
  );

  app.get("/health", async () => ({ ok: true, service: "audio-detection-runner" }));

  app.post("/v1/infer/audio", async (request, reply) => {
    const body = InferAudioRequestSchema.parse(request.body ?? {});

    const sampleRate = Math.max(8000, Number(body.options.sampleRate ?? body.mediaRef.sampleRate ?? 16000));
    const channels = Math.min(2, Math.max(1, Number(body.options.channels ?? body.mediaRef.channels ?? 1)));
    const windowMs = Math.max(100, Number(body.options.windowMs ?? body.mediaRef.windowMs ?? 500));
    const overlapMs = Math.max(0, Number(body.options.overlapMs ?? body.mediaRef.overlapMs ?? 250));
    const minVolume = Math.max(0, Number(body.options.minVolume ?? body.thresholds.minVolume ?? 0.02));
    const transcriptionEnabled = body.options.transcriptionEnabled === true;
    const transcriptionMode =
      body.options.transcriptionMode === "on_demand" || body.options.transcriptionMode === "rules_based"
        ? body.options.transcriptionMode
        : "off";
    const transcriptionMinConfidence = Math.max(0, Math.min(1, Number(body.options.transcriptionMinConfidence ?? 0.75)));

    const pipeline = new AudioPipeline(
      {
        minVolume,
        aggregationGapMs: Math.max(100, Number(body.options.aggregationGapMs ?? 600)),
        transcriptionEnabled,
        transcriptionMode,
        transcriptionMinConfidence
      },
      [new VadDetectorPlugin(new MockVadAdapter()), new MockAudioClassifierPlugin()],
      transcriptionEnabled ? new MockSpeechTranscriptionHook() : undefined
    );

    const windows = await sourceAdapter.sampleWindows({
      requestId: body.requestId,
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      mediaRef: body.mediaRef,
      sampleRate,
      channels,
      windowMs,
      overlapMs
    });

    const detections = [] as Array<Record<string, unknown>>;
    for (const window of windows) {
      const events = await pipeline.runWindow(window);
      detections.push(
        ...events.map((event) => ({
          label: event.label,
          confidence: event.confidence,
          mediaKind: "audio",
          startedAt: event.startedAt,
          endedAt: event.endedAt ?? event.startedAt,
          temporalWindow: event.temporalWindow,
          frameTs: event.startedAt,
          attributes: event.attributes,
          providerMeta: event.providerMeta
        }))
      );
    }

    const trailing = await pipeline.flush();
    detections.push(
      ...trailing.map((event) => ({
        label: event.label,
        confidence: event.confidence,
        mediaKind: "audio",
        startedAt: event.startedAt,
        endedAt: event.endedAt ?? event.startedAt,
        temporalWindow: event.temporalWindow,
        frameTs: event.startedAt,
        attributes: event.attributes,
        providerMeta: event.providerMeta
      }))
    );

    reply.code(200);
    return {
      detections,
      providerLatencyMs: 12,
      providerMeta: {
        provider: "audio_runner",
        modelRef: body.modelRef,
        taskType: body.taskType,
        source: body.mediaRef.source ?? "rtsp/go2rtc",
        windows: windows.length
      }
    };
  });

  return app;
}
