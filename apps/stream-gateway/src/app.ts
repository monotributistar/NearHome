import Fastify from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

const ProvisionSchema = z.object({
  tenantId: z.string().min(1),
  cameraId: z.string().min(1),
  rtspUrl: z.string().min(4),
  transport: z.enum(["auto", "tcp", "udp"]).default("auto"),
  codecHint: z.enum(["h264", "h265", "mpeg4", "unknown"]).default("unknown"),
  targetProfiles: z.array(z.string().min(1)).default(["main"])
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
  transport: "auto" | "tcp" | "udp";
  codecHint: "h264" | "h265" | "mpeg4" | "unknown";
  targetProfiles: string[];
};

type StreamEntry = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
  source: StreamSource;
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

function cameraDir(storageDir: string, tenantId: string, cameraId: string) {
  return path.join(storageDir, tenantId, cameraId);
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

async function ensureMockPlaylist(storageDir: string, tenantId: string, cameraId: string) {
  const dir = cameraDir(storageDir, tenantId, cameraId);
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

async function readManifest(storageDir: string, tenantId: string, cameraId: string) {
  const playlistPath = path.join(cameraDir(storageDir, tenantId, cameraId), "index.m3u8");
  return fs.readFile(playlistPath, "utf8");
}

async function readSegment(storageDir: string, tenantId: string, cameraId: string) {
  const segmentPath = path.join(cameraDir(storageDir, tenantId, cameraId), "segment0.ts");
  return fs.readFile(segmentPath);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function buildApp() {
  const app = Fastify({ logger: true });
  const streams = new Map<string, StreamEntry>();
  const streamSessions = new Map<string, StreamSessionEntry>();
  const storageDir = process.env.STREAM_STORAGE_DIR ?? path.resolve(process.cwd(), "storage");
  const streamTokenSecret = process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret";
  const probeIntervalMs = Number(process.env.STREAM_PROBE_INTERVAL_MS ?? 5000);
  const sessionIdleTtlMs = Number(process.env.STREAM_SESSION_IDLE_TTL_MS ?? 60_000);
  const sessionSweepIntervalMs = Number(process.env.STREAM_SESSION_SWEEP_MS ?? 5_000);
  const playbackReadRetries = Math.max(0, Number(process.env.STREAM_PLAYBACK_READ_RETRIES ?? 0));
  const playbackReadRetryBaseMs = Math.max(0, Number(process.env.STREAM_PLAYBACK_READ_RETRY_BASE_MS ?? 25));
  const playbackReadRetryMaxMs = Math.max(playbackReadRetryBaseMs, Number(process.env.STREAM_PLAYBACK_READ_RETRY_MAX_MS ?? 250));
  let probeTimer: NodeJS.Timeout | null = null;
  let sessionSweepTimer: NodeJS.Timeout | null = null;
  let sessionSweepCount = 0;
  const playbackRequestCounters = new Map<string, number>();
  const playbackErrorCounters = new Map<string, number>();
  const playbackReadRetryCounters = new Map<string, number>();

  const metricKey = (labels: Record<string, string>) =>
    Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join("|");

  const incCounter = (store: Map<string, number>, labels: Record<string, string>) => {
    const key = metricKey(labels);
    store.set(key, (store.get(key) ?? 0) + 1);
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

  startProbeLoop();
  startSessionSweepLoop();

  app.addHook("onClose", async () => {
    stopProbeLoop();
    stopSessionSweepLoop();
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
    let attempt = 0;
    while (true) {
      try {
        return await args.reader();
      } catch (error) {
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
    try {
      const result = await args.handler();
      incCounter(playbackRequestCounters, {
        tenant_id: args.tenantId,
        camera_id: args.cameraId,
        asset: args.asset,
        result: "ok"
      });
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

  app.get("/health", async () => ({ ok: true, streams: streams.size, sessions: streamSessions.size, storageDir }));

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
      ...formatMetricLines("nearhome_playback_read_retries_total", playbackReadRetryCounters)
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

  app.post("/provision", async (request) => {
    const body = ProvisionSchema.parse(request.body);
    const key = streamKey(body.tenantId, body.cameraId);
    const source: StreamSource = {
      transport: body.transport,
      codecHint: body.codecHint,
      targetProfiles: body.targetProfiles
    };
    const existing = streams.get(key);

    if (
      existing &&
      existing.rtspUrl === body.rtspUrl &&
      existing.source.transport === source.transport &&
      existing.source.codecHint === source.codecHint &&
      JSON.stringify(existing.source.targetProfiles) === JSON.stringify(source.targetProfiles)
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
      version: existing ? existing.version + 1 : 1,
      status: "provisioning",
      health: buildHealth("degraded", "provisioning"),
      updatedAt: nowIso()
    });

    await ensureMockPlaylist(storageDir, body.tenantId, body.cameraId);

    const ready: StreamEntry = {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      source,
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
    return { data: { removed: true } };
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
            reader: () => readManifest(storageDir, tenantId, cameraId),
            tenantId,
            cameraId,
            asset: "manifest"
          });
        } catch {
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "PLAYBACK_MANIFEST_NOT_FOUND",
            message: "Playback manifest is missing",
            details: { tenantId, cameraId, path: `${tenantId}/${cameraId}/index.m3u8` }
          });
        }
        const tokenQuery = `?token=${encodeURIComponent(query.token as string)}`;
        const patchedManifest = manifest.replace("segment0.ts", `/playback/${tenantId}/${cameraId}/segment0.ts${tokenQuery}`);

        reply.header("content-type", "application/vnd.apple.mpegurl");
        return patchedManifest;
      }
    });
  });

  app.get("/playback/:tenantId/:cameraId/segment0.ts", async (request, reply) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const query = request.query as { token?: string };
    return withPlaybackMetrics({
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
            reader: () => readSegment(storageDir, tenantId, cameraId),
            tenantId,
            cameraId,
            asset: "segment"
          });
        } catch {
          throw new ApiDomainError({
            statusCode: 404,
            apiCode: "PLAYBACK_SEGMENT_NOT_FOUND",
            message: "Playback segment is missing",
            details: { tenantId, cameraId, path: `${tenantId}/${cameraId}/segment0.ts` }
          });
        }
        reply.header("content-type", "video/MP2T");
        return reply.send(segment);
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

  return app;
}
