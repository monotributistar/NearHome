import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

let app: FastifyInstance;

type LoginResult = {
  accessToken: string;
};

type MeResult = {
  memberships: Array<{ tenantId: string; role: string; tenant: { name: string } }>;
};

async function login(email: string, password = "demo1234"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<LoginResult>();
  return body.accessToken;
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

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("NH-004 multi-tenant isolation", () => {
  it("rejects tenant-scoped access when X-Tenant-Id is missing", async () => {
    const token = await login("admin@nearhome.dev");

    const response = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects tenant-scoped access when user is not member of requested tenant", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const adminToken = await login("admin@nearhome.dev");

    const adminMe = await me(adminToken);
    const monitorMe = await me(monitorToken);

    const monitorTenantIds = new Set(monitorMe.memberships.map((m) => m.tenantId));
    const foreignTenant = adminMe.memberships.find((m) => !monitorTenantIds.has(m.tenantId));
    expect(foreignTenant).toBeTruthy();

    const response = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": foreignTenant!.tenantId
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("hides resources from other tenants", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const adminToken = await login("admin@nearhome.dev");

    const adminMe = await me(adminToken);
    const monitorMe = await me(monitorToken);
    const monitorTenantId = monitorMe.memberships[0]?.tenantId;
    const monitorTenantIds = new Set(monitorMe.memberships.map((m) => m.tenantId));
    const foreignTenant = adminMe.memberships.find((m) => !monitorTenantIds.has(m.tenantId));

    expect(monitorTenantId).toBeTruthy();
    expect(foreignTenant).toBeTruthy();

    const foreignList = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": foreignTenant!.tenantId
      }
    });

    expect(foreignList.statusCode).toBe(200);
    const cameraFromForeignTenant = foreignList.json<{ data: Array<{ id: string }> }>().data[0];
    expect(cameraFromForeignTenant).toBeTruthy();

    const monitorAccess = await app.inject({
      method: "GET",
      url: `/cameras/${cameraFromForeignTenant.id}`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": monitorTenantId!
      }
    });

    expect(monitorAccess.statusCode).toBe(404);
    expect(monitorAccess.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("NH-005 rbac policy", () => {
  it("allows tenant_admin to create cameras", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const response = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Test Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/test",
        location: "Lab",
        tags: ["test"],
        isActive: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { id: expect.any(String) } });
  });

  it("denies client_user camera creation", async () => {
    const clientToken = await login("client@nearhome.dev");
    const clientMe = await me(clientToken);
    const tenantId = clientMe.memberships[0].tenantId;

    const response = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: "Blocked Cam",
        rtspUrl: "rtsp://demo/blocked",
        isActive: true
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies monitor subscription changes", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const plansResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { authorization: `Bearer ${monitorToken}` }
    });
    expect(plansResponse.statusCode).toBe(200);
    const planId = plansResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(planId).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: `/tenants/${tenantId}/subscription`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        planId
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("NH-021 user administration", () => {
  it("allows tenant_admin to create users and assign tenant role", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;
    const userEmail = `user-admin-${Date.now()}@nearhome.dev`;

    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        email: userEmail,
        name: "User Admin Test",
        password: "demo1234",
        role: "client_user"
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{ data: { id: string; email: string } }>().data;
    expect(created.email).toBe(userEmail);

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });

    expect(usersResponse.statusCode).toBe(200);
    const users = usersResponse.json<{ data: Array<{ id: string; role: string }> }>().data;
    const createdInList = users.find((u) => u.id === created.id);
    expect(createdInList).toMatchObject({ role: "client_user" });
  });

  it("denies monitor user creation", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        email: `monitor-blocked-${Date.now()}@nearhome.dev`,
        name: "Blocked Monitor",
        password: "demo1234",
        role: "client_user"
      }
    });

    expect(createResponse.statusCode).toBe(403);
    expect(createResponse.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows tenant_admin to update user profile and role in active tenant", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;
    const userEmail = `user-update-${Date.now()}@nearhome.dev`;

    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        email: userEmail,
        name: "Before Update",
        password: "demo1234",
        role: "client_user"
      }
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{ data: { id: string } }>().data;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/users/${created.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: "After Update",
        isActive: false,
        role: "monitor"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        id: created.id,
        name: "After Update",
        isActive: false,
        role: "monitor"
      }
    });
  });

  it("denies monitor user updates", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const monitorToken = await login("monitor@nearhome.dev");
    const adminMe = await me(adminToken);
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        email: `user-monitor-denied-${Date.now()}@nearhome.dev`,
        name: "User Denied",
        password: "demo1234",
        role: "client_user"
      }
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{ data: { id: string } }>().data;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/users/${created.id}`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: "Should Not Update",
        role: "monitor"
      }
    });

    expect(updateResponse.statusCode).toBe(403);
    expect(updateResponse.json()).toMatchObject({ code: "FORBIDDEN" });

    const adminUsersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": adminMe.memberships[0].tenantId
      }
    });

    expect(adminUsersResponse.statusCode).toBe(200);
  });
});

describe("NH-025 camera internal profile", () => {
  it("creates internal profile automatically for active cameras", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const createResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Profile Cam ${Date.now()}`,
        description: "Camera with internal profile",
        rtspUrl: "rtsp://demo/profile",
        location: "NOC",
        tags: ["profile"],
        isActive: true
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const camera = createResponse.json<{ data: { id: string; profile?: { proxyPath: string } } }>().data;
    expect(camera.profile).toBeTruthy();
    expect(camera.profile?.proxyPath).toContain(`/proxy/live/${tenantId}/${camera.id}`);
  });

  it("allows tenant_admin to configure camera internal profile", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const listResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const cameraId = listResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/profile`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        proxyPath: `/proxy/live/${tenantId}/${cameraId}/main`,
        recordingEnabled: true,
        recordingStorageKey: `s3://nearhome/${tenantId}/recordings/${cameraId}/main`,
        detectorConfigKey: `kv://nearhome/${tenantId}/detectors/${cameraId}/config-v2.json`,
        detectorResultsKey: `s3://nearhome/${tenantId}/detectors/${cameraId}/events`,
        detectorFlags: { mediapipe: true, yolo: true, lpr: true }
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        cameraId,
        recordingEnabled: true,
        detectorFlags: { mediapipe: true, yolo: true, lpr: true }
      }
    });
  });

  it("denies monitor camera profile updates", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const listResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const cameraId = listResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/profile`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        recordingEnabled: false
      }
    });

    expect(updateResponse.statusCode).toBe(403);
    expect(updateResponse.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("marks profile as pending when configuration becomes incomplete", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const listResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const cameraId = listResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/profile`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        detectorResultsKey: "",
        status: "ready"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        cameraId,
        detectorResultsKey: "",
        configComplete: false,
        status: "pending"
      }
    });
  });
});

describe("NH-027 camera lifecycle", () => {
  it("transitions draft camera to ready through validate endpoint", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const createResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Lifecycle Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/lifecycle",
        isActive: false
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const cameraId = createResponse.json<{ data: { id: string; lifecycleStatus: string } }>().data.id;
    expect(createResponse.json<{ data: { lifecycleStatus: string } }>().data.lifecycleStatus).toBe("draft");

    const validateResponse = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/validate`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: { simulate: "pass" }
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(validateResponse.json()).toMatchObject({ data: { lifecycleStatus: "ready" } });

    const lifecycleResponse = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/lifecycle`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(lifecycleResponse.statusCode).toBe(200);
    expect(lifecycleResponse.json()).toMatchObject({
      data: {
        cameraId,
        currentStatus: "ready"
      }
    });
  });

  it("allows retire/reactivate transitions for tenant_admin and denies monitor", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const monitorToken = await login("monitor@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const listResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const cameraId = listResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const monitorRetire = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/retire`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(monitorRetire.statusCode).toBe(403);

    const adminRetire = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/retire`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(adminRetire.statusCode).toBe(200);
    expect(adminRetire.json()).toMatchObject({ data: { lifecycleStatus: "retired", isActive: false } });

    const adminReactivate = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/reactivate`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(adminReactivate.statusCode).toBe(200);
    expect(adminReactivate.json()).toMatchObject({ data: { lifecycleStatus: "draft", isActive: true } });
  });
});

describe("NH-002 login rate limit", () => {
  it("returns 429 when login attempts exceed configured limit", async () => {
    const previousMax = process.env.LOGIN_RATE_LIMIT_MAX;
    const previousWindow = process.env.LOGIN_RATE_LIMIT_WINDOW_MS;

    process.env.LOGIN_RATE_LIMIT_MAX = "3";
    process.env.LOGIN_RATE_LIMIT_WINDOW_MS = "60000";

    const throttledApp = await buildApp();
    await throttledApp.ready();

    try {
      const payload = { email: "admin@nearhome.dev", password: "wrong-password" };

      for (let i = 0; i < 3; i += 1) {
        const response = await throttledApp.inject({
          method: "POST",
          url: "/auth/login",
          payload
        });
        expect(response.statusCode).toBe(401);
      }

      const blocked = await throttledApp.inject({
        method: "POST",
        url: "/auth/login",
        payload
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    } finally {
      await throttledApp.close();
      process.env.LOGIN_RATE_LIMIT_MAX = previousMax;
      process.env.LOGIN_RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });
});
