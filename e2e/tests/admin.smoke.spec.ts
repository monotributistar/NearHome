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

test("NH-006 admin smoke: login + camera CRUD", async ({ page }) => {
  await page.goto(`${adminUrl}/login`);

  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await expect(page).toHaveURL(/\/operations\/control/);
  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page).toHaveURL(/\/resources\/cameras/);
  await cleanupCamerasByPrefix(page, "E2E Cam ");

  const cameraName = `E2E Cam ${Date.now()}`;
  const cameraForm = page.locator("form").filter({ has: page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream") });
  await cameraForm.getByPlaceholder("name").fill(cameraName);
  await cameraForm.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream").fill("rtsp://demo/e2e");
  await cameraForm.getByPlaceholder("location").fill("E2E Lab");
  await cameraForm.getByPlaceholder("tags csv").fill("e2e,smoke");
  await cameraForm.getByRole("button", { name: "Crear cámara" }).click();

  await expect(page.getByText(cameraName)).toBeVisible();

  await page.getByPlaceholder("Filter by name").fill(cameraName);
  await page.getByRole("button", { name: "Search" }).click();
  const rowToDelete = page.locator("tr", { hasText: cameraName });
  await rowToDelete.getByRole("button", { name: "Delete" }).click();

  await page.getByPlaceholder("Filter by name").fill(cameraName);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(cameraName)).toHaveCount(0);
});
