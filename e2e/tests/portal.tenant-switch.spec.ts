import { expect, test } from "@playwright/test";
import { loginToPortal, selectPortalTenant } from "./support/portal";
import { seedPortalBrowser } from "./support/seed";

test("NH-030 portal monitor tenant switch shows only seeded tenant cameras", async ({ page }) => {
  await loginToPortal(page, "monitor@nearhome.dev");

  await selectPortalTenant(page, seedPortalBrowser.scopeTenantNames.a);
  await page.locator(`a[href="${seedPortalBrowser.routes.cameras}"]`).click();
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeA)).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeB)).toHaveCount(0);

  await selectPortalTenant(page, seedPortalBrowser.scopeTenantNames.b);
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeB)).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeA)).toHaveCount(0);

  await page.getByRole("button", { name: "Logout" }).click();
  await loginToPortal(page, "client@nearhome.dev");
  const tenantSelector = page.getByRole("combobox").first();
  await expect(tenantSelector.getByRole("option", { name: seedPortalBrowser.scopeTenantNames.a })).toHaveCount(1);
  await expect(tenantSelector.getByRole("option", { name: seedPortalBrowser.scopeTenantNames.b })).toHaveCount(0);
  await selectPortalTenant(page, seedPortalBrowser.scopeTenantNames.a);
  await page.locator(`a[href="${seedPortalBrowser.routes.cameras}"]`).click();
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeA)).toBeVisible();
  await expect(page.getByText(seedPortalBrowser.cameraNames.scopeB)).toHaveCount(0);
});
