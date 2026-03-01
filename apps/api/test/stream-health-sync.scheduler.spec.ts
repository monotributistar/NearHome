import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

let app: FastifyInstance;

const originalEnv = {
  streamGatewayUrl: process.env.STREAM_GATEWAY_URL,
  syncEnabled: process.env.STREAM_HEALTH_SYNC_ENABLED,
  syncInterval: process.env.STREAM_HEALTH_SYNC_INTERVAL_MS,
  syncBatchSize: process.env.STREAM_HEALTH_SYNC_BATCH_SIZE
};

type LoginResult = { accessToken: string };
type MeResult = { memberships: Array<{ tenantId: string }> };
type TenantListResult = { data: Array<{ id: string; name: string }> };

async function login(email: string, password = "demo1234"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "x-forwarded-for": `scheduler-${email}-${Date.now()}-${Math.random()}` },
    payload: { email, password }
  });
  expect(response.statusCode).toBe(200);
  return response.json<LoginResult>().accessToken;
}

async function me(token: string): Promise<MeResult> {
  const response = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${token}` }
  });
  expect(response.statusCode).toBe(200);
  return response.json<MeResult>();
}

async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  process.env.STREAM_GATEWAY_URL = "http://mock-stream-gateway";
  process.env.STREAM_HEALTH_SYNC_ENABLED = "1";
  process.env.STREAM_HEALTH_SYNC_INTERVAL_MS = "50";
  process.env.STREAM_HEALTH_SYNC_BATCH_SIZE = "100";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: "ready",
              health: {
                connectivity: "online",
                latencyMs: 91,
                packetLossPct: 0.1,
                jitterMs: 5,
                error: null,
                checkedAt: new Date().toISOString()
              }
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    })
  );

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  process.env.STREAM_GATEWAY_URL = originalEnv.streamGatewayUrl;
  process.env.STREAM_HEALTH_SYNC_ENABLED = originalEnv.syncEnabled;
  process.env.STREAM_HEALTH_SYNC_INTERVAL_MS = originalEnv.syncInterval;
  process.env.STREAM_HEALTH_SYNC_BATCH_SIZE = originalEnv.syncBatchSize;
});

describe("stream health scheduler", () => {
  it("syncs active camera health automatically and updates lifecycle snapshot", async () => {
    const adminToken = await login("admin@nearhome.dev");
    await me(adminToken);
    const tenantsResponse = await app.inject({
      method: "GET",
      url: "/tenants",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(tenantsResponse.statusCode).toBe(200);
    const tenantId = tenantsResponse
      .json<TenantListResult>()
      .data.find((tenant) => tenant.name === "Acme Retail")?.id;
    expect(tenantId).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      },
      payload: {
        name: `Scheduler Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/scheduler",
        isActive: true
      }
    });
    expect(created.statusCode).toBe(200);
    const cameraId = created.json<{ data: { id: string } }>().data.id;

    await waitFor(async () => {
      const lifecycle = await app.inject({
        method: "GET",
        url: `/cameras/${cameraId}/lifecycle`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId!
        }
      });
      if (lifecycle.statusCode !== 200) return false;
      const body = lifecycle.json<{
        data: { currentStatus: string; healthSnapshot: { connectivity: string } | null };
      }>();
      return body.data.currentStatus === "ready" && body.data.healthSnapshot?.connectivity === "online";
    });

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(`/health/${tenantId!}/${cameraId}`))).toBe(true);
  });
});
