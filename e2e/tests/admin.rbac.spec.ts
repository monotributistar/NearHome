import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, email: string, password = "demo1234") {
  await page.goto("http://localhost:4173/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("NearHome Admin")).toBeVisible();
}

test("NH-023 admin rbac monitor: read-only in users/cameras/subscriptions", async ({ page }) => {
  await loginAs(page, "monitor@nearhome.dev");
  await expect(page.getByTestId("current-role")).toHaveText("monitor");

  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://...")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.getByRole("link", { name: "Users" }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByTestId("users-create-form")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.getByRole("link", { name: "Subscriptions" }).click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});

test("NH-024 admin rbac client_user: no camera create/edit", async ({ page }) => {
  await loginAs(page, "client@nearhome.dev");
  await expect(page.getByTestId("current-role")).toHaveText("client_user");

  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://...")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.getByRole("link", { name: "Subscriptions" }).click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});
