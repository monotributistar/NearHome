import { expect, test } from "@playwright/test";

const API_URL = "http://localhost:3001";

test("NH-030 portal monitor tenant switch shows only assigned tenant cameras", async ({ page, request }) => {
  const adminLogin = await request.post(`${API_URL}/auth/login`, {
    data: { email: "admin@nearhome.dev", password: "demo1234" }
  });
  expect(adminLogin.ok()).toBeTruthy();
  const adminToken = (await adminLogin.json()).accessToken as string;

  const monitorLogin = await request.post(`${API_URL}/auth/login`, {
    data: { email: "monitor@nearhome.dev", password: "demo1234" }
  });
  expect(monitorLogin.ok()).toBeTruthy();
  const monitorToken = (await monitorLogin.json()).accessToken as string;

  const monitorMeResponse = await request.get(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${monitorToken}` }
  });
  expect(monitorMeResponse.ok()).toBeTruthy();
  const monitorMe = await monitorMeResponse.json();
  const monitorUserId = monitorMe.user.id as string;

  const unique = Date.now();
  const tenantName = `Monitor Portal Tenant ${unique}`;
  const cameraName = `Portal Scoped Cam ${unique}`;

  const createTenantResponse = await request.post(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name: tenantName }
  });
  expect(createTenantResponse.ok()).toBeTruthy();
  const tenantId = (await createTenantResponse.json()).data.id as string;

  const assignMembershipResponse = await request.post(`${API_URL}/memberships`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "X-Tenant-Id": tenantId
    },
    data: {
      userId: monitorUserId,
      role: "monitor"
    }
  });
  expect(assignMembershipResponse.ok()).toBeTruthy();

  const createCameraResponse = await request.post(`${API_URL}/cameras`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "X-Tenant-Id": tenantId
    },
    data: {
      name: cameraName,
      rtspUrl: "rtsp://demo/portal-scoped",
      isActive: true
    }
  });
  expect(createCameraResponse.ok()).toBeTruthy();

  await page.goto("http://localhost:4174/login");
  await page.getByLabel("Email").fill("monitor@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByText(cameraName)).toHaveCount(0);

  await page.locator(".navbar select").selectOption({ label: tenantName });
  await expect(page.getByText(cameraName)).toBeVisible();
});
