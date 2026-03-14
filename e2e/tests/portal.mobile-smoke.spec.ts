import { expect, test } from "@playwright/test";
import { portalUrl } from "./support/env";

test("NH-055 portal mobile smoke: login + operations nav", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portalUrl}/login`);
  await page.getByLabel("Email").fill("monitor@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome App")).toBeVisible();
  await page.locator('a[href="/operations/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cámaras RTSP" })).toBeVisible();
  await page.locator('a[href="/operations/events"]').click();
  await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
});
