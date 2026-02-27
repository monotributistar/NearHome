import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";

const createdDirs: string[] = [];

function createPlaybackToken(cameraId: string, expiresAt: Date) {
  return Buffer.from(`test-user:${cameraId}:test-session:${expiresAt.toISOString()}`, "utf8").toString("base64");
}

async function setupApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "nearhome-stream-"));
  createdDirs.push(dir);
  process.env.STREAM_STORAGE_DIR = dir;
  const app = await buildApp();
  return { app, dir };
}

afterEach(async () => {
  delete process.env.STREAM_STORAGE_DIR;
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

    const token = createPlaybackToken(cameraId, new Date(Date.now() + 60_000));
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

    const expiredToken = createPlaybackToken(cameraId, new Date(Date.now() - 60_000));
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

    const token = createPlaybackToken(cameraId, new Date(Date.now() + 60_000));
    const playbackRes = await app.inject({
      method: "GET",
      url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
    });
    expect(playbackRes.statusCode).toBe(404);

    await app.close();
  });
});
