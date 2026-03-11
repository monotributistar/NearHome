import { expect, test } from "@playwright/test";
import { apiUrl, portalUrl } from "./support/env";

test("NH-056 portal smoke: client onboarding camera + realtime + subscription request", async ({ page, request }) => {
  const unique = Date.now();
  const cameraName = `Portal NH056 Cam ${unique}`;
  const API_URL = apiUrl;

  const adminLogin = await request.post(`${API_URL}/auth/login`, {
    headers: { "Content-Type": "application/json" },
    data: { email: "admin@nearhome.dev", password: "demo1234", audience: "backoffice" }
  });
  expect(adminLogin.ok()).toBeTruthy();
  const adminToken = (await adminLogin.json()) as { accessToken: string };

  const adminMeResponse = await request.get(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${adminToken.accessToken}` }
  });
  expect(adminMeResponse.ok()).toBeTruthy();
  const adminMe = (await adminMeResponse.json()) as { memberships: Array<{ tenantId: string }> };
  const tenantId = adminMe.memberships[0]?.tenantId;
  expect(tenantId).toBeTruthy();

  const plansResponse = await request.get(`${API_URL}/plans`, {
    headers: { Authorization: `Bearer ${adminToken.accessToken}` }
  });
  expect(plansResponse.ok()).toBeTruthy();
  const plansPayload = (await plansResponse.json()) as {
    data: Array<{ id: string; limits: { maxCameras?: number } }>;
  };
  const selectedPlan = [...plansPayload.data].sort((a, b) => (b.limits?.maxCameras ?? 0) - (a.limits?.maxCameras ?? 0))[0];
  expect(selectedPlan?.id).toBeTruthy();

  const setSubscription = await request.post(`${API_URL}/tenants/${tenantId}/subscription`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken.accessToken}`,
      "X-Tenant-Id": tenantId!
    },
    data: { planId: selectedPlan.id }
  });
  expect(setSubscription.ok()).toBeTruthy();

  await page.goto(`${portalUrl}/login`);

  await page.getByLabel("Email").fill("client@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome App")).toBeVisible();
  const tenantSelector = page.getByRole("combobox").first();
  await expect(tenantSelector).not.toHaveValue("");
  const activeTenant = await tenantSelector.inputValue();
  await tenantSelector.selectOption(activeTenant);

  await page.locator('a[href="/operations/cameras"]').click();
  await expect(page.getByText("Cámaras RTSP")).toBeVisible();

  await page.getByPlaceholder("Nombre cámara").fill(cameraName);
  await page.getByPlaceholder("RTSP URL").fill(`rtsp://demo/nh056-${unique}`);
  await page.getByPlaceholder("Ubicación").fill("Entrada principal");
  await page.getByRole("button", { name: "Crear" }).click();
  await expect(page.getByText(cameraName)).toBeVisible();

  const createdRow = page.locator("tr", { hasText: cameraName });
  await createdRow.getByRole("link", { name: "Abrir" }).click();
  await expect(page.getByText(/Viewer mock/)).toBeVisible();

  await page.getByRole("button", { name: "Validar cámara" }).click();
  await expect(page.getByText("Lifecycle:")).toBeVisible();

  const streamResponse = page.waitForResponse(
    (res) => res.url().includes("/stream-token") && res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Get stream token" }).click();
  const response = await streamResponse;
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(200);
  await expect(page.getByTestId("stream-session-status")).toContainText("issued");

  await page.getByTestId("stream-activate").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("active");

  await page.getByTestId("stream-end").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("ended");

  await page.locator('a[href="/operations/events"]').click();
  await expect(page.getByText("Events")).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.locator('a[href="/operations/realtime"]').click();
  await expect(page.getByText("Realtime stream")).toBeVisible();
  await expect(page.getByPlaceholder("topics csv (incident,detection,stream,notification)")).toHaveValue(
    "incident,detection,stream,notification"
  );

  await page.locator('a[href="/account/subscriptions"]').click();
  await expect(page.getByText("Suscripción y comprobantes")).toBeVisible();
  await page.getByPlaceholder("URL comprobante").fill(`https://cdn.nearhome.dev/e2e/nh056-${unique}.jpg`);
  await page.getByPlaceholder("Nombre archivo").fill(`nh056-${unique}.jpg`);
  await page.getByPlaceholder("Tamaño bytes").fill("245000");
  await page.getByPlaceholder("Notas").fill("Comprobante e2e NH-056");
  await page.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(page.getByText("Solicitud enviada para revisión")).toBeVisible();
  await expect(page.getByText("pending_review").first()).toBeVisible();
});
