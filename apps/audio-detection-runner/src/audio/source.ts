import { spawn } from "node:child_process";

import { AudioWindowSampleSchema, type AudioWindowSample } from "@app/shared";

export type AudioSourceAdapter = {
  sampleWindows(args: {
    requestId: string;
    tenantId: string;
    cameraId: string;
    mediaRef: Record<string, unknown>;
    sampleRate: number;
    channels: number;
    windowMs: number;
    overlapMs: number;
  }): Promise<AudioWindowSample[]>;
};

function parseVolumeStats(stderr: string) {
  const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const meanDb = meanMatch ? Number(meanMatch[1]) : null;
  const maxDb = maxMatch ? Number(maxMatch[1]) : null;
  const rms = meanDb !== null && Number.isFinite(meanDb) ? Math.max(0, Math.pow(10, meanDb / 20)) : null;
  const peakDbfs = maxDb !== null && Number.isFinite(maxDb) ? maxDb : null;
  return { rms, peakDbfs };
}

export class FfmpegRtspAudioSourceAdapter implements AudioSourceAdapter {
  private readonly ffmpegBin: string;
  private readonly transport: string;
  private readonly timeoutMs: number;

  constructor(args?: { ffmpegBin?: string; rtspTransport?: string; timeoutMs?: number }) {
    this.ffmpegBin = args?.ffmpegBin ?? process.env.AUDIO_FFMPEG_BIN ?? "ffmpeg";
    this.transport = args?.rtspTransport ?? process.env.AUDIO_RTSP_TRANSPORT ?? "tcp";
    this.timeoutMs = args?.timeoutMs ?? Number(process.env.AUDIO_SOURCE_TIMEOUT_MS ?? 6000);
  }

  async sampleWindows(args: {
    requestId: string;
    tenantId: string;
    cameraId: string;
    mediaRef: Record<string, unknown>;
    sampleRate: number;
    channels: number;
    windowMs: number;
    overlapMs: number;
  }): Promise<AudioWindowSample[]> {
    const rtspUrl = typeof args.mediaRef.rtspUrl === "string" ? args.mediaRef.rtspUrl : "";
    if (!rtspUrl) {
      throw new Error("AUDIO_SOURCE_RTSP_URL_REQUIRED");
    }

    const captureSeconds = Math.max(args.windowMs / 1000, 0.2);
    const cmdArgs = [
      "-nostats",
      "-hide_banner",
      "-loglevel",
      "info",
      "-rtsp_transport",
      this.transport,
      "-i",
      rtspUrl,
      "-t",
      String(captureSeconds),
      "-vn",
      "-ac",
      String(args.channels),
      "-ar",
      String(args.sampleRate),
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-"
    ];

    const stderr = await new Promise<string>((resolve, reject) => {
      const proc = spawn(this.ffmpegBin, cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("AUDIO_SOURCE_TIMEOUT"));
      }, this.timeoutMs);
      proc.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`AUDIO_SOURCE_FFMPEG_EXIT_${code}`));
          return;
        }
        resolve(err);
      });
    });

    const stats = parseVolumeStats(stderr);
    if (stats.rms === null) {
      throw new Error("AUDIO_SOURCE_VOLUME_STATS_MISSING");
    }

    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - args.windowMs);

    return [
      AudioWindowSampleSchema.parse({
        sampleId: `${args.requestId}-${Date.now()}`,
        tenantId: args.tenantId,
        cameraId: args.cameraId,
        mediaKind: "audio",
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        sampleRate: args.sampleRate,
        channels: args.channels,
        windowMs: args.windowMs,
        overlapMs: args.overlapMs,
        rms: stats.rms,
        peakDbfs: stats.peakDbfs ?? undefined,
        sourceRef: {
          source: args.mediaRef.source,
          rtspUrl,
          transport: "rtsp/go2rtc"
        }
      })
    ];
  }
}

export class RtspAudioSourceStubAdapter implements AudioSourceAdapter {
  async sampleWindows(args: {
    requestId: string;
    tenantId: string;
    cameraId: string;
    mediaRef: Record<string, unknown>;
    sampleRate: number;
    channels: number;
    windowMs: number;
    overlapMs: number;
  }): Promise<AudioWindowSample[]> {
    const now = new Date();
    const startedAt = new Date(now.getTime() - args.windowMs).toISOString();
    const endedAt = now.toISOString();

    const rmsHint = Number(args.mediaRef.rmsHint ?? 0.12);
    const peakHint = Number(args.mediaRef.peakDbfsHint ?? -12);

    const window = AudioWindowSampleSchema.parse({
      sampleId: `${args.requestId}-${Date.now()}`,
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      mediaKind: "audio",
      startedAt,
      endedAt,
      sampleRate: args.sampleRate,
      channels: args.channels,
      windowMs: args.windowMs,
      overlapMs: args.overlapMs,
      rms: Number.isFinite(rmsHint) ? Math.max(0, rmsHint) : 0.12,
      peakDbfs: Number.isFinite(peakHint) ? peakHint : -12,
      sourceRef: {
        source: args.mediaRef.source,
        rtspUrl: args.mediaRef.rtspUrl,
        transport: args.mediaRef.transport ?? "rtsp/go2rtc"
      }
    });

    return [window];
  }
}

export class FallbackAudioSourceAdapter implements AudioSourceAdapter {
  constructor(
    private readonly primary: AudioSourceAdapter,
    private readonly fallback: AudioSourceAdapter
  ) {}

  async sampleWindows(args: {
    requestId: string;
    tenantId: string;
    cameraId: string;
    mediaRef: Record<string, unknown>;
    sampleRate: number;
    channels: number;
    windowMs: number;
    overlapMs: number;
  }): Promise<AudioWindowSample[]> {
    try {
      return await this.primary.sampleWindows(args);
    } catch {
      return this.fallback.sampleWindows(args);
    }
  }
}
