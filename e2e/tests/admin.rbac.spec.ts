import { expect, test, type Page } from "@playwright/test";
import { adminUrl } from "./support/env";

async function loginAs(page: Page, email: string, password = "demo1234") {
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("NearHome Admin")).toBeVisible();
}

test("NH-023 admin rbac monitor: read-only in users/cameras/subscriptions", async ({ page }) => {
  await loginAs(page, "monitor@nearhome.dev");
  await expect(page.getByTestId("current-role")).toHaveText("monitor");

  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.locator('a[href="/identity/users"]').click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByTestId("users-create-form")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});

test("NH-024 admin rbac client_user: no camera create/edit", async ({ page }) => {
  await loginAs(page, "client@nearhome.dev");
  const roleBadge = page.getByTestId("current-role");
  if ((await roleBadge.count()) === 0) {
    await expect(page).toHaveURL(/\/login/);
    return;
  }
  await expect(roleBadge).toBeVisible();

  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await expect(page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.locator('a[href="/commercial/subscriptions"]').click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate / })).toHaveCount(0);
});
