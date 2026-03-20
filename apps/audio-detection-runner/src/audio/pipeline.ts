import type { AudioWindowSample, DetectionEvent, DetectorPlugin } from "@app/shared";

import { AudioTemporalAggregator } from "./aggregator.js";
import { RmsGate } from "./gate.js";

export type TranscriptionHook = {
  transcribe(sample: AudioWindowSample, event: DetectionEvent): Promise<string | null>;
};

export type AudioPipelineConfig = {
  minVolume: number;
  aggregationGapMs: number;
  transcriptionEnabled: boolean;
  transcriptionMode: "off" | "on_demand" | "rules_based";
  transcriptionMinConfidence: number;
};

export class AudioPipeline {
  private readonly gate: RmsGate;
  private readonly aggregator: AudioTemporalAggregator;

  constructor(
    private readonly config: AudioPipelineConfig,
    private readonly plugins: Array<DetectorPlugin<AudioWindowSample>>,
    private readonly transcriptionHook?: TranscriptionHook
  ) {
    this.gate = new RmsGate({ minVolume: config.minVolume });
    this.aggregator = new AudioTemporalAggregator({ maxGapMs: config.aggregationGapMs });
  }

  async runWindow(sample: AudioWindowSample): Promise<DetectionEvent[]> {
    if (!this.gate.shouldPass(sample.rms)) return [];

    const events = (
      await Promise.all(this.plugins.map((plugin) => plugin.detect(sample, { tenantId: sample.tenantId, cameraId: sample.cameraId })))
    ).flat();

    const output: DetectionEvent[] = [];
    for (const event of events) {
      for (const merged of this.aggregator.ingest(event)) {
        output.push(await this.withTranscription(sample, merged));
      }
    }

    return output;
  }

  async flush(): Promise<DetectionEvent[]> {
    const events = this.aggregator.flush();
    return Promise.all(events.map((event) => this.withTranscription(undefined, event)));
  }

  private async withTranscription(sample: AudioWindowSample | undefined, event: DetectionEvent): Promise<DetectionEvent> {
    if (!this.transcriptionHook) return event;
    if (!this.config.transcriptionEnabled || this.config.transcriptionMode === "off") return event;
    if (event.label !== "speech") return event;
    if (event.confidence < this.config.transcriptionMinConfidence) return event;
    if (!sample && this.config.transcriptionMode === "on_demand") return event;

    const sourceSample =
      sample ??
      ({
        sampleId: event.sampleId ?? event.eventId,
        tenantId: event.tenantId,
        cameraId: event.cameraId,
        mediaKind: "audio",
        startedAt: event.startedAt,
        endedAt: event.endedAt ?? event.startedAt,
        sampleRate: 16000,
        channels: 1,
        windowMs: 500,
        overlapMs: 250,
        rms: Number((event.attributes as Record<string, unknown> | undefined)?.rms ?? 0)
      } satisfies AudioWindowSample);

    const text = await this.transcriptionHook.transcribe(sourceSample, event);
    if (!text) return event;
    return {
      ...event,
      attributes: {
        ...(event.attributes ?? {}),
        transcription: text
      }
    };
  }
}
