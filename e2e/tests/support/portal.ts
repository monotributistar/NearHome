import { expect, type Page } from "@playwright/test";
import { portalUrl } from "./env";

export async function loginToPortal(page: Page, email: string, password = "demo1234") {
  await page.goto(`${portalUrl}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByText("NearHome App")).toBeVisible();
}

export async function selectPortalTenant(page: Page, tenantName: string) {
  const tenantSelector = page.getByRole("combobox").first();
  await tenantSelector.selectOption({ label: tenantName });
  await expect(tenantSelector).toHaveText(new RegExp(tenantName));
}
