import { expect, test } from "@playwright/test";

test("NH-029 admin tenants flow: create + update + delete", async ({ page }) => {
  await page.goto("http://localhost:4173/login");

  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await page.getByRole("link", { name: "Tenants" }).click();
  await expect(page.getByRole("heading", { name: "Tenants" })).toBeVisible();

  const unique = Date.now();
  const tenantName = `E2E Tenant ${unique}`;
  const updatedName = `${tenantName} Updated`;
  const initialRows = await page.locator("table tbody tr").count();

  await page.getByPlaceholder("Tenant name").fill(tenantName);
  await page.getByRole("button", { name: "Create" }).click();

  await expect.poll(async () => page.locator("table tbody tr").count(), { timeout: 30000 }).toBeGreaterThan(initialRows);
  const row = page.locator("table tbody tr").last();

  await row.getByRole("textbox").fill(updatedName);
  await row.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Delete" }).last().click();
  await expect.poll(async () => page.locator("table tbody tr").count(), { timeout: 30000 }).toBe(initialRows);
});
