import type { DetectionEvent, TemporalEventAggregator } from "@app/shared";

export class AudioTemporalAggregator implements TemporalEventAggregator {
  private readonly maxGapMs: number;
  private readonly buckets = new Map<string, DetectionEvent>();

  constructor(args: { maxGapMs: number }) {
    this.maxGapMs = Math.max(0, args.maxGapMs);
  }

  ingest(event: DetectionEvent): DetectionEvent[] {
    if (event.mediaKind !== "audio") return [event];

    const key = `${event.tenantId}:${event.cameraId}:${event.label}`;
    const current = this.buckets.get(key);
    if (!current) {
      this.buckets.set(key, event);
      return [];
    }

    const currentEnd = Date.parse(current.endedAt ?? current.startedAt);
    const incomingStart = Date.parse(event.startedAt);
    if (Number.isFinite(currentEnd) && Number.isFinite(incomingStart) && incomingStart - currentEnd <= this.maxGapMs) {
      this.buckets.set(key, {
        ...current,
        confidence: Math.max(current.confidence, event.confidence),
        endedAt: event.endedAt ?? event.startedAt,
        attributes: {
          ...(current.attributes ?? {}),
          ...(event.attributes ?? {}),
          mergedWindows: Number((current.attributes as Record<string, unknown> | undefined)?.mergedWindows ?? 1) + 1
        }
      });
      return [];
    }

    this.buckets.set(key, event);
    return [current];
  }

  flush(): DetectionEvent[] {
    const out = [...this.buckets.values()];
    this.buckets.clear();
    return out;
  }
}
