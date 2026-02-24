import { expect, test } from "@playwright/test";

test("NH-007 portal smoke: login + cameras + stream token + events", async ({ page }) => {
  await page.goto("http://localhost:4174/login");

  await page.getByLabel("Email").fill("monitor@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Portal")).toBeVisible();
  const tenantSelector = page.getByRole("combobox").first();
  await expect(tenantSelector).not.toHaveValue("");
  const activeTenant = await tenantSelector.inputValue();
  await tenantSelector.selectOption(activeTenant);

  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByText("Cameras")).toBeVisible();

  await page.getByRole("link", { name: "Open" }).first().click();
  await expect(page.getByText(/Viewer mock/)).toBeVisible();

  const streamResponse = page.waitForResponse(
    (res) => res.url().includes("/stream-token") && res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Get stream token" }).click();
  const response = await streamResponse;
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(200);
  await expect(page.getByTestId("stream-session-status")).toContainText("issued");

  await page.getByTestId("stream-activate").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("active");

  await page.getByTestId("stream-end").click();
  await expect(page.getByTestId("stream-session-status")).toContainText("ended");

  await page.getByRole("link", { name: "Events" }).click();
  await expect(page.getByText("Events")).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
});
