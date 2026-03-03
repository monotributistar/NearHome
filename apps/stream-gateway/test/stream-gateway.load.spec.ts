import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
  sid: string;
  sub?: string;
  issuedAt?: Date;
}) {
  const issuedAt = args.issuedAt ?? new Date();
  const payload = {
    sub: args.sub ?? "load-user",
    tid: args.tenantId,
    cid: args.cameraId,
    sid: args.sid,
    exp: Math.floor(args.expiresAt.getTime() / 1000),
    iat: Math.floor(issuedAt.getTime() / 1000),
    v: 1 as const
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", STREAM_TOKEN_SECRET).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${signature}`;
}

async function setupApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "nearhome-stream-load-"));
  createdDirs.push(dir);
  process.env.STREAM_STORAGE_DIR = dir;
  process.env.STREAM_TOKEN_SECRET = STREAM_TOKEN_SECRET;
  process.env.STREAM_PLAYBACK_SLOW_MS = "120";
  const app = await buildApp();
  return { app };
}

afterEach(async () => {
  delete process.env.STREAM_STORAGE_DIR;
  delete process.env.STREAM_TOKEN_SECRET;
  delete process.env.STREAM_PLAYBACK_SLOW_MS;
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("stream-gateway load", () => {
  it("handles multi-tenant playback burst within error budget", async () => {
    const { app } = await setupApp();

    const tenants = ["tenant-load-a", "tenant-load-b"];
    const cameras = ["camera-1", "camera-2"];
    const requestsPerCamera = 30;

    for (const tenantId of tenants) {
      for (const cameraId of cameras) {
        const provision = await app.inject({
          method: "POST",
          url: "/provision",
          payload: { tenantId, cameraId, rtspUrl: `rtsp://demo/${tenantId}/${cameraId}` }
        });
        expect(provision.statusCode).toBe(200);
      }
    }

    const startedAt = Date.now();
    const jobs: Array<Promise<number>> = [];
    let sidCounter = 0;
    for (const tenantId of tenants) {
      for (const cameraId of cameras) {
        for (let i = 0; i < requestsPerCamera; i += 1) {
          sidCounter += 1;
          const token = createPlaybackToken({
            tenantId,
            cameraId,
            sid: `sid-load-${sidCounter}`,
            expiresAt: new Date(Date.now() + 60_000)
          });
          jobs.push(
            app
              .inject({
                method: "GET",
                url: `/playback/${tenantId}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
              })
              .then((res) => res.statusCode)
          );
        }
      }
    }

    const statuses = await Promise.all(jobs);
    const durationMs = Date.now() - startedAt;
    const errorCount = statuses.filter((status) => status !== 200).length;
    const total = statuses.length;
    const errorRate = errorCount / total;

    expect(total).toBe(tenants.length * cameras.length * requestsPerCamera);
    expect(errorCount).toBe(0);
    expect(errorRate).toBeLessThanOrEqual(0.01);
    expect(durationMs).toBeLessThan(8_000);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);

    for (const tenantId of tenants) {
      for (const cameraId of cameras) {
        expect(metrics.body).toContain(
          `nearhome_playback_requests_total{asset="manifest",camera_id="${cameraId}",result="ok",tenant_id="${tenantId}"} ${requestsPerCamera}`
        );
        expect(metrics.body).toContain(
          `nearhome_playback_latency_ms_count{asset="manifest",camera_id="${cameraId}",tenant_id="${tenantId}"} ${requestsPerCamera}`
        );
      }
    }

    await app.close();
  });
});
