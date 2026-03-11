import { expect, test } from "@playwright/test";
import { adminUrl } from "./support/env";

async function cleanupCamerasByPrefix(page: import("@playwright/test").Page, prefix: string) {
  await page.getByPlaceholder("Filter by name").fill(prefix);
  await page.getByRole("button", { name: "Search" }).click();
  const rows = page.locator("tbody tr");
  while ((await rows.count()) > 0) {
    await rows.nth(0).getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(100);
  }
  await page.getByPlaceholder("Filter by name").fill("");
  await page.getByRole("button", { name: "Search" }).click();
}

test("NH-026 admin camera profile flow: create camera + configure internal profile", async ({ page }) => {
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel("Email").fill("admin@nearhome.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page.getByText("NearHome Admin")).toBeVisible();
  await page.locator('a[href="/resources/cameras"]').click();
  await expect(page.getByRole("heading", { name: "Cameras" })).toBeVisible();
  await cleanupCamerasByPrefix(page, "Profile Cam ");

  const unique = Date.now();
  const cameraName = `Profile Cam ${unique}`;
  const description = `Profile description ${unique}`;

  const cameraForm = page.locator("form").filter({ has: page.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream") });
  await cameraForm.getByPlaceholder("name").fill(cameraName);
  await cameraForm.getByPlaceholder("description").fill(description);
  await cameraForm.getByPlaceholder("rtsp://usuario:password@ip:puerto/stream").fill("rtsp://demo/profile-flow");
  await cameraForm.getByPlaceholder("location").fill("NOC");
  await cameraForm.getByPlaceholder("tags csv").fill("profile,e2e");
  await cameraForm.getByRole("button", { name: "Crear cámara" }).click();

  const row = page.locator("tr", { hasText: cameraName });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Show" }).click();

  await expect(page.getByText(`Description: ${description}`)).toBeVisible();
  await expect(page.locator(".divider", { hasText: "Internal Profile" })).toBeVisible();

  const proxyPath = `/proxy/live/e2e/${unique}`;
  await page.getByTestId("profile-proxy-path").fill(proxyPath);
  await page.getByTestId("profile-recording-enabled").selectOption("true");
  await page.getByTestId("profile-recording-storage").fill(`s3://nearhome/e2e/recordings/${unique}`);
  await page.getByTestId("profile-detector-config").fill(`kv://nearhome/e2e/config/${unique}.json`);
  await page.getByTestId("profile-detector-results").fill(`s3://nearhome/e2e/results/${unique}`);

  await page.getByLabel("yolo").check();
  await page.getByLabel("lpr").check();
  await page.getByTestId("profile-save").click();

  await expect(page.getByText("Profile saved")).toBeVisible();
  await expect(page.getByTestId("profile-proxy-path")).toHaveValue(proxyPath);

  await page.getByTestId("profile-status").selectOption("ready");
  await page.getByTestId("profile-detector-results").fill("");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-fallback-alert")).toBeVisible();
});
