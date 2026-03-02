import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export type StreamMediaInput = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
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
  readSegment(scope: StreamMediaScope): Promise<Buffer>;
  close(): Promise<void>;
  diagnostics?: () => {
    workers?: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
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

async function readManifestFile(storageDir: string, scope: StreamMediaScope) {
  const playlistPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), "index.m3u8");
  return fs.readFile(playlistPath, "utf8");
}

async function readSegmentFile(storageDir: string, scope: StreamMediaScope) {
  const segmentPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), "segment0.ts");
  return fs.readFile(segmentPath);
}

export function createMockMediaEngine(storageDir: string): MediaEngine {
  const provisionStream = async (input: StreamMediaInput) => {
    await ensurePlaybackAssets(storageDir, { tenantId: input.tenantId, cameraId: input.cameraId });
  };

  const deprovisionStream = async (_scope: StreamMediaScope) => {
    // Mock engine keeps files on disk; stream state is enforced in memory by app layer.
  };

  return {
    name: "mock-filesystem",
    provisionStream,
    deprovisionStream,
    readManifest: (scope) => readManifestFile(storageDir, scope),
    readSegment: (scope) => readSegmentFile(storageDir, scope),
    close: async () => {}
  };
}

type ProcessWorkerState = "running" | "stopped" | "failed";

type ProcessWorkerEntry = {
  process: ReturnType<typeof spawn>;
  state: ProcessWorkerState;
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
    .replaceAll("{{rtspUrl}}", input.rtspUrl);
}

export function createProcessMediaEngine(storageDir: string): MediaEngine {
  const shell = process.env.STREAM_TRANSCODER_SHELL ?? process.env.SHELL ?? "/bin/sh";
  const commandTemplate = process.env.STREAM_TRANSCODER_CMD ?? 'node -e "setInterval(() => {}, 1000)"';
  const startTimeoutMs = Math.max(100, Number(process.env.STREAM_TRANSCODER_START_TIMEOUT_MS ?? 1000));
  const stopTimeoutMs = Math.max(100, Number(process.env.STREAM_TRANSCODER_STOP_TIMEOUT_MS ?? 800));
  const workers = new Map<string, ProcessWorkerEntry>();

  const provisionStream = async (input: StreamMediaInput) => {
    await ensurePlaybackAssets(storageDir, { tenantId: input.tenantId, cameraId: input.cameraId });
    const key = streamKey({ tenantId: input.tenantId, cameraId: input.cameraId });
    const existing = workers.get(key);
    if (existing) {
      await stopProcess(existing.process, stopTimeoutMs);
      existing.state = "stopped";
    }

    const command = renderCommandTemplate(commandTemplate, input);
    const child = spawn(shell, ["-lc", command], {
      stdio: "ignore"
    });

    const entry: ProcessWorkerEntry = { process: child, state: "running" };
    workers.set(key, entry);

    child.on("exit", (code, signal) => {
      if (entry.state === "running") {
        entry.state = code === 0 || signal === "SIGTERM" || signal === "SIGKILL" ? "stopped" : "failed";
      }
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

  const deprovisionStream = async (scope: StreamMediaScope) => {
    const key = streamKey(scope);
    const worker = workers.get(key);
    if (!worker) return;
    await stopProcess(worker.process, stopTimeoutMs);
    worker.state = "stopped";
  };

  const close = async () => {
    for (const worker of workers.values()) {
      await stopProcess(worker.process, stopTimeoutMs);
      worker.state = "stopped";
    }
  };

  const diagnostics = () => {
    let running = 0;
    let stopped = 0;
    let failed = 0;
    for (const worker of workers.values()) {
      if (worker.state === "running") running += 1;
      if (worker.state === "stopped") stopped += 1;
      if (worker.state === "failed") failed += 1;
    }
    return {
      workers: {
        total: workers.size,
        running,
        stopped,
        failed
      }
    };
  };

  return {
    name: "process-shell",
    provisionStream,
    deprovisionStream,
    readManifest: (scope) => readManifestFile(storageDir, scope),
    readSegment: (scope) => readSegmentFile(storageDir, scope),
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
  throw new Error(`Unsupported STREAM_MEDIA_ENGINE=${engine}`);
}
