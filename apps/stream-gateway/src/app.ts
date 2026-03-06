import Fastify from "fastify";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createMediaEngineFromEnv, type MediaEngine } from "./media-engine.js";

const IngestTransportSchema = z.enum(["auto", "tcp", "udp"]);
const IngestEncryptionSchema = z.enum(["optional", "required", "disabled"]);
const IngestTunnelSchema = z.enum(["none", "http", "https", "ws", "wss", "auto"]);
const CodecHintSchema = z.enum(["h264", "h265", "mpeg4", "unknown"]);
const RecordingModeSchema = z.enum(["continuous", "event_only", "hybrid", "observe_only"]);

const ProvisionSchema = z.object({
  tenantId: z.string().min(1),
  cameraId: z.string().min(1),
  rtspUrl: z.string().min(4),
  transport: IngestTransportSchema.optional(),
  encryption: IngestEncryptionSchema.optional(),
  tunnel: IngestTunnelSchema.optional(),
  codecHint: CodecHintSchema.default("unknown"),
  targetProfiles: z.array(z.string().min(1)).default(["main"]),
  storageVaultId: z.string().min(1).optional(),
  planCode: z.string().min(1).optional(),
  retentionDays: z.number().int().positive().optional(),
  recordingMode: RecordingModeSchema.optional(),
  eventClipPreSeconds: z.number().int().min(0).max(120).optional(),
  eventClipPostSeconds: z.number().int().min(1).max(300).optional()
});

type StreamStatus = "provisioning" | "ready" | "stopped";
type Connectivity = "online" | "degraded" | "offline";

type StreamHealth = {
  connectivity: Connectivity;
  latencyMs: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  error: string | null;
  checkedAt: string;
};

type StreamSource = {
  transport: z.infer<typeof IngestTransportSchema>;
  encryption: z.infer<typeof IngestEncryptionSchema>;
  tunnel: z.infer<typeof IngestTunnelSchema>;
  codecHint: "h264" | "h265" | "mpeg4" | "unknown";
  targetProfiles: string[];
};

type StreamEntry = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
  source: StreamSource;
  storage: {
    vaultId: string;
    vaultBasePath: string;
    cameraStorageDir: string;
    observeScratchDir: string | null;
    planCode: string | null;
    retentionDays: number;
    recordingMode: z.infer<typeof RecordingModeSchema>;
    eventClipPreSeconds: number;
    eventClipPostSeconds: number;
  };
  version: number;
  status: StreamStatus;
  health: StreamHealth;
  updatedAt: string;
};

type SessionStatus = "issued" | "active" | "ended" | "expired";

type StreamSessionEntry = {
  tenantId: string;
  cameraId: string;
  sid: string;
  sub: string;
  status: SessionStatus;
  issuedAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  lastSeenAt: string;
  endReason: string | null;
};

type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

class ApiDomainError extends Error {
  statusCode: number;
  apiCode: string;
  details?: unknown;

  constructor(args: { statusCode: number; apiCode: string; message: string; details?: unknown }) {
    super(args.message);
    this.name = "ApiDomainError";
    this.statusCode = args.statusCode;
    this.apiCode = args.apiCode;
    this.details = args.details;
  }
}

function statusToCode(statusCode: number) {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 422) return "UNPROCESSABLE_ENTITY";
  if (statusCode === 429) return "TOO_MANY_REQUESTS";
  return "INTERNAL_SERVER_ERROR";
}

function streamKey(tenantId: string, cameraId: string) {
  return `${tenantId}:${cameraId}`;
}

function streamSessionKey(tenantId: string, cameraId: string, sid: string) {
  return `${tenantId}:${cameraId}:${sid}`;
}

const StreamPlaybackTokenSchema = z.object({
  sub: z.string().min(1),
  tid: z.string().min(1),
  cid: z.string().min(1),
  sid: z.string().min(1),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  v: z.literal(1)
});

function verifyTokenDetailed(token: string, secret: string) {
  const [payloadBase64, signatureBase64] = token.split(".");
  if (!payloadBase64 || !signatureBase64) return { ok: false as const, reason: "format_invalid" as const };

  const expectedSignature = createHmac("sha256", secret).update(payloadBase64).digest("base64url");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  const providedBytes = Buffer.from(signatureBase64, "utf8");
  if (expectedBytes.length !== providedBytes.length) return { ok: false as const, reason: "signature_invalid" as const };
  if (!timingSafeEqual(expectedBytes, providedBytes)) return { ok: false as const, reason: "signature_invalid" as const };

  try {
    const decodedPayload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    const parsed = StreamPlaybackTokenSchema.safeParse(decodedPayload);
    if (!parsed.success) return { ok: false as const, reason: "payload_invalid" as const };
    if (parsed.data.exp <= Math.floor(Date.now() / 1000)) return { ok: false as const, reason: "token_expired" as const };
    return { ok: true as const, payload: parsed.data };
  } catch {
    return { ok: false as const, reason: "payload_invalid" as const };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(binary: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "ignore" });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} exited with code ${code ?? "unknown"}`));
    });
  });
}

function randomIn(min: number, max: number) {
  return Math.round(min + Math.random() * (max - min));
}

function buildHealth(connectivity: Connectivity, error: string | null = null): StreamHealth {
  if (connectivity === "online") {
    return {
      connectivity,
      latencyMs: randomIn(70, 130),
      packetLossPct: Number((Math.random() * 0.3).toFixed(2)),
      jitterMs: randomIn(3, 12),
      error,
      checkedAt: nowIso()
    };
  }
  if (connectivity === "degraded") {
    return {
      connectivity,
      latencyMs: randomIn(160, 320),
      packetLossPct: Number((1 + Math.random() * 4).toFixed(2)),
      jitterMs: randomIn(15, 45),
      error: error ?? "high jitter / packet loss",
      checkedAt: nowIso()
    };
  }
  return {
    connectivity,
    latencyMs: null,
    packetLossPct: null,
    jitterMs: null,
    error: error ?? "stream unreachable",
    checkedAt: nowIso()
  };
}

function runStreamProbe(entry: StreamEntry): StreamEntry {
  if (entry.status === "stopped") {
    return { ...entry, health: buildHealth("offline", "deprovisioned"), updatedAt: nowIso() };
  }
  if (entry.status === "provisioning") {
    return {
      ...entry,
      status: "ready",
      health: buildHealth("online"),
      updatedAt: nowIso()
    };
  }

  const roll = Math.random();
  if (roll < 0.07) {
    return { ...entry, health: buildHealth("offline"), updatedAt: nowIso() };
  }
  if (roll < 0.22) {
    return { ...entry, health: buildHealth("degraded"), updatedAt: nowIso() };
  }
  return { ...entry, health: buildHealth("online"), updatedAt: nowIso() };
}

type RetentionFileEntry = {
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
  vaultId: string;
  tenantId: string | null;
};

type DiskUsageSnapshot = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

type RetentionSweepSummary = {
  reason: "scheduled" | "manual";
  scannedFiles: number;
  deletedByAgeFiles: number;
  deletedByPressureFiles: number;
  deletedByQuotaFiles: number;
  deletedFiles: number;
  deletedBytes: number;
  retentionCutoffIso: string;
  usedPctBefore: number | null;
  usedPctAfter: number | null;
  finishedAt: string;
};

type StorageVaultConfig = {
  id: string;
  basePath: string;
  planCodes?: string[];
  description?: string;
};

type StorageVaultHealth = {
  status: "healthy" | "unhealthy";
  reason: string | null;
  checkedAt: string | null;
  writable: boolean;
  usage: DiskUsageSnapshot | null;
};

type EventClipEntry = {
  tenantId: string;
  cameraId: string;
  eventId: string;
  source: "manual" | "detection" | "rule";
  eventTs: string;
  startedAt: string;
  endedAt: string;
  clipPath: string;
  clipBytes: number;
  sourceSegments: string[];
  createdAt: string;
};

const RETENTION_DEFAULT_EXTENSIONS = [".ts", ".m4s", ".mp4", ".mkv", ".fmp4"];

function parseRetentionExtensions(raw: string | undefined) {
  const values = (raw ?? RETENTION_DEFAULT_EXTENSIONS.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return new Set(values.map((value) => (value.startsWith(".") ? value : `.${value}`)));
}

function parseStorageVaults(raw: string | undefined, fallbackStorageDir: string): StorageVaultConfig[] {
  if (!raw) {
    return [{ id: "default", basePath: fallbackStorageDir, description: "default local storage" }];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [{ id: "default", basePath: fallbackStorageDir }];
    const normalized: StorageVaultConfig[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (typeof value.id !== "string" || value.id.trim().length === 0) continue;
      if (typeof value.basePath !== "string" || value.basePath.trim().length === 0) continue;
      const planCodes = Array.isArray(value.planCodes)
        ? value.planCodes.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : undefined;
      normalized.push({
        id: value.id.trim(),
        basePath: value.basePath.trim(),
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(planCodes && planCodes.length > 0 ? { planCodes } : {})
      });
    }
    return normalized.length > 0 ? normalized : [{ id: "default", basePath: fallbackStorageDir }];
  } catch {
    return [{ id: "default", basePath: fallbackStorageDir }];
  }
}

function parsePlanVaultMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      if (typeof value !== "string" || value.trim().length === 0) continue;
      out[key.trim()] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function parseTenantQuotaMap(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      const asNumber = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(asNumber) || asNumber <= 0) continue;
      out[key.trim()] = Math.floor(asNumber);
    }
    return out;
  } catch {
    return {};
  }
}

const StorageVaultMutationSchema = z.object({
  id: z.string().min(1),
  basePath: z.string().min(1),
  description: z.string().optional(),
  planCodes: z.array(z.string().min(1)).optional(),
  isDefault: z.boolean().optional()
});

const StorageVaultPatchSchema = z.object({
  basePath: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  planCodes: z.array(z.string().min(1)).optional(),
  isDefault: z.boolean().optional()
});

const StoragePlanVaultMapSchema = z.record(z.string().min(1), z.string().min(1));

async function collectRetentionCandidates(
  rootDir: string,
  extensions: Set<string>,
  minAgeMs: number,
  vaultId: string,
  tenantId: string | null = null
): Promise<RetentionFileEntry[]> {
  const now = Date.now();
  const candidates: RetentionFileEntry[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) continue;
    let entries: Array<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; name: string }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs < minAgeMs) continue;
        candidates.push({ filePath: fullPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, vaultId, tenantId });
      } catch {
        // File disappeared between readdir/stat. Ignore.
      }
    }
  }
  return candidates;
}

async function readDiskUsage(rootDir: string): Promise<DiskUsageSnapshot | null> {
  try {
    const stat = await fs.statfs(rootDir);
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct
    };
  } catch {
    return null;
  }
}

type BuildAppOptions = {
  mediaEngine?: MediaEngine;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const streams = new Map<string, StreamEntry>();
  const streamSessions = new Map<string, StreamSessionEntry>();
  const storageDir = process.env.STREAM_STORAGE_DIR ?? path.resolve(process.cwd(), "storage");
  const configuredVaults = parseStorageVaults(process.env.STREAM_STORAGE_VAULTS_JSON, storageDir);
  const storageVaultsById = new Map(
    configuredVaults.map((vault) => [vault.id, { ...vault, basePath: path.resolve(vault.basePath) }])
  );
  let storageDefaultVaultId = process.env.STREAM_STORAGE_DEFAULT_VAULT_ID?.trim() || configuredVaults[0]?.id || "default";
  let storagePlanVaultMap = parsePlanVaultMap(process.env.STREAM_STORAGE_PLAN_VAULT_MAP_JSON);
  const storageFailoverEnabled = (process.env.STREAM_STORAGE_FAILOVER_ENABLED ?? "1") === "1";
  const storageHealthcheckEnabled = (process.env.STREAM_STORAGE_HEALTHCHECK_ENABLED ?? "1") === "1";
  const storageHealthcheckIntervalMs = Math.max(2_000, Number(process.env.STREAM_STORAGE_HEALTHCHECK_MS ?? 30_000));
  const storageHealthcheckWriteProbe = (process.env.STREAM_STORAGE_HEALTHCHECK_WRITE_PROBE ?? "1") === "1";
  const storageTenantQuotaMap = parseTenantQuotaMap(process.env.STREAM_STORAGE_TENANT_QUOTAS_JSON);
  const storageDefaultTenantQuotaBytes = Math.max(0, Number(process.env.STREAM_STORAGE_DEFAULT_TENANT_QUOTA_BYTES ?? 0));
  const storageTenantQuotaTargetPct = Math.min(
    100,
    Math.max(1, Number(process.env.STREAM_STORAGE_TENANT_QUOTA_TARGET_PCT ?? 90))
  );
  const eventClipStrategy = (process.env.STREAM_EVENT_CLIP_STRATEGY ?? "concat").toLowerCase();
  const eventClipFfmpegBin = process.env.STREAM_EVENT_CLIP_FFMPEG_BIN ?? "ffmpeg";
  const observeScratchBaseDir = path.resolve(process.env.STREAM_OBSERVE_SCRATCH_DIR ?? path.join(tmpdir(), "nearhome-observe"));
  const mediaEngine = options.mediaEngine ?? createMediaEngineFromEnv(storageDir);
  const streamTokenSecret = process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret";
  const probeIntervalMs = Number(process.env.STREAM_PROBE_INTERVAL_MS ?? 5000);
  const sessionIdleTtlMs = Number(process.env.STREAM_SESSION_IDLE_TTL_MS ?? 60_000);
  const sessionSweepIntervalMs = Number(process.env.STREAM_SESSION_SWEEP_MS ?? 5_000);
  const playbackReadRetries = Math.max(0, Number(process.env.STREAM_PLAYBACK_READ_RETRIES ?? 0));
  const playbackReadRetryBaseMs = Math.max(0, Number(process.env.STREAM_PLAYBACK_READ_RETRY_BASE_MS ?? 25));
  const playbackReadRetryMaxMs = Math.max(playbackReadRetryBaseMs, Number(process.env.STREAM_PLAYBACK_READ_RETRY_MAX_MS ?? 250));
  const playbackReadTimeoutMs = Math.max(50, Number(process.env.STREAM_PLAYBACK_READ_TIMEOUT_MS ?? 2000));
  const playbackSlowRequestMs = Math.max(1, Number(process.env.STREAM_PLAYBACK_SLOW_MS ?? 500));
  const maxActiveSessionsPerTenant = Math.max(0, Number(process.env.STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT ?? 0));
  const defaultIngestTransport = IngestTransportSchema.catch("auto").parse(process.env.STREAM_DEFAULT_INGEST_TRANSPORT);
  const defaultIngestEncryption = IngestEncryptionSchema.catch("optional").parse(process.env.STREAM_DEFAULT_INGEST_ENCRYPTION);
  const defaultIngestTunnel = IngestTunnelSchema.catch("none").parse(process.env.STREAM_DEFAULT_INGEST_TUNNEL);
  const retentionEnabled = (process.env.STREAM_RETENTION_ENABLED ?? "0") === "1";
  const retentionDays = Math.max(1, Number(process.env.STREAM_RETENTION_DAYS ?? 7));
  const retentionSweepIntervalMs = Math.max(1_000, Number(process.env.STREAM_RETENTION_SWEEP_MS ?? 300_000));
  const retentionMinFileAgeMs = Math.max(1_000, Number(process.env.STREAM_RETENTION_MIN_FILE_AGE_SECONDS ?? 45) * 1_000);
  const retentionMaxDiskUsagePct = Math.min(99, Math.max(1, Number(process.env.STREAM_RETENTION_MAX_DISK_USAGE_PCT ?? 85)));
  const retentionTargetDiskUsagePct = Math.min(
    retentionMaxDiskUsagePct,
    Math.max(1, Number(process.env.STREAM_RETENTION_TARGET_DISK_USAGE_PCT ?? 75))
  );
  const retentionExtensions = parseRetentionExtensions(process.env.STREAM_RETENTION_FILE_EXTENSIONS);
  let probeTimer: NodeJS.Timeout | null = null;
  let sessionSweepTimer: NodeJS.Timeout | null = null;
  let retentionSweepTimer: NodeJS.Timeout | null = null;
  let storageHealthcheckTimer: NodeJS.Timeout | null = null;
  let sessionSweepCount = 0;
  let retentionSweepCount = 0;
  let retentionDeletedFilesTotal = 0;
  let retentionDeletedBytesTotal = 0;
  let retentionQuotaDeletedFilesTotal = 0;
  let retentionQuotaDeletedBytesTotal = 0;
  let retentionLastSweepAt: string | null = null;
  let retentionLastError: string | null = null;
  let retentionLastSummary: RetentionSweepSummary | null = null;
  let retentionDiskUsage: DiskUsageSnapshot | null = null;
  let storageTenantQuotaExceededTotal = 0;
  let storageFailoverProvisionTotal = 0;
  let eventClipsCreatedTotal = 0;
  let eventClipsBytesTotal = 0;
  const storageVaultHealthById = new Map<string, StorageVaultHealth>();
  const eventClips = new Map<string, EventClipEntry>();
  const playbackRequestCounters = new Map<string, number>();
  const playbackErrorCounters = new Map<string, number>();
  const playbackReadRetryCounters = new Map<string, number>();
  const playbackSlowRequestCounters = new Map<string, number>();
  const playbackLatencySum = new Map<string, number>();
  const playbackLatencyCount = new Map<string, number>();

  const metricKey = (labels: Record<string, string>) =>
    Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join("|");

  const incCounter = (store: Map<string, number>, labels: Record<string, string>) => {
    const key = metricKey(labels);
    store.set(key, (store.get(key) ?? 0) + 1);
  };

  const observeValue = (store: Map<string, number>, labels: Record<string, string>, value: number) => {
    const key = metricKey(labels);
    store.set(key, (store.get(key) ?? 0) + value);
  };

  const formatMetricLines = (name: string, store: Map<string, number>) => {
    return Array.from(store.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => {
        const labels = key
          .split("|")
          .map((pair) => pair.split("="))
          .map(([label, labelValue]) => `${label}="${labelValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(",");
        return `${name}{${labels}} ${value}`;
      });
  };

  const resolveTenantQuotaBytes = (tenantId: string) => {
    const direct = storageTenantQuotaMap[tenantId];
    if (Number.isFinite(direct) && direct > 0) return direct;
    const wildcard = storageTenantQuotaMap["*"];
    if (Number.isFinite(wildcard) && wildcard > 0) return wildcard;
    return storageDefaultTenantQuotaBytes > 0 ? storageDefaultTenantQuotaBytes : null;
  };

  const extractTenantFromPath = (filePath: string, vaultBasePath: string) => {
    const relative = path.relative(vaultBasePath, filePath);
    if (!relative || relative.startsWith("..")) return null;
    const [tenantId] = relative.split(path.sep);
    if (!tenantId || tenantId === "." || tenantId === "..") return null;
    return tenantId;
  };

  const readTenantUsageBytes = async (vaultBasePath: string, tenantId: string) => {
    const tenantDir = path.join(vaultBasePath, tenantId);
    const files = await collectRetentionCandidates(tenantDir, retentionExtensions, 0, "quota-usage", tenantId);
    return files.reduce((total, entry) => total + entry.sizeBytes, 0);
  };

  const buildVaultHealth = async (vault: StorageVaultConfig): Promise<StorageVaultHealth> => {
    let writable = false;
    let reason: string | null = null;
    try {
      await fs.mkdir(vault.basePath, { recursive: true });
      if (storageHealthcheckWriteProbe) {
        const probePath = path.join(vault.basePath, `.nearhome-vault-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        await fs.writeFile(probePath, "nearhome-vault-probe", "utf8");
        await fs.unlink(probePath);
      }
      writable = true;
    } catch (error) {
      writable = false;
      reason = error instanceof Error ? error.message : String(error);
    }
    const usage = await readDiskUsage(vault.basePath);
    return {
      status: writable ? "healthy" : "unhealthy",
      reason,
      checkedAt: nowIso(),
      writable,
      usage
    };
  };

  const refreshVaultHealth = async () => {
    for (const vault of storageVaultsById.values()) {
      const health = await buildVaultHealth(vault);
      storageVaultHealthById.set(vault.id, health);
    }
  };

  const resolveVaultForStream = (args: { requestedVaultId?: string; planCode?: string }) => {
    const knownVaultIds = new Set(storageVaultsById.keys());
    const pushCandidate = (list: string[], vaultId?: string) => {
      if (!vaultId || !knownVaultIds.has(vaultId) || list.includes(vaultId)) return;
      list.push(vaultId);
    };
    const candidates: string[] = [];
    const requested = args.requestedVaultId?.trim();
    if (requested && !storageVaultsById.get(requested)) {
      throw new ApiDomainError({
        statusCode: 400,
        apiCode: "STORAGE_VAULT_NOT_FOUND",
        message: "Requested storage vault does not exist",
        details: { storageVaultId: requested }
      });
    }
    pushCandidate(candidates, requested);
    pushCandidate(candidates, args.planCode ? storagePlanVaultMap[args.planCode] : undefined);
    pushCandidate(candidates, storageDefaultVaultId);
    for (const vaultId of knownVaultIds) {
      pushCandidate(candidates, vaultId);
    }

    const selectedCandidate =
      candidates
        .map((vaultId) => {
          const vault = storageVaultsById.get(vaultId);
          if (!vault) return null;
          const health = storageVaultHealthById.get(vaultId);
          const healthy = !storageHealthcheckEnabled || (health?.status ?? "healthy") === "healthy";
          return { vault, healthy };
        })
        .find((entry) => {
          if (!entry) return false;
          if (!storageFailoverEnabled) {
            return entry.vault.id === candidates[0];
          }
          return entry.healthy;
        }) ?? null;

    if (!selectedCandidate || (!selectedCandidate.healthy && storageHealthcheckEnabled)) {
      throw new ApiDomainError({
        statusCode: 503,
        apiCode: "STORAGE_VAULT_UNAVAILABLE",
        message: "No healthy storage vault is currently available",
        details: {
          requestedVaultId: requested ?? null,
          planCode: args.planCode ?? null
        }
      });
    }
    const failedOverFromVaultId =
      candidates[0] && candidates[0] !== selectedCandidate.vault.id && storageFailoverEnabled ? candidates[0] : null;
    if (failedOverFromVaultId) {
      storageFailoverProvisionTotal += 1;
    }
    return {
      ...selectedCandidate.vault,
      failedOverFromVaultId
    };
  };

  const startProbeLoop = () => {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      for (const [key, entry] of streams.entries()) {
        streams.set(key, runStreamProbe(entry));
      }
    }, probeIntervalMs);
  };

  const stopProbeLoop = () => {
    if (!probeTimer) return;
    clearInterval(probeTimer);
    probeTimer = null;
  };

  const sweepSessions = () => {
    const now = Date.now();
    let expired = 0;
    let ended = 0;
    for (const [key, session] of streamSessions.entries()) {
      if ((session.status === "issued" || session.status === "active") && Date.parse(session.expiresAt) <= now) {
        streamSessions.set(key, {
          ...session,
          status: "expired",
          endedAt: nowIso(),
          endReason: "token_expired"
        });
        expired += 1;
        continue;
      }
      if (session.status === "active" && now - Date.parse(session.lastSeenAt) > sessionIdleTtlMs) {
        streamSessions.set(key, {
          ...session,
          status: "ended",
          endedAt: nowIso(),
          endReason: "idle_timeout"
        });
        ended += 1;
      }
    }
    sessionSweepCount += 1;
    return { expired, ended };
  };

  const startSessionSweepLoop = () => {
    if (sessionSweepTimer) return;
    sessionSweepTimer = setInterval(() => {
      sweepSessions();
    }, sessionSweepIntervalMs);
  };

  const stopSessionSweepLoop = () => {
    if (!sessionSweepTimer) return;
    clearInterval(sessionSweepTimer);
    sessionSweepTimer = null;
  };

  const deleteFileEntries = async (files: RetentionFileEntry[]) => {
    let deletedFiles = 0;
    let deletedBytes = 0;
    for (const file of files) {
      try {
        await fs.unlink(file.filePath);
        deletedFiles += 1;
        deletedBytes += file.sizeBytes;
      } catch {
        // File may have been removed by another process. Ignore.
      }
    }
    return { deletedFiles, deletedBytes };
  };

  const runRetentionSweep = async (reason: "scheduled" | "manual"): Promise<RetentionSweepSummary | null> => {
    if (!retentionEnabled) return null;
    const now = Date.now();
    const streamPolicies = Array.from(streams.values()).map((stream) => ({
      tenantId: stream.tenantId,
      vaultId: stream.storage.vaultId,
      vaultBasePath: stream.storage.vaultBasePath,
      cameraStorageDir: stream.storage.cameraStorageDir,
      retentionDays: stream.storage.retentionDays
    }));
    const dedupPolicies = new Map<string, (typeof streamPolicies)[number]>();
    for (const policy of streamPolicies) {
      dedupPolicies.set(policy.cameraStorageDir, policy);
    }
    if (dedupPolicies.size === 0) {
      const defaultVault = storageVaultsById.get(storageDefaultVaultId) ?? { id: "default", basePath: storageDir };
      dedupPolicies.set(defaultVault.basePath, {
        tenantId: "*",
        vaultId: defaultVault.id,
        vaultBasePath: defaultVault.basePath,
        cameraStorageDir: defaultVault.basePath,
        retentionDays
      });
    }

    const allCandidates: RetentionFileEntry[] = [];
    const ageCandidates: RetentionFileEntry[] = [];
    for (const policy of dedupPolicies.values()) {
      const candidates = await collectRetentionCandidates(
        policy.cameraStorageDir,
        retentionExtensions,
        retentionMinFileAgeMs,
        policy.vaultId,
        policy.tenantId
      );
      for (const candidate of candidates) {
        if (!candidate.tenantId) {
          candidate.tenantId = extractTenantFromPath(candidate.filePath, policy.vaultBasePath);
        }
      }
      allCandidates.push(...candidates);
      const cutoff = now - policy.retentionDays * 24 * 60 * 60 * 1_000;
      for (const candidate of candidates) {
        if (candidate.mtimeMs <= cutoff) {
          ageCandidates.push(candidate);
        }
      }
    }

    const usageBeforeByVault = new Map<string, DiskUsageSnapshot>();
    for (const vault of storageVaultsById.values()) {
      const usage = await readDiskUsage(vault.basePath);
      if (usage) usageBeforeByVault.set(vault.id, usage);
    }

    ageCandidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const deletedByAge = await deleteFileEntries(ageCandidates);
    const ageDeletedPaths = new Set(ageCandidates.map((entry) => entry.filePath));
    let deletedByPressureFiles = 0;
    let deletedByPressureBytes = 0;
    let deletedByQuotaFiles = 0;
    let deletedByQuotaBytes = 0;

    const quotaByTenant = new Map<string, number>();
    for (const policy of dedupPolicies.values()) {
      if (!policy.tenantId || policy.tenantId === "*") continue;
      const quotaBytes = resolveTenantQuotaBytes(policy.tenantId);
      if (!quotaBytes) continue;
      quotaByTenant.set(policy.tenantId, quotaBytes);
    }
    for (const [tenantId, quotaBytes] of quotaByTenant.entries()) {
      const candidatePool = allCandidates
        .filter((entry) => entry.tenantId === tenantId && !ageDeletedPaths.has(entry.filePath))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      if (candidatePool.length === 0) continue;
      let tenantUsage = 0;
      const seenVaults = new Set<string>();
      for (const candidate of candidatePool) {
        if (seenVaults.has(candidate.vaultId)) continue;
        const vault = storageVaultsById.get(candidate.vaultId);
        if (!vault) continue;
        seenVaults.add(candidate.vaultId);
        tenantUsage += await readTenantUsageBytes(vault.basePath, tenantId);
      }
      if (tenantUsage <= quotaBytes) continue;
      const targetBytes = Math.floor((quotaBytes * storageTenantQuotaTargetPct) / 100);
      for (const candidate of candidatePool) {
        if (tenantUsage <= targetBytes) break;
        try {
          await fs.unlink(candidate.filePath);
          deletedByQuotaFiles += 1;
          deletedByQuotaBytes += candidate.sizeBytes;
          tenantUsage = Math.max(0, tenantUsage - candidate.sizeBytes);
        } catch {
          // Ignore racy file-not-found errors.
        }
      }
    }

    for (const vault of storageVaultsById.values()) {
      let usage = await readDiskUsage(vault.basePath);
      if (!usage) continue;
      if (usage.usedPct <= retentionMaxDiskUsagePct || retentionTargetDiskUsagePct >= retentionMaxDiskUsagePct) {
        continue;
      }
      const pressureCandidates = allCandidates
        .filter(
          (candidate) => candidate.vaultId === vault.id && !ageDeletedPaths.has(candidate.filePath)
        )
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const candidate of pressureCandidates) {
        if (usage.usedPct <= retentionTargetDiskUsagePct) break;
        try {
          await fs.unlink(candidate.filePath);
          deletedByPressureFiles += 1;
          deletedByPressureBytes += candidate.sizeBytes;
        } catch {
          // Ignore racy file-not-found errors.
        }
        usage = await readDiskUsage(vault.basePath);
        if (!usage) break;
      }
    }

    const usageAfterByVault = new Map<string, DiskUsageSnapshot>();
    for (const vault of storageVaultsById.values()) {
      const usage = await readDiskUsage(vault.basePath);
      if (usage) usageAfterByVault.set(vault.id, usage);
    }
    const usageBefore = usageBeforeByVault.get(storageDefaultVaultId) ?? usageBeforeByVault.values().next().value ?? null;
    const usageAfter = usageAfterByVault.get(storageDefaultVaultId) ?? usageAfterByVault.values().next().value ?? null;
    retentionSweepCount += 1;
    retentionDeletedFilesTotal += deletedByAge.deletedFiles + deletedByQuotaFiles + deletedByPressureFiles;
    retentionDeletedBytesTotal += deletedByAge.deletedBytes + deletedByQuotaBytes + deletedByPressureBytes;
    retentionQuotaDeletedFilesTotal += deletedByQuotaFiles;
    retentionQuotaDeletedBytesTotal += deletedByQuotaBytes;
    retentionLastSweepAt = nowIso();
    retentionDiskUsage = usageAfter;
    const summary: RetentionSweepSummary = {
      reason,
      scannedFiles: allCandidates.length,
      deletedByAgeFiles: deletedByAge.deletedFiles,
      deletedByPressureFiles,
      deletedByQuotaFiles,
      deletedFiles: deletedByAge.deletedFiles + deletedByQuotaFiles + deletedByPressureFiles,
      deletedBytes: deletedByAge.deletedBytes + deletedByQuotaBytes + deletedByPressureBytes,
      retentionCutoffIso: new Date(now - retentionDays * 24 * 60 * 60 * 1_000).toISOString(),
      usedPctBefore: usageBefore ? Number(usageBefore.usedPct.toFixed(2)) : null,
      usedPctAfter: usageAfter ? Number(usageAfter.usedPct.toFixed(2)) : null,
      finishedAt: retentionLastSweepAt
    };
    retentionLastSummary = summary;
    retentionLastError = null;
    return summary;
  };

  const startRetentionSweepLoop = () => {
    if (!retentionEnabled || retentionSweepTimer) return;
    retentionSweepTimer = setInterval(() => {
      void runRetentionSweep("scheduled").catch((error) => {
        retentionLastError = error instanceof Error ? error.message : String(error);
        app.log.warn({ err: error }, "retention sweep failed");
      });
    }, retentionSweepIntervalMs);
  };

  const stopRetentionSweepLoop = () => {
    if (!retentionSweepTimer) return;
    clearInterval(retentionSweepTimer);
    retentionSweepTimer = null;
  };

  const startStorageHealthcheckLoop = () => {
    if (!storageHealthcheckEnabled || storageHealthcheckTimer) return;
    storageHealthcheckTimer = setInterval(() => {
      void refreshVaultHealth().catch((error) => {
        app.log.warn({ err: error }, "storage healthcheck failed");
      });
    }, storageHealthcheckIntervalMs);
  };

  const stopStorageHealthcheckLoop = () => {
    if (!storageHealthcheckTimer) return;
    clearInterval(storageHealthcheckTimer);
    storageHealthcheckTimer = null;
  };

  retentionDiskUsage = await readDiskUsage(storageDir);
  await refreshVaultHealth();
  if (retentionEnabled) {
    try {
      retentionLastSummary = await runRetentionSweep("scheduled");
    } catch (error) {
      retentionLastError = error instanceof Error ? error.message : String(error);
      app.log.warn({ err: error }, "initial retention sweep failed");
    }
  }

  startProbeLoop();
  startSessionSweepLoop();
  startRetentionSweepLoop();
  startStorageHealthcheckLoop();

  app.addHook("onClose", async () => {
    stopProbeLoop();
    stopSessionSweepLoop();
    stopRetentionSweepLoop();
    stopStorageHealthcheckLoop();
    await mediaEngine.close();
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = {
      code: "NOT_FOUND",
      message: "Route not found"
    };
    reply.status(404).send(body);
  });

  app.setErrorHandler((error, _request, reply) => {
    let statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    let body: ApiErrorBody = {
      code: statusToCode(statusCode),
      message: statusCode >= 500 ? "Internal server error" : "Request failed"
    };

    if (error instanceof ApiDomainError) {
      statusCode = error.statusCode;
      body = {
        code: error.apiCode,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {})
      };
    }

    if (error instanceof z.ZodError) {
      statusCode = 400;
      body = {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: error.flatten()
      };
    }

    reply.status(statusCode).send(body);
  });

  function parseAndValidatePlaybackToken(args: { token?: string; tenantId: string; cameraId: string }) {
    if (!args.token) {
      throw new ApiDomainError({
        statusCode: 401,
        apiCode: "PLAYBACK_TOKEN_MISSING",
        message: "Missing playback token"
      });
    }
    const validation = verifyTokenDetailed(args.token, streamTokenSecret);
    if (!validation.ok) {
      const reasonMap: Record<string, { statusCode: number; code: string; message: string }> = {
        format_invalid: {
          statusCode: 401,
          code: "PLAYBACK_TOKEN_FORMAT_INVALID",
          message: "Playback token format is invalid"
        },
        signature_invalid: {
          statusCode: 401,
          code: "PLAYBACK_TOKEN_SIGNATURE_INVALID",
          message: "Playback token signature is invalid"
        },
        payload_invalid: {
          statusCode: 401,
          code: "PLAYBACK_TOKEN_PAYLOAD_INVALID",
          message: "Playback token payload is invalid"
        },
        token_expired: {
          statusCode: 401,
          code: "PLAYBACK_TOKEN_EXPIRED",
          message: "Playback token has expired"
        }
      };
      const mapped = reasonMap[validation.reason];
      throw new ApiDomainError({
        statusCode: mapped.statusCode,
        apiCode: mapped.code,
        message: mapped.message
      });
    }
    const parsed = validation.payload;
    if (parsed.cid !== args.cameraId || parsed.tid !== args.tenantId) {
      throw new ApiDomainError({
        statusCode: 403,
        apiCode: "PLAYBACK_TOKEN_SCOPE_MISMATCH",
        message: "Playback token scope does not match requested stream",
        details: {
          tokenTenantId: parsed.tid,
          tokenCameraId: parsed.cid,
          requestTenantId: args.tenantId,
          requestCameraId: args.cameraId
        }
      });
    }
    return parsed;
  }

  function assertStreamReady(entry: StreamEntry | undefined, tenantId: string, cameraId: string) {
    if (!entry) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "PLAYBACK_STREAM_NOT_FOUND",
        message: "Stream is not provisioned",
        details: { tenantId, cameraId }
      });
    }
    if (entry.status === "provisioning") {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "PLAYBACK_STREAM_NOT_READY",
        message: "Stream is provisioning",
        details: { tenantId, cameraId, status: entry.status }
      });
    }
    if (entry.status === "stopped") {
      throw new ApiDomainError({
        statusCode: 410,
        apiCode: "PLAYBACK_STREAM_STOPPED",
        message: "Stream has been deprovisioned",
        details: { tenantId, cameraId, status: entry.status }
      });
    }
  }

  function upsertActiveSession(args: {
    tenantId: string;
    cameraId: string;
    sid: string;
    sub: string;
    exp: number;
    iat: number;
  }) {
    const sessionKey = streamSessionKey(args.tenantId, args.cameraId, args.sid);
    const existingSession = streamSessions.get(sessionKey);
    if (existingSession?.status === "ended" || existingSession?.status === "expired") {
      throw new ApiDomainError({
        statusCode: 401,
        apiCode: "PLAYBACK_SESSION_CLOSED",
        message: "Playback session is no longer active",
        details: {
          sid: args.sid,
          status: existingSession.status,
          endReason: existingSession.endReason
        }
      });
    }
    if (maxActiveSessionsPerTenant > 0 && existingSession?.status !== "active") {
      let activeSessionsInTenant = 0;
      for (const session of streamSessions.values()) {
        if (session.tenantId === args.tenantId && session.status === "active") {
          activeSessionsInTenant += 1;
        }
      }
      if (activeSessionsInTenant >= maxActiveSessionsPerTenant) {
        throw new ApiDomainError({
          statusCode: 409,
          apiCode: "PLAYBACK_TENANT_CAPACITY_EXCEEDED",
          message: "Tenant reached max active playback sessions",
          details: {
            tenantId: args.tenantId,
            maxActiveSessionsPerTenant,
            activeSessionsInTenant
          }
        });
      }
    }
    const issuedAt = new Date(args.iat * 1000).toISOString();
    const expiresAt = new Date(args.exp * 1000).toISOString();
    streamSessions.set(sessionKey, {
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      sid: args.sid,
      sub: args.sub,
      status: "active",
      issuedAt: existingSession?.issuedAt ?? issuedAt,
      activatedAt: existingSession?.activatedAt ?? nowIso(),
      endedAt: null,
      expiresAt,
      lastSeenAt: nowIso(),
      endReason: null
    });
  }

  async function readWithRetry<T>(args: {
    reader: () => Promise<T>;
    tenantId: string;
    cameraId: string;
    asset: "manifest" | "segment";
  }): Promise<T> {
    const readWithTimeout = async () => {
      const timeoutError = new ApiDomainError({
        statusCode: 504,
        apiCode: "PLAYBACK_ASSET_TIMEOUT",
        message: "Playback asset read timed out",
        details: {
          tenantId: args.tenantId,
          cameraId: args.cameraId,
          asset: args.asset,
          timeoutMs: playbackReadTimeoutMs
        }
      });
      return Promise.race([
        args.reader(),
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(timeoutError), playbackReadTimeoutMs);
        })
      ]);
    };

    let attempt = 0;
    while (true) {
      try {
        return await readWithTimeout();
      } catch (error) {
        if (error instanceof ApiDomainError && error.apiCode === "PLAYBACK_ASSET_TIMEOUT") {
          throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        const retryable = code === "ENOENT" || code === "EAGAIN" || code === "EBUSY";
        if (!retryable || attempt >= playbackReadRetries) {
          throw error;
        }
        attempt += 1;
        incCounter(playbackReadRetryCounters, {
          tenant_id: args.tenantId,
          camera_id: args.cameraId,
          asset: args.asset
        });
        const waitMs = Math.min(playbackReadRetryBaseMs * 2 ** (attempt - 1), playbackReadRetryMaxMs);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
    }
  }

  async function withPlaybackMetrics<T>(args: {
    tenantId: string;
    cameraId: string;
    asset: "manifest" | "segment";
    handler: () => Promise<T>;
  }): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await args.handler();
      const durationMs = Date.now() - startedAt;
      incCounter(playbackRequestCounters, {
        tenant_id: args.tenantId,
        camera_id: args.cameraId,
        asset: args.asset,
        result: "ok"
      });
      observeValue(
        playbackLatencySum,
        { tenant_id: args.tenantId, camera_id: args.cameraId, asset: args.asset },
        durationMs
      );
      incCounter(playbackLatencyCount, {
        tenant_id: args.tenantId,
        camera_id: args.cameraId,
        asset: args.asset
      });
      if (durationMs >= playbackSlowRequestMs) {
        incCounter(playbackSlowRequestCounters, {
          tenant_id: args.tenantId,
          camera_id: args.cameraId,
          asset: args.asset
        });
      }
      return result;
    } catch (error) {
      incCounter(playbackRequestCounters, {
        tenant_id: args.tenantId,
        camera_id: args.cameraId,
        asset: args.asset,
        result: "error"
      });
      const code = error instanceof ApiDomainError ? error.apiCode : "INTERNAL_SERVER_ERROR";
      incCounter(playbackErrorCounters, {
        tenant_id: args.tenantId,
        camera_id: args.cameraId,
        asset: args.asset,
        code
      });
      throw error;
    }
  }

  const rewriteManifestSegmentUris = (manifest: string, tenantId: string, cameraId: string, token: string) => {
    const tokenQuery = `?token=${encodeURIComponent(token)}`;
    return manifest
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        return `/playback/${tenantId}/${cameraId}/segments/${encodeURIComponent(trimmed)}${tokenQuery}`;
      })
      .join("\n");
  };

  const eventClipKey = (tenantId: string, cameraId: string, eventId: string) => `${tenantId}:${cameraId}:${eventId}`;

  const listCameraSegments = async (cameraDir: string) => {
    let entries: Array<{ isFile(): boolean; isDirectory(): boolean; name: string }> = [];
    try {
      entries = await fs.readdir(cameraDir, { withFileTypes: true });
    } catch {
      return [] as Array<{ filePath: string; name: string; mtimeMs: number; sizeBytes: number }>;
    }
    const files: Array<{ filePath: string; name: string; mtimeMs: number; sizeBytes: number }> = [];
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!retentionExtensions.has(ext)) continue;
      const filePath = path.join(cameraDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        files.push({ filePath, name: entry.name, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
      } catch {
        // Ignore disappearing files.
      }
    }
    return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  };

  const createEventClipFromRange = async (args: {
    stream: StreamEntry;
    eventId: string;
    eventTs: Date;
    preSeconds: number;
    postSeconds: number;
    source: "manual" | "detection" | "rule";
  }) => {
    const cameraSegments = await listCameraSegments(args.stream.storage.cameraStorageDir);
    const startMs = args.eventTs.getTime() - args.preSeconds * 1_000;
    const endMs = args.eventTs.getTime() + args.postSeconds * 1_000;
    let selectedSegments = cameraSegments.filter((segment) => segment.mtimeMs >= startMs && segment.mtimeMs <= endMs);
    if (selectedSegments.length === 0) {
      selectedSegments = cameraSegments.filter((segment) => segment.mtimeMs <= endMs).slice(-3);
    }
    if (selectedSegments.length === 0) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "EVENT_CLIP_SOURCE_NOT_AVAILABLE",
        message: "No source segments available for requested event window",
        details: {
          tenantId: args.stream.tenantId,
          cameraId: args.stream.cameraId,
          eventId: args.eventId
        }
      });
    }

    const clipDir = path.join(args.stream.storage.cameraStorageDir, "_events", args.eventId);
    await fs.mkdir(clipDir, { recursive: true });
    const clipPath = path.join(clipDir, "clip.ts");
    const usableSegments: typeof selectedSegments = [];
    const buffers: Buffer[] = [];
    for (const segment of selectedSegments) {
      try {
        const payload = await fs.readFile(segment.filePath);
        buffers.push(payload);
        usableSegments.push(segment);
      } catch {
        // Ignore transient segment deletion.
      }
    }
    if (buffers.length === 0 || usableSegments.length === 0) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "EVENT_CLIP_SOURCE_NOT_AVAILABLE",
        message: "Segments disappeared while building event clip",
        details: {
          tenantId: args.stream.tenantId,
          cameraId: args.stream.cameraId,
          eventId: args.eventId
        }
      });
    }
    const firstSegmentTs = usableSegments[0].mtimeMs;
    const desiredStartMs = Math.max(startMs, firstSegmentTs);
    const offsetSeconds = Math.max(0, (desiredStartMs - firstSegmentTs) / 1000);
    const durationSeconds = Math.max(1, (endMs - desiredStartMs) / 1000);
    let clipBuffer: Buffer;
    if (eventClipStrategy === "ffmpeg") {
      const concatListPath = path.join(clipDir, "concat.txt");
      const concatPayload = usableSegments.map((segment) => `file '${segment.filePath.replace(/'/g, "'\\''")}'`).join("\n");
      await fs.writeFile(concatListPath, concatPayload, "utf8");
      try {
        await runCommand(eventClipFfmpegBin, [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatListPath,
          "-ss",
          `${offsetSeconds.toFixed(3)}`,
          "-t",
          `${durationSeconds.toFixed(3)}`,
          "-c",
          "copy",
          clipPath
        ]);
        clipBuffer = await fs.readFile(clipPath);
      } catch {
        clipBuffer = Buffer.concat(buffers);
        await fs.writeFile(clipPath, clipBuffer);
      } finally {
        await fs.rm(concatListPath, { force: true });
      }
    } else {
      clipBuffer = Buffer.concat(buffers);
      await fs.writeFile(clipPath, clipBuffer);
    }
    const meta = {
      eventId: args.eventId,
      tenantId: args.stream.tenantId,
      cameraId: args.stream.cameraId,
      source: args.source,
      eventTs: args.eventTs.toISOString(),
      startedAt: new Date(desiredStartMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      sourceSegments: usableSegments.map((segment) => segment.name),
      clipPath,
      clipBytes: clipBuffer.length,
      strategy: eventClipStrategy === "ffmpeg" ? "ffmpeg" : "concat",
      createdAt: nowIso()
    };
    await fs.writeFile(path.join(clipDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    return meta;
  };

  const loadEventClipFromDisk = async (tenantId: string, cameraId: string, eventId: string): Promise<EventClipEntry | null> => {
    for (const vault of storageVaultsById.values()) {
      const clipDir = path.join(vault.basePath, tenantId, cameraId, "_events", eventId);
      const metaPath = path.join(clipDir, "meta.json");
      try {
        const raw = await fs.readFile(metaPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const clipPath = typeof parsed.clipPath === "string" ? parsed.clipPath : path.join(clipDir, "clip.ts");
        const stat = await fs.stat(clipPath);
        const entry: EventClipEntry = {
          tenantId,
          cameraId,
          eventId,
          source: parsed.source === "detection" || parsed.source === "rule" ? parsed.source : "manual",
          eventTs: typeof parsed.eventTs === "string" ? parsed.eventTs : nowIso(),
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : nowIso(),
          endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : nowIso(),
          clipPath,
          clipBytes: stat.size,
          sourceSegments: Array.isArray(parsed.sourceSegments)
            ? parsed.sourceSegments.filter((item): item is string => typeof item === "string")
            : [],
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : nowIso()
        };
        eventClips.set(eventClipKey(tenantId, cameraId, eventId), entry);
        return entry;
      } catch {
        // Keep searching other vault roots.
      }
    }
    return null;
  };

  app.get("/health", async () => ({
    ok: true,
    streams: streams.size,
    sessions: streamSessions.size,
    storageDir,
    mediaEngine: mediaEngine.name,
    storage: {
      observeScratchBaseDir,
      failoverEnabled: storageFailoverEnabled,
      healthcheckEnabled: storageHealthcheckEnabled,
      healthcheckIntervalMs: storageHealthcheckIntervalMs,
      defaultVaultId: storageDefaultVaultId,
      planVaultMap: storagePlanVaultMap,
      tenantQuotas: {
        defaultQuotaBytes: storageDefaultTenantQuotaBytes,
        targetPct: storageTenantQuotaTargetPct,
        overrides: storageTenantQuotaMap
      },
      failoverProvisionTotal: storageFailoverProvisionTotal,
      tenantQuotaExceededTotal: storageTenantQuotaExceededTotal,
      eventClipsCreatedTotal,
      eventClipsBytesTotal,
      vaults: Array.from(storageVaultsById.values()).map((vault) => ({
        id: vault.id,
        basePath: vault.basePath,
        description: vault.description ?? null,
        planCodes: vault.planCodes ?? [],
        health: storageVaultHealthById.get(vault.id) ?? null
      }))
    },
    retention: {
      enabled: retentionEnabled,
      days: retentionDays,
      sweepIntervalMs: retentionSweepIntervalMs,
      minFileAgeMs: retentionMinFileAgeMs,
      maxDiskUsagePct: retentionMaxDiskUsagePct,
      targetDiskUsagePct: retentionTargetDiskUsagePct,
      extensions: Array.from(retentionExtensions.values()).sort(),
      defaultVaultId: storageDefaultVaultId,
      vaults: Array.from(storageVaultsById.values()).map((vault) => ({
        id: vault.id,
        basePath: vault.basePath,
        description: vault.description ?? null,
        planCodes: vault.planCodes ?? []
      })),
      sweepCount: retentionSweepCount,
      deletedFilesTotal: retentionDeletedFilesTotal,
      deletedBytesTotal: retentionDeletedBytesTotal,
      quotaDeletedFilesTotal: retentionQuotaDeletedFilesTotal,
      quotaDeletedBytesTotal: retentionQuotaDeletedBytesTotal,
      lastSweepAt: retentionLastSweepAt,
      lastError: retentionLastError,
      lastSummary: retentionLastSummary,
      diskUsage: retentionDiskUsage
    },
    ...(mediaEngine.diagnostics ? { mediaEngineDiagnostics: mediaEngine.diagnostics() } : {})
  }));

  app.get("/metrics", async (_request, reply) => {
    const counters = {
      provisioning: 0,
      ready: 0,
      stopped: 0,
      online: 0,
      degraded: 0,
      offline: 0
    };
    const sessionCounters: Record<SessionStatus, number> = {
      issued: 0,
      active: 0,
      ended: 0,
      expired: 0
    };
    for (const entry of streams.values()) {
      counters[entry.status] += 1;
      counters[entry.health.connectivity] += 1;
    }
    for (const session of streamSessions.values()) {
      sessionCounters[session.status] += 1;
    }

    const workerStats = mediaEngine.diagnostics?.().workers;
    const lines = [
      "# HELP nearhome_streams_total Number of known streams by status",
      "# TYPE nearhome_streams_total gauge",
      `nearhome_streams_total{status=\"provisioning\"} ${counters.provisioning}`,
      `nearhome_streams_total{status=\"ready\"} ${counters.ready}`,
      `nearhome_streams_total{status=\"stopped\"} ${counters.stopped}`,
      "# HELP nearhome_stream_connectivity_total Number of streams by connectivity",
      "# TYPE nearhome_stream_connectivity_total gauge",
      `nearhome_stream_connectivity_total{connectivity=\"online\"} ${counters.online}`,
      `nearhome_stream_connectivity_total{connectivity=\"degraded\"} ${counters.degraded}`,
      `nearhome_stream_connectivity_total{connectivity=\"offline\"} ${counters.offline}`,
      "# HELP nearhome_stream_sessions_total Number of tracked stream sessions by status",
      "# TYPE nearhome_stream_sessions_total gauge",
      `nearhome_stream_sessions_total{status=\"issued\"} ${sessionCounters.issued}`,
      `nearhome_stream_sessions_total{status=\"active\"} ${sessionCounters.active}`,
      `nearhome_stream_sessions_total{status=\"ended\"} ${sessionCounters.ended}`,
      `nearhome_stream_sessions_total{status=\"expired\"} ${sessionCounters.expired}`,
      "# HELP nearhome_stream_session_sweeps_total Number of session sweep cycles",
      "# TYPE nearhome_stream_session_sweeps_total counter",
      `nearhome_stream_session_sweeps_total ${sessionSweepCount}`,
      "# HELP nearhome_playback_requests_total Playback requests by tenant/camera/asset/result",
      "# TYPE nearhome_playback_requests_total counter",
      ...formatMetricLines("nearhome_playback_requests_total", playbackRequestCounters),
      "# HELP nearhome_playback_errors_total Playback errors by tenant/camera/asset/code",
      "# TYPE nearhome_playback_errors_total counter",
      ...formatMetricLines("nearhome_playback_errors_total", playbackErrorCounters),
      "# HELP nearhome_playback_read_retries_total Playback asset read retries by tenant/camera/asset",
      "# TYPE nearhome_playback_read_retries_total counter",
      ...formatMetricLines("nearhome_playback_read_retries_total", playbackReadRetryCounters),
      "# HELP nearhome_playback_slow_requests_total Playback requests slower than STREAM_PLAYBACK_SLOW_MS by tenant/camera/asset",
      "# TYPE nearhome_playback_slow_requests_total counter",
      ...formatMetricLines("nearhome_playback_slow_requests_total", playbackSlowRequestCounters),
      "# HELP nearhome_playback_latency_ms_sum Sum of successful playback request latency in ms by tenant/camera/asset",
      "# TYPE nearhome_playback_latency_ms_sum counter",
      ...formatMetricLines("nearhome_playback_latency_ms_sum", playbackLatencySum),
      "# HELP nearhome_playback_latency_ms_count Count of successful playback request latency observations by tenant/camera/asset",
      "# TYPE nearhome_playback_latency_ms_count counter",
      ...formatMetricLines("nearhome_playback_latency_ms_count", playbackLatencyCount),
      "# HELP nearhome_media_workers_total Media engine workers by state",
      "# TYPE nearhome_media_workers_total gauge",
      `nearhome_media_workers_total{state=\"running\"} ${workerStats?.running ?? 0}`,
      `nearhome_media_workers_total{state=\"restarting\"} ${workerStats?.restarting ?? 0}`,
      `nearhome_media_workers_total{state=\"stopped\"} ${workerStats?.stopped ?? 0}`,
      `nearhome_media_workers_total{state=\"failed\"} ${workerStats?.failed ?? 0}`,
      "# HELP nearhome_media_worker_restarts_total Media engine worker restart attempts",
      "# TYPE nearhome_media_worker_restarts_total counter",
      `nearhome_media_worker_restarts_total ${workerStats?.restartsTotal ?? 0}`,
      "# HELP nearhome_storage_retention_enabled Retention loop enabled flag (1 enabled, 0 disabled)",
      "# TYPE nearhome_storage_retention_enabled gauge",
      `nearhome_storage_retention_enabled ${retentionEnabled ? 1 : 0}`,
      "# HELP nearhome_storage_retention_sweeps_total Number of retention sweep cycles",
      "# TYPE nearhome_storage_retention_sweeps_total counter",
      `nearhome_storage_retention_sweeps_total ${retentionSweepCount}`,
      "# HELP nearhome_storage_retention_deleted_files_total Number of media files deleted by retention",
      "# TYPE nearhome_storage_retention_deleted_files_total counter",
      `nearhome_storage_retention_deleted_files_total ${retentionDeletedFilesTotal}`,
      "# HELP nearhome_storage_retention_deleted_bytes_total Bytes deleted by retention",
      "# TYPE nearhome_storage_retention_deleted_bytes_total counter",
      `nearhome_storage_retention_deleted_bytes_total ${retentionDeletedBytesTotal}`,
      "# HELP nearhome_storage_retention_deleted_quota_files_total Number of media files deleted by tenant quota retention",
      "# TYPE nearhome_storage_retention_deleted_quota_files_total counter",
      `nearhome_storage_retention_deleted_quota_files_total ${retentionQuotaDeletedFilesTotal}`,
      "# HELP nearhome_storage_retention_deleted_quota_bytes_total Bytes deleted by tenant quota retention",
      "# TYPE nearhome_storage_retention_deleted_quota_bytes_total counter",
      `nearhome_storage_retention_deleted_quota_bytes_total ${retentionQuotaDeletedBytesTotal}`,
      "# HELP nearhome_storage_tenant_quota_exceeded_total Number of provision requests rejected by tenant quota",
      "# TYPE nearhome_storage_tenant_quota_exceeded_total counter",
      `nearhome_storage_tenant_quota_exceeded_total ${storageTenantQuotaExceededTotal}`,
      "# HELP nearhome_storage_failover_provision_total Number of stream provisions that failed over to a different vault",
      "# TYPE nearhome_storage_failover_provision_total counter",
      `nearhome_storage_failover_provision_total ${storageFailoverProvisionTotal}`,
      "# HELP nearhome_storage_event_clips_created_total Number of generated event clips",
      "# TYPE nearhome_storage_event_clips_created_total counter",
      `nearhome_storage_event_clips_created_total ${eventClipsCreatedTotal}`,
      "# HELP nearhome_storage_event_clips_bytes_total Total bytes generated in event clips",
      "# TYPE nearhome_storage_event_clips_bytes_total counter",
      `nearhome_storage_event_clips_bytes_total ${eventClipsBytesTotal}`,
      "# HELP nearhome_storage_usage_bytes Storage usage bytes by state",
      "# TYPE nearhome_storage_usage_bytes gauge",
      `nearhome_storage_usage_bytes{state="total"} ${retentionDiskUsage?.totalBytes ?? 0}`,
      `nearhome_storage_usage_bytes{state="used"} ${retentionDiskUsage?.usedBytes ?? 0}`,
      `nearhome_storage_usage_bytes{state="free"} ${retentionDiskUsage?.freeBytes ?? 0}`,
      "# HELP nearhome_storage_usage_pct Used storage percentage in STREAM_STORAGE_DIR filesystem",
      "# TYPE nearhome_storage_usage_pct gauge",
      `nearhome_storage_usage_pct ${retentionDiskUsage ? Number(retentionDiskUsage.usedPct.toFixed(3)) : 0}`,
      "# HELP nearhome_storage_vault_health Storage vault health by vault_id (1 healthy, 0 unhealthy)",
      "# TYPE nearhome_storage_vault_health gauge",
      ...Array.from(storageVaultsById.values())
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((vault) => {
          const health = storageVaultHealthById.get(vault.id);
          const healthy = !health || health.status === "healthy" ? 1 : 0;
          return `nearhome_storage_vault_health{vault_id="${vault.id}"} ${healthy}`;
        }),
      "# HELP nearhome_storage_vault_usage_pct Storage vault usage percentage by vault_id",
      "# TYPE nearhome_storage_vault_usage_pct gauge",
      ...Array.from(storageVaultsById.values())
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((vault) => {
          const usage = storageVaultHealthById.get(vault.id)?.usage;
          return `nearhome_storage_vault_usage_pct{vault_id="${vault.id}"} ${usage ? Number(usage.usedPct.toFixed(3)) : 0}`;
        })
    ];
    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n");
  });

  app.get("/health/:tenantId/:cameraId", async (request, reply) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const key = streamKey(tenantId, cameraId);
    const entry = streams.get(key);
    if (!entry) {
      reply.status(404);
      return { ok: false, reason: "not_provisioned" };
    }
    return { ok: true, data: entry };
  });

  app.get("/storage/vaults", async () => {
    const activeStreamsByVault = new Map<string, number>();
    for (const stream of streams.values()) {
      activeStreamsByVault.set(stream.storage.vaultId, (activeStreamsByVault.get(stream.storage.vaultId) ?? 0) + 1);
    }
    const data = Array.from(storageVaultsById.values())
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((vault) => ({
        id: vault.id,
        basePath: vault.basePath,
        description: vault.description ?? null,
        planCodes: vault.planCodes ?? [],
        isDefault: vault.id === storageDefaultVaultId,
        activeStreams: activeStreamsByVault.get(vault.id) ?? 0,
        health: storageVaultHealthById.get(vault.id) ?? null
      }));
    return { data, total: data.length };
  });

  app.post("/storage/vaults/:vaultId/check", async (request) => {
    const { vaultId } = request.params as { vaultId: string };
    const vault = storageVaultsById.get(vaultId);
    if (!vault) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "STORAGE_VAULT_NOT_FOUND",
        message: "Storage vault not found",
        details: { vaultId }
      });
    }
    const health = await buildVaultHealth(vault);
    storageVaultHealthById.set(vault.id, health);
    return { data: { vaultId: vault.id, health } };
  });

  app.post("/storage/vaults", async (request) => {
    const body = StorageVaultMutationSchema.parse(request.body);
    const id = body.id.trim();
    if (storageVaultsById.has(id)) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "STORAGE_VAULT_ALREADY_EXISTS",
        message: "Storage vault already exists",
        details: { vaultId: id }
      });
    }
    const vault: StorageVaultConfig = {
      id,
      basePath: path.resolve(body.basePath),
      ...(body.description ? { description: body.description } : {}),
      ...(body.planCodes && body.planCodes.length > 0 ? { planCodes: body.planCodes } : {})
    };
    storageVaultsById.set(vault.id, vault);
    if (body.planCodes && body.planCodes.length > 0) {
      for (const planCode of body.planCodes) {
        storagePlanVaultMap[planCode] = vault.id;
      }
    }
    if (body.isDefault || !storageVaultsById.get(storageDefaultVaultId)) {
      storageDefaultVaultId = vault.id;
    }
    const health = await buildVaultHealth(vault);
    storageVaultHealthById.set(vault.id, health);
    return { data: { ...vault, isDefault: storageDefaultVaultId === vault.id, health } };
  });

  app.patch("/storage/vaults/:vaultId", async (request) => {
    const { vaultId } = request.params as { vaultId: string };
    const body = StorageVaultPatchSchema.parse(request.body);
    const existing = storageVaultsById.get(vaultId);
    if (!existing) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "STORAGE_VAULT_NOT_FOUND",
        message: "Storage vault not found",
        details: { vaultId }
      });
    }
    const activeStreams = Array.from(streams.values()).filter((stream) => stream.storage.vaultId === vaultId).length;
    if (body.basePath && path.resolve(body.basePath) !== existing.basePath && activeStreams > 0) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "STORAGE_VAULT_IN_USE",
        message: "Cannot change basePath while vault has active streams",
        details: { vaultId, activeStreams }
      });
    }
    const updated: StorageVaultConfig = {
      ...existing,
      ...(body.basePath ? { basePath: path.resolve(body.basePath) } : {}),
      ...(body.description === null ? { description: undefined } : body.description ? { description: body.description } : {}),
      ...(body.planCodes ? { planCodes: body.planCodes } : {})
    };
    storageVaultsById.set(vaultId, updated);
    if (body.planCodes) {
      for (const [planCode, mappedVaultId] of Object.entries(storagePlanVaultMap)) {
        if (mappedVaultId === vaultId) delete storagePlanVaultMap[planCode];
      }
      for (const planCode of body.planCodes) {
        storagePlanVaultMap[planCode] = vaultId;
      }
    }
    if (body.isDefault) {
      storageDefaultVaultId = vaultId;
    }
    const health = await buildVaultHealth(updated);
    storageVaultHealthById.set(vaultId, health);
    return { data: { ...updated, isDefault: storageDefaultVaultId === vaultId, health } };
  });

  app.delete("/storage/vaults/:vaultId", async (request) => {
    const { vaultId } = request.params as { vaultId: string };
    const existing = storageVaultsById.get(vaultId);
    if (!existing) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "STORAGE_VAULT_NOT_FOUND",
        message: "Storage vault not found",
        details: { vaultId }
      });
    }
    if (vaultId === storageDefaultVaultId) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "STORAGE_VAULT_IS_DEFAULT",
        message: "Cannot delete default storage vault",
        details: { vaultId }
      });
    }
    const activeStreams = Array.from(streams.values()).filter((stream) => stream.storage.vaultId === vaultId).length;
    if (activeStreams > 0) {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "STORAGE_VAULT_IN_USE",
        message: "Cannot delete vault with active streams",
        details: { vaultId, activeStreams }
      });
    }
    storageVaultsById.delete(vaultId);
    storageVaultHealthById.delete(vaultId);
    for (const [planCode, mappedVaultId] of Object.entries(storagePlanVaultMap)) {
      if (mappedVaultId === vaultId) delete storagePlanVaultMap[planCode];
    }
    return { data: { removed: true, vaultId } };
  });

  app.get("/storage/plan-vault-map", async () => {
    return { data: { defaultVaultId: storageDefaultVaultId, map: storagePlanVaultMap } };
  });

  app.put("/storage/plan-vault-map", async (request) => {
    const body = z.object({ defaultVaultId: z.string().min(1).optional(), map: StoragePlanVaultMapSchema }).parse(request.body);
    for (const vaultId of Object.values(body.map)) {
      if (!storageVaultsById.has(vaultId)) {
        throw new ApiDomainError({
          statusCode: 400,
          apiCode: "STORAGE_VAULT_NOT_FOUND",
          message: "Plan map references unknown storage vault",
          details: { vaultId }
        });
      }
    }
    if (body.defaultVaultId && !storageVaultsById.has(body.defaultVaultId)) {
      throw new ApiDomainError({
        statusCode: 400,
        apiCode: "STORAGE_VAULT_NOT_FOUND",
        message: "Default storage vault does not exist",
        details: { defaultVaultId: body.defaultVaultId }
      });
    }
    storagePlanVaultMap = { ...body.map };
    if (body.defaultVaultId) {
      storageDefaultVaultId = body.defaultVaultId;
    }
    return { data: { defaultVaultId: storageDefaultVaultId, map: storagePlanVaultMap } };
  });

  app.post("/provision", async (request) => {
    const body = ProvisionSchema.parse(request.body);
    const key = streamKey(body.tenantId, body.cameraId);
    const resolvedTransport = body.transport ?? defaultIngestTransport;
    const resolvedEncryption = body.encryption ?? defaultIngestEncryption;
    const resolvedTunnel = body.tunnel ?? defaultIngestTunnel;
    const selectedVault = resolveVaultForStream({
      requestedVaultId: body.storageVaultId,
      planCode: body.planCode
    });
    const recordingMode = body.recordingMode ?? "continuous";
    const observeScratchDir =
      recordingMode === "observe_only" ? path.join(observeScratchBaseDir, body.tenantId, body.cameraId) : null;
    const tenantQuotaBytes = resolveTenantQuotaBytes(body.tenantId);
    if (tenantQuotaBytes && recordingMode !== "observe_only") {
      const currentUsageBytes = await readTenantUsageBytes(selectedVault.basePath, body.tenantId);
      if (currentUsageBytes >= tenantQuotaBytes) {
        storageTenantQuotaExceededTotal += 1;
        throw new ApiDomainError({
          statusCode: 409,
          apiCode: "STORAGE_TENANT_QUOTA_EXCEEDED",
          message: "Tenant storage quota exceeded",
          details: {
            tenantId: body.tenantId,
            vaultId: selectedVault.id,
            currentUsageBytes,
            quotaBytes: tenantQuotaBytes
          }
        });
      }
    }
    const streamRetentionDays = Math.max(1, body.retentionDays ?? retentionDays);
    const eventClipPreSeconds = body.eventClipPreSeconds ?? 5;
    const eventClipPostSeconds = body.eventClipPostSeconds ?? 10;
    if (observeScratchDir) {
      await fs.mkdir(observeScratchDir, { recursive: true });
    }
    const streamStorage = {
      vaultId: selectedVault.id,
      vaultBasePath: selectedVault.basePath,
      cameraStorageDir: observeScratchDir ?? path.join(selectedVault.basePath, body.tenantId, body.cameraId),
      observeScratchDir,
      planCode: body.planCode ?? null,
      retentionDays: streamRetentionDays,
      recordingMode,
      eventClipPreSeconds,
      eventClipPostSeconds
    };
    const source: StreamSource = {
      transport: resolvedTransport,
      encryption: resolvedEncryption,
      tunnel: resolvedTunnel,
      codecHint: body.codecHint,
      targetProfiles: body.targetProfiles
    };
    const existing = streams.get(key);

    if (
      existing &&
      existing.rtspUrl === body.rtspUrl &&
      existing.source.transport === source.transport &&
      existing.source.encryption === source.encryption &&
      existing.source.tunnel === source.tunnel &&
      existing.source.codecHint === source.codecHint &&
      JSON.stringify(existing.source.targetProfiles) === JSON.stringify(source.targetProfiles) &&
      existing.storage.vaultId === streamStorage.vaultId &&
      existing.storage.retentionDays === streamStorage.retentionDays &&
      existing.storage.planCode === streamStorage.planCode &&
      existing.storage.recordingMode === streamStorage.recordingMode &&
      existing.storage.eventClipPreSeconds === streamStorage.eventClipPreSeconds &&
      existing.storage.eventClipPostSeconds === streamStorage.eventClipPostSeconds
    ) {
      return {
        data: {
          ...existing,
          playbackPath: `/playback/${body.tenantId}/${body.cameraId}/index.m3u8`,
          reprovisioned: false
        }
      };
    }

    streams.set(key, {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      source,
      storage: streamStorage,
      version: existing ? existing.version + 1 : 1,
      status: "provisioning",
      health: buildHealth("degraded", "provisioning"),
      updatedAt: nowIso()
    });

    await mediaEngine.provisionStream({
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      transport: source.transport,
      encryption: source.encryption,
      tunnel: source.tunnel,
      storageDir: observeScratchDir ? observeScratchBaseDir : selectedVault.basePath
    });

    const ready: StreamEntry = {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      source,
      storage: streamStorage,
      version: existing ? existing.version + 1 : 1,
      status: "ready",
      health: buildHealth("online"),
      updatedAt: nowIso()
    };

    streams.set(key, ready);

    return {
      data: {
        ...ready,
        playbackPath: `/playback/${body.tenantId}/${body.cameraId}/index.m3u8`,
        ...(selectedVault.failedOverFromVaultId
          ? { failover: { fromVaultId: selectedVault.failedOverFromVaultId, toVaultId: selectedVault.id } }
          : {}),
        reprovisioned: true
      }
    };
  });

  app.post("/deprovision", async (request) => {
    const body = z.object({ tenantId: z.string(), cameraId: z.string() }).parse(request.body);
    const key = streamKey(body.tenantId, body.cameraId);
    const existing = streams.get(key);
    if (!existing) {
      return { data: { removed: false } };
    }
    streams.set(key, {
      ...existing,
      status: "stopped",
      health: buildHealth("offline", "deprovisioned"),
      updatedAt: nowIso()
    });
    for (const [sessionKey, session] of streamSessions.entries()) {
      if (
        session.tenantId === body.tenantId &&
        session.cameraId === body.cameraId &&
        (session.status === "issued" || session.status === "active")
      ) {
        streamSessions.set(sessionKey, {
          ...session,
          status: "ended",
          endedAt: nowIso(),
          endReason: "deprovisioned"
        });
      }
    }
    try {
      await mediaEngine.deprovisionStream({
        tenantId: body.tenantId,
        cameraId: body.cameraId
      });
    } catch (error) {
      request.log.warn({ err: error, tenantId: body.tenantId, cameraId: body.cameraId }, "media engine deprovision failed");
    }
    if (existing.storage.observeScratchDir) {
      await fs.rm(existing.storage.observeScratchDir, { recursive: true, force: true });
    }
    return { data: { removed: true } };
  });

  app.post("/events/clip", async (request) => {
    const body = z
      .object({
        tenantId: z.string().min(1),
        cameraId: z.string().min(1),
        eventId: z.string().min(1).optional(),
        source: z.enum(["manual", "detection", "rule"]).default("manual"),
        eventTs: z.string().datetime().optional(),
        preSeconds: z.number().int().min(0).max(120).optional(),
        postSeconds: z.number().int().min(1).max(300).optional()
      })
      .parse(request.body);
    const key = streamKey(body.tenantId, body.cameraId);
    const stream = streams.get(key);
    assertStreamReady(stream, body.tenantId, body.cameraId);
    if (!stream) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "PLAYBACK_STREAM_NOT_FOUND",
        message: "Stream is not provisioned",
        details: { tenantId: body.tenantId, cameraId: body.cameraId }
      });
    }
    if (stream.storage.recordingMode === "observe_only") {
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "EVENT_CLIP_DISABLED_IN_OBSERVE_ONLY",
        message: "Event clips are disabled for observe-only streams",
        details: { tenantId: body.tenantId, cameraId: body.cameraId }
      });
    }
    const eventTs = body.eventTs ? new Date(body.eventTs) : new Date();
    const preSeconds = body.preSeconds ?? stream.storage.eventClipPreSeconds;
    const postSeconds = body.postSeconds ?? stream.storage.eventClipPostSeconds;
    const eventId = body.eventId?.trim() || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const clip = await createEventClipFromRange({
      stream,
      eventId,
      eventTs,
      preSeconds,
      postSeconds,
      source: body.source
    });
    const entry: EventClipEntry = {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      eventId,
      source: body.source,
      eventTs: clip.eventTs,
      startedAt: clip.startedAt,
      endedAt: clip.endedAt,
      clipPath: clip.clipPath,
      clipBytes: clip.clipBytes,
      sourceSegments: clip.sourceSegments,
      createdAt: clip.createdAt
    };
    eventClips.set(eventClipKey(body.tenantId, body.cameraId, eventId), entry);
    eventClipsCreatedTotal += 1;
    eventClipsBytesTotal += entry.clipBytes;
    return {
      data: {
        ...entry,
        playbackPath: `/playback/events/${body.tenantId}/${body.cameraId}/${eventId}/index.m3u8`
      }
    };
  });

  app.get("/events/clips", async (request) => {
    const query = request.query as { tenantId?: string; cameraId?: string };
    const data = Array.from(eventClips.values())
      .filter((entry) => (query.tenantId ? entry.tenantId === query.tenantId : true))
      .filter((entry) => (query.cameraId ? entry.cameraId === query.cameraId : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((entry) => ({
        ...entry,
        playbackPath: `/playback/events/${entry.tenantId}/${entry.cameraId}/${entry.eventId}/index.m3u8`
      }));
    return { data, total: data.length };
  });

  app.get("/events/clips/:tenantId/:cameraId/:eventId", async (request) => {
    const { tenantId, cameraId, eventId } = request.params as { tenantId: string; cameraId: string; eventId: string };
    const entry = eventClips.get(eventClipKey(tenantId, cameraId, eventId)) ?? (await loadEventClipFromDisk(tenantId, cameraId, eventId));
    if (!entry) {
      throw new ApiDomainError({
        statusCode: 404,
        apiCode: "EVENT_CLIP_NOT_FOUND",
        message: "Event clip does not exist",
        details: { tenantId, cameraId, eventId }
      });
    }
    return {
      data: {
        ...entry,
        playbackPath: `/playback/events/${tenantId}/${cameraId}/${eventId}/index.m3u8`
      }
    };
  });

  app.get("/playback/:tenantId/:cameraId/index.m3u8", async (request, reply) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const query = request.query as { token?: string };
    return withPlaybackMetrics({
      tenantId,
      cameraId,
      asset: "manifest",
      handler: async () => {
        const parsed = parseAndValidatePlaybackToken({ token: query.token, tenantId, cameraId });

        const key = streamKey(tenantId, cameraId);
        const entry = streams.get(key);
        assertStreamReady(entry, tenantId, cameraId);
        upsertActiveSession({ tenantId, cameraId, sid: parsed.sid, sub: parsed.sub, exp: parsed.exp, iat: parsed.iat });

        let manifest: string;
        try {
          manifest = await readWithRetry({
            reader: () => mediaEngine.readManifest({ tenantId, cameraId }),
            tenantId,
            cameraId,
            asset: "manifest"
          });
        } catch (error) {
          if (error instanceof ApiDomainError && error.apiCode === "PLAYBACK_ASSET_TIMEOUT") {
            throw error;
          }
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "PLAYBACK_MANIFEST_NOT_FOUND",
            message: "Playback manifest is missing",
            details: { tenantId, cameraId, path: `${tenantId}/${cameraId}/index.m3u8` }
          });
        }
        const patchedManifest = rewriteManifestSegmentUris(manifest, tenantId, cameraId, query.token as string);

        reply.header("content-type", "application/vnd.apple.mpegurl");
        return patchedManifest;
      }
    });
  });

  const servePlaybackSegment = async (request: any, reply: any, segmentName: string) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const query = request.query as { token?: string };
    return withPlaybackMetrics<unknown>({
      tenantId,
      cameraId,
      asset: "segment",
      handler: async () => {
        const parsed = parseAndValidatePlaybackToken({ token: query.token, tenantId, cameraId });

        const key = streamKey(tenantId, cameraId);
        const entry = streams.get(key);
        assertStreamReady(entry, tenantId, cameraId);
        upsertActiveSession({ tenantId, cameraId, sid: parsed.sid, sub: parsed.sub, exp: parsed.exp, iat: parsed.iat });

        let segment: Buffer;
        try {
          segment = await readWithRetry({
            reader: () => mediaEngine.readSegment({ tenantId, cameraId }, segmentName),
            tenantId,
            cameraId,
            asset: "segment"
          });
        } catch (error) {
          if (error instanceof ApiDomainError && error.apiCode === "PLAYBACK_ASSET_TIMEOUT") {
            throw error;
          }
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "PLAYBACK_SEGMENT_NOT_FOUND",
            message: "Playback segment is missing",
            details: { tenantId, cameraId, path: `${tenantId}/${cameraId}/${segmentName}` }
          });
        }
        reply.header("content-type", "video/MP2T");
        return reply.send(segment);
      }
    });
  };

  app.get("/playback/:tenantId/:cameraId/segments/:segmentName", async (request, reply) => {
    const { segmentName } = request.params as { segmentName: string };
    return servePlaybackSegment(request, reply, decodeURIComponent(segmentName));
  });

  app.get("/playback/:tenantId/:cameraId/segment0.ts", async (request, reply) => {
    return servePlaybackSegment(request, reply, "segment0.ts");
  });

  app.get("/playback/events/:tenantId/:cameraId/:eventId/index.m3u8", async (request, reply) => {
    const { tenantId, cameraId, eventId } = request.params as { tenantId: string; cameraId: string; eventId: string };
    const query = request.query as { token?: string };
    return withPlaybackMetrics({
      tenantId,
      cameraId,
      asset: "manifest",
      handler: async () => {
        const parsed = parseAndValidatePlaybackToken({ token: query.token, tenantId, cameraId });
        upsertActiveSession({ tenantId, cameraId, sid: parsed.sid, sub: parsed.sub, exp: parsed.exp, iat: parsed.iat });
        const clip = eventClips.get(eventClipKey(tenantId, cameraId, eventId)) ?? (await loadEventClipFromDisk(tenantId, cameraId, eventId));
        if (!clip) {
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "EVENT_CLIP_NOT_FOUND",
            message: "Event clip does not exist",
            details: { tenantId, cameraId, eventId }
          });
        }
        const manifest = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:30",
          "#EXT-X-MEDIA-SEQUENCE:0",
          "#EXTINF:8.0,",
          `/playback/events/${tenantId}/${cameraId}/${eventId}/clip.ts?token=${encodeURIComponent(query.token as string)}`,
          "#EXT-X-ENDLIST"
        ].join("\n");
        reply.header("content-type", "application/vnd.apple.mpegurl");
        return manifest;
      }
    });
  });

  app.get("/playback/events/:tenantId/:cameraId/:eventId/clip.ts", async (request, reply) => {
    const { tenantId, cameraId, eventId } = request.params as { tenantId: string; cameraId: string; eventId: string };
    const query = request.query as { token?: string };
    return withPlaybackMetrics({
      tenantId,
      cameraId,
      asset: "segment",
      handler: async () => {
        const parsed = parseAndValidatePlaybackToken({ token: query.token, tenantId, cameraId });
        upsertActiveSession({ tenantId, cameraId, sid: parsed.sid, sub: parsed.sub, exp: parsed.exp, iat: parsed.iat });
        const clip = eventClips.get(eventClipKey(tenantId, cameraId, eventId)) ?? (await loadEventClipFromDisk(tenantId, cameraId, eventId));
        if (!clip) {
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "EVENT_CLIP_NOT_FOUND",
            message: "Event clip does not exist",
            details: { tenantId, cameraId, eventId }
          });
        }
        let payload: Buffer;
        try {
          payload = await fs.readFile(clip.clipPath);
        } catch {
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "EVENT_CLIP_NOT_FOUND",
            message: "Event clip file is missing",
            details: { tenantId, cameraId, eventId, clipPath: clip.clipPath }
          });
        }
        reply.header("content-type", "video/MP2T");
        return reply.send(payload);
      }
    });
  });

  app.get("/sessions", async (request) => {
    const q = request.query as {
      tenantId?: string;
      cameraId?: string;
      status?: SessionStatus;
      sid?: string;
    };
    const data = Array.from(streamSessions.values())
      .filter((session) => (q.tenantId ? session.tenantId === q.tenantId : true))
      .filter((session) => (q.cameraId ? session.cameraId === q.cameraId : true))
      .filter((session) => (q.status ? session.status === q.status : true))
      .filter((session) => (q.sid ? session.sid === q.sid : true))
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));

    return { data, total: data.length };
  });

  app.post("/sessions/sweep", async () => {
    return { data: sweepSessions() };
  });

  app.post("/retention/sweep", async () => {
    const summary = await runRetentionSweep("manual");
    return {
      data: summary ?? {
        reason: "manual",
        status: "disabled"
      }
    };
  });

  return app;
}
