import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsBackoffice, selectTenantByName } from "./support/admin";
import { adminUrl, apiUrl } from "./support/env";

const API_URL = apiUrl;
const ADMIN_URL = adminUrl;

/**
 * NH-E2E-ADM-001: Admin creates tenant via API, verifies in Admin UI
 *
 * Flow: Login admin → create tenant via API → verify in tenant selector
 */
test("admin: create tenant via API and verify in UI", async ({ page, request }) => {
  // Login admin
  await loginAsBackoffice(page, "admin@nearhome.dev");

  // Create tenant via API
  const unique = Date.now();
  const tenantName = `E2E Admin Tenant ${unique}`;
  const loginResp = await request.post(`${API_URL}/auth/login`, {
    data: { email: "admin@nearhome.dev", password: "demo1234" },
  });
  expect(loginResp.ok()).toBeTruthy();
  const token = (await loginResp.json()).accessToken;

  const tenantResp = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { name: tenantName },
  });
  expect(tenantResp.ok()).toBeTruthy();
  const tenantId = (await tenantResp.json()).data.id;

  // Verify in Admin UI tenant selector
  await page.reload();
  await page.waitForTimeout(500);
  const tenantSelector = page.getByRole("combobox").first();
  await expect(tenantSelector).toBeVisible();

  // Select the newly created tenant
  await tenantSelector.selectOption({ label: tenantName });
  await expect(tenantSelector).toHaveText(new RegExp(tenantName));
});

/**
 * NH-E2E-ADM-002: Admin creates camera via API, verifies via API
 *
 * Flow: Login admin → create tenant → create camera → verify camera exists
 */
test("admin: create camera via API with tenant scoping", async ({ request }) => {
  const unique = Date.now();

  // Login
  const loginResp = await request.post(`${API_URL}/auth/login`, {
    data: { email: "admin@nearhome.dev", password: "demo1234" },
  });
  const token = (await loginResp.json()).accessToken;

  // Create tenant
  const tenantResp = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { name: `E2E Cam Tenant ${unique}` },
  });
  const tenantId = (await tenantResp.json()).data.id;

  // Create camera with RTSP URL
  const camResp = await request.post(`${API_URL}/cameras`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": tenantId,
      "content-type": "application/json",
    },
    data: {
      name: `E2E Camera ${unique}`,
      rtspUrl: `rtsp://demo/e2e-${unique}`,
      location: "E2E Test Location",
      tags: ["e2e", "admin-crud"],
      isActive: true,
    },
  });
  expect(camResp.ok()).toBeTruthy();
  const camData = (await camResp.json()).data;
  expect(camData.name).toContain("E2E Camera");
  expect(camData.rtspUrl).toContain("rtsp://");
  expect(camData.lifecycleStatus).toBe("provisioning");

  // Validate camera
  const validateResp = await request.post(`${API_URL}/cameras/${camData.id}/validate`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": tenantId,
      "content-type": "application/json",
    },
    data: { simulate: "pass" },
  });
  expect(validateResp.ok()).toBeTruthy();
  const validated = (await validateResp.json()).data;
  expect(validated.lifecycleStatus).toBe("ready");
});

/**
 * NH-E2E-ADM-003: Admin lists cameras with proper tenant isolation
 *
 * Flow: Create 2 tenants → create camera in each → verify lists are isolated
 */
test("admin: camera list isolation across tenants", async ({ request }) => {
  const unique = Date.now();

  const loginResp = await request.post(`${API_URL}/auth/login`, {
    data: { email: "admin@nearhome.dev", password: "demo1234" },
  });
  const token = (await loginResp.json()).accessToken;

  // Create Tenant A
  const tA = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { name: `E2E Iso A ${unique}` },
  });
  const tidA = (await tA.json()).data.id;

  // Create Tenant B
  const tB = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { name: `E2E Iso B ${unique}` },
  });
  const tidB = (await tB.json()).data.id;

  // Camera in Tenant A
  const camA = await request.post(`${API_URL}/cameras`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tidA, "content-type": "application/json" },
    data: { name: `Cam-A-${unique}`, rtspUrl: "rtsp://demo/a", isActive: true },
  });
  const cidA = (await camA.json()).data.id;

  // Camera in Tenant B
  const camB = await request.post(`${API_URL}/cameras`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tidB, "content-type": "application/json" },
    data: { name: `Cam-B-${unique}`, rtspUrl: "rtsp://demo/b", isActive: true },
  });
  const cidB = (await camB.json()).data.id;

  // Tenant A list must NOT include Tenant B camera
  const listA = await request.get(`${API_URL}/cameras?_start=0&_end=50`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tidA },
  });
  const dataA = (await listA.json()).data;
  const namesA = dataA.map((c: any) => c.name);
  expect(namesA).toContain(`Cam-A-${unique}`);
  expect(namesA).not.toContain(`Cam-B-${unique}`);

  // Tenant B list must NOT include Tenant A camera
  const listB = await request.get(`${API_URL}/cameras?_start=0&_end=50`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tidB },
  });
  const dataB = (await listB.json()).data;
  const namesB = dataB.map((c: any) => c.name);
  expect(namesB).toContain(`Cam-B-${unique}`);
  expect(namesB).not.toContain(`Cam-A-${unique}`);

  // Cross-tenant read must 404
  const crossRead = await request.get(`${API_URL}/cameras/${cidB}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tidA },
  });
  expect(crossRead.status()).toBe(404);
});

/**
 * NH-E2E-ADM-004: Admin provisions stream and gets playback URL
 *
 * Flow: Create tenant+camera → validate → get stream token → verify playback URL
 */
test("admin: stream token provisioning with playback URL", async ({ request }) => {
  const unique = Date.now();

  const loginResp = await request.post(`${API_URL}/auth/login`, {
    data: { email: "admin@nearhome.dev", password: "demo1234" },
  });
  const token = (await loginResp.json()).accessToken;

  const tResp = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { name: `E2E Stream ${unique}` },
  });
  const tid = (await tResp.json()).data.id;

  const cResp = await request.post(`${API_URL}/cameras`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tid, "content-type": "application/json" },
    data: { name: `Stream Cam ${unique}`, rtspUrl: `rtsp://demo/stream-${unique}`, isActive: true },
  });
  const cid = (await cResp.json()).data.id;

  // Validate
  await request.post(`${API_URL}/cameras/${cid}/validate`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tid, "content-type": "application/json" },
    data: { simulate: "pass" },
  });

  // Get stream token
  const streamResp = await request.post(`${API_URL}/cameras/${cid}/stream-token`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tid, "content-type": "application/json" },
    data: {},
  });
  expect(streamResp.ok()).toBeTruthy();
  const streamData = (await streamResp.json());
  expect(streamData.token).toBeTruthy();
  expect(streamData.playbackUrl).toBeTruthy();
  expect(streamData.playbackUrl).toContain("index.m3u8");
  expect(streamData.playbackUrl).toContain(tid);
  expect(streamData.playbackUrl).toContain(cid);
});
