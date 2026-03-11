import { expect, test } from "@playwright/test";
import { adminUrl } from "./support/env";

async function cleanupCamerasByPrefix(page: import("@playwright/test").Page, prefix: string) {
  await page.getByPlaceholder("Filter by name").fill(prefix);
  await page.getByRole("button", { name: "Search" }).click();
  const rows = page.locator("tbody tr");
  while ((await rows.count()) > 0) {
    await rows.nth(0).getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(100);
  }
  await page.getByPlaceholder("Filter by name").fill("");
  await page.getByRole("button", { name: "Search" }).click();
}

test("NH-027 admin camera lifecycle flow: draft -> ready via validate", async ({ page }) => {
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await page.locator('a[href="/resources/cameras"]').click();
  await cleanupCamerasByPrefix(page, "Lifecycle Cam ");

  const unique = Date.now();
  const cameraName = `Lifecycle Cam ${unique}`;
  const form = page.locator("form").filter({ has: page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream") });
  await form.getByPlaceholder("name").fill(cameraName);
  await form.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream").fill("rtsp://demo/lifecycle-e2e");
  await form.locator("select").last().selectOption("false");
  await form.getByRole("button", { name: "Crear cámara" }).click();

  const row = page.locator("tr", { hasText: cameraName });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Show" }).click();

  await expect(page.getByTestId("camera-lifecycle-status")).toContainText("draft");
  await page.getByTestId("lifecycle-validate").click();
  await expect(page.getByTestId("camera-lifecycle-status")).toContainText("ready");
});
