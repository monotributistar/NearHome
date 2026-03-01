import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";

const createdDirs: string[] = [];

const STREAM_TOKEN_SECRET = "test-stream-secret";

function createPlaybackToken(args: { tenantId: string; cameraId: string; expiresAt: Date }) {
  const payload = {
    sub: "test-user",
    tid: args.tenantId,
    cid: args.cameraId,
    sid: "test-session",
    exp: Math.floor(args.expiresAt.getTime() / 1000),
    iat: Math.floor(Date.now() / 1000),
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
  const app = await buildApp();
  return { app, dir };
}

afterEach(async () => {
  delete process.env.STREAM_STORAGE_DIR;
  delete process.env.STREAM_TOKEN_SECRET;
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

    const expiredToken = createPlaybackToken({ tenantId, cameraId, expiresAt: new Date(Date.now() - 60_000) });
    const expiredRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(expiredToken)}`
    });
    expect(expiredRes.statusCode).toBe(401);

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
    expect(playbackRes.statusCode).toBe(404);

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

    const otherTenantToken = createPlaybackToken({ tenantId: "tenant-other", cameraId, expiresAt: new Date(Date.now() + 60_000) });
    const mismatchRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(otherTenantToken)}`
    });
    expect(mismatchRes.statusCode).toBe(401);

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
    expect(stoppedOne.statusCode).toBe(404);

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
});
