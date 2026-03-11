import { expect, test } from "@playwright/test";
import { adminUrl, apiUrl } from "./support/env";

async function loginApi(request: import("@playwright/test").APIRequestContext, email: string, audience: "backoffice" | "portal") {
  const response = await request.post(`${apiUrl}/auth/login`, {
    headers: { "Content-Type": "application/json" },
    data: { email, password: "demo1234", audience }
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { accessToken: string };
}

test("NH-043 e2e admin commercial: approve subscription request created by client", async ({ page, request }) => {
  const unique = Date.now();
  const proofFileName = `nh043-e2e-${unique}.jpg`;

  const clientLogin = await loginApi(request, "client@nearhome.dev", "portal");
  const clientMeResponse = await request.get(`${apiUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${clientLogin.accessToken}` }
  });
  expect(clientMeResponse.ok()).toBeTruthy();
  const clientMe = (await clientMeResponse.json()) as { memberships: Array<{ tenantId: string }> };
  const tenantId = clientMe.memberships[0]?.tenantId;
  expect(tenantId).toBeTruthy();

  const plansResponse = await request.get(`${apiUrl}/plans`, {
    headers: { Authorization: `Bearer ${clientLogin.accessToken}` }
  });
  expect(plansResponse.ok()).toBeTruthy();
  const plansPayload = (await plansResponse.json()) as { data: Array<{ id: string }> };
  const planId = plansPayload.data[0]?.id;
  expect(planId).toBeTruthy();

  const createRequest = await request.post(`${apiUrl}/subscriptions/requests`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${clientLogin.accessToken}`,
      "X-Tenant-Id": tenantId!
    },
    data: {
      planId,
      notes: "Solicitud e2e NH-043",
      proof: {
        imageUrl: `https://cdn.nearhome.dev/e2e/${proofFileName}`,
        fileName: proofFileName,
        mimeType: "image/jpeg",
        sizeBytes: 198442
      }
    }
  });
  expect(createRequest.ok()).toBeTruthy();

  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("NearHome Admin")).toBeVisible();

  const tenantSelector = page.getByRole("combobox").first();
  await expect(tenantSelector).not.toHaveValue("");
  await tenantSelector.selectOption(tenantId!);

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();

  const requestRow = page.locator("tr", { hasText: proofFileName });
  await expect(requestRow).toBeVisible();
  await expect(requestRow.getByText("pending_review")).toBeVisible();

  await requestRow.getByRole("button", { name: "Aprobar" }).click();
  await expect(page).toHaveURL(/\/commercial\/subscriptions/);

  const approvedRow = page.locator("tr", { hasText: proofFileName });
  await expect(approvedRow).toBeVisible();
  await expect(approvedRow.getByText("approved")).toBeVisible();
});
