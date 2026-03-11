import { expect, test } from "@playwright/test";
import { adminUrl } from "./support/env";

test("NH-055 admin mobile smoke: login + navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${adminUrl}/login`);

  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Backoffice")).toBeVisible();
  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByTestId("current-role")).toBeVisible();
});
