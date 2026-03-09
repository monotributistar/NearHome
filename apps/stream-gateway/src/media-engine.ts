import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export type StreamMediaInput = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
  storageDir?: string;
  transport: "auto" | "tcp" | "udp";
  encryption: "optional" | "required" | "disabled";
  tunnel: "none" | "http" | "https" | "ws" | "wss" | "auto";
};

export type StreamMediaScope = {
  tenantId: string;
  cameraId: string;
};

export type MediaEngine = {
  name: string;
  provisionStream(input: StreamMediaInput): Promise<void>;
  deprovisionStream(scope: StreamMediaScope): Promise<void>;
  readManifest(scope: StreamMediaScope): Promise<string>;
  readSegment(scope: StreamMediaScope, segmentName?: string): Promise<Buffer>;
  close(): Promise<void>;
  diagnostics?: () => {
    workers?: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
      restarting?: number;
      restartsTotal?: number;
      details?: Array<{
        tenantId: string;
        cameraId: string;
        state: string;
        restartCount: number;
        command: string;
        lastExitCode: number | null;
        lastExitSignal: string | null;
      }>;
    };
  };
};

function cameraDir(storageDir: string, tenantId: string, cameraId: string) {
  return path.join(storageDir, tenantId, cameraId);
}

function streamKey(scope: StreamMediaScope) {
  return `${scope.tenantId}:${scope.cameraId}`;
}

async function ensurePlaybackAssets(storageDir: string, scope: StreamMediaScope) {
  const dir = cameraDir(storageDir, scope.tenantId, scope.cameraId);
  await fs.mkdir(dir, { recursive: true });

  const segmentPath = path.join(dir, "segment0.ts");
  const playlistPath = path.join(dir, "index.m3u8");

  const segment = Buffer.from("NEARHOME_STREAM_SEGMENT");
  await fs.writeFile(segmentPath, segment);

  const manifest = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:5",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXTINF:5.0,",
    "segment0.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  await fs.writeFile(playlistPath, manifest, "utf8");
}

async function ensureCameraStorageDir(storageDir: string, scope: StreamMediaScope) {
  await fs.mkdir(cameraDir(storageDir, scope.tenantId, scope.cameraId), { recursive: true });
}

async function readManifestFile(storageDir: string, scope: StreamMediaScope) {
  const playlistPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), "index.m3u8");
  return fs.readFile(playlistPath, "utf8");
}

async function readSegmentFile(storageDir: string, scope: StreamMediaScope, segmentName = "segment0.ts") {
  const segmentPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), segmentName);
  return fs.readFile(segmentPath);
}

export function createMockMediaEngine(storageDir: string): MediaEngine {
  const streamStorageDirs = new Map<string, string>();

  const provisionStream = async (input: StreamMediaInput) => {
    const scope = { tenantId: input.tenantId, cameraId: input.cameraId };
    const resolvedStorageDir = input.storageDir ?? storageDir;
    streamStorageDirs.set(streamKey(scope), resolvedStorageDir);
    await ensurePlaybackAssets(resolvedStorageDir, scope);
  };

  const deprovisionStream = async (scope: StreamMediaScope) => {
    // Mock engine keeps files on disk; stream state is enforced in memory by app layer.
    streamStorageDirs.delete(streamKey(scope));
  };

  const resolveStorageDir = (scope: StreamMediaScope) => streamStorageDirs.get(streamKey(scope)) ?? storageDir;

  return {
    name: "mock-filesystem",
    provisionStream,
    deprovisionStream,
    readManifest: (scope) => readManifestFile(resolveStorageDir(scope), scope),
    readSegment: (scope, segmentName) => readSegmentFile(resolveStorageDir(scope), scope, segmentName),
    close: async () => {}
  };
}

type ProcessWorkerState = "running" | "stopped" | "failed" | "restarting";

type ProcessWorkerEntry = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
  command: string;
  process: ReturnType<typeof spawn> | null;
  state: ProcessWorkerState;
  restartCount: number;
  desiredRunning: boolean;
  restartTimer: NodeJS.Timeout | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
};

async function stopProcess(processRef: ReturnType<typeof spawn>, timeoutMs: number) {
  if (processRef.exitCode !== null) return;
  processRef.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (processRef.exitCode === null) processRef.kill("SIGKILL");
      finish();
    }, timeoutMs);
    processRef.once("exit", finish);
  });
}

function renderCommandTemplate(template: string, input: StreamMediaInput) {
  return template
    .replaceAll("{{tenantId}}", input.tenantId)
    .replaceAll("{{cameraId}}", input.cameraId)
    .replaceAll("{{rtspUrl}}", input.rtspUrl)
    .replaceAll("{{transport}}", input.transport)
    .replaceAll("{{encryption}}", input.encryption)
    .replaceAll("{{tunnel}}", input.tunnel);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function yamlDoubleQuoted(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildFfmpegHlsCommand(input: StreamMediaInput, storageDir: string) {
  const outDir = cameraDir(storageDir, input.tenantId, input.cameraId);
  const playlist = path.join(outDir, "index.m3u8");
  const segmentPattern = path.join(outDir, "segment%d.ts");
  const isLavfi = input.rtspUrl.startsWith("lavfi:");
  const ffmpegTransport = input.transport === "udp" ? "udp" : "tcp";
  const inputArgs = isLavfi
    ? ["-f", "lavfi", "-i", `"${input.rtspUrl.slice("lavfi:".length)}"`]
    : ["-rtsp_transport", ffmpegTransport, "-i", `"${input.rtspUrl}"`];
  const videoArgs = isLavfi
    ? ["-c:v", "mpeg2video", "-q:v", "4", "-pix_fmt", "yuv420p"]
    : ["-c:v", "copy"];
  return [
    "ffmpeg",
    ...inputArgs,
    "-an",
    ...videoArgs,
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "5",
    "-hls_flags",
    "delete_segments+append_list",
    "-hls_segment_filename",
    `"${segmentPattern}"`,
    `"${playlist}"`
  ].join(" ");
}

function buildFfmpegHlsRetentionCommand(input: StreamMediaInput, storageDir: string) {
  const outDir = cameraDir(storageDir, input.tenantId, input.cameraId);
  const playlist = path.join(outDir, "index.m3u8");
  const segmentPattern = path.join(outDir, "segment-%Y%m%dT%H%M%S.ts");
  const isLavfi = input.rtspUrl.startsWith("lavfi:");
  const ffmpegTransport = input.transport === "udp" ? "udp" : "tcp";
  const inputArgs = isLavfi
    ? ["-f", "lavfi", "-i", `"${input.rtspUrl.slice("lavfi:".length)}"`]
    : ["-rtsp_transport", ffmpegTransport, "-i", `"${input.rtspUrl}"`];
  const videoMode = process.env.STREAM_FFMPEG_VIDEO_MODE ?? "copy";
  const targetBitrateKbps = Math.max(128, Number(process.env.STREAM_FFMPEG_TARGET_BITRATE_KBPS ?? 2500));
  const maxRateKbps = Math.max(targetBitrateKbps, Number(process.env.STREAM_FFMPEG_MAXRATE_KBPS ?? targetBitrateKbps));
  const bufferKbps = Math.max(maxRateKbps, Number(process.env.STREAM_FFMPEG_BUFSIZE_KBPS ?? maxRateKbps * 2));
  const outputFps = Math.max(5, Number(process.env.STREAM_FFMPEG_OUTPUT_FPS ?? 15));
  const keyframeSeconds = Math.max(0.25, Number(process.env.STREAM_FFMPEG_KEYFRAME_SECONDS ?? 1));
  const keyint = Math.max(1, Math.round(outputFps * keyframeSeconds));
  const segmentSeconds = Math.max(1, Number(process.env.STREAM_RETENTION_SEGMENT_SECONDS ?? 1));
  const liveListSize = Math.max(2, Number(process.env.STREAM_RETENTION_LIVE_LIST_SIZE ?? 3));
  const videoArgs =
    videoMode === "cbr"
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-r",
          `${outputFps}`,
          "-g",
          `${keyint}`,
          "-keyint_min",
          `${keyint}`,
          "-sc_threshold",
          "0",
          "-bf",
          "0",
          "-force_key_frames",
          `"expr:gte(t,n_forced*${keyframeSeconds})"`,
          "-b:v",
          `${targetBitrateKbps}k`,
          "-maxrate",
          `${maxRateKbps}k`,
          "-bufsize",
          `${bufferKbps}k`
        ]
      : ["-c:v", "copy"];
  return [
    "ffmpeg",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-max_delay",
    "0",
    "-reorder_queue_size",
    "0",
    ...inputArgs,
    "-an",
    ...videoArgs,
    "-f",
    "hls",
    "-hls_time",
    `${segmentSeconds}`,
    "-hls_list_size",
    `${liveListSize}`,
    "-hls_flags",
    "append_list+delete_segments+omit_endlist+program_date_time+split_by_time",
    "-strftime",
    "1",
    "-hls_segment_filename",
    `"${segmentPattern}"`,
    `"${playlist}"`
  ].join(" ");
}

function normalizeRtspUrlForEncryption(rtspUrl: string, encryption: StreamMediaInput["encryption"]) {
  if (encryption !== "required") return rtspUrl;
  if (rtspUrl.startsWith("rtsp://")) {
    return `rtsps://${rtspUrl.slice("rtsp://".length)}`;
  }
  return rtspUrl;
}

function mapMediaMtxSourceProtocol(transport: StreamMediaInput["transport"]) {
  if (transport === "tcp") return "tcp";
  if (transport === "udp") return "udp";
  return "automatic";
}

function buildMediaMtxPullCommand(input: StreamMediaInput, storageDir: string) {
  const streamName = `${input.tenantId}_${input.cameraId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const streamDir = cameraDir(storageDir, input.tenantId, input.cameraId);
  const configPath = path.join(streamDir, "mediamtx.generated.yml");
  const sourceUrl = normalizeRtspUrlForEncryption(input.rtspUrl, input.encryption);
  const sourceProtocol = mapMediaMtxSourceProtocol(input.transport);
  const readTimeout = process.env.STREAM_MEDIAMTX_READ_TIMEOUT ?? "10s";
  const writeTimeout = process.env.STREAM_MEDIAMTX_WRITE_TIMEOUT ?? "10s";
  const mediamtxBin = process.env.STREAM_MEDIAMTX_BIN ?? "mediamtx";
  const mediamtxArgs = process.env.STREAM_MEDIAMTX_ARGS ?? "";
  const config = [
    "logLevel: info",
    "readTimeout: " + readTimeout,
    "writeTimeout: " + writeTimeout,
    "hls: yes",
    "hlsAlwaysRemux: yes",
    "paths:",
    `  ${streamName}:`,
    `    source: ${yamlDoubleQuoted(sourceUrl)}`,
    `    sourceProtocol: ${sourceProtocol}`
  ].join("\n");
  return [
    `mkdir -p ${shellQuote(streamDir)}`,
    `cat > ${shellQuote(configPath)} <<'NH_MEDIAMTX_CFG'\n${config}\nNH_MEDIAMTX_CFG`,
    `${mediamtxBin}${mediamtxArgs ? ` ${mediamtxArgs}` : ""} ${shellQuote(configPath)}`
  ].join(" && ");
}

function resolveTranscoderCommand(input: StreamMediaInput, storageDir: string, preset: string) {
  if (preset === "ffmpeg-hls") {
    return buildFfmpegHlsCommand(input, storageDir);
  }
  if (preset === "ffmpeg-hls-retention") {
    return buildFfmpegHlsRetentionCommand(input, storageDir);
  }
  if (preset === "mediamtx-rtsp-pull") {
    return buildMediaMtxPullCommand(input, storageDir);
  }
  const commandTemplate = process.env.STREAM_TRANSCODER_CMD ?? 'node -e "setInterval(() => {}, 1000)"';
  return renderCommandTemplate(commandTemplate, input);
}

type ProcessEngineOptions = {
  engineName?: string;
  defaultPreset?: string;
};

export function createProcessMediaEngine(storageDir: string, options: ProcessEngineOptions = {}): MediaEngine {
  const shell = process.env.STREAM_TRANSCODER_SHELL ?? process.env.SHELL ?? "/bin/sh";
  const startTimeoutMs = Math.max(100, Number(process.env.STREAM_TRANSCODER_START_TIMEOUT_MS ?? 1000));
  const stopTimeoutMs = Math.max(100, Number(process.env.STREAM_TRANSCODER_STOP_TIMEOUT_MS ?? 800));
  const dryRun = process.env.STREAM_TRANSCODER_DRY_RUN === "1";
  const preset = process.env.STREAM_TRANSCODER_PRESET ?? options.defaultPreset ?? "custom";
  const seedAssetsByDefault = preset === "ffmpeg-hls" || preset === "ffmpeg-hls-retention" ? "0" : "1";
  const seedAssets = (process.env.STREAM_PROCESS_SEED_ASSETS ?? seedAssetsByDefault) !== "0";
  const maxRestarts = Math.max(0, Number(process.env.STREAM_TRANSCODER_RESTART_MAX ?? 3));
  const restartBackoffMs = Math.max(0, Number(process.env.STREAM_TRANSCODER_RESTART_BACKOFF_MS ?? 200));
  const restartBackoffMaxMs = Math.max(restartBackoffMs, Number(process.env.STREAM_TRANSCODER_RESTART_BACKOFF_MAX_MS ?? 3000));
  const workers = new Map<string, ProcessWorkerEntry>();
  const streamStorageDirs = new Map<string, string>();
  let closing = false;

  const clearRestartTimer = (entry: ProcessWorkerEntry) => {
    if (!entry.restartTimer) return;
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  };

  const scheduleRestart = (entry: ProcessWorkerEntry) => {
    if (!entry.desiredRunning || closing) return;
    if (entry.restartCount >= maxRestarts) {
      entry.state = "failed";
      return;
    }
    entry.restartCount += 1;
    entry.state = "restarting";
    const waitMs = Math.min(restartBackoffMs * 2 ** (entry.restartCount - 1), restartBackoffMaxMs);
    clearRestartTimer(entry);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      void spawnWorker(entry);
    }, waitMs);
  };

  const spawnWorker = async (entry: ProcessWorkerEntry) => {
    clearRestartTimer(entry);
    const child = spawn(shell, ["-lc", entry.command], {
      stdio: "ignore"
    });
    entry.process = child;
    entry.state = "running";

    child.on("exit", (code, signal) => {
      entry.lastExitCode = code;
      entry.lastExitSignal = signal ?? null;
      entry.process = null;
      if (!entry.desiredRunning || closing) {
        entry.state = "stopped";
        return;
      }
      if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") {
        entry.state = "stopped";
        return;
      }
      scheduleRestart(entry);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Transcoder process did not start in time"));
      }, startTimeoutMs);
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        entry.state = "failed";
        reject(error);
      });
    });
  };

  const provisionStream = async (input: StreamMediaInput) => {
    const scope = { tenantId: input.tenantId, cameraId: input.cameraId };
    const resolvedStorageDir = input.storageDir ?? storageDir;
    streamStorageDirs.set(streamKey(scope), resolvedStorageDir);
    if (seedAssets) {
      await ensurePlaybackAssets(resolvedStorageDir, scope);
    } else {
      await ensureCameraStorageDir(resolvedStorageDir, scope);
    }
    const key = streamKey(scope);
    const existing = workers.get(key);
    if (existing) {
      existing.desiredRunning = false;
      clearRestartTimer(existing);
      if (existing.process) {
        await stopProcess(existing.process, stopTimeoutMs);
      }
      existing.state = "stopped";
    }

    const command = resolveTranscoderCommand({ ...input, storageDir: resolvedStorageDir }, resolvedStorageDir, preset);
    const entry: ProcessWorkerEntry = {
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      rtspUrl: input.rtspUrl,
      command,
      process: null,
      state: "stopped",
      restartCount: 0,
      desiredRunning: true,
      restartTimer: null,
      lastExitCode: null,
      lastExitSignal: null
    };
    workers.set(key, entry);
    if (dryRun) {
      entry.state = "running";
      return;
    }
    await spawnWorker(entry);
  };

  const deprovisionStream = async (scope: StreamMediaScope) => {
    const key = streamKey(scope);
    const worker = workers.get(key);
    streamStorageDirs.delete(key);
    if (!worker) return;
    worker.desiredRunning = false;
    clearRestartTimer(worker);
    if (worker.process) {
      await stopProcess(worker.process, stopTimeoutMs);
    }
    worker.state = "stopped";
  };

  const close = async () => {
    closing = true;
    for (const worker of workers.values()) {
      worker.desiredRunning = false;
      clearRestartTimer(worker);
      if (worker.process) {
        await stopProcess(worker.process, stopTimeoutMs);
      }
      worker.state = "stopped";
    }
  };

  const diagnostics = () => {
    let running = 0;
    let stopped = 0;
    let failed = 0;
    let restarting = 0;
    let restartsTotal = 0;
    for (const worker of workers.values()) {
      if (worker.state === "running") running += 1;
      if (worker.state === "stopped") stopped += 1;
      if (worker.state === "failed") failed += 1;
      if (worker.state === "restarting") restarting += 1;
      restartsTotal += worker.restartCount;
    }
    return {
      workers: {
        total: workers.size,
        running,
        stopped,
        failed,
        restarting,
        restartsTotal,
        details: Array.from(workers.values()).map((worker) => ({
          tenantId: worker.tenantId,
          cameraId: worker.cameraId,
          state: worker.state,
          restartCount: worker.restartCount,
          command: worker.command,
          lastExitCode: worker.lastExitCode,
          lastExitSignal: worker.lastExitSignal
        }))
      }
    };
  };

  return {
    name: options.engineName ?? "process-shell",
    provisionStream,
    deprovisionStream,
    readManifest: (scope) => readManifestFile(streamStorageDirs.get(streamKey(scope)) ?? storageDir, scope),
    readSegment: (scope, segmentName) =>
      readSegmentFile(streamStorageDirs.get(streamKey(scope)) ?? storageDir, scope, segmentName),
    close,
    diagnostics
  };
}

export function createMediaEngineFromEnv(storageDir: string): MediaEngine {
  const engine = process.env.STREAM_MEDIA_ENGINE ?? "mock";
  if (engine === "mock") {
    return createMockMediaEngine(storageDir);
  }
  if (engine === "process") {
    return createProcessMediaEngine(storageDir);
  }
  if (engine === "process-mediamtx") {
    return createProcessMediaEngine(storageDir, {
      engineName: "process-mediamtx",
      defaultPreset: "mediamtx-rtsp-pull"
    });
  }
  throw new Error(`Unsupported STREAM_MEDIA_ENGINE=${engine}`);
}
