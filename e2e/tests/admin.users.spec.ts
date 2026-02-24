import { expect, test } from "@playwright/test";

test("NH-022 admin users flow: create + update role", async ({ page }) => {
  await page.goto("http://localhost:4173/login");

  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await page.getByRole("link", { name: "Users" }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

  const unique = Date.now();
  const email = `e2e-user-${unique}@nearhome.dev`;
  const initialName = `E2E User ${unique}`;
  const updatedName = `${initialName} Updated`;

  const createForm = page.getByTestId("users-create-form");
  await createForm.getByPlaceholder("email").fill(email);
  await createForm.getByPlaceholder("name").fill(initialName);
  await createForm.getByPlaceholder("password").fill("demo1234");
  await createForm.locator("select").selectOption("client_user");
  await createForm.getByRole("button", { name: "Create" }).click();

  const row = page.locator("tr", { hasText: email });
  await expect(row).toBeVisible();

  await row.getByRole("textbox").fill(updatedName);
  await row.locator("select").selectOption("monitor");
  await row.getByRole("button", { name: "Save" }).click();

  await expect(row.getByRole("textbox")).toHaveValue(updatedName);
  await expect(row.locator("select")).toHaveValue("monitor");

});
