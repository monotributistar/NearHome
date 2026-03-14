import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app";
import { seedFixtures } from "../prisma/seed-fixtures.js";
import {
  clearDetectionStateForCamera,
  getSeedDetectionJobsFixture,
  getSeedDetectionTopologyFixture,
  getSeedDetectionValidationFixture,
  getSeedFacesFixture
} from "./seed-test-helpers";

let app: FastifyInstance;
const prisma = new PrismaClient();

type LoginResult = {
  accessToken: string;
};

type MeResult = {
  memberships: Array<{ tenantId: string; role: string; tenant: { name: string } }>;
};

type UserListResult = {
  data: Array<{ id: string; email: string }>;
};

async function login(email: string, password = "demo1234"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "x-forwarded-for": `test-${email}-${Date.now()}-${Math.random()}` },
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

async function createTenant(adminToken: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/tenants",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { id: string } }>().data.id;
}

async function listUsers(adminToken: string, tenantId: string): Promise<UserListResult["data"]> {
  const response = await app.inject({
    method: "GET",
    url: "/users",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "x-tenant-id": tenantId
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json<UserListResult>().data;
}

async function addMembership(adminToken: string, tenantId: string, userId: string, role: string) {
  const response = await app.inject({
    method: "POST",
    url: "/memberships",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { tenantId, userId, role }
  });
  expect(response.statusCode).toBe(200);
}

async function createTenantFixture(
  adminToken: string,
  name: string,
  memberships: Array<{ email: string; role: string }> = []
): Promise<{ tenantId: string }> {
  const tenantId = await createTenant(adminToken, name);
  if (memberships.length === 0) {
    return { tenantId };
  }

  const adminMe = await me(adminToken);
  const lookupTenantId = adminMe.memberships[0]!.tenantId;
  const users = await listUsers(adminToken, lookupTenantId);

  for (const membership of memberships) {
    const user = users.find((entry) => entry.email === membership.email);
    expect(user).toBeTruthy();
    await addMembership(adminToken, tenantId, user!.id, membership.role);
  }

  return { tenantId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
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
    const { tenantId } = await createTenantFixture(adminToken, `NH005 Admin ${Date.now()}`);

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

  it("allows client_user camera creation", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH005 Client ${Date.now()}`, [
      { email: "client@nearhome.dev", role: "customer" }
    ]);
    const clientToken = await login("client@nearhome.dev");

    const response = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Client Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/client",
        isActive: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { id: expect.any(String) } });
  });

  it("denies monitor camera creation", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const response = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Blocked Cam ${Date.now()}`,
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

describe("NH-029 tenant administration", () => {
  it("allows tenant_admin to create, update and soft-delete tenant", async () => {
    const adminToken = await login("admin@nearhome.dev");

    const createResponse = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        name: `Tenant E2E ${Date.now()}`
      }
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{ data: { id: string; name: string } }>().data;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/tenants/${created.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        name: `${created.name} Updated`
      }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        id: created.id,
        name: `${created.name} Updated`
      }
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/tenants/${created.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    expect(deleteResponse.statusCode).toBe(200);

    const listResponse = await app.inject({
      method: "GET",
      url: "/tenants",
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const tenants = listResponse.json<{ data: Array<{ id: string }> }>().data;
    expect(tenants.some((t) => t.id === created.id)).toBe(false);
  });

  it("denies monitor tenant deletion", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const response = await app.inject({
      method: "DELETE",
      url: `/tenants/${tenantId}`,
      headers: {
        authorization: `Bearer ${monitorToken}`
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("NH-030 monitor tenant-scoped camera visibility", () => {
  it("allows monitor to view cameras only for tenants where it has membership", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const monitorUserId = monitorMe.memberships[0].userId;
    const monitorPrimaryTenantId = monitorMe.memberships[0].tenantId;

    const createdTenantResponse = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        name: `Monitor Scoped Tenant ${Date.now()}`
      }
    });
    expect(createdTenantResponse.statusCode).toBe(200);
    const scopedTenantId = createdTenantResponse.json<{ data: { id: string } }>().data.id;

    const assignMembershipResponse = await app.inject({
      method: "POST",
      url: "/memberships",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": scopedTenantId
      },
      payload: {
        userId: monitorUserId,
        role: "monitor"
      }
    });
    expect(assignMembershipResponse.statusCode).toBe(200);

    const cameraName = `Scoped Cam ${Date.now()}`;
    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": scopedTenantId
      },
      payload: {
        name: cameraName,
        rtspUrl: "rtsp://demo/scoped-monitor",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const scopedCameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

    const listScopedTenantResponse = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": scopedTenantId
      }
    });
    expect(listScopedTenantResponse.statusCode).toBe(200);
    const scopedCameras = listScopedTenantResponse.json<{ data: Array<{ id: string; name: string }> }>().data;
    expect(scopedCameras.some((camera) => camera.id === scopedCameraId)).toBe(true);

    const listPrimaryTenantResponse = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": monitorPrimaryTenantId
      }
    });
    expect(listPrimaryTenantResponse.statusCode).toBe(200);
    const primaryCameras = listPrimaryTenantResponse.json<{ data: Array<{ id: string; name: string }> }>().data;
    expect(primaryCameras.some((camera) => camera.id === scopedCameraId)).toBe(false);
  });
});

describe("NH-039 operator camera zoning", () => {
  it("keeps default full visibility and applies camera allowlist when assignments exist", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH039 ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(usersResponse.statusCode).toBe(200);
    const monitorUser = usersResponse
      .json<{ data: Array<{ id: string; email: string }> }>()
      .data.find((user) => user.email === "monitor@nearhome.dev");
    expect(monitorUser).toBeTruthy();

    const cameraAResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Zoning Cam A ${Date.now()}`,
        rtspUrl: "rtsp://demo/zoning-a",
        location: "Zone A",
        tags: ["zoning"],
        isActive: false
      }
    });
    expect(cameraAResponse.statusCode).toBe(200);
    const cameraAId = cameraAResponse.json<{ data: { id: string } }>().data.id;

    const cameraBResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Zoning Cam B ${Date.now()}`,
        rtspUrl: "rtsp://demo/zoning-b",
        location: "Zone B",
        tags: ["zoning"],
        isActive: false
      }
    });
    expect(cameraBResponse.statusCode).toBe(200);
    const cameraBId = cameraBResponse.json<{ data: { id: string } }>().data.id;

    const clearScopeResponse = await app.inject({
      method: "PUT",
      url: `/camera-assignments/${monitorUser!.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraIds: []
      }
    });
    expect(clearScopeResponse.statusCode).toBe(200);

    const listBeforeScope = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listBeforeScope.statusCode).toBe(200);
    const beforeIds = new Set(listBeforeScope.json<{ data: Array<{ id: string }> }>().data.map((camera) => camera.id));
    expect(beforeIds.has(cameraAId)).toBe(true);
    expect(beforeIds.has(cameraBId)).toBe(true);

    const scopeResponse = await app.inject({
      method: "PUT",
      url: `/camera-assignments/${monitorUser!.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraIds: [cameraAId]
      }
    });
    expect(scopeResponse.statusCode).toBe(200);

    const listAfterScope = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listAfterScope.statusCode).toBe(200);
    const afterIds = new Set(listAfterScope.json<{ data: Array<{ id: string }> }>().data.map((camera) => camera.id));
    expect(afterIds.has(cameraAId)).toBe(true);
    expect(afterIds.has(cameraBId)).toBe(false);

    const hiddenCamera = await app.inject({
      method: "GET",
      url: `/cameras/${cameraBId}`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(hiddenCamera.statusCode).toBe(404);
  });
});

describe("NH-035 superadmin context switch + impersonation audit", () => {
  it("restricts actions when superadmin impersonates monitor", async () => {
    const adminToken = await login("admin@nearhome.dev");

    const createTenantResponse = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `Tenant NH035 ${Date.now()}` }
    });
    expect(createTenantResponse.statusCode).toBe(200);
    const tenantId = createTenantResponse.json<{ data: { id: string } }>().data.id;

    const meImpersonated = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId,
        "x-impersonate-role": "monitor"
      }
    });
    expect(meImpersonated.statusCode).toBe(200);
    expect(meImpersonated.json()).toMatchObject({
      context: {
        tenantId,
        effectiveRole: "monitor",
        isImpersonating: true,
        impersonatedRole: "monitor"
      }
    });

    const createAsMonitorContext = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId,
        "x-impersonate-role": "monitor"
      },
      payload: {
        name: `NH035 Blocked Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh035-blocked",
        isActive: false
      }
    });
    expect(createAsMonitorContext.statusCode).toBe(403);

    const createAsGlobalSuperadmin = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH035 Allowed Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh035-allowed",
        isActive: false
      }
    });
    expect(createAsGlobalSuperadmin.statusCode).toBe(200);
  });

  it("stores real actor and impersonated context in audit logs", async () => {
    const adminToken = await login("admin@nearhome.dev");

    const createTenantResponse = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `Tenant NH035 Audit ${Date.now()}` }
    });
    expect(createTenantResponse.statusCode).toBe(200);
    const tenantId = createTenantResponse.json<{ data: { id: string } }>().data.id;

    const meResponse = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId,
        "x-impersonate-role": "tenant_admin"
      }
    });
    expect(meResponse.statusCode).toBe(200);
    const actorUserId = meResponse.json<{ user: { id: string } }>().user.id;

    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId,
        "x-impersonate-role": "tenant_admin"
      },
      payload: {
        name: `NH035 Audit Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh035-audit",
        isActive: false
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

    const logsResponse = await app.inject({
      method: "GET",
      url: "/audit-logs?_start=0&_end=50",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId,
        "x-impersonate-role": "tenant_admin"
      }
    });
    expect(logsResponse.statusCode).toBe(200);
    const logs = logsResponse.json<{ data: Array<{ actorUserId: string; resource: string; action: string; resourceId: string; payload: any }> }>().data;
    const cameraCreateLog = logs.find((entry) => entry.resource === "camera" && entry.action === "create" && entry.resourceId === cameraId);
    expect(cameraCreateLog).toBeTruthy();
    expect(cameraCreateLog?.actorUserId).toBe(actorUserId);
    expect(cameraCreateLog?.payload?._auth).toMatchObject({
      actorUserId,
      effectiveRole: "tenant_admin",
      isImpersonating: true,
      impersonatedRole: "tenant_admin",
      tenantId
    });
  });
});

describe("NH-036 memberships N:M operator/customer", () => {
  it("allows operator membership across tenants and enforces tenant-scoped access", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const acmeTenant = adminMe.memberships.find((m) => m.tenant.name === "Acme Retail");
    const betaTenant = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(acmeTenant).toBeTruthy();
    expect(betaTenant).toBeTruthy();

    const createForeignTenant = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: { name: `Tenant NH036 Operator Foreign ${Date.now()}` }
    });
    expect(createForeignTenant.statusCode).toBe(200);
    const foreignTenantId = createForeignTenant.json<{ data: { id: string } }>().data.id;

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      }
    });
    expect(usersResponse.statusCode).toBe(200);
    const monitorUser = usersResponse
      .json<{ data: Array<{ id: string; email: string }> }>()
      .data.find((row) => row.email === "monitor@nearhome.dev");
    expect(monitorUser).toBeTruthy();

    const addBetaMembership = await app.inject({
      method: "POST",
      url: "/memberships",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        tenantId: betaTenant!.tenantId,
        userId: monitorUser!.id,
        role: "operator"
      }
    });
    expect(addBetaMembership.statusCode).toBe(200);

    const monitorToken = await login("monitor@nearhome.dev");

    const accessPrimaryTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      }
    });
    expect(accessPrimaryTenant.statusCode).toBe(200);

    const accessSecondaryTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": betaTenant!.tenantId
      }
    });
    expect(accessSecondaryTenant.statusCode).toBe(200);

    const accessForeignTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": foreignTenantId
      }
    });
    expect(accessForeignTenant.statusCode).toBe(403);
  });

  it("allows customer membership across tenants and blocks access outside memberships", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const acmeTenant = adminMe.memberships.find((m) => m.tenant.name === "Acme Retail");
    const betaTenant = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(acmeTenant).toBeTruthy();
    expect(betaTenant).toBeTruthy();

    const createForeignTenant = await app.inject({
      method: "POST",
      url: "/tenants",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: { name: `Tenant NH036 Customer Foreign ${Date.now()}` }
    });
    expect(createForeignTenant.statusCode).toBe(200);
    const foreignTenantId = createForeignTenant.json<{ data: { id: string } }>().data.id;

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      }
    });
    expect(usersResponse.statusCode).toBe(200);
    const clientUser = usersResponse
      .json<{ data: Array<{ id: string; email: string }> }>()
      .data.find((row) => row.email === "client@nearhome.dev");
    expect(clientUser).toBeTruthy();

    const addBetaMembership = await app.inject({
      method: "POST",
      url: "/memberships",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        tenantId: betaTenant!.tenantId,
        userId: clientUser!.id,
        role: "customer"
      }
    });
    expect(addBetaMembership.statusCode).toBe(200);
    expect(addBetaMembership.json()).toMatchObject({
      data: {
        tenantId: betaTenant!.tenantId,
        userId: clientUser!.id,
        role: "client_user"
      }
    });

    const clientToken = await login("client@nearhome.dev");

    const accessPrimaryTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      }
    });
    expect(accessPrimaryTenant.statusCode).toBe(200);

    const accessSecondaryTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": betaTenant!.tenantId
      }
    });
    expect(accessSecondaryTenant.statusCode).toBe(200);

    const accessForeignTenant = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=10",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": foreignTenantId
      }
    });
    expect(accessForeignTenant.statusCode).toBe(403);
  });
});

describe("NH-037 role and memberships management", () => {
  it("allows super_admin to change user roles in different tenants", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const acmeTenant = adminMe.memberships.find((m) => m.tenant.name === "Acme Retail");
    const betaTenant = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(acmeTenant).toBeTruthy();
    expect(betaTenant).toBeTruthy();

    const userEmail = `nh037-global-${Date.now()}@nearhome.dev`;
    const createInAcme = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      },
      payload: {
        email: userEmail,
        name: "NH037 Global User",
        password: "demo1234",
        role: "customer"
      }
    });
    expect(createInAcme.statusCode).toBe(200);
    const userId = createInAcme.json<{ data: { id: string } }>().data.id;

    const addMembershipInBeta = await app.inject({
      method: "POST",
      url: "/memberships",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        tenantId: betaTenant!.tenantId,
        userId,
        role: "customer"
      }
    });
    expect(addMembershipInBeta.statusCode).toBe(200);

    const updateRoleInBeta = await app.inject({
      method: "PUT",
      url: `/users/${userId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": betaTenant!.tenantId
      },
      payload: {
        role: "operator"
      }
    });
    expect(updateRoleInBeta.statusCode).toBe(200);
    expect(updateRoleInBeta.json()).toMatchObject({
      data: {
        id: userId,
        role: "monitor"
      }
    });
  });

  it("restricts tenant_admin to manage users only inside own tenant", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const acmeTenant = adminMe.memberships.find((m) => m.tenant.name === "Acme Retail");
    const betaTenant = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(acmeTenant).toBeTruthy();
    expect(betaTenant).toBeTruthy();

    const tenantAdminEmail = `nh037-tenant-admin-${Date.now()}@nearhome.dev`;
    const createTenantAdmin = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      },
      payload: {
        email: tenantAdminEmail,
        name: "NH037 Tenant Admin",
        password: "demo1234",
        role: "tenant_admin"
      }
    });
    expect(createTenantAdmin.statusCode).toBe(200);

    const betaUserEmail = `nh037-beta-user-${Date.now()}@nearhome.dev`;
    const createBetaUser = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": betaTenant!.tenantId
      },
      payload: {
        email: betaUserEmail,
        name: "NH037 Beta User",
        password: "demo1234",
        role: "client_user"
      }
    });
    expect(createBetaUser.statusCode).toBe(200);
    const betaUserId = createBetaUser.json<{ data: { id: string } }>().data.id;

    const tenantAdminToken = await login(tenantAdminEmail);
    const updateOutsideTenant = await app.inject({
      method: "PUT",
      url: `/users/${betaUserId}`,
      headers: {
        authorization: `Bearer ${tenantAdminToken}`,
        "x-tenant-id": betaTenant!.tenantId
      },
      payload: {
        role: "operator"
      }
    });
    expect(updateOutsideTenant.statusCode).toBe(403);
  });
});

describe("NH-040 customer households and members", () => {
  it("allows client_user to manage households and members in active tenant", async () => {
    const clientToken = await login("client@nearhome.dev");
    const clientMe = await me(clientToken);
    const tenantId = clientMe.memberships[0].tenantId;

    const createHousehold = await app.inject({
      method: "POST",
      url: "/households",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Casa NH040 ${Date.now()}`,
        address: "Calle Falsa 123",
        notes: "Familia principal"
      }
    });
    expect(createHousehold.statusCode).toBe(200);
    const householdId = createHousehold.json<{ data: { id: string } }>().data.id;

    const createMember = await app.inject({
      method: "POST",
      url: `/households/${householdId}/members`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        fullName: "Integrante NH040",
        relationship: "familia",
        phone: "+5491112345678",
        canViewCameras: true,
        canReceiveAlerts: true
      }
    });
    expect(createMember.statusCode).toBe(200);
    const memberId = createMember.json<{ data: { id: string } }>().data.id;

    const listMembers = await app.inject({
      method: "GET",
      url: `/households/${householdId}/members?_start=0&_end=20`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listMembers.statusCode).toBe(200);
    expect(listMembers.json<{ data: Array<{ id: string }> }>().data.some((row) => row.id === memberId)).toBe(true);

    const updateMember = await app.inject({
      method: "PUT",
      url: `/household-members/${memberId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        canReceiveAlerts: false
      }
    });
    expect(updateMember.statusCode).toBe(200);
    expect(updateMember.json()).toMatchObject({
      data: {
        id: memberId,
        canReceiveAlerts: false
      }
    });

    const deleteMember = await app.inject({
      method: "DELETE",
      url: `/household-members/${memberId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(deleteMember.statusCode).toBe(200);

    const deleteHousehold = await app.inject({
      method: "DELETE",
      url: `/households/${householdId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(deleteHousehold.statusCode).toBe(200);
  });

  it("denies monitor from creating households and members", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const createHousehold = await app.inject({
      method: "POST",
      url: "/households",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Blocked Casa ${Date.now()}`
      }
    });
    expect(createHousehold.statusCode).toBe(403);
  });
});

describe("NH-041 customer camera onboarding and health monitor", () => {
  it("allows client_user to create, edit and validate an RTSP camera", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH041 Client ${Date.now()}`, [
      { email: "client@nearhome.dev", role: "customer" }
    ]);
    const clientToken = await login("client@nearhome.dev");

    const createCamera = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Cliente RTSP ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh041",
        location: "Ingreso principal",
        isActive: true
      }
    });
    expect(createCamera.statusCode).toBe(200);
    const cameraId = createCamera.json<{ data: { id: string } }>().data.id;

    const updateCamera = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Cliente RTSP ${Date.now()} (edit)`,
        rtspUrl: "rtsp://demo/nh041-updated",
        location: "Patio trasero",
        isActive: true
      }
    });
    expect(updateCamera.statusCode).toBe(200);
    expect(updateCamera.json()).toMatchObject({
      data: {
        id: cameraId,
        rtspUrl: "rtsp://demo/nh041-updated"
      }
    });

    const validateCamera = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/validate`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: { simulate: "pass" }
    });
    expect(validateCamera.statusCode).toBe(200);
    expect(validateCamera.json()).toMatchObject({
      data: {
        id: cameraId,
        lifecycleStatus: "ready"
      }
    });

    const lifecycle = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/lifecycle`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({
      data: {
        cameraId,
        currentStatus: "ready",
        healthSnapshot: {
          connectivity: "online"
        }
      }
    });
  });

  it("keeps monitor read-only for camera onboarding", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0].tenantId;

    const createCamera = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Blocked Monitor Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/blocked-monitor",
        isActive: true
      }
    });
    expect(createCamera.statusCode).toBe(403);
  });
});

describe("NH-015 client camera assignment subset", () => {
  it("applies allowlist to client_user only when assignments exist", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH015 ${Date.now()}`, [
      { email: "client@nearhome.dev", role: "customer" }
    ]);
    const clientToken = await login("client@nearhome.dev");

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(usersResponse.statusCode).toBe(200);
    const clientUser = usersResponse
      .json<{ data: Array<{ id: string; email: string }> }>()
      .data.find((user) => user.email === "client@nearhome.dev");
    expect(clientUser).toBeTruthy();

    const cameraAResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Client Scope Cam A ${Date.now()}`,
        rtspUrl: "rtsp://demo/client-scope-a",
        location: "Client Zone A",
        tags: ["client-scope"],
        isActive: false
      }
    });
    expect(cameraAResponse.statusCode).toBe(200);
    const cameraAId = cameraAResponse.json<{ data: { id: string } }>().data.id;

    const cameraBResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Client Scope Cam B ${Date.now()}`,
        rtspUrl: "rtsp://demo/client-scope-b",
        location: "Client Zone B",
        tags: ["client-scope"],
        isActive: false
      }
    });
    expect(cameraBResponse.statusCode).toBe(200);
    const cameraBId = cameraBResponse.json<{ data: { id: string } }>().data.id;

    const clearScopeResponse = await app.inject({
      method: "PUT",
      url: `/camera-assignments/${clientUser!.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraIds: []
      }
    });
    expect(clearScopeResponse.statusCode).toBe(200);

    const listBeforeScope = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listBeforeScope.statusCode).toBe(200);
    const beforeIds = new Set(listBeforeScope.json<{ data: Array<{ id: string }> }>().data.map((camera) => camera.id));
    expect(beforeIds.has(cameraAId)).toBe(true);
    expect(beforeIds.has(cameraBId)).toBe(true);

    const scopeResponse = await app.inject({
      method: "PUT",
      url: `/camera-assignments/${clientUser!.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraIds: [cameraAId]
      }
    });
    expect(scopeResponse.statusCode).toBe(200);

    const listAfterScope = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listAfterScope.statusCode).toBe(200);
    const afterIds = new Set(listAfterScope.json<{ data: Array<{ id: string }> }>().data.map((camera) => camera.id));
    expect(afterIds.has(cameraAId)).toBe(true);
    expect(afterIds.has(cameraBId)).toBe(false);

    const hiddenCamera = await app.inject({
      method: "GET",
      url: `/cameras/${cameraBId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(hiddenCamera.statusCode).toBe(404);
  });
});

describe("NH-021 user administration", () => {
  it("accepts role aliases operator/customer and stores canonical roles", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;
    const userEmail = `user-alias-${Date.now()}@nearhome.dev`;

    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        email: userEmail,
        name: "User Alias Test",
        password: "demo1234",
        role: "customer"
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
        role: "operator"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        id: created.id,
        role: "monitor"
      }
    });
  });

  it("allows super_admin to create memberships for any tenant without tenant header", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const acmeTenant = adminMe.memberships.find((m) => m.tenant.name === "Acme Retail");
    const betaTenant = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(acmeTenant).toBeTruthy();
    expect(betaTenant).toBeTruthy();

    const usersResponse = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": acmeTenant!.tenantId
      }
    });
    expect(usersResponse.statusCode).toBe(200);
    const monitorUser = usersResponse
      .json<{ data: Array<{ id: string; email: string }> }>()
      .data.find((row) => row.email === "monitor@nearhome.dev");
    expect(monitorUser).toBeTruthy();

    const createMembershipResponse = await app.inject({
      method: "POST",
      url: "/memberships",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        tenantId: betaTenant!.tenantId,
        userId: monitorUser!.id,
        role: "operator"
      }
    });
    expect(createMembershipResponse.statusCode).toBe(200);
    expect(createMembershipResponse.json()).toMatchObject({
      data: {
        tenantId: betaTenant!.tenantId,
        userId: monitorUser!.id,
        role: "monitor"
      }
    });

    const listMembershipsResponse = await app.inject({
      method: "GET",
      url: `/memberships?tenantId=${encodeURIComponent(betaTenant!.tenantId)}&userId=${encodeURIComponent(monitorUser!.id)}`,
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    expect(listMembershipsResponse.statusCode).toBe(200);
    const rows = listMembershipsResponse.json<{ data: Array<{ tenantId: string; userId: string; role: string }> }>().data;
    expect(rows.some((row) => row.tenantId === betaTenant!.tenantId && row.userId === monitorUser!.id && row.role === "monitor")).toBe(
      true
    );
  });

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
    const { tenantId } = await createTenantFixture(adminToken, `NH025 Auto ${Date.now()}`);

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
    const { tenantId } = await createTenantFixture(adminToken, `NH025 Config ${Date.now()}`);

    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH025 Config Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh025-config",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

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
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH025 Monitor ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");
    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH025 Monitor Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh025-monitor",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

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
    const { tenantId } = await createTenantFixture(adminToken, `NH025 Pending ${Date.now()}`);

    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH025 Pending Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh025-pending",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

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
    const { tenantId } = await createTenantFixture(adminToken, `NH027 Validate ${Date.now()}`);

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
    const { tenantId } = await createTenantFixture(adminToken, `NH027 Retire ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");
    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH027 Retire Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh027-retire",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

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

describe("NH-028 stream sessions lifecycle", () => {
  it("issues, activates and ends stream session with tenant tracking", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH028 Flow ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");
    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH028 Flow Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh028-flow",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

    const tokenResponse = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/stream-token`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(tokenResponse.statusCode).toBe(200);
    const issuedSessionId = tokenResponse.json<{ session: { id: string; status: string } }>().session.id;
    expect(tokenResponse.json()).toMatchObject({
      token: expect.any(String),
      session: { id: expect.any(String), status: "issued", cameraId }
    });
    const issuedToken = tokenResponse.json<{ token: string }>().token;
    expect(issuedToken.split(".")).toHaveLength(2);

    const listResponse = await app.inject({
      method: "GET",
      url: `/stream-sessions?cameraId=${cameraId}`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listResponse.statusCode).toBe(200);
    const sessions = listResponse.json<{ data: Array<{ id: string; status: string }> }>().data;
    expect(sessions.some((session) => session.id === issuedSessionId && session.status === "issued")).toBe(true);

    const activateResponse = await app.inject({
      method: "POST",
      url: `/stream-sessions/${issuedSessionId}/activate`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(activateResponse.statusCode).toBe(200);
    expect(activateResponse.json()).toMatchObject({ data: { id: issuedSessionId, status: "active" } });

    const endResponse = await app.inject({
      method: "POST",
      url: `/stream-sessions/${issuedSessionId}/end`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: { reason: "viewer closed" }
    });
    expect(endResponse.statusCode).toBe(200);
    expect(endResponse.json()).toMatchObject({ data: { id: issuedSessionId, status: "ended", endReason: "viewer closed" } });

    const detailResponse = await app.inject({
      method: "GET",
      url: `/stream-sessions/${issuedSessionId}`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json<{ data: { history: Array<{ event: string }> } }>().data;
    expect(detail.history.some((entry) => entry.event === "stream.ended")).toBe(true);
  });

  it("enforces ownership for client_user and allows tenant_admin override", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH028 Ownership ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" },
      { email: "client@nearhome.dev", role: "customer" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");
    const clientToken = await login("client@nearhome.dev");

    const createCameraResponse = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `NH028 Ownership Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/nh028-ownership",
        isActive: true
      }
    });
    expect(createCameraResponse.statusCode).toBe(200);
    const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

    const tokenResponse = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/stream-token`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    const sessionId = tokenResponse.json<{ session: { id: string } }>().session.id;

    const forbiddenEnd = await app.inject({
      method: "POST",
      url: `/stream-sessions/${sessionId}/end`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: { reason: "unauthorized end" }
    });
    expect(forbiddenEnd.statusCode).toBe(403);

    const adminEnd = await app.inject({
      method: "POST",
      url: `/stream-sessions/${sessionId}/end`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: { reason: "admin override" }
    });
    expect(adminEnd.statusCode).toBe(200);
    expect(adminEnd.json()).toMatchObject({ data: { id: sessionId, status: "ended", endReason: "admin override" } });
  });
});

describe("NH-035 entitlement enforcement", () => {
  it("returns entitlements per tenant plan", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantB = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    const tenantC = adminMe.memberships.find((m) => m.tenant.name === "Gamma Clinics");
    expect(tenantB).toBeTruthy();
    expect(tenantC).toBeTruthy();

    const tenantBEntitlements = await app.inject({
      method: "GET",
      url: `/tenants/${tenantB!.tenantId}/entitlements`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(tenantBEntitlements.statusCode).toBe(200);
    expect(tenantBEntitlements.json()).toMatchObject({
      data: {
        planCode: "starter",
        limits: { maxCameras: 2, retentionDays: 1, maxConcurrentStreams: 1 }
      }
    });

    const tenantCEntitlements = await app.inject({
      method: "GET",
      url: `/tenants/${tenantC!.tenantId}/entitlements`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(tenantCEntitlements.statusCode).toBe(200);
    expect(tenantCEntitlements.json()).toMatchObject({
      data: {
        planCode: "basic",
        limits: { maxCameras: 10, retentionDays: 7, maxConcurrentStreams: 2 }
      }
    });
  });

  it("blocks camera creation when maxCameras limit is reached", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantB = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(tenantB).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantB!.tenantId
      },
      payload: {
        name: `Overflow Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/overflow",
        isActive: true
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ENTITLEMENT_LIMIT_EXCEEDED",
      message: "Camera limit reached for active plan",
      details: {
        limit: "maxCameras",
        maxAllowed: 2
      }
    });
  });

  it("blocks issuing a second concurrent stream beyond plan limit", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantB = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(tenantB).toBeTruthy();

    const tenantId = tenantB!.tenantId;
    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/stream-sessions",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(sessionsResponse.statusCode).toBe(200);
    const sessions = sessionsResponse.json<{ data: Array<{ id: string; status: string }> }>().data;
    for (const session of sessions.filter((entry) => ["requested", "issued", "active"].includes(entry.status))) {
      const endResponse = await app.inject({
        method: "POST",
        url: `/stream-sessions/${session.id}/end`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        },
        payload: { reason: "test cleanup" }
      });
      expect(endResponse.statusCode).toBe(200);
    }

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const first = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/stream-token`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/stream-token`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: "ENTITLEMENT_LIMIT_EXCEEDED",
      message: "Concurrent stream limit reached for active plan",
      details: {
        limit: "maxConcurrentStreams",
        maxAllowed: 1
      }
    });
  });

  it("keeps concurrent stream limits isolated across tenants", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantB = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    const tenantC = adminMe.memberships.find((m) => m.tenant.name === "Gamma Clinics");
    expect(tenantB).toBeTruthy();
    expect(tenantC).toBeTruthy();

    for (const tenantId of [tenantB!.tenantId, tenantC!.tenantId]) {
      const sessionsResponse = await app.inject({
        method: "GET",
        url: "/stream-sessions",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        }
      });
      expect(sessionsResponse.statusCode).toBe(200);
      const sessions = sessionsResponse.json<{ data: Array<{ id: string; status: string }> }>().data;
      for (const session of sessions.filter((entry) => ["requested", "issued", "active"].includes(entry.status))) {
        const endResponse = await app.inject({
          method: "POST",
          url: `/stream-sessions/${session.id}/end`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "x-tenant-id": tenantId
          },
          payload: { reason: "cross-tenant cleanup" }
        });
        expect(endResponse.statusCode).toBe(200);
      }
    }

    const camerasTenantB = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantB!.tenantId
      }
    });
    const cameraBTenantId = camerasTenantB.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraBTenantId).toBeTruthy();

    const camerasTenantC = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantC!.tenantId
      }
    });
    let cameraCTenantId = camerasTenantC.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    if (!cameraCTenantId) {
      const createCameraTenantC = await app.inject({
        method: "POST",
        url: "/cameras",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantC!.tenantId
        },
        payload: {
          name: `Tenant C Stream Cam ${Date.now()}`,
          rtspUrl: "rtsp://demo/tenant-c-stream",
          isActive: true
        }
      });
      expect(createCameraTenantC.statusCode).toBe(200);
      cameraCTenantId = createCameraTenantC.json<{ data: { id: string } }>().data.id;
    }
    expect(cameraCTenantId).toBeTruthy();

    const tenantBFirst = await app.inject({
      method: "POST",
      url: `/cameras/${cameraBTenantId}/stream-token`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantB!.tenantId
      },
      payload: {}
    });
    expect(tenantBFirst.statusCode).toBe(200);

    const tenantBSecond = await app.inject({
      method: "POST",
      url: `/cameras/${cameraBTenantId}/stream-token`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantB!.tenantId
      },
      payload: {}
    });
    expect(tenantBSecond.statusCode).toBe(409);

    const tenantCFirst = await app.inject({
      method: "POST",
      url: `/cameras/${cameraCTenantId}/stream-token`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantC!.tenantId
      },
      payload: {}
    });
    expect(tenantCFirst.statusCode).toBe(200);
  });

  it("enforces retentionDays in events queries", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantB = adminMe.memberships.find((m) => m.tenant.name === "Beta Logistics");
    expect(tenantB).toBeTruthy();

    const tooOldFrom = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const response = await app.inject({
      method: "GET",
      url: `/events?from=${encodeURIComponent(tooOldFrom)}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantB!.tenantId
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "ENTITLEMENT_RETENTION_EXCEEDED",
      message: "Requested date range exceeds plan retention window",
      details: {
        limit: "retentionDays",
        maxAllowedDays: 1
      }
    });
  });
});

describe("NH-033 data-plane health sync", () => {
  it("returns 503 when stream gateway is not configured", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const syncResponse = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/sync-health`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {}
    });

    expect(syncResponse.statusCode).toBe(503);
    expect(syncResponse.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("NH-016 audit logs", () => {
  it("stores critical actions and returns them for tenant_admin", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH016 Audit ${Date.now()}`);

    const cameraCreate = await app.inject({
      method: "POST",
      url: "/cameras",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        name: `Audit Cam ${Date.now()}`,
        rtspUrl: "rtsp://demo/audit",
        location: "Audit Lab",
        tags: ["audit"],
        isActive: true
      }
    });
    expect(cameraCreate.statusCode).toBe(200);
    const cameraId = cameraCreate.json<{ data: { id: string } }>().data.id;

    const plansResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(plansResponse.statusCode).toBe(200);
    const planId = plansResponse
      .json<{ data: Array<{ id: string; code: string }> }>()
      .data.find((plan) => plan.code === "pro")?.id;
    expect(planId).toBeTruthy();

    const subscriptionSet = await app.inject({
      method: "POST",
      url: `/tenants/${tenantId}/subscription`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: { planId }
    });
    expect(subscriptionSet.statusCode).toBe(200);

    const logsResponse = await app.inject({
      method: "GET",
      url: "/audit-logs?_start=0&_end=100",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(logsResponse.statusCode).toBe(200);
    const logsBody = logsResponse.json<{
      data: Array<{ resource: string; action: string; resourceId: string | null }>;
      total: number;
    }>();

    expect(logsBody.total).toBeGreaterThan(0);
    expect(logsBody.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "camera",
          action: "create",
          resourceId: cameraId
        }),
        expect.objectContaining({
          resource: "subscription",
          action: "set_plan"
        })
      ])
    );
  });

  it("denies audit log access for monitor role", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId } = await createTenantFixture(adminToken, `NH016 Monitor ${Date.now()}`, [
      { email: "monitor@nearhome.dev", role: "monitor" }
    ]);
    const monitorToken = await login("monitor@nearhome.dev");

    const response = await app.inject({
      method: "GET",
      url: "/audit-logs",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("NH-002 login rate limit", () => {
  it("denies backoffice login for customer users", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "client@nearhome.dev",
        password: "demo1234",
        audience: "backoffice"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "BACKOFFICE_ACCESS_DENIED"
    });
  });

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

describe("NH-011 request-id and structured logging contract", () => {
  it("echoes incoming x-request-id header in responses", async () => {
    const requestId = `nh-req-${Date.now()}`;
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: {
        "x-request-id": requestId,
        "x-forwarded-for": `test-reqid-${Date.now()}`
      },
      payload: { email: "admin@nearhome.dev", password: "demo1234" }
    });
    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.headers["x-request-id"]).toBe(requestId);
  });

  it("generates x-request-id when header is missing", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": `test-reqid-auto-${Date.now()}` },
      payload: { email: "admin@nearhome.dev", password: "demo1234" }
    });
    expect(loginResponse.statusCode).toBe(200);
    expect(typeof loginResponse.headers["x-request-id"]).toBe("string");
    expect((loginResponse.headers["x-request-id"] as string).length).toBeGreaterThan(0);
  });
});

describe("NH-013 API versioning /v1 compatibility", () => {
  it("supports login and me through /v1 prefix", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-forwarded-for": `test-v1-login-${Date.now()}` },
      payload: { email: "admin@nearhome.dev", password: "demo1234" }
    });
    expect(loginResponse.statusCode).toBe(200);

    const token = loginResponse.json<{ accessToken: string }>().accessToken;
    const meResponse = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({
      user: { email: "admin@nearhome.dev" }
    });
  });

  it("supports tenant-scoped routes through /v1 prefix", async () => {
    const token = await login("monitor@nearhome.dev");
    const meResponse = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });
    const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
    expect(tenantId).toBeTruthy();

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/v1/cameras?_start=0&_end=5",
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    expect(camerasResponse.json()).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number)
    });
  });
});

describe("NH-012 readiness endpoint", () => {
  it("returns ok when db is reachable", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/readiness"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      db: "up"
    });
    expect(typeof response.headers["x-request-id"]).toBe("string");
  });

  it("returns 503 when readiness is forced to fail", async () => {
    const previous = process.env.READINESS_FORCE_FAIL;
    process.env.READINESS_FORCE_FAIL = "1";

    const failingApp = await buildApp();
    await failingApp.ready();

    try {
      const response = await failingApp.inject({
        method: "GET",
        url: "/readiness"
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        db: "down",
        reason: "forced_failure"
      });
    } finally {
      await failingApp.close();
      process.env.READINESS_FORCE_FAIL = previous;
    }
  });
});

describe("NH-OBS deployment status endpoint", () => {
  it("returns consolidated services and node lifecycle status for authenticated users", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const response = await app.inject({
      method: "GET",
      url: "/ops/deployment/status",
      headers: { authorization: `Bearer ${adminToken}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        generatedAt: string;
        overallOk: boolean;
        services: Array<{ name: string; ok: boolean; latencyMs: number; statusCode: number | null }>;
        nodes: { total: number; online: number; degraded: number; offline: number; drained: number; items: unknown[] };
      };
    }>();

    expect(typeof body.data.generatedAt).toBe("string");
    expect(Array.isArray(body.data.services)).toBe(true);
    expect(body.data.services.length).toBeGreaterThan(0);
    expect(body.data.services.every((service) => typeof service.name === "string")).toBe(true);
    expect(typeof body.data.nodes.total).toBe("number");
    expect(Array.isArray(body.data.nodes.items)).toBe(true);
  });
});

describe("NH-DP detection jobs and incidents", () => {
  it("allows tenant_admin to create, read, list results and cancel detection jobs", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0]?.tenantId;
    expect(tenantId).toBeTruthy();

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=1",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: { modelRef: "yolo26n@1.0.0", minConfidence: 0.4 }
      }
    });
    expect(createResponse.statusCode).toBe(200);
    const jobId = createResponse.json<{ data: { id: string; status: string } }>().data.id;
    expect(jobId).toBeTruthy();
    expect(createResponse.json()).toMatchObject({ data: { status: "queued" } });

    const getResponse = await app.inject({
      method: "GET",
      url: `/v1/detections/jobs/${jobId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        id: jobId,
        tenantId,
        cameraId
      }
    });

    const resultsResponse = await app.inject({
      method: "GET",
      url: `/v1/detections/jobs/${jobId}/results`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(resultsResponse.statusCode).toBe(200);
    expect(resultsResponse.json()).toMatchObject({ data: expect.any(Array), total: expect.any(Number) });

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/v1/detections/jobs/${jobId}/cancel`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId!
      },
      payload: {}
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toMatchObject({
      data: { id: jobId, status: "canceled" }
    });
  });

  it("denies detection job creation for client_user", async () => {
    const clientToken = await login("client@nearhome.dev");
    const clientMe = await me(clientToken);
    const tenantId = clientMe.memberships[0]?.tenantId;
    expect(tenantId).toBeTruthy();

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=1",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/detections/jobs",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId!
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento"
      }
    });
    expect(createResponse.statusCode).toBe(403);
    expect(createResponse.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns ws token and incidents list scoped by tenant", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const monitorMe = await me(monitorToken);
    const tenantId = monitorMe.memberships[0]?.tenantId;
    expect(tenantId).toBeTruthy();

    const wsTokenResponse = await app.inject({
      method: "GET",
      url: "/v1/events/ws-token",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(wsTokenResponse.statusCode).toBe(200);
    expect(wsTokenResponse.json()).toMatchObject({
      data: {
        token: expect.any(String),
        tenantId,
        topicsAllowed: expect.any(Array),
        expiresAt: expect.any(String)
      }
    });

    const incidentsResponse = await app.inject({
      method: "GET",
      url: "/v1/incidents?_start=0&_end=20",
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId!
      }
    });
    expect(incidentsResponse.statusCode).toBe(200);
    expect(incidentsResponse.json()).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number)
    });
  });
});

describe("NH-DP-13 detection pipeline execution", () => {
  it("executes queued job through inference bridge and persists observations/incidents", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    process.env.DETECTION_BRIDGE_URL = "http://mock-inference-bridge";

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("http://mock-inference-bridge/v1/infer")) {
        return new globalThis.Response(
          JSON.stringify({
            detections: [
              {
                label: "dog",
                confidence: 0.91,
                bbox: { x: 0.15, y: 0.2, w: 0.25, h: 0.3 },
                attributes: { motion: true }
              }
            ],
            providerMeta: { nodeId: "node-yolo-cpu" }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new globalThis.Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pipelineApp = await buildApp();
    await pipelineApp.ready();

    try {
      const loginResponse = await pipelineApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-pipeline-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const meResponse = await pipelineApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(meResponse.statusCode).toBe(200);
      const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
      expect(tenantId).toBeTruthy();

      const camerasResponse = await pipelineApp.inject({
        method: "GET",
        url: "/cameras?_start=0&_end=1",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(camerasResponse.statusCode).toBe(200);
      const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
      expect(cameraId).toBeTruthy();

      const createResponse = await pipelineApp.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento",
          options: { modelRef: "yolo26n@1.0.0", taskType: "object_detection" }
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const jobId = createResponse.json<{ data: { id: string } }>().data.id;

      let jobStatus = "queued";
      for (let i = 0; i < 30; i += 1) {
        const jobResponse = await pipelineApp.inject({
          method: "GET",
          url: `/v1/detections/jobs/${jobId}`,
          headers: {
            authorization: `Bearer ${token}`,
            "x-tenant-id": tenantId!
          }
        });
        expect(jobResponse.statusCode).toBe(200);
        jobStatus = jobResponse.json<{ data: { status: string } }>().data.status;
        if (jobStatus === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(jobStatus).toBe("succeeded");

      const resultsResponse = await pipelineApp.inject({
        method: "GET",
        url: `/v1/detections/jobs/${jobId}/results`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(resultsResponse.statusCode).toBe(200);
      const results = resultsResponse.json<{ data: Array<{ label: string }>; total: number }>();
      expect(results.total).toBeGreaterThan(0);
      expect(results.data[0]?.label).toBe("dog");

      const incidentsResponse = await pipelineApp.inject({
        method: "GET",
        url: "/v1/incidents?_start=0&_end=20",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(incidentsResponse.statusCode).toBe(200);
      const incidents = incidentsResponse.json<{ data: Array<{ id: string; type: string }>; total: number }>();
      expect(incidents.total).toBeGreaterThan(0);
      expect(incidents.data.some((entry) => entry.type === "dog_in_backyard")).toBe(true);

      const firstIncidentId = incidents.data[0]?.id;
      expect(firstIncidentId).toBeTruthy();

      const evidenceResponse = await pipelineApp.inject({
        method: "GET",
        url: `/v1/incidents/${firstIncidentId}/evidence`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(evidenceResponse.statusCode).toBe(200);
      expect(evidenceResponse.json<{ total: number }>().total).toBeGreaterThan(0);
    } finally {
      await pipelineApp.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
    }
  });
});

describe("NH-DP-14 temporal workflow dispatch", () => {
  it("dispatches detection job to temporal endpoint and stores workflow/run ids", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    const previousMode = process.env.DETECTION_EXECUTION_MODE;
    const previousTemporalDispatch = process.env.DETECTION_TEMPORAL_DISPATCH_URL;

    process.env.DETECTION_BRIDGE_URL = "";
    process.env.DETECTION_EXECUTION_MODE = "temporal";
    process.env.DETECTION_TEMPORAL_DISPATCH_URL = "http://mock-temporal-dispatch";

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("http://mock-temporal-dispatch/v1/workflows/detection-jobs")) {
        return new globalThis.Response(
          JSON.stringify({
            workflowId: "wf-det-job",
            runId: "run-det-job",
            taskQueue: "nearhome-detection"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new globalThis.Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const temporalApp = await buildApp();
    await temporalApp.ready();

    try {
      const loginResponse = await temporalApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-temporal-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const meResponse = await temporalApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(meResponse.statusCode).toBe(200);
      const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
      expect(tenantId).toBeTruthy();

      const camerasResponse = await temporalApp.inject({
        method: "GET",
        url: "/cameras?_start=0&_end=1",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(camerasResponse.statusCode).toBe(200);
      const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
      expect(cameraId).toBeTruthy();

      const createResponse = await temporalApp.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento",
          options: { modelRef: "yolo26n@1.0.0", taskType: "object_detection" }
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const jobId = createResponse.json<{ data: { id: string } }>().data.id;

      let job: { status: string; workflowId: string | null; runId: string | null } | null = null;
      for (let i = 0; i < 30; i += 1) {
        const jobResponse = await temporalApp.inject({
          method: "GET",
          url: `/v1/detections/jobs/${jobId}`,
          headers: {
            authorization: `Bearer ${token}`,
            "x-tenant-id": tenantId!
          }
        });
        expect(jobResponse.statusCode).toBe(200);
        job = jobResponse.json<{ data: { status: string; workflowId: string | null; runId: string | null } }>().data;
        if (job.workflowId) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(job).toBeTruthy();
      expect(job?.status).toBe("queued");
      expect(job?.workflowId).toBe("wf-det-job");
      expect(job?.runId).toBe("run-det-job");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://mock-temporal-dispatch/v1/workflows/detection-jobs",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      await temporalApp.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
      process.env.DETECTION_EXECUTION_MODE = previousMode;
      process.env.DETECTION_TEMPORAL_DISPATCH_URL = previousTemporalDispatch;
    }
  });

  it("marks detection job as failed when temporal dispatch errors", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    const previousMode = process.env.DETECTION_EXECUTION_MODE;
    const previousTemporalDispatch = process.env.DETECTION_TEMPORAL_DISPATCH_URL;

    process.env.DETECTION_BRIDGE_URL = "";
    process.env.DETECTION_EXECUTION_MODE = "temporal";
    process.env.DETECTION_TEMPORAL_DISPATCH_URL = "http://mock-temporal-dispatch";

    const fetchMock = vi.fn(async () => new globalThis.Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const temporalApp = await buildApp();
    await temporalApp.ready();

    try {
      const loginResponse = await temporalApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-temporal-fail-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const meResponse = await temporalApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(meResponse.statusCode).toBe(200);
      const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
      expect(tenantId).toBeTruthy();

      const camerasResponse = await temporalApp.inject({
        method: "GET",
        url: "/cameras?_start=0&_end=1",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(camerasResponse.statusCode).toBe(200);
      const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
      expect(cameraId).toBeTruthy();

      const createResponse = await temporalApp.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento"
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const jobId = createResponse.json<{ data: { id: string } }>().data.id;

      let jobStatus = "queued";
      let jobErrorCode: string | null = null;
      for (let i = 0; i < 30; i += 1) {
        const jobResponse = await temporalApp.inject({
          method: "GET",
          url: `/v1/detections/jobs/${jobId}`,
          headers: {
            authorization: `Bearer ${token}`,
            "x-tenant-id": tenantId!
          }
        });
        expect(jobResponse.statusCode).toBe(200);
        const job = jobResponse.json<{ data: { status: string; errorCode: string | null } }>().data;
        jobStatus = job.status;
        jobErrorCode = job.errorCode;
        if (jobStatus === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(jobStatus).toBe("failed");
      expect(jobErrorCode).toBe("TEMPORAL_DISPATCH_ERROR");
    } finally {
      await temporalApp.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
      process.env.DETECTION_EXECUTION_MODE = previousMode;
      process.env.DETECTION_TEMPORAL_DISPATCH_URL = previousTemporalDispatch;
    }
  });
});

describe("NH-DP-15 temporal callback ingestion", () => {
  it("ingests workflow completion and persists detections/incidents", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    const previousMode = process.env.DETECTION_EXECUTION_MODE;
    const previousCallbackSecret = process.env.DETECTION_CALLBACK_SECRET;
    const previousEventGatewayUrl = process.env.EVENT_GATEWAY_URL;
    const previousEventPublishSecret = process.env.EVENT_PUBLISH_SECRET;

    process.env.DETECTION_BRIDGE_URL = "";
    process.env.DETECTION_EXECUTION_MODE = "inline";
    process.env.DETECTION_CALLBACK_SECRET = "test-callback-secret";
    process.env.EVENT_GATEWAY_URL = "http://mock-event-gateway";
    process.env.EVENT_PUBLISH_SECRET = "test-event-secret";

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("http://mock-event-gateway/internal/events/publish")) {
        return new globalThis.Response(JSON.stringify({ data: { accepted: true } }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackApp = await buildApp();
    await callbackApp.ready();

    try {
      const loginResponse = await callbackApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-callback-complete-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const meResponse = await callbackApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(meResponse.statusCode).toBe(200);
      const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
      expect(tenantId).toBeTruthy();

      const camerasResponse = await callbackApp.inject({
        method: "GET",
        url: "/cameras?_start=0&_end=1",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(camerasResponse.statusCode).toBe(200);
      const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
      expect(cameraId).toBeTruthy();

      const createResponse = await callbackApp.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento"
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const jobId = createResponse.json<{ data: { id: string } }>().data.id;

      const completeUnauthorized = await callbackApp.inject({
        method: "POST",
        url: `/internal/detections/jobs/${jobId}/complete`,
        payload: { detections: [] }
      });
      expect(completeUnauthorized.statusCode).toBe(401);

      const completeResponse = await callbackApp.inject({
        method: "POST",
        url: `/internal/detections/jobs/${jobId}/complete`,
        headers: {
          "x-detection-callback-secret": "test-callback-secret"
        },
        payload: {
          detections: [
            {
              label: "person",
              confidence: 0.87,
              bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.3 },
              attributes: { motion: true }
            }
          ],
          providerMeta: { nodeId: "node-yolo-cpu" }
        }
      });
      expect(completeResponse.statusCode).toBe(200);
      expect(completeResponse.json<{ data: { status: string } }>().data.status).toBe("succeeded");

      const resultsResponse = await callbackApp.inject({
        method: "GET",
        url: `/v1/detections/jobs/${jobId}/results`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(resultsResponse.statusCode).toBe(200);
      const results = resultsResponse.json<{ total: number; data: Array<{ label: string }> }>();
      expect(results.total).toBeGreaterThan(0);
      expect(results.data[0]?.label).toBe("person");

      const incidentsResponse = await callbackApp.inject({
        method: "GET",
        url: "/v1/incidents?_start=0&_end=20",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(incidentsResponse.statusCode).toBe(200);
      const incidents = incidentsResponse.json<{ data: Array<{ type: string }> }>().data;
      expect(incidents.some((entry) => entry.type === "person_approached_front_window")).toBe(true);

      const publishBodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
      expect(
        publishBodies.some(
          (payload) =>
            payload.eventType === "detection.job" &&
            payload.payload?.jobId === jobId &&
            payload.payload?.status === "succeeded"
        )
      ).toBe(true);
      expect(
        publishBodies.some(
          (payload) =>
            payload.eventType === "incident" &&
            payload.payload?.jobId === jobId &&
            payload.payload?.type === "person_approached_front_window"
        )
      ).toBe(true);
    } finally {
      await callbackApp.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
      process.env.DETECTION_EXECUTION_MODE = previousMode;
      process.env.DETECTION_CALLBACK_SECRET = previousCallbackSecret;
      process.env.EVENT_GATEWAY_URL = previousEventGatewayUrl;
      process.env.EVENT_PUBLISH_SECRET = previousEventPublishSecret;
    }
  });

  it("ingests workflow failure callback and marks job as failed", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    const previousMode = process.env.DETECTION_EXECUTION_MODE;
    const previousCallbackSecret = process.env.DETECTION_CALLBACK_SECRET;
    const previousEventGatewayUrl = process.env.EVENT_GATEWAY_URL;
    const previousEventPublishSecret = process.env.EVENT_PUBLISH_SECRET;

    process.env.DETECTION_BRIDGE_URL = "";
    process.env.DETECTION_EXECUTION_MODE = "inline";
    process.env.DETECTION_CALLBACK_SECRET = "test-callback-secret";
    process.env.EVENT_GATEWAY_URL = "http://mock-event-gateway";
    process.env.EVENT_PUBLISH_SECRET = "test-event-secret";

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("http://mock-event-gateway/internal/events/publish")) {
        return new globalThis.Response(JSON.stringify({ data: { accepted: true } }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackApp = await buildApp();
    await callbackApp.ready();

    try {
      const loginResponse = await callbackApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-callback-fail-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const meResponse = await callbackApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(meResponse.statusCode).toBe(200);
      const tenantId = meResponse.json<{ memberships: Array<{ tenantId: string }> }>().memberships[0]?.tenantId;
      expect(tenantId).toBeTruthy();

      const camerasResponse = await callbackApp.inject({
        method: "GET",
        url: "/cameras?_start=0&_end=1",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        }
      });
      expect(camerasResponse.statusCode).toBe(200);
      const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
      expect(cameraId).toBeTruthy();

      const createResponse = await callbackApp.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId!
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento"
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const jobId = createResponse.json<{ data: { id: string } }>().data.id;

      const failResponse = await callbackApp.inject({
        method: "POST",
        url: `/internal/detections/jobs/${jobId}/fail`,
        headers: {
          "x-detection-callback-secret": "test-callback-secret"
        },
        payload: {
          errorCode: "DETECTION_WORKFLOW_ERROR",
          errorMessage: "bridge timeout"
        }
      });
      expect(failResponse.statusCode).toBe(200);
      expect(failResponse.json<{ data: { status: string; errorCode: string | null } }>().data).toMatchObject({
        status: "failed",
        errorCode: "DETECTION_WORKFLOW_ERROR"
      });
      const publishBodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
      expect(
        publishBodies.some(
          (payload) =>
            payload.eventType === "detection.job" &&
            payload.payload?.jobId === jobId &&
            payload.payload?.status === "failed"
        )
      ).toBe(true);
    } finally {
      await callbackApp.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
      process.env.DETECTION_EXECUTION_MODE = previousMode;
      process.env.DETECTION_CALLBACK_SECRET = previousCallbackSecret;
      process.env.EVENT_GATEWAY_URL = previousEventGatewayUrl;
      process.env.EVENT_PUBLISH_SECRET = previousEventPublishSecret;
    }
  });
});

describe("NH-042 notification rules and multi-channel deliveries", () => {
  it("dispatches realtime, webhook and email deliveries from camera notification rules", async () => {
    const previousBridge = process.env.DETECTION_BRIDGE_URL;
    const previousMode = process.env.DETECTION_EXECUTION_MODE;
    const previousCallbackSecret = process.env.DETECTION_CALLBACK_SECRET;
    const previousEventGatewayUrl = process.env.EVENT_GATEWAY_URL;
    const previousEventPublishSecret = process.env.EVENT_PUBLISH_SECRET;

    process.env.DETECTION_BRIDGE_URL = "";
    process.env.DETECTION_EXECUTION_MODE = "inline";
    process.env.DETECTION_CALLBACK_SECRET = "test-callback-secret";
    process.env.EVENT_GATEWAY_URL = "http://mock-event-gateway";
    process.env.EVENT_PUBLISH_SECRET = "test-event-secret";

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("http://mock-event-gateway/internal/events/publish")) {
        return new globalThis.Response(JSON.stringify({ data: { accepted: true } }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("http://mock-webhook.local/nearhome")) {
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const appUnderTest = await buildApp();
    await appUnderTest.ready();

    try {
      const loginResponse = await appUnderTest.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `test-nh042-${Date.now()}` },
        payload: { email: "admin@nearhome.dev", password: "demo1234" }
      });
      expect(loginResponse.statusCode).toBe(200);
      const token = loginResponse.json<{ accessToken: string }>().accessToken;

      const createTenantResponse = await appUnderTest.inject({
        method: "POST",
        url: "/tenants",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: `NH042 ${Date.now()}`
        }
      });
      expect(createTenantResponse.statusCode).toBe(200);
      const tenantId = createTenantResponse.json<{ data: { id: string } }>().data.id;

      const createCameraResponse = await appUnderTest.inject({
        method: "POST",
        url: "/cameras",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        },
        payload: {
          name: `NH042 Cam ${Date.now()}`,
          rtspUrl: `rtsp://demo/nh042-${Date.now()}`,
          isActive: true
        }
      });
      expect(createCameraResponse.statusCode).toBe(200);
      const cameraId = createCameraResponse.json<{ data: { id: string } }>().data.id;

      const upsertWebhookChannel = await appUnderTest.inject({
        method: "POST",
        url: "/notification-channels",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        },
        payload: {
          name: "NH042 webhook",
          type: "webhook",
          endpoint: "http://mock-webhook.local/nearhome",
          isActive: true
        }
      });
      expect(upsertWebhookChannel.statusCode).toBe(200);

      const upsertEmailChannel = await appUnderTest.inject({
        method: "POST",
        url: "/notification-channels",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        },
        payload: {
          name: "NH042 email",
          type: "email",
          emailTo: "alerts+nh042@nearhome.dev",
          isActive: true
        }
      });
      expect(upsertEmailChannel.statusCode).toBe(200);

      const profileUpdate = await appUnderTest.inject({
        method: "PUT",
        url: `/cameras/${cameraId}/profile`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        },
        payload: {
          rulesProfile: {
            notification: {
              enabled: true,
              minConfidence: 0.6,
              labels: "person",
              cooldownSeconds: 0,
              channels: {
                realtime: true,
                webhook: true,
                email: true
              }
            }
          }
        }
      });
      expect(profileUpdate.statusCode).toBe(200);

      const createJob = await appUnderTest.inject({
        method: "POST",
        url: "/v1/detections/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        },
        payload: {
          cameraId,
          mode: "realtime",
          source: "snapshot",
          provider: "onprem_bento"
        }
      });
      expect(createJob.statusCode).toBe(200);
      const jobId = createJob.json<{ data: { id: string } }>().data.id;

      const completeResponse = await appUnderTest.inject({
        method: "POST",
        url: `/internal/detections/jobs/${jobId}/complete`,
        headers: {
          "x-detection-callback-secret": "test-callback-secret"
        },
        payload: {
          detections: [
            {
              label: "person",
              confidence: 0.93,
              bbox: { x: 0.11, y: 0.18, w: 0.22, h: 0.32 }
            }
          ]
        }
      });
      expect(completeResponse.statusCode).toBe(200);

      const deliveriesResponse = await appUnderTest.inject({
        method: "GET",
        url: `/notifications/deliveries?cameraId=${cameraId}&_start=0&_end=20`,
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": tenantId
        }
      });
      expect(deliveriesResponse.statusCode).toBe(200);
      const deliveries = deliveriesResponse.json<{ data: Array<{ channelType: string; status: string }> }>().data;
      expect(deliveries.some((delivery) => delivery.channelType === "realtime" && delivery.status === "sent")).toBe(true);
      expect(deliveries.some((delivery) => delivery.channelType === "webhook" && delivery.status === "sent")).toBe(true);
      expect(deliveries.some((delivery) => delivery.channelType === "email" && delivery.status === "queued")).toBe(true);

      const publishBodies = fetchMock.mock.calls
        .map((call) => {
          const rawBody = call[1]?.body;
          if (typeof rawBody !== "string") return null;
          try {
            return JSON.parse(rawBody);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{ eventType?: string; payload?: Record<string, unknown> }>;

      expect(
        publishBodies.some(
          (payload) => payload.eventType === "notification.sent" && payload.payload?.["channel"] === "realtime"
        )
      ).toBe(true);
      expect(publishBodies.some((payload) => payload.eventType === "notification.email_queued")).toBe(true);

      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("http://mock-webhook.local/nearhome"))).toBe(true);
    } finally {
      await appUnderTest.close();
      vi.unstubAllGlobals();
      process.env.DETECTION_BRIDGE_URL = previousBridge;
      process.env.DETECTION_EXECUTION_MODE = previousMode;
      process.env.DETECTION_CALLBACK_SECRET = previousCallbackSecret;
      process.env.EVENT_GATEWAY_URL = previousEventGatewayUrl;
      process.env.EVENT_PUBLISH_SECRET = previousEventPublishSecret;
    }
  });
});

describe("NH-043 subscription request with payment proof", () => {
  it("allows client_user to request a plan with proof metadata and tenant_admin to approve", async () => {
    const clientToken = await login("client@nearhome.dev");
    const clientMe = await me(clientToken);
    const tenantId = clientMe.memberships[0].tenantId;

    const plansResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { authorization: `Bearer ${clientToken}` }
    });
    expect(plansResponse.statusCode).toBe(200);
    const planId = plansResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(planId).toBeTruthy();

    const createRequest = await app.inject({
      method: "POST",
      url: "/subscriptions/requests",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        planId,
        notes: "Pago por transferencia del 10/03",
        proof: {
          imageUrl: "https://cdn.nearhome.dev/proofs/nh043-proof.jpg",
          fileName: "nh043-proof.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 248300,
          metadata: { bank: "DemoBank", operationId: "OP-12345" }
        }
      }
    });
    expect(createRequest.statusCode).toBe(200);
    const requestId = createRequest.json<{ data: { id: string; status: string } }>().data.id;
    expect(createRequest.json<{ data: { status: string } }>().data.status).toBe("pending_review");

    const listRequests = await app.inject({
      method: "GET",
      url: "/subscriptions/requests?_start=0&_end=20",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(listRequests.statusCode).toBe(200);
    expect(listRequests.json<{ data: Array<{ id: string; status: string }> }>().data.some((row) => row.id === requestId)).toBe(true);

    const adminToken = await login("admin@nearhome.dev");
    const approveRequest = await app.inject({
      method: "PUT",
      url: `/subscriptions/requests/${requestId}/review`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        status: "approved",
        reviewNotes: "Comprobante válido"
      }
    });
    expect(approveRequest.statusCode).toBe(200);
    expect(approveRequest.json()).toMatchObject({
      data: {
        id: requestId,
        status: "approved"
      }
    });

    const subscriptions = await app.inject({
      method: "GET",
      url: "/subscriptions",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(subscriptions.statusCode).toBe(200);
    expect(subscriptions.json<{ data: Array<{ status: string; planId: string }> }>().data[0]).toMatchObject({
      status: "active",
      planId
    });
  });

  it("denies monitor from reviewing subscription requests", async () => {
    const clientToken = await login("client@nearhome.dev");
    const clientMe = await me(clientToken);
    const tenantId = clientMe.memberships[0].tenantId;

    const plansResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { authorization: `Bearer ${clientToken}` }
    });
    const planId = plansResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(planId).toBeTruthy();

    const createRequest = await app.inject({
      method: "POST",
      url: "/subscriptions/requests",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        planId,
        proof: {
          imageUrl: "https://cdn.nearhome.dev/proofs/nh043-proof-2.jpg",
          fileName: "nh043-proof-2.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 128000
        }
      }
    });
    expect(createRequest.statusCode).toBe(200);
    const requestId = createRequest.json<{ data: { id: string } }>().data.id;

    const monitorToken = await login("monitor@nearhome.dev");
    const reviewAsMonitor = await app.inject({
      method: "PUT",
      url: `/subscriptions/requests/${requestId}/review`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        status: "rejected"
      }
    });
    expect(reviewAsMonitor.statusCode).toBe(403);
  });
});

describe("NH-DP-17 camera detection profile", () => {
  it("allows tenant roles to read detection profile and tenant_admin to update it", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const adminMe = await me(adminToken);
    const tenantId = adminMe.memberships[0].tenantId;

    const camerasResponse = await app.inject({
      method: "GET",
      url: "/cameras?_start=0&_end=1",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(camerasResponse.statusCode).toBe(200);
    const cameraId = camerasResponse.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    expect(cameraId).toBeTruthy();

    const getAsAdmin = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/detection-profile`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(getAsAdmin.statusCode).toBe(200);
    expect(getAsAdmin.json()).toMatchObject({
      data: {
        cameraId,
        tenantId,
        pipelines: expect.any(Array)
      }
    });

    const updateAsAdmin = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/detection-profile`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        pipelines: [
          {
            pipelineId: "person-fast",
            provider: "yolo",
            taskType: "person_detection",
            quality: "fast",
            enabled: true,
            schedule: { mode: "realtime", frameStride: 2 }
          }
        ]
      }
    });
    expect(updateAsAdmin.statusCode).toBe(200);
    expect(updateAsAdmin.json()).toMatchObject({
      data: {
        cameraId,
        tenantId,
        pipelines: [{ pipelineId: "person-fast", provider: "yolo", taskType: "person_detection", quality: "fast" }]
      }
    });

    const monitorToken = await login("monitor@nearhome.dev");
    const updateAsMonitor = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/detection-profile`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        pipelines: []
      }
    });
    expect(updateAsMonitor.statusCode).toBe(403);
  });
});

describe("NH-DP-18 model catalog operations", () => {
  it("allows superuser to create and update model catalog entries", async () => {
    const adminToken = await login("admin@nearhome.dev");

    const createResponse = await app.inject({
      method: "POST",
      url: "/ops/model-catalog",
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        provider: "yolo",
        taskType: "person_detection",
        quality: "balanced",
        modelRef: `yolo-v8-${Date.now()}`,
        displayName: "YOLOv8 Person Balanced",
        resources: { cpu: 2, gpu: 1, vramMb: 2048 },
        status: "active"
      }
    });
    expect(createResponse.statusCode).toBe(200);
    const id = createResponse.json<{ data: { id: string } }>().data.id;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/ops/model-catalog/${id}`,
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        status: "disabled",
        displayName: "YOLOv8 Person Balanced (disabled)"
      }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        id,
        status: "disabled"
      }
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/ops/model-catalog?provider=yolo&taskType=person_detection",
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ data: Array<{ id: string }> }>().data.some((row) => row.id === id)).toBe(true);
  });

  it("denies non-superuser catalog creation", async () => {
    const monitorToken = await login("monitor@nearhome.dev");
    const response = await app.inject({
      method: "POST",
      url: "/ops/model-catalog",
      headers: {
        authorization: `Bearer ${monitorToken}`
      },
      payload: {
        provider: "mediapipe",
        taskType: "pose_estimation",
        quality: "fast",
        modelRef: `mp-pose-${Date.now()}`,
        displayName: "MediaPipe Pose Fast",
        resources: { cpu: 1, gpu: 0, vramMb: 0 },
        status: "active"
      }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("NH-DP-20 detection jobs resolved from camera pipeline", () => {
  it("creates jobs from pipelineId and resolves effective model config from catalog", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef, pipelineId } = await getSeedDetectionJobsFixture(prisma);
    const modelEntry = await prisma.modelCatalogEntry.findFirst({
      where: { modelRef },
      select: { id: true, modelRef: true }
    });
    expect(modelEntry).toBeTruthy();

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        pipelineId,
        source: "snapshot",
        provider: "onprem_bento"
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    expect(createJobResponse.json()).toMatchObject({
      data: {
        cameraId,
        provider: "onprem_bento",
        options: {
          pipelineId,
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced",
          modelRef: modelEntry!.modelRef
        },
        effectiveConfig: {
          pipelineId,
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced",
          modelRef: modelEntry!.modelRef,
          modelCatalogEntryId: modelEntry!.id,
          schedule: {
            mode: "realtime",
            frameStride: 12
          },
          thresholds: {
            minConfidence: 0.7,
            nmsIoU: 0.45
          },
          outputs: {
            storeFaceCrops: true,
            storeEmbeddings: true
          }
        }
      }
    });

    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;
    const getJobResponse = await app.inject({
      method: "GET",
      url: `/detections/jobs/${jobId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(getJobResponse.statusCode).toBe(200);
    expect(getJobResponse.json()).toMatchObject({
      data: {
        id: jobId,
        effectiveConfig: {
          pipelineId,
          modelRef: modelEntry!.modelRef
        }
      }
    });
  });

  it("rejects jobs when the requested pipeline does not exist on the camera profile", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedDetectionJobsFixture(prisma);

    const response = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        pipelineId: "missing-pipeline",
        source: "snapshot",
        provider: "onprem_bento"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "DETECTION_PIPELINE_NOT_FOUND"
    });
  });

  it("rejects jobs when the requested pipeline is disabled", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, pipelineId } = await getSeedDetectionJobsFixture(prisma);
    const profile = await prisma.cameraProfile.findUniqueOrThrow({ where: { cameraId } });
    const previousProfile = profile.detectionProfile;
    const parsed = JSON.parse(profile.detectionProfile) as {
      pipelines: Array<Record<string, unknown>>;
    };

    parsed.pipelines = parsed.pipelines.map((entry) => (entry.pipelineId === pipelineId ? { ...entry, enabled: false } : entry));

    await prisma.cameraProfile.update({
      where: { cameraId },
      data: { detectionProfile: JSON.stringify(parsed) }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/detections/jobs",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        },
        payload: {
          cameraId,
          pipelineId,
          source: "snapshot",
          provider: "onprem_bento"
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "DETECTION_PIPELINE_DISABLED"
      });
    } finally {
      await prisma.cameraProfile.update({
        where: { cameraId },
        data: { detectionProfile: previousProfile }
      });
    }
  });

  it("rejects jobs when the pipeline model is not active in the catalog", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef, pipelineId } = await getSeedDetectionJobsFixture(prisma);

    await prisma.modelCatalogEntry.updateMany({
      where: { modelRef },
      data: { status: "inactive" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/detections/jobs",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        },
        payload: {
          cameraId,
          pipelineId,
          source: "snapshot",
          provider: "onprem_bento"
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "DETECTION_MODEL_NOT_CONFIGURED"
      });
    } finally {
      await prisma.modelCatalogEntry.updateMany({
        where: { modelRef },
        data: { status: "active" }
      });
    }
  });

  it("resolves jobs directly from runtimeProvider, taskType and quality when pipelineId is omitted", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef } = await getSeedDetectionJobsFixture(prisma);
    const modelEntry = await prisma.modelCatalogEntry.findFirstOrThrow({
      where: { modelRef },
      select: { id: true, modelRef: true }
    });

    const response = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced",
          thresholds: {
            minConfidence: 0.82
          },
          outputs: {
            storeFaceCrops: true
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        cameraId,
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced",
          modelRef: modelEntry.modelRef,
          resolvedConfig: {
            runtimeProvider: "yolo",
            taskType: "face_detection",
            quality: "balanced",
            modelRef: modelEntry.modelRef,
            modelCatalogEntryId: modelEntry.id,
            thresholds: {
              minConfidence: 0.82
            },
            outputs: {
              storeFaceCrops: true
            }
          }
        },
        effectiveConfig: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced",
          modelRef: modelEntry.modelRef,
          modelCatalogEntryId: modelEntry.id,
          thresholds: {
            minConfidence: 0.82
          },
          outputs: {
            storeFaceCrops: true
          }
        }
      }
    });
  });

  it("rejects direct resolution when the requested quality has no active catalog entry", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedDetectionJobsFixture(prisma);

    const response = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "accurate"
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "DETECTION_MODEL_NOT_CONFIGURED"
    });
  });

  it("rejects direct resolution when the requested taskType has no active catalog entry", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedDetectionJobsFixture(prisma);

    const response = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "object_detection",
          quality: "balanced"
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "DETECTION_MODEL_NOT_CONFIGURED"
    });
  });
});

describe("NH-DP-21 detection profile validation", () => {
  it("validates catalog resolution and node runtime compatibility for camera pipelines", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef, pipelineId, nodeId } = await getSeedDetectionValidationFixture(prisma);

    const validateResponse = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/detection-profile/validate`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(validateResponse.json()).toMatchObject({
      data: {
        cameraId,
        tenantId,
        valid: true,
        runnable: false,
        inSync: false,
        summary: {
          totalPipelines: 1,
          enabledPipelines: 1,
          validPipelines: 1,
          runnablePipelines: 0,
          driftedPipelines: 1
        },
        pipelines: [
          {
            pipelineId,
            valid: true,
            runnable: false,
            inSync: false,
            resolvedModel: {
              modelRef
            },
            matchingNodes: [
              {
                nodeId,
                runtime: "yolo",
                status: "offline"
              }
            ],
            issues: [
              {
                code: "NO_ACTIVE_NODE"
              }
            ]
          }
        ]
      }
    });
  });

  it("marks pipelines invalid when the matching catalog entry is inactive", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef, pipelineId } = await getSeedDetectionValidationFixture(prisma);

    await prisma.modelCatalogEntry.updateMany({
      where: { modelRef },
      data: { status: "inactive" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/cameras/${cameraId}/detection-profile/validate`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          cameraId,
          tenantId,
          valid: false,
          runnable: false,
          inSync: false,
          summary: {
            totalPipelines: 1,
            enabledPipelines: 1,
            validPipelines: 0,
            runnablePipelines: 0,
            driftedPipelines: 1
          },
          pipelines: [
            {
              pipelineId,
              valid: false,
              runnable: false,
              inSync: false,
              resolvedModel: null,
              issues: [{ code: "MODEL_NOT_CONFIGURED" }]
            }
          ]
        }
      });
    } finally {
      await prisma.modelCatalogEntry.updateMany({
        where: { modelRef },
        data: { status: "active" }
      });
    }
  });

  it("builds an operational topology with a preferred node assignment and allows applying node config", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, modelRef, pipelineId, preferredNodeId, fallbackNodeId } = await getSeedDetectionTopologyFixture(prisma);

    const topologyResponse = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/detection-topology`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(topologyResponse.statusCode).toBe(200);
    expect(topologyResponse.json()).toMatchObject({
      data: {
        cameraId,
        tenantId,
        valid: true,
        runnable: true,
        inSync: true,
        summary: {
          totalPipelines: 1,
          assignedPipelines: 1,
          totalCandidateNodes: 2,
          activeCandidateNodes: 2
        },
        pipelines: [
          {
            pipelineId,
            assignment: {
              status: "assigned",
              primaryNodeId: preferredNodeId
            },
            candidates: [
              {
                nodeId: preferredNodeId,
                role: "primary",
                status: "online"
              },
              {
                nodeId: fallbackNodeId,
                role: "fallback",
                status: "degraded"
              }
            ]
          }
        ]
      }
    });

    const applyResponse = await app.inject({
      method: "POST",
      url: `/ops/nodes/${preferredNodeId}/config/apply`,
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        syncBridgeTenantAssignments: false
      }
    });
    expect(applyResponse.statusCode).toBe(200);
    expect(applyResponse.json()).toMatchObject({
      data: {
        nodeId: preferredNodeId,
        syncedBridgeTenantAssignments: false,
        desiredConfig: {
          nodeId: preferredNodeId,
          tenantIds: [tenantId]
        }
      }
    });
    expect(applyResponse.json<{ data: { appliedAt: string } }>().data.appliedAt).toBeTruthy();
  });

  it("returns an unassigned topology when compatible nodes are no longer assigned to the tenant", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, pipelineId, preferredNodeId, fallbackNodeId } = await getSeedDetectionTopologyFixture(prisma);
    const foreignTenant = await prisma.tenant.findFirstOrThrow({
      where: { name: seedFixtures.tenants.detectionJobs },
      select: { id: true }
    });

    await prisma.inferenceNodeTenantAssignment.deleteMany({
      where: {
        nodeId: { in: [preferredNodeId, fallbackNodeId] },
        tenantId: { in: [tenantId, foreignTenant.id] }
      }
    });
    await prisma.inferenceNodeTenantAssignment.createMany({
      data: [
        { nodeId: preferredNodeId, tenantId: foreignTenant.id },
        { nodeId: fallbackNodeId, tenantId: foreignTenant.id }
      ]
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/cameras/${cameraId}/detection-topology`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          cameraId,
          tenantId,
          valid: true,
          runnable: false,
          inSync: false,
          summary: {
            totalPipelines: 1,
            enabledPipelines: 1,
            validPipelines: 1,
            runnablePipelines: 0,
            driftedPipelines: 1,
            assignedPipelines: 0,
            totalCandidateNodes: 0,
            activeCandidateNodes: 0
          },
          pipelines: [
            {
              pipelineId,
              assignment: {
                status: "unassigned",
                primaryNodeId: null
              },
              candidates: [],
              issues: [{ code: "NO_COMPATIBLE_NODE" }]
            }
          ]
        }
      });
    } finally {
      await prisma.inferenceNodeTenantAssignment.deleteMany({
        where: {
          nodeId: { in: [preferredNodeId, fallbackNodeId] },
          tenantId: { in: [tenantId, foreignTenant.id] }
        }
      });
      await prisma.inferenceNodeTenantAssignment.createMany({
        data: [
          { nodeId: preferredNodeId, tenantId },
          { nodeId: fallbackNodeId, tenantId }
        ]
      });
    }
  });

  it("returns a degraded topology when compatible nodes exist but none are currently runnable", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId, pipelineId, preferredNodeId, fallbackNodeId } = await getSeedDetectionTopologyFixture(prisma);
    const originalSnapshots = await prisma.inferenceNodeSnapshot.findMany({
      where: {
        nodeId: { in: [preferredNodeId, fallbackNodeId] }
      },
      select: {
        nodeId: true,
        status: true,
        isDrained: true
      }
    });

    await prisma.inferenceNodeSnapshot.updateMany({
      where: { nodeId: { in: [preferredNodeId, fallbackNodeId] } },
      data: {
        status: "offline",
        isDrained: false
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/cameras/${cameraId}/detection-topology`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-tenant-id": tenantId
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          cameraId,
          tenantId,
          valid: true,
          runnable: false,
          inSync: false,
          summary: {
            totalPipelines: 1,
            enabledPipelines: 1,
            validPipelines: 1,
            runnablePipelines: 0,
            driftedPipelines: 1,
            assignedPipelines: 0,
            degradedAssignments: 1,
            totalCandidateNodes: 2,
            activeCandidateNodes: 0
          },
          pipelines: [
            {
              pipelineId,
              assignment: {
                status: "degraded",
                primaryNodeId: preferredNodeId
              },
              candidates: [
                {
                  nodeId: preferredNodeId,
                  role: "primary",
                  status: "offline"
                },
                {
                  nodeId: fallbackNodeId,
                  role: "fallback",
                  status: "offline"
                }
              ],
              issues: [{ code: "NO_ACTIVE_NODE" }]
            }
          ]
        }
      });
    } finally {
      for (const snapshot of originalSnapshots) {
        await prisma.inferenceNodeSnapshot.update({
          where: { nodeId: snapshot.nodeId },
          data: {
            status: snapshot.status,
            isDrained: snapshot.isDrained
          }
        });
      }
    }
  });
});

describe("NH-DP-22 detection callback idempotency", () => {
  it("ignores duplicate completion callbacks once the job has already succeeded", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const callbackPayload = {
      detections: [
        {
          label: "face",
          confidence: 0.97,
          bbox: { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
          attributes: {
            embedding: [0.91, 0.09, 0, 0],
            cropStorageKey: "s3://nearhome/faces/idempotent-1.jpg"
          }
        }
      ],
      providerMeta: {
        taskType: "face_detection",
        nodeId: "seed-node-idempotent"
      }
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: callbackPayload
    });
    expect(firstResponse.statusCode).toBe(200);

    const countsAfterFirst = await Promise.all([
      prisma.detectionObservation.count({ where: { jobId } }),
      (prisma as any).faceDetection.count({ where: { tenantId, cameraId } }),
      (prisma as any).faceEmbedding.count({ where: { tenantId } })
    ]);

    const secondResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: callbackPayload
    });
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json<{ data: { status: string } }>().data.status).toBe("succeeded");

    const countsAfterSecond = await Promise.all([
      prisma.detectionObservation.count({ where: { jobId } }),
      (prisma as any).faceDetection.count({ where: { tenantId, cameraId } }),
      (prisma as any).faceEmbedding.count({ where: { tenantId } })
    ]);

    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });
});

describe("NH-DP-23 detection rbac and tenant isolation", () => {
  it("allows client_user to read detection views but forbids profile validation and updates", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const clientToken = await login("client@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const clientUser = await prisma.user.findUniqueOrThrow({
      where: { email: "client@nearhome.dev" },
      select: { id: true }
    });
    await prisma.membership.upsert({
      where: {
        tenantId_userId: {
          tenantId,
          userId: clientUser.id
        }
      },
      update: { role: "client_user" },
      create: {
        tenantId,
        userId: clientUser.id,
        role: "client_user"
      }
    });

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.96,
            bbox: { x: 0.12, y: 0.12, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.88, 0.12, 0, 0],
              cropStorageKey: "s3://nearhome/faces/rbac-1.jpg"
            }
          }
        ],
        providerMeta: {
          taskType: "face_detection",
          nodeId: "seed-node-rbac"
        }
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const readProfile = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/detection-profile`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(readProfile.statusCode).toBe(200);

    const readTopology = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/detection-topology`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(readTopology.statusCode).toBe(200);

    const readFaces = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/faces`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(readFaces.statusCode).toBe(200);
    expect(readFaces.json<{ total: number }>().total).toBe(1);

    const validateProfile = await app.inject({
      method: "POST",
      url: `/cameras/${cameraId}/detection-profile/validate`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(validateProfile.statusCode).toBe(403);

    const updateProfile = await app.inject({
      method: "PUT",
      url: `/cameras/${cameraId}/detection-profile`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        pipelines: []
      }
    });
    expect(updateProfile.statusCode).toBe(403);
  });

  it("forbids client_user face identity confirmation and merge actions", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const clientToken = await login("client@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const clientUser = await prisma.user.findUniqueOrThrow({
      where: { email: "client@nearhome.dev" },
      select: { id: true }
    });
    await prisma.membership.upsert({
      where: {
        tenantId_userId: {
          tenantId,
          userId: clientUser.id
        }
      },
      update: { role: "client_user" },
      create: {
        tenantId,
        userId: clientUser.id,
        role: "client_user"
      }
    });

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          taskType: "face_detection"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.98,
            bbox: { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.9, 0.1, 0, 0],
              cropStorageKey: "s3://nearhome/faces/rbac-a-1.jpg"
            }
          },
          {
            label: "face",
            confidence: 0.97,
            bbox: { x: 0.5, y: 0.2, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0, 0, 0.95, 0.05],
              cropStorageKey: "s3://nearhome/faces/rbac-b-1.jpg"
            }
          }
        ],
        providerMeta: { taskType: "face_detection", nodeId: "seed-node-rbac-2" }
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const clustersResponse = await app.inject({
      method: "GET",
      url: "/faces/clusters",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(clustersResponse.statusCode).toBe(200);
    const clusters = clustersResponse.json<{ data: Array<{ id: string }> }>().data;
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    const confirmAsClient = await app.inject({
      method: "POST",
      url: `/faces/clusters/${clusters[0]!.id}/confirm-identity`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        displayName: "No permitido"
      }
    });
    expect(confirmAsClient.statusCode).toBe(403);

    const confirmedA = await app.inject({
      method: "POST",
      url: `/faces/clusters/${clusters[0]!.id}/confirm-identity`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        displayName: "Persona RBAC A"
      }
    });
    expect(confirmedA.statusCode).toBe(200);
    const targetIdentityId = confirmedA.json<{ data: { id: string } }>().data.id;

    const confirmedB = await app.inject({
      method: "POST",
      url: `/faces/clusters/${clusters[1]!.id}/confirm-identity`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        displayName: "Persona RBAC B"
      }
    });
    expect(confirmedB.statusCode).toBe(200);
    const sourceIdentityId = confirmedB.json<{ data: { id: string } }>().data.id;

    const mergeAsClient = await app.inject({
      method: "POST",
      url: `/faces/identities/${targetIdentityId}/merge`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        sourceIdentityId
      }
    });
    expect(mergeAsClient.statusCode).toBe(403);
  });

  it("keeps detection topology and face data isolated across tenants", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const monitorToken = await login("monitor@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    const monitorMe = await me(monitorToken);
    const foreignTenantId = monitorMe.memberships.find((membership) => membership.tenantId !== tenantId)?.tenantId;
    expect(foreignTenantId).toBeTruthy();

    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.95,
            bbox: { x: 0.2, y: 0.2, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.93, 0.07, 0, 0],
              cropStorageKey: "s3://nearhome/faces/isolation-1.jpg"
            }
          }
        ]
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const topologyAsForeignMonitor = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/detection-topology`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": foreignTenantId!
      }
    });
    expect(topologyAsForeignMonitor.statusCode).toBe(404);

    const facesAsForeignMonitor = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/faces`,
      headers: {
        authorization: `Bearer ${monitorToken}`,
        "x-tenant-id": foreignTenantId!
      }
    });
    expect(facesAsForeignMonitor.statusCode).toBe(404);
  });
});

describe("NH-DP-24 face similarity search", () => {
  it("returns similar faces ranked by embedding similarity", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.98,
            bbox: { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.9, 0.1, 0, 0],
              cropStorageKey: "s3://nearhome/faces/sim-a.jpg"
            }
          },
          {
            label: "face",
            confidence: 0.97,
            bbox: { x: 0.12, y: 0.11, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.89, 0.11, 0, 0],
              cropStorageKey: "s3://nearhome/faces/sim-b.jpg"
            }
          },
          {
            label: "face",
            confidence: 0.95,
            bbox: { x: 0.5, y: 0.2, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0, 0, 0.95, 0.05],
              cropStorageKey: "s3://nearhome/faces/sim-c.jpg"
            }
          }
        ]
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const facesResponse = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/faces`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(facesResponse.statusCode).toBe(200);
    const faces = facesResponse.json<{ data: Array<{ id: string; cropStorageKey?: string | null }> }>().data;
    const sourceFace = faces.find((face) => face.cropStorageKey === "s3://nearhome/faces/sim-a.jpg");
    expect(sourceFace).toBeTruthy();

    const similarResponse = await app.inject({
      method: "GET",
      url: `/faces/detections/${sourceFace!.id}/similar?_start=0&_end=10&minSimilarity=0.5`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(similarResponse.statusCode).toBe(200);
    expect(similarResponse.json()).toMatchObject({
      data: {
        sourceFaceId: sourceFace!.id,
        tenantId,
        total: 1,
        matches: [
          {
            sameCamera: true,
            face: {
              cropStorageKey: "s3://nearhome/faces/sim-b.jpg"
            }
          }
        ]
      }
    });
    const similarityBody = similarResponse.json<{
      data: {
        matches: Array<{ similarityScore: number; face: { cropStorageKey?: string | null } }>;
      };
    }>().data;
    expect(similarityBody.matches[0]!.similarityScore).toBeGreaterThan(0.99);
  });

  it("rejects similarity search when the source face has no stored embedding vector", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          runtimeProvider: "yolo",
          taskType: "face_detection",
          quality: "balanced"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.94,
            bbox: { x: 0.2, y: 0.2, w: 0.15, h: 0.15 },
            attributes: {
              cropStorageKey: "s3://nearhome/faces/no-embedding.jpg"
            }
          }
        ]
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const facesResponse = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/faces`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(facesResponse.statusCode).toBe(200);
    const faceId = facesResponse.json<{ data: Array<{ id: string }> }>().data[0]!.id;

    const similarResponse = await app.inject({
      method: "GET",
      url: `/faces/detections/${faceId}/similar`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(similarResponse.statusCode).toBe(409);
    expect(similarResponse.json()).toMatchObject({
      code: "FACE_SIMILARITY_UNAVAILABLE"
    });
  });
});

describe("NH-DP-19 face clustering and identity management", () => {
  it("stores face detections, auto-clusters similar faces and allows identity confirmation and merge", async () => {
    const adminToken = await login("admin@nearhome.dev");
    const { tenantId, cameraId } = await getSeedFacesFixture(prisma);
    await clearDetectionStateForCamera(prisma, tenantId, cameraId);

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/detections/jobs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        cameraId,
        mode: "realtime",
        source: "snapshot",
        provider: "onprem_bento",
        options: {
          taskType: "face_detection"
        }
      }
    });
    expect(createJobResponse.statusCode).toBe(200);
    const jobId = createJobResponse.json<{ data: { id: string } }>().data.id;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/internal/detections/jobs/${jobId}/complete`,
      headers: {
        "x-detection-callback-secret": "dev-detection-callback-secret"
      },
      payload: {
        detections: [
          {
            label: "face",
            confidence: 0.98,
            bbox: { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.9, 0.1, 0.0, 0.0],
              cropStorageKey: "s3://nearhome/faces/a-1.jpg"
            }
          },
          {
            label: "face",
            confidence: 0.96,
            bbox: { x: 0.12, y: 0.11, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.89, 0.11, 0.0, 0.0],
              cropStorageKey: "s3://nearhome/faces/a-2.jpg"
            }
          },
          {
            label: "face",
            confidence: 0.95,
            bbox: { x: 0.5, y: 0.2, w: 0.15, h: 0.15 },
            attributes: {
              embedding: [0.0, 0.0, 0.95, 0.05],
              cropStorageKey: "s3://nearhome/faces/b-1.jpg"
            }
          }
        ],
        providerMeta: { taskType: "face_detection", nodeId: "node-yolo-face" }
      }
    });
    expect(completeResponse.statusCode).toBe(200);

    const facesResponse = await app.inject({
      method: "GET",
      url: `/cameras/${cameraId}/faces`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(facesResponse.statusCode).toBe(200);
    const facesBody = facesResponse.json<{
      total: number;
      data: Array<{ id: string; cluster?: { id: string }; embedding?: { dimensions: number | null } }>;
    }>();
    expect(facesBody.total).toBe(3);
    expect(facesBody.data.every((face) => face.embedding?.dimensions === 4)).toBe(true);

    const clustersResponse = await app.inject({
      method: "GET",
      url: "/faces/clusters",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(clustersResponse.statusCode).toBe(200);
    const clusters = clustersResponse.json<{
      total: number;
      data: Array<{ id: string; memberCount: number }>;
    }>().data;
    expect(clusters).toHaveLength(2);
    const primaryCluster = clusters.find((cluster) => cluster.memberCount === 2);
    const secondaryCluster = clusters.find((cluster) => cluster.memberCount === 1);
    expect(primaryCluster).toBeTruthy();
    expect(secondaryCluster).toBeTruthy();

    const confirmPrimary = await app.inject({
      method: "POST",
      url: `/faces/clusters/${primaryCluster!.id}/confirm-identity`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        displayName: "Persona A"
      }
    });
    expect(confirmPrimary.statusCode).toBe(200);
    const primaryIdentityId = confirmPrimary.json<{ data: { id: string; memberCount: number } }>().data.id;
    expect(confirmPrimary.json<{ data: { memberCount: number } }>().data.memberCount).toBe(2);

    const confirmSecondary = await app.inject({
      method: "POST",
      url: `/faces/clusters/${secondaryCluster!.id}/confirm-identity`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        displayName: "Persona B"
      }
    });
    expect(confirmSecondary.statusCode).toBe(200);
    const secondaryIdentityId = confirmSecondary.json<{ data: { id: string } }>().data.id;

    const mergeResponse = await app.inject({
      method: "POST",
      url: `/faces/identities/${primaryIdentityId}/merge`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      },
      payload: {
        sourceIdentityId: secondaryIdentityId,
        reason: "confirmed same visitor"
      }
    });
    expect(mergeResponse.statusCode).toBe(200);
    expect(mergeResponse.json<{ data: { memberCount: number } }>().data.memberCount).toBe(3);

    const identityResponse = await app.inject({
      method: "GET",
      url: `/faces/identities/${primaryIdentityId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": tenantId
      }
    });
    expect(identityResponse.statusCode).toBe(200);
    expect(identityResponse.json()).toMatchObject({
      data: {
        id: primaryIdentityId,
        displayName: "Persona A",
        memberCount: 3
      }
    });
  });
});
