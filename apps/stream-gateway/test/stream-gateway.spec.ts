import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";

const createdDirs: string[] = [];

const STREAM_TOKEN_SECRET = "test-stream-secret";

function createPlaybackToken(args: {
  tenantId: string;
  cameraId: string;
  expiresAt: Date;
  sid?: string;
  sub?: string;
  issuedAt?: Date;
}) {
  const issuedAt = args.issuedAt ?? new Date();
  const payload = {
    sub: args.sub ?? "test-user",
    tid: args.tenantId,
    cid: args.cameraId,
    sid: args.sid ?? "test-session",
    exp: Math.floor(args.expiresAt.getTime() / 1000),
    iat: Math.floor(issuedAt.getTime() / 1000),
    v: 1 as const
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", STREAM_TOKEN_SECRET).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${signature}`;
}

async function setupApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "nearhome-stream-"));
  createdDirs.push(dir);
  process.env.STREAM_STORAGE_DIR = dir;
  process.env.STREAM_TOKEN_SECRET = STREAM_TOKEN_SECRET;
  process.env.STREAM_SESSION_IDLE_TTL_MS = "1000";
  process.env.STREAM_SESSION_SWEEP_MS = "60000";
  const app = await buildApp();
  return { app, dir };
}

afterEach(async () => {
  delete process.env.STREAM_STORAGE_DIR;
  delete process.env.STREAM_TOKEN_SECRET;
  delete process.env.STREAM_SESSION_IDLE_TTL_MS;
  delete process.env.STREAM_SESSION_SWEEP_MS;
  delete process.env.STREAM_PLAYBACK_READ_RETRIES;
  delete process.env.STREAM_PLAYBACK_READ_RETRY_BASE_MS;
  delete process.env.STREAM_PLAYBACK_READ_RETRY_MAX_MS;
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("stream-gateway", () => {
  it("provisions stream and serves playback manifest + segment with token", async () => {
    const { app } = await setupApp();

    const tenantId = "tenant-a";
    const cameraId = "camera-a";
    const provisionRes = await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/camera-a" }
    });
    expect(provisionRes.statusCode).toBe(200);
    expect(provisionRes.json()).toMatchObject({
      data: {
        tenantId,
        cameraId,
        status: "ready",
        playbackPath: `/playback/${tenantId}/${cameraId}/index.m3u8`
      }
    });

    const token = createPlaybackToken({ tenantId, cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const manifestRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(manifestRes.statusCode).toBe(200);
    expect(manifestRes.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    const manifest = manifestRes.body;
    expect(manifest).toContain(`#EXTM3U`);
    expect(manifest).toContain(`/playback/${tenantId}/${cameraId}/segment0.ts?token=`);

    const segmentRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/segment0.ts?token=${encodeURIComponent(token)}`
    });
    expect(segmentRes.statusCode).toBe(200);
    expect(segmentRes.headers["content-type"]).toContain("video/MP2T");
    expect(segmentRes.body).toContain("NEARHOME_STREAM_SEGMENT");

    await app.close();
  });

  it("rejects playback when token is missing or expired", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-b";
    const cameraId = "camera-b";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/camera-b" }
    });

    const missingTokenRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8`
    });
    expect(missingTokenRes.statusCode).toBe(401);
    expect(missingTokenRes.json()).toMatchObject({
      code: "PLAYBACK_TOKEN_MISSING"
    });

    const expiredToken = createPlaybackToken({ tenantId, cameraId, expiresAt: new Date(Date.now() - 60_000) });
    const expiredRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(expiredToken)}`
    });
    expect(expiredRes.statusCode).toBe(401);
    expect(expiredRes.json()).toMatchObject({
      code: "PLAYBACK_TOKEN_EXPIRED"
    });

    await app.close();
  });

  it("deprovisions stream and stops playback availability", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-c";
    const cameraId = "camera-c";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/camera-c" }
    });

    const deprovisionRes = await app.inject({
      method: "POST",
      url: "/deprovision",
      payload: { tenantId, cameraId }
    });
    expect(deprovisionRes.statusCode).toBe(200);
    expect(deprovisionRes.json()).toEqual({ data: { removed: true } });

    const token = createPlaybackToken({ tenantId, cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const playbackRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(playbackRes.statusCode).toBe(410);
    expect(playbackRes.json()).toMatchObject({
      code: "PLAYBACK_STREAM_STOPPED"
    });

    await app.close();
  });

  it("rejects token with invalid signature or tenant mismatch", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-d";
    const cameraId = "camera-d";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/camera-d" }
    });

    const valid = createPlaybackToken({ tenantId, cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const tampered = `${valid.slice(0, -1)}x`;
    const tamperedRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(tampered)}`
    });
    expect(tamperedRes.statusCode).toBe(401);
    expect(tamperedRes.json()).toMatchObject({
      code: "PLAYBACK_TOKEN_SIGNATURE_INVALID"
    });

    const otherTenantToken = createPlaybackToken({ tenantId: "tenant-other", cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const mismatchRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(otherTenantToken)}`
    });
    expect(mismatchRes.statusCode).toBe(403);
    expect(mismatchRes.json()).toMatchObject({
      code: "PLAYBACK_TOKEN_SCOPE_MISMATCH"
    });

    const malformedRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=invalid-format`
    });
    expect(malformedRes.statusCode).toBe(401);
    expect(malformedRes.json()).toMatchObject({
      code: "PLAYBACK_TOKEN_FORMAT_INVALID"
    });

    await app.close();
  });

  it("exposes stream status metrics", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-metrics";
    const cameraId = "camera-metrics";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/camera-metrics" }
    });

    const metricsRes = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.headers["content-type"]).toContain("text/plain");
    expect(metricsRes.body).toContain("nearhome_streams_total{status=\"ready\"} 1");

    await app.close();
  });

  it("isolates same cameraId across different tenants without collisions", async () => {
    const { app } = await setupApp();
    const cameraId = "shared-camera";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId: "tenant-one", cameraId, rtspUrl: "rtsp://demo/tenant-one/shared-camera" }
    });
    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId: "tenant-two", cameraId, rtspUrl: "rtsp://demo/tenant-two/shared-camera" }
    });

    const healthOne = await app.inject({ method: "GET", url: "/health/tenant-one/shared-camera" });
    const healthTwo = await app.inject({ method: "GET", url: "/health/tenant-two/shared-camera" });
    expect(healthOne.statusCode).toBe(200);
    expect(healthTwo.statusCode).toBe(200);
    expect(healthOne.json<{ data: { rtspUrl: string } }>().data.rtspUrl).toContain("tenant-one");
    expect(healthTwo.json<{ data: { rtspUrl: string } }>().data.rtspUrl).toContain("tenant-two");

    await app.inject({
      method: "POST",
      url: "/deprovision",
      payload: { tenantId: "tenant-one", cameraId }
    });

    const tokenTwo = createPlaybackToken({ tenantId: "tenant-two", cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const stillPlayableTwo = await app.inject({
      method: "GET",
      url: `/playback/tenant-two/${cameraId}/index.m3u8?token=${encodeURIComponent(tokenTwo)}`
    });
    expect(stillPlayableTwo.statusCode).toBe(200);

    const tokenOne = createPlaybackToken({ tenantId: "tenant-one", cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const stoppedOne = await app.inject({
      method: "GET",
      url: `/playback/tenant-one/${cameraId}/index.m3u8?token=${encodeURIComponent(tokenOne)}`
    });
    expect(stoppedOne.statusCode).toBe(410);
    expect(stoppedOne.json()).toMatchObject({
      code: "PLAYBACK_STREAM_STOPPED"
    });

    await app.close();
  });

  it("returns clear validation and not-found error shapes", async () => {
    const { app } = await setupApp();

    const invalidProvision = await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId: "", cameraId: "x", rtspUrl: "bad" }
    });
    expect(invalidProvision.statusCode).toBe(400);
    expect(invalidProvision.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      details: expect.any(Object)
    });

    const notFoundRoute = await app.inject({
      method: "GET",
      url: "/missing-route"
    });
    expect(notFoundRoute.statusCode).toBe(404);
    expect(notFoundRoute.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Route not found"
    });

    await app.close();
  });

  it("supports idempotent reprovision and source profile updates", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-reprovision";
    const cameraId = "camera-reprovision";

    const first = await app.inject({
      method: "POST",
      url: "/provision",
      payload: {
        tenantId,
        cameraId,
        rtspUrl: "rtsp://demo/reprovision",
        transport: "tcp",
        codecHint: "h264",
        targetProfiles: ["main", "sub"]
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      data: {
        version: 1,
        reprovisioned: true,
        source: {
          transport: "tcp",
          codecHint: "h264",
          targetProfiles: ["main", "sub"]
        }
      }
    });

    const second = await app.inject({
      method: "POST",
      url: "/provision",
      payload: {
        tenantId,
        cameraId,
        rtspUrl: "rtsp://demo/reprovision",
        transport: "tcp",
        codecHint: "h264",
        targetProfiles: ["main", "sub"]
      }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      data: {
        version: 1,
        reprovisioned: false
      }
    });

    const third = await app.inject({
      method: "POST",
      url: "/provision",
      payload: {
        tenantId,
        cameraId,
        rtspUrl: "rtsp://demo/reprovision-v2",
        transport: "udp",
        codecHint: "h265",
        targetProfiles: ["low", "main"]
      }
    });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({
      data: {
        version: 2,
        reprovisioned: true,
        rtspUrl: "rtsp://demo/reprovision-v2",
        source: {
          transport: "udp",
          codecHint: "h265",
          targetProfiles: ["low", "main"]
        }
      }
    });

    await app.close();
  });

  it("tracks playback sessions by sid and expires them deterministically", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-sessions";
    const cameraId = "camera-sessions";
    const sid = "sid-expire-1";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/sessions" }
    });

    const token = createPlaybackToken({
      tenantId,
      cameraId,
      sid,
      expiresAt: new Date(Date.now() + 1_000)
    });
    const playback = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(playback.statusCode).toBe(200);

    const listActive = await app.inject({
      method: "GET",
      url: `/sessions?tenantId=${tenantId}&cameraId=${cameraId}&sid=${sid}`
    });
    expect(listActive.statusCode).toBe(200);
    expect(listActive.json()).toMatchObject({
      total: 1,
      data: [
        {
          sid,
          tenantId,
          cameraId,
          status: "active"
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const sweep = await app.inject({
      method: "POST",
      url: "/sessions/sweep"
    });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json<{ data: { expired: number; ended: number } }>().data.expired).toBe(1);

    const sessionsExpired = await app.inject({
      method: "GET",
      url: `/sessions?tenantId=${tenantId}&cameraId=${cameraId}`
    });
    expect(sessionsExpired.statusCode).toBe(200);
    const body = sessionsExpired.json<{ data: Array<{ sid: string; status: string }> }>();
    expect(body.data.some((session) => session.sid === sid && session.status === "expired")).toBe(true);

    await app.close();
  });

  it("closes active sessions when camera is deprovisioned and reports in metrics", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-session-close";
    const cameraId = "camera-session-close";
    const sid = "sid-close-1";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/session-close" }
    });

    const token = createPlaybackToken({
      tenantId,
      cameraId,
      sid,
      expiresAt: new Date(Date.now() + 60_000)
    });
    const playback = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(playback.statusCode).toBe(200);

    const deprovision = await app.inject({
      method: "POST",
      url: "/deprovision",
      payload: { tenantId, cameraId }
    });
    expect(deprovision.statusCode).toBe(200);

    const sessions = await app.inject({
      method: "GET",
      url: `/sessions?tenantId=${tenantId}&cameraId=${cameraId}&sid=${sid}`
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({
      total: 1,
      data: [
        {
          sid,
          status: "ended",
          endReason: "deprovisioned"
        }
      ]
    });

    const metrics = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("nearhome_stream_sessions_total{status=\"ended\"} 1");

    await app.close();
  });

  it("rejects playback for a previously closed session even when stream is ready", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-session-ended";
    const cameraId = "camera-session-ended";
    const sid = "sid-ended-1";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/session-ended" }
    });

    const token = createPlaybackToken({
      tenantId,
      cameraId,
      sid,
      expiresAt: new Date(Date.now() + 60_000)
    });
    const firstPlayback = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(firstPlayback.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await app.inject({ method: "POST", url: "/sessions/sweep" });

    const secondPlayback = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(secondPlayback.statusCode).toBe(401);
    expect(secondPlayback.json()).toMatchObject({
      code: "PLAYBACK_SESSION_CLOSED"
    });

    await app.close();
  });

  it("returns clear errors when playback assets are missing", async () => {
    const { app, dir } = await setupApp();
    const tenantId = "tenant-missing-assets";
    const cameraId = "camera-missing-assets";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/missing-assets" }
    });

    const token = createPlaybackToken({
      tenantId,
      cameraId,
      sid: "sid-assets",
      expiresAt: new Date(Date.now() + 60_000)
    });

    await rm(path.join(dir, tenantId, cameraId, "segment0.ts"), { force: true });
    const segmentRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/segment0.ts?token=${encodeURIComponent(token)}`
    });
    expect(segmentRes.statusCode).toBe(404);
    expect(segmentRes.json()).toMatchObject({
      code: "PLAYBACK_SEGMENT_NOT_FOUND"
    });

    await rm(path.join(dir, tenantId, cameraId, "index.m3u8"), { force: true });
    const manifestRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(manifestRes.statusCode).toBe(404);
    expect(manifestRes.json()).toMatchObject({
      code: "PLAYBACK_MANIFEST_NOT_FOUND"
    });

    await app.close();
  });

  it("retries manifest read on transient miss and serves playback once asset appears", async () => {
    process.env.STREAM_PLAYBACK_READ_RETRIES = "3";
    process.env.STREAM_PLAYBACK_READ_RETRY_BASE_MS = "10";
    const { app, dir } = await setupApp();
    const tenantId = "tenant-retry";
    const cameraId = "camera-retry";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/retry" }
    });

    const token = createPlaybackToken({
      tenantId,
      cameraId,
      sid: "sid-retry",
      expiresAt: new Date(Date.now() + 60_000)
    });

    const manifestPath = path.join(dir, tenantId, cameraId, "index.m3u8");
    await rm(manifestPath, { force: true });
    setTimeout(async () => {
      await writeFile(manifestPath, "#EXTM3U\n#EXT-X-ENDLIST", "utf8");
    }, 5);

    const manifestRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(manifestRes.statusCode).toBe(200);
    expect(manifestRes.body).toContain("#EXTM3U");

    const metricsRes = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain(
      `nearhome_playback_read_retries_total{asset=\"manifest\",camera_id=\"${cameraId}\",tenant_id=\"${tenantId}\"} 1`
    );

    await app.close();
  });

  it("exposes per-tenant playback error metrics", async () => {
    const { app } = await setupApp();
    const tenantId = "tenant-playback-metrics";
    const cameraId = "camera-playback-metrics";

    await app.inject({
      method: "POST",
      url: "/provision",
      payload: { tenantId, cameraId, rtspUrl: "rtsp://demo/playback-metrics" }
    });

    const missingToken = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8`
    });
    expect(missingToken.statusCode).toBe(401);

    const malformed = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/segment0.ts?token=invalid-format`
    });
    expect(malformed.statusCode).toBe(401);

    const metricsRes = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain(
      `nearhome_playback_requests_total{asset=\"manifest\",camera_id=\"${cameraId}\",result=\"error\",tenant_id=\"${tenantId}\"} 1`
    );
    expect(metricsRes.body).toContain(
      `nearhome_playback_requests_total{asset=\"segment\",camera_id=\"${cameraId}\",result=\"error\",tenant_id=\"${tenantId}\"} 1`
    );
    expect(metricsRes.body).toContain(
      `nearhome_playback_errors_total{asset=\"manifest\",camera_id=\"${cameraId}\",code=\"PLAYBACK_TOKEN_MISSING\",tenant_id=\"${tenantId}\"} 1`
    );
    expect(metricsRes.body).toContain(
      `nearhome_playback_errors_total{asset=\"segment\",camera_id=\"${cameraId}\",code=\"PLAYBACK_TOKEN_FORMAT_INVALID\",tenant_id=\"${tenantId}\"} 1`
    );

    await app.close();
  });
});
