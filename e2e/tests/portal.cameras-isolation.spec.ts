import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUrl, portalUrl } from "./support/env";

const API_URL = apiUrl;
const PORTAL_URL = portalUrl;

type TenantCtx = {
  id: string;
  name: string;
};

type CameraSeed = {
  id: string;
  name: string;
  tenantId: string;
  rtspUrl: string;
};

function realRtspPool() {
  const values = [process.env.E2E_REAL_CAM1_RTSP, process.env.E2E_REAL_CAM2_RTSP].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return values;
}

async function login(request: APIRequestContext, email: string, password: string) {
  const response = await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.accessToken as string;
}

async function me(request: APIRequestContext, token: string) {
  const response = await request.get(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("NH-031 e2e cameras isolation: 10 cameras split across tenants for monitor/client", async ({ page, request }) => {
  const adminToken = await login(request, "admin@nearhome.dev", "demo1234");
  const monitorToken = await login(request, "monitor@nearhome.dev", "demo1234");
  const clientToken = await login(request, "client@nearhome.dev", "demo1234");

  const monitorMe = await me(request, monitorToken);
  const clientMe = await me(request, clientToken);
  const monitorUserId = monitorMe.user.id as string;
  const clientUserId = clientMe.user.id as string;

  const unique = Date.now();
  const tenantNames = [
    `E2E CAM TENANT A ${unique}`,
    `E2E CAM TENANT B ${unique}`,
    `E2E CAM TENANT C ${unique}`
  ];

  const tenants: TenantCtx[] = [];
  for (const name of tenantNames) {
    const response = await request.post(`${API_URL}/tenants`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name }
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    tenants.push({ id: body.data.id as string, name });
  }

  // monitor can switch between tenant A and B; client_user only belongs to tenant A.
  for (const assignment of [
    { tenantId: tenants[0].id, userId: monitorUserId, role: "monitor" },
    { tenantId: tenants[1].id, userId: monitorUserId, role: "monitor" },
    { tenantId: tenants[0].id, userId: clientUserId, role: "client_user" }
  ]) {
    const response = await request.post(`${API_URL}/memberships`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "X-Tenant-Id": assignment.tenantId
      },
      data: { userId: assignment.userId, role: assignment.role }
    });
    expect(response.ok()).toBeTruthy();
  }

  const realPool = realRtspPool();
  const fallbackRtsp = (tenantIdx: number, cameraIdx: number) => `rtsp://demo/e2e-t${tenantIdx + 1}-c${cameraIdx + 1}-${unique}`;
  const seeded: CameraSeed[] = [];
  let globalCounter = 0;
  const perTenant = [4, 3, 3];
  for (let t = 0; t < tenants.length; t += 1) {
    for (let i = 0; i < perTenant[t]; i += 1) {
      const rtsp = realPool[globalCounter] ?? fallbackRtsp(t, i);
      const name = `E2E-CAM-T${t + 1}-${i + 1}-${unique}`;
      const response = await request.post(`${API_URL}/cameras`, {
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "X-Tenant-Id": tenants[t].id
        },
        data: {
          name,
          rtspUrl: rtsp,
          location: `Zone-${t + 1}`,
          tags: ["e2e", "tenant-isolation", t === 0 && i < realPool.length ? "real" : "mock"],
          isActive: true
        }
      });
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      seeded.push({ id: body.data.id as string, name, tenantId: tenants[t].id, rtspUrl: rtsp });
      globalCounter += 1;
    }
  }
  expect(seeded).toHaveLength(10);

  const tenantACams = seeded.filter((camera) => camera.tenantId === tenants[0].id);
  const tenantBCams = seeded.filter((camera) => camera.tenantId === tenants[1].id);
  const tenantCCams = seeded.filter((camera) => camera.tenantId === tenants[2].id);

  const listCameras = async (token: string, tenantId: string) => {
    const response = await request.get(`${API_URL}/cameras?_start=0&_end=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });
    return response;
  };

  const monitorTenantAList = await listCameras(monitorToken, tenants[0].id);
  expect(monitorTenantAList.status()).toBe(200);
  const monitorTenantAData = (await monitorTenantAList.json()).data as Array<{ name: string }>;
  for (const camera of tenantACams) expect(monitorTenantAData.some((entry) => entry.name === camera.name)).toBeTruthy();
  for (const camera of tenantCCams) expect(monitorTenantAData.some((entry) => entry.name === camera.name)).toBeFalsy();

  const monitorTenantBList = await listCameras(monitorToken, tenants[1].id);
  expect(monitorTenantBList.status()).toBe(200);
  const monitorTenantBData = (await monitorTenantBList.json()).data as Array<{ name: string }>;
  for (const camera of tenantBCams) expect(monitorTenantBData.some((entry) => entry.name === camera.name)).toBeTruthy();
  for (const camera of tenantACams) expect(monitorTenantBData.some((entry) => entry.name === camera.name)).toBeFalsy();

  const monitorTenantCList = await listCameras(monitorToken, tenants[2].id);
  expect(monitorTenantCList.status()).toBe(403);

  const clientTenantAList = await listCameras(clientToken, tenants[0].id);
  expect(clientTenantAList.status()).toBe(200);
  const clientTenantAData = (await clientTenantAList.json()).data as Array<{ name: string }>;
  for (const camera of tenantACams) expect(clientTenantAData.some((entry) => entry.name === camera.name)).toBeTruthy();
  const clientTenantBList = await listCameras(clientToken, tenants[1].id);
  expect(clientTenantBList.status()).toBe(403);

  // Resource-level isolation: camera from tenant B is not readable under tenant A scope.
  const crossCamera = tenantBCams[0];
  const crossRead = await request.get(`${API_URL}/cameras/${crossCamera.id}`, {
    headers: {
      Authorization: `Bearer ${monitorToken}`,
      "X-Tenant-Id": tenants[0].id
    }
  });
  expect(crossRead.status()).toBe(404);

  const loginPortal = async (email: string, password: string) => {
    await page.goto(`${PORTAL_URL}/login`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.locator('a[href="/operations/cameras"]').click();
  };

  const assertTenantView = async (tenantName: string, expected: string[], forbidden: string[]) => {
    await page.getByRole("combobox").first().selectOption({ label: tenantName });
    for (const cameraName of expected) await expect(page.getByText(cameraName)).toBeVisible();
    for (const cameraName of forbidden) await expect(page.getByText(cameraName)).toHaveCount(0);
  };

  await loginPortal("monitor@nearhome.dev", "demo1234");
  await assertTenantView(
    tenants[0].name,
    [tenantACams[0].name, tenantACams[1].name],
    [tenantBCams[0].name, tenantCCams[0].name]
  );
  await assertTenantView(
    tenants[1].name,
    [tenantBCams[0].name, tenantBCams[1].name],
    [tenantACams[0].name, tenantCCams[0].name]
  );
  await expect(page.getByRole("combobox").first().getByRole("option", { name: tenants[2].name })).toHaveCount(0);

  await page.getByRole("button", { name: "Logout" }).click();
  await loginPortal("client@nearhome.dev", "demo1234");
  await expect(page.getByRole("combobox").first().getByRole("option", { name: tenants[0].name })).toHaveCount(1);
  await expect(page.getByRole("combobox").first().getByRole("option", { name: tenants[1].name })).toHaveCount(0);
  await expect(page.getByRole("combobox").first().getByRole("option", { name: tenants[2].name })).toHaveCount(0);
  await page.getByRole("combobox").first().selectOption({ label: tenants[0].name });
  await expect(page.getByText(tenantACams[0].name)).toBeVisible();
  await expect(page.getByText(tenantBCams[0].name)).toHaveCount(0);
  await expect(page.getByText(tenantCCams[0].name)).toHaveCount(0);
});
