import { expect, test, type Page } from "@playwright/test";
import { adminUrl, apiUrl } from "./support/env";

async function loginAs(page: Page, email: string, password = "demo1234") {
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("NearHome Admin")).toBeVisible();
}

test("NH-023 admin rbac monitor: read-only in users/cameras/subscriptions", async ({ page }) => {
  await loginAs(page, "monitor@nearhome.dev");
  await expect(page.getByTestId("current-role")).toHaveText("monitor");

  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.locator('a[href="/identity/users"]').click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByTestId("users-create-form")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});

test("NH-024 admin rbac client_user: no camera create/edit", async ({ page }) => {
  await loginAs(page, "client@nearhome.dev");
  const roleBadge = page.getByTestId("current-role");
  if ((await roleBadge.count()) === 0) {
    await expect(page).toHaveURL(/\/login/);
    return;
  }
  await expect(roleBadge).toBeVisible();

  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});

test("NH-043 admin rbac monitor: cannot review subscription requests", async ({ page, request }) => {
  const clientLogin = await request.post(`${apiUrl}/auth/login`, {
    headers: { "Content-Type": "application/json" },
    data: { email: "client@nearhome.dev", password: "demo1234", audience: "portal" }
  });
  expect(clientLogin.ok()).toBeTruthy();
  const clientToken = (await clientLogin.json()) as { accessToken: string };

  const clientMeResponse = await request.get(`${apiUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${clientToken.accessToken}` }
  });
  expect(clientMeResponse.ok()).toBeTruthy();
  const clientMe = (await clientMeResponse.json()) as { memberships: Array<{ tenantId: string }> };
  const tenantId = clientMe.memberships[0]?.tenantId;
  expect(tenantId).toBeTruthy();

  const plansResponse = await request.get(`${apiUrl}/plans`, {
    headers: { Authorization: `Bearer ${clientToken.accessToken}` }
  });
  expect(plansResponse.ok()).toBeTruthy();
  const plansPayload = (await plansResponse.json()) as { data: Array<{ id: string }> };
  const planId = plansPayload.data[0]?.id;
  expect(planId).toBeTruthy();

  const proofFileName = `nh043-monitor-rbac-${Date.now()}.jpg`;
  const createRequest = await request.post(`${apiUrl}/subscriptions/requests`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${clientToken.accessToken}`,
      "X-Tenant-Id": tenantId!
    },
    data: {
      planId,
      proof: {
        imageUrl: `https://cdn.nearhome.dev/e2e/${proofFileName}`,
        fileName: proofFileName,
        mimeType: "image/jpeg",
        sizeBytes: 123000
      }
    }
  });
  expect(createRequest.ok()).toBeTruthy();

  await loginAs(page, "monitor@nearhome.dev");
  const tenantSelector = page.getByRole("combobox").first();
  await tenantSelector.selectOption(tenantId!);

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();

  const requestRow = page.locator("tr", { hasText: proofFileName });
  await expect(requestRow).toBeVisible();
  await expect(requestRow.getByText("pending_review")).toBeVisible();
  await expect(requestRow.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
  await expect(requestRow.getByRole("button", { name: "Rechazar" })).toHaveCount(0);
});
