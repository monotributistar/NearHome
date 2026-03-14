import { expect, type Page } from "@playwright/test";
import { adminUrl } from "./env";

export async function loginAsBackoffice(page: Page, email: string, password = "demo1234") {
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"));
  await expect(page.getByTestId("current-role")).toBeVisible();
}

export async function selectTenantByName(page: Page, tenantName: string) {
  const tenantSelector = page.getByRole("combobox").first();
  await tenantSelector.selectOption({ label: tenantName });
  await expect(tenantSelector).toHaveText(new RegExp(tenantName));
}
