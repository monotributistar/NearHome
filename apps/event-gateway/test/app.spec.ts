import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("event-gateway publish and replay", () => {
  afterEach(() => {
    delete process.env.EVENT_PUBLISH_SECRET;
  });

  it("rejects publish when secret is missing or invalid", async () => {
    process.env.EVENT_PUBLISH_SECRET = "test-secret";
    const app = await buildApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/internal/events/publish",
        payload: {
          eventType: "detection.job",
          tenantId: "tenant-a",
          payload: { jobId: "job-1" }
        }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("publishes event and replays it via SSE", async () => {
    process.env.EVENT_PUBLISH_SECRET = "test-secret";
    const app = await buildApp();
    await app.ready();
    try {
      const publishResponse = await app.inject({
        method: "POST",
        url: "/internal/events/publish",
        headers: { "x-event-publish-secret": "test-secret" },
        payload: {
          eventType: "detection.job",
          tenantId: "tenant-a",
          payload: { jobId: "job-1", status: "succeeded" }
        }
      });
      expect(publishResponse.statusCode).toBe(202);
      expect(publishResponse.json<{ data: { eventType: string; tenantId: string } }>().data).toMatchObject({
        eventType: "detection.job",
        tenantId: "tenant-a"
      });

      const sseResponse = await app.inject({
        method: "GET",
        url: "/events/stream?replay=1&topics=detection&once=1",
        headers: {
          "x-tenant-id": "tenant-a"
        }
      });
      expect(sseResponse.statusCode).toBe(200);
      const body = sseResponse.body;
      expect(body).toContain("event: detection.job");
      expect(body).toContain('"jobId":"job-1"');
    } finally {
      await app.close();
    }
  });
});
