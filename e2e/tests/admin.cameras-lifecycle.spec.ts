import { expect, test } from "@playwright/test";

test("NH-027 admin camera lifecycle flow: draft -> ready via validate", async ({ page }) => {
  await page.goto("http://localhost:4173/login");
  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await page.getByRole("link", { name: "Cameras" }).click();

  const unique = Date.now();
  const cameraName = `Lifecycle Cam ${unique}`;
  const form = page.locator("form").filter({ has: page.getByPlaceholder("rtsp://...") });
  await form.getByPlaceholder("name").fill(cameraName);
  await form.getByPlaceholder("rtsp://...").fill("rtsp://demo/lifecycle-e2e");
  await form.locator("select").last().selectOption("false");
  await form.getByRole("button", { name: "Create" }).click();

  const row = page.locator("tr", { hasText: cameraName });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Show" }).click();

  await expect(page.getByTestId("camera-lifecycle-status")).toContainText("draft");
  await page.getByTestId("lifecycle-validate").click();
  await expect(page.getByTestId("camera-lifecycle-status")).toContainText("ready");
});
