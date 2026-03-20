import type { AudioWindowSample, DetectionEvent, DetectorPlugin } from "@app/shared";

export interface VadAdapter {
  detect(sample: AudioWindowSample): Promise<{ isSpeech: boolean; confidence: number }>;
}

export class MockVadAdapter implements VadAdapter {
  constructor(private readonly threshold = 0.03) {}

  async detect(sample: AudioWindowSample) {
    const confidence = Math.max(0, Math.min(1, sample.rms / (this.threshold * 2)));
    return {
      isSpeech: sample.rms >= this.threshold,
      confidence
    };
  }
}

export class VadDetectorPlugin implements DetectorPlugin<AudioWindowSample> {
  pluginId = "vad";
  supports = "audio" as const;

  constructor(private readonly vad: VadAdapter) {}

  async detect(sample: AudioWindowSample): Promise<DetectionEvent[]> {
    const result = await this.vad.detect(sample);
    return [
      {
        eventId: `evt-${sample.sampleId}-vad`,
        eventVersion: "1.0",
        mediaKind: "audio",
        tenantId: sample.tenantId,
        cameraId: sample.cameraId,
        label: result.isSpeech ? "speech" : "no_speech",
        confidence: result.confidence,
        startedAt: sample.startedAt,
        endedAt: sample.endedAt,
        sampleId: sample.sampleId,
        temporalWindow: {
          startMs: 0,
          endMs: sample.windowMs,
          durationMs: sample.windowMs
        },
        attributes: { rms: sample.rms }
      }
    ];
  }
}

export class MockAudioClassifierPlugin implements DetectorPlugin<AudioWindowSample> {
  pluginId = "audio-classifier";
  supports = "audio" as const;

  async detect(sample: AudioWindowSample): Promise<DetectionEvent[]> {
    const labels: Array<{ label: string; confidence: number }> = [];
    if (sample.rms >= 0.1) labels.push({ label: "loud_noise", confidence: Math.min(sample.rms, 1) });
    if (sample.rms >= 0.2) labels.push({ label: "yell", confidence: Math.min(sample.rms * 1.1, 1) });
    if ((sample.peakDbfs ?? -90) >= -8) labels.push({ label: "glass_shatter", confidence: 0.8 });

    return labels.map((item, index) => ({
      eventId: `evt-${sample.sampleId}-cls-${index}`,
      eventVersion: "1.0",
      mediaKind: "audio",
      tenantId: sample.tenantId,
      cameraId: sample.cameraId,
      label: item.label,
      confidence: item.confidence,
      startedAt: sample.startedAt,
      endedAt: sample.endedAt,
      sampleId: sample.sampleId,
      temporalWindow: {
        startMs: 0,
        endMs: sample.windowMs,
        durationMs: sample.windowMs
      },
      attributes: {
        rms: sample.rms,
        peakDbfs: sample.peakDbfs
      }
    }));
  }
}
