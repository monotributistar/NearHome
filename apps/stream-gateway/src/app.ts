import Fastify from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

const ProvisionSchema = z.object({
  tenantId: z.string().min(1),
  cameraId: z.string().min(1),
  rtspUrl: z.string().min(4)
});

type StreamStatus = "provisioning" | "ready" | "stopped";

type StreamEntry = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
  status: StreamStatus;
  updatedAt: string;
};

function streamKey(tenantId: string, cameraId: string) {
  return `${tenantId}:${cameraId}`;
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

function verifyToken(token: string, secret: string) {
  const [payloadBase64, signatureBase64] = token.split(".");
  if (!payloadBase64 || !signatureBase64) return null;

  const expectedSignature = createHmac("sha256", secret).update(payloadBase64).digest("base64url");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  const providedBytes = Buffer.from(signatureBase64, "utf8");
  if (expectedBytes.length !== providedBytes.length) return null;
  if (!timingSafeEqual(expectedBytes, providedBytes)) return null;

  try {
    const decodedPayload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    const parsed = StreamPlaybackTokenSchema.safeParse(decodedPayload);
    if (!parsed.success) return null;
    if (parsed.data.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed.data;
  } catch {
    return null;
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

export async function buildApp() {
  const app = Fastify({ logger: true });
  const streams = new Map<string, StreamEntry>();
  const storageDir = process.env.STREAM_STORAGE_DIR ?? path.resolve(process.cwd(), "storage");
  const streamTokenSecret = process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret";

  app.get("/health", async () => ({ ok: true, streams: streams.size, storageDir }));

  app.get("/metrics", async (_request, reply) => {
    const counters = {
      provisioning: 0,
      ready: 0,
      stopped: 0
    };
    for (const entry of streams.values()) {
      counters[entry.status] += 1;
    }

    const lines = [
      "# HELP nearhome_streams_total Number of known streams by status",
      "# TYPE nearhome_streams_total gauge",
      `nearhome_streams_total{status=\"provisioning\"} ${counters.provisioning}`,
      `nearhome_streams_total{status=\"ready\"} ${counters.ready}`,
      `nearhome_streams_total{status=\"stopped\"} ${counters.stopped}`
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

    streams.set(key, {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      status: "provisioning",
      updatedAt: new Date().toISOString()
    });

    await ensureMockPlaylist(storageDir, body.tenantId, body.cameraId);

    const ready: StreamEntry = {
      tenantId: body.tenantId,
      cameraId: body.cameraId,
      rtspUrl: body.rtspUrl,
      status: "ready",
      updatedAt: new Date().toISOString()
    };

    streams.set(key, ready);

    return {
      data: {
        ...ready,
        playbackPath: `/playback/${body.tenantId}/${body.cameraId}/index.m3u8`
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
    streams.set(key, { ...existing, status: "stopped", updatedAt: new Date().toISOString() });
    return { data: { removed: true } };
  });

  app.get("/playback/:tenantId/:cameraId/index.m3u8", async (request, reply) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const query = request.query as { token?: string };

    if (!query.token) {
      reply.status(401);
      return { code: "UNAUTHORIZED", message: "Missing playback token" };
    }

    const parsed = verifyToken(query.token, streamTokenSecret);
    if (!parsed || parsed.cid !== cameraId || parsed.tid !== tenantId) {
      reply.status(401);
      return { code: "UNAUTHORIZED", message: "Invalid or expired playback token" };
    }

    const key = streamKey(tenantId, cameraId);
    const entry = streams.get(key);
    if (!entry || entry.status !== "ready") {
      reply.status(404);
      return { code: "NOT_FOUND", message: "Stream not provisioned" };
    }

    const manifest = await readManifest(storageDir, tenantId, cameraId);
    const tokenQuery = `?token=${encodeURIComponent(query.token)}`;
    const patchedManifest = manifest.replace("segment0.ts", `/playback/${tenantId}/${cameraId}/segment0.ts${tokenQuery}`);

    reply.header("content-type", "application/vnd.apple.mpegurl");
    return patchedManifest;
  });

  app.get("/playback/:tenantId/:cameraId/segment0.ts", async (request, reply) => {
    const { tenantId, cameraId } = request.params as { tenantId: string; cameraId: string };
    const query = request.query as { token?: string };

    if (!query.token) {
      reply.status(401);
      return { code: "UNAUTHORIZED", message: "Missing playback token" };
    }

    const parsed = verifyToken(query.token, streamTokenSecret);
    if (!parsed || parsed.cid !== cameraId || parsed.tid !== tenantId) {
      reply.status(401);
      return { code: "UNAUTHORIZED", message: "Invalid or expired playback token" };
    }

    const key = streamKey(tenantId, cameraId);
    const entry = streams.get(key);
    if (!entry || entry.status !== "ready") {
      reply.status(404);
      return { code: "NOT_FOUND", message: "Stream not provisioned" };
    }

    const segment = await readSegment(storageDir, tenantId, cameraId);
    reply.header("content-type", "video/MP2T");
    return reply.send(segment);
  });

  return app;
}
