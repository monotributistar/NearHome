import { expect, test } from "@playwright/test";
import { loginAsBackoffice, selectTenantByName } from "./support/admin";
import { adminUrl } from "./support/env";
import { seedAdminBrowser } from "./support/seed";

test("NH-DP-UI-01 admin seeded detection flow: overview filters, validation and nodes", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await page.locator(`a[href="${seedAdminBrowser.routes.clientOverview}"]`).click();
  await expect(page.getByRole("heading", { name: "Resumen Cliente" })).toBeVisible();

  await expect(page.getByRole("link", { name: "Ver detalle de cámara" })).toHaveCount(3);

  await page.getByRole("combobox").nth(2).selectOption("ready");
  await expect(page.getByText(seedAdminBrowser.cameraNames.ready)).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.attention)).toHaveCount(0);

  await page.getByRole("combobox").nth(2).selectOption("attention");
  await expect(page.getByText(seedAdminBrowser.cameraNames.attention)).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.idle)).toHaveCount(0);

  await page.getByRole("combobox").nth(2).selectOption("not_configured");
  await expect(page.getByText(seedAdminBrowser.cameraNames.idle)).toBeVisible();

  await page.getByRole("combobox").nth(2).selectOption("all");
  await page.getByPlaceholder("Buscar por cámara, ubicación o detección").fill(seedAdminBrowser.cameraNames.attention);
  await expect(page.getByRole("link", { name: "Ver detalle de cámara" })).toHaveCount(1);
  await page.getByRole("link", { name: "Ver detalle de cámara" }).click();
  await expect(page.getByText(seedAdminBrowser.cameraNames.attention)).toBeVisible();
  await expect(page.getByText("Servicio con atención")).toBeVisible();
  await page.getByRole("button", { name: "Validate against nodes" }).click();
  await expect(page.getByText("valid=true runnable=false inSync=false")).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.pipelineLabels.attention, { exact: true })).toBeVisible();

  await page.locator(`a[href="${seedAdminBrowser.routes.nodes}"]`).click();
  await expect(page.getByRole("heading", { name: "Detection Nodes" })).toBeVisible();
  await page.getByPlaceholder("Buscar por nodeId, endpoint o modelRef").fill(seedAdminBrowser.nodeIds.primary);
  await expect(page.getByRole("button", { name: seedAdminBrowser.nodeIds.primary })).toBeVisible();
  await page.getByRole("button", { name: seedAdminBrowser.nodeIds.primary }).click();
  await expect(page.getByText("Desired vs observed")).toBeVisible();
  await expect(page.getByText("in sync")).toBeVisible();
});

test("NH-DP-UI-02 admin seeded client role: landing stays on client overview", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await page.getByRole("combobox").nth(1).selectOption("client_user");
  await expect(page.getByTestId("current-role")).toContainText("client_user");
  await selectTenantByName(page, seedAdminBrowser.tenantName);
  await page.goto(`${adminUrl}/`);
  await expect(page).toHaveURL(/\/resources\/client-overview/);
  await expect(page.getByRole("heading", { name: "Resumen Cliente" })).toBeVisible();
  await expect(page.getByText(seedAdminBrowser.cameraNames.ready)).toBeVisible();
});

test("NH-DP-UI-03 admin can configure an idle camera detection profile and validate it", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await page.locator(`a[href="${seedAdminBrowser.routes.clientOverview}"]`).click();
  await page.getByPlaceholder("Buscar por cámara, ubicación o detección").fill(seedAdminBrowser.cameraNames.idle);
  await expect(page.getByRole("link", { name: "Ver detalle de cámara" })).toHaveCount(1);
  await page.getByRole("link", { name: "Ver detalle de cámara" }).click();

  await expect(page.getByText(seedAdminBrowser.cameraNames.idle)).toBeVisible();
  await expect(page.getByText("Todavía no hay detecciones activas configuradas.")).toBeVisible();

  const detectionForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save detection profile" }) });
  await detectionForm.getByRole("button", { name: "Add pipeline" }).click();
  await detectionForm.locator("input").first().fill("people-idle");
  await detectionForm.getByRole("button", { name: "Save detection profile" }).click();

  await expect(page.getByText("Detection profile saved")).toBeVisible();
  await expect(page.getByText("Personas", { exact: true })).toBeVisible();

  await detectionForm.getByRole("button", { name: "Validate against nodes" }).click();
  await expect(page.getByText("valid=true runnable=true inSync=true")).toBeVisible();
  await expect(page.getByText("Servicio listo")).toBeVisible();
});

test("NH-DP-UI-04 admin can apply seeded node config from operations", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await page.locator(`a[href="${seedAdminBrowser.routes.nodes}"]`).click();
  await expect(page.getByRole("heading", { name: "Detection Nodes" })).toBeVisible();

  await page.getByPlaceholder("Buscar por nodeId, endpoint o modelRef").fill(seedAdminBrowser.nodeIds.primary);
  await page.getByRole("button", { name: seedAdminBrowser.nodeIds.primary }).click();

  await page.getByRole("button", { name: "Apply desired config" }).click();
  await expect(page.getByText(`Configuración aplicada para ${seedAdminBrowser.nodeIds.primary}`)).toBeVisible();
  await expect(page.getByText("Desired vs observed")).toBeVisible();
  await expect(page.getByText("in sync")).toBeVisible();
});

test("NH-DP-UI-05 client role keeps simplified navigation and sees detection detail as read-only", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await page.getByRole("combobox").nth(1).selectOption("client_user");
  await expect(page.getByTestId("current-role")).toContainText("client_user");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await expect(page.locator(`a[href="${seedAdminBrowser.routes.nodes}"]`)).toHaveCount(0);

  await page.locator(`a[href="${seedAdminBrowser.routes.clientOverview}"]`).click();
  await page.getByPlaceholder("Buscar por cámara, ubicación o detección").fill(seedAdminBrowser.cameraNames.ready);
  await page.getByRole("link", { name: "Ver detalle de cámara" }).click();

  await expect(page.getByText("Client Summary")).toBeVisible();
  await expect(page.getByText("Servicio listo")).toBeVisible();
  await expect(page.getByText("Vista de solo lectura para el detection profile en este rol.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate against nodes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save detection profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add pipeline" })).toHaveCount(0);
});

test("NH-DP-UI-06 admin can investigate faces, associate a cluster and merge identities", async ({ page }) => {
  await loginAsBackoffice(page, "admin@nearhome.dev");
  await selectTenantByName(page, seedAdminBrowser.tenantName);

  await page.locator(`a[href="${seedAdminBrowser.routes.clientOverview}"]`).click();
  await page.getByPlaceholder("Buscar por cámara, ubicación o detección").fill(seedAdminBrowser.cameraNames.ready);
  await page.getByRole("link", { name: "Ver detalle de cámara" }).click();

  await expect(page.getByText("Face Library")).toBeVisible();
  await page.getByRole("button", { name: new RegExp(seedAdminBrowser.faceLabels.open) }).click();
  await expect(page.getByText("Sin confirmar")).toBeVisible();
  await page.getByRole("button", { name: `Usar ${seedAdminBrowser.identityNames.maria}` }).click();
  await expect(page.getByText(`Identidad confirmada: ${seedAdminBrowser.identityNames.maria}`)).toBeVisible();

  await page.getByRole("button", { name: new RegExp(seedAdminBrowser.faceLabels.mergeSource) }).click();
  await expect(page.getByText("Identidad actual").locator("..").getByText(seedAdminBrowser.identityNames.mergeSource)).toBeVisible();
  await page.getByRole("button", { name: `Merge hacia ${seedAdminBrowser.identityNames.mergeTarget}` }).first().click();
  await expect(page.getByText(`Merge aplicado hacia ${seedAdminBrowser.identityNames.mergeTarget}`)).toBeVisible();
});
