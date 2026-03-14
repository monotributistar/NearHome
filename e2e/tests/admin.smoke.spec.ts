import { expect, test } from "@playwright/test";
import { loginAsBackoffice, selectTenantByName } from "./support/admin";
import { seedAdminBrowser } from "./support/seed";

test("NH-006 admin smoke: seeded client overview + camera detail", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await page.locator(`a[href="${seedAdminBrowser.routes.clientOverview}"]`).click();
  await expect(page.getByRole("heading", { name: "Resumen Cliente" })).toBeVisible();
  await expect(page.getByText("Cantidad total visible para este tenant")).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.ready)).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.attention)).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.idle)).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver detalle de cámara" })).toHaveCount(3);

  await page.getByPlaceholder("Buscar por cámara, ubicación o detección").fill(seedAdminBrowser.cameraNames.ready);
  await expect(page.getByRole("link", { name: "Ver detalle de cámara" })).toHaveCount(1);
  await page.getByRole("link", { name: "Ver detalle de cámara" }).click();
  await expect(page).toHaveURL(new RegExp("/resources/cameras/"));
  await expect(page.getByText("Client Summary")).toBeVisible();
  await expect(page.getByText("Servicio listo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate against nodes" })).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.pipelineLabels.ready, { exact: true })).toBeVisible();
});
