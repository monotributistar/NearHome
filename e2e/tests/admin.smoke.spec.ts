import { expect, test } from "@playwright/test";

test("NH-006 admin smoke: login + camera CRUD", async ({ page }) => {
  await page.goto("http://localhost:4173/login");

  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await expect(page).toHaveURL(/\/cameras/);

  const cameraName = `E2E Cam ${Date.now()}`;
  const cameraForm = page.locator("form").filter({ has: page.getByPlaceholder("rtsp://...") });
  await cameraForm.getByPlaceholder("name").fill(cameraName);
  await cameraForm.getByPlaceholder("rtsp://...").fill("rtsp://demo/e2e");
  await cameraForm.getByPlaceholder("location").fill("E2E Lab");
  await cameraForm.getByPlaceholder("tags csv").fill("e2e,smoke");
  await cameraForm.getByRole("button", { name: "Create" }).click();

  await expect(page.getByText(cameraName)).toBeVisible();

  const row = page.locator("tr", { hasText: cameraName });
  await row.getByRole("button", { name: "Edit" }).click();

  const updatedName = `${cameraName} Updated`;
  await cameraForm.getByPlaceholder("name").fill(updatedName);
  await cameraForm.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(500);

  await page.getByPlaceholder("Filter by name").fill(cameraName);
  await page.getByRole("button", { name: "Search" }).click();
  const rowToDelete = page.locator("tr", { hasText: cameraName });
  await rowToDelete.getByRole("button", { name: "Delete" }).click();

  await page.getByPlaceholder("Filter by name").fill(cameraName);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(cameraName)).toHaveCount(0);
});
