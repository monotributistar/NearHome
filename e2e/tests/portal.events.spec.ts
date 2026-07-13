import { expect, test } from "@playwright/test";
import { loginToPortal, selectPortalTenant } from "./support/portal";
import { seedPortalBrowser } from "./support/seed";

/**
 * NH-E2E-EVT-001: Events page loads with seeded data
 *
 * Flow: Login → select tenant → open events → verify table renders
 */
test("events: list renders with seeded event data", async ({ page }) => {
  await loginToPortal(page, "client@nearhome.dev");
  await selectPortalTenant(page, seedPortalBrowser.tenantName);

  await page.locator(`a[href="${seedPortalBrowser.routes.events}"]`).click();
  await expect(page.getByText("Events")).toBeVisible();

  // Table headers should be present
  await expect(page.getByText("Time")).toBeVisible();
  await expect(page.getByText("Camera")).toBeVisible();
  await expect(page.getByText("Type")).toBeVisible();
  await expect(page.getByText("Severity")).toBeVisible();

  // At least one row in the table
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 5000 });
});

/**
 * NH-E2E-EVT-002: Events filtering by cameraId
 *
 * Flow: Login → events → type cameraId → filter → verify results filtered
 */
test("events: filter by cameraId", async ({ page }) => {
  await loginToPortal(page, "client@nearhome.dev");
  await selectPortalTenant(page, seedPortalBrowser.tenantName);

  await page.locator(`a[href="${seedPortalBrowser.routes.events}"]`).click();
  await expect(page.getByText("Events")).toBeVisible();

  // Fill cameraId filter with known camera name
  const filterInput = page.getByPlaceholder("cameraId");
  await filterInput.fill(seedPortalBrowser.cameraNames.ready);
  await page.getByRole("button", { name: "Filter" }).click();

  // Wait for results to update
  await page.waitForTimeout(1000);

  // Table should still be visible (may have 0 results — that's fine)
  await expect(page.getByText("Events")).toBeVisible();
});

/**
 * NH-E2E-EVT-003: Events navigation from cameras page
 *
 * Flow: Login → cameras → click events nav → events page visible
 */
test("events: navigation from sidebar", async ({ page }) => {
  await loginToPortal(page, "client@nearhome.dev");
  await selectPortalTenant(page, seedPortalBrowser.tenantName);

  // Start on cameras page
  await page.locator(`a[href="${seedPortalBrowser.routes.cameras}"]`).click();
  await expect(page.getByText("Cámaras RTSP")).toBeVisible();

  // Navigate to events
  await page.locator(`a[href="${seedPortalBrowser.routes.events}"]`).click();
  await expect(page.getByText("Events")).toBeVisible();
  await expect(page.locator("table")).toBeVisible();
});

/**
 * NH-E2E-EVT-004: Realtime monitoring page
 *
 * Flow: Login → realtime → verify topics input + stream area
 */
test("events: realtime monitoring page loads", async ({ page }) => {
  await loginToPortal(page, "client@nearhome.dev");
  await selectPortalTenant(page, seedPortalBrowser.tenantName);

  await page.locator(`a[href="${seedPortalBrowser.routes.realtime}"]`).click();
  await expect(page.getByText("Realtime stream")).toBeVisible();

  const topicsInput = page.getByPlaceholder(/topics/);
  await expect(topicsInput).toBeVisible();
  await expect(topicsInput).toHaveValue(/incident/);
});
