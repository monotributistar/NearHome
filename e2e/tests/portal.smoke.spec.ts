import { expect, test } from "@playwright/test";
import { loginToPortal, selectPortalTenant } from "./support/portal";
import { seedPortalBrowser } from "./support/seed";

test("NH-056 portal smoke: seeded cameras + stream + events + subscription", async ({ page }) => {
  await loginToPortal(page, "client@nearhome.dev");
  await selectPortalTenant(page, seedPortalBrowser.tenantName);

  await page.locator(`a[href="${seedPortalBrowser.routes.cameras}"]`).click();
  await expect(page.getByText("Cámaras RTSP")).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.cameraNames.ready)).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.cameraNames.entry)).toBeVisible();

  const readyRow = page.locator("tr", { hasText: seedPortalBrowser.cameraNames.ready });
  await readyRow.getByRole("link", { name: "Abrir" }).click();
  await expect(page.getByText(/Viewer mock/)).toBeVisible();
  await expect(page.getByText("Location: Portal Seed Lobby")).toBeVisible();

  const streamResponse = page.waitForResponse((res) => res.url().includes("/stream-token") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Get stream token" }).click();
  const response = await streamResponse;
  expect(response.status()).toBe(200);
  await expect(page.getByTestId("stream-session-status")).toContainText("issued");

  await page.getByTestId("stream-activate").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("active");

  await page.getByTestId("stream-end").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("ended");

  await page.locator(`a[href="${seedPortalBrowser.routes.events}"]`).click();
  await expect(page.getByText("Events")).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.locator(`a[href="${seedPortalBrowser.routes.realtime}"]`).click();
  await expect(page.getByText("Realtime stream")).toBeVisible();
  await expect(page.getByPlaceholder("topics csv (incident,detection,stream,notification)")).toHaveValue(
    "incident,detection,stream,notification"
  );

  await page.locator(`a[href="${seedPortalBrowser.routes.subscriptions}"]`).click();
  await expect(page.getByText("Suscripción y comprobantes")).toBeVisible();
  await expect(page.getByText("Plan activo: Pro")).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.requestFileName)).toBeVisible();
  await expect(page.getByText("pending_review").first()).toBeVisible();
});
