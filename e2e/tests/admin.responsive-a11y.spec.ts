import { expect, test, type Page } from "@playwright/test";
import { adminUrl } from "./support/env";

const BREAKPOINTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 }
] as const;

async function assertNoHorizontalOverflow(page: Page) {
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth > 1);
  expect(hasOverflow).toBeFalsy();
}

test("NH-054 admin responsive + keyboard baseline", async ({ page, request }) => {
  const loginResponse = await request.post("http://localhost:3001/auth/login", {
    data: { email: "admin@nearhome.dev", password: "demo1234" }
  });
  expect(loginResponse.ok()).toBeTruthy();
  const loginBody = (await loginResponse.json()) as { accessToken: string };

  const meResponse = await request.get("http://localhost:3001/auth/me", {
    headers: { Authorization: `Bearer ${loginBody.accessToken}` }
  });
  expect(meResponse.ok()).toBeTruthy();
  const meBody = (await meResponse.json()) as { memberships?: Array<{ tenantId: string }> };
  const tenantId = meBody.memberships?.[0]?.tenantId ?? "";
  expect(tenantId).not.toBe("");

  await page.goto(`${adminUrl}/login`);
  await page.evaluate(
    (args) => {
      localStorage.setItem("nearhome_access_token", args.accessToken);
      localStorage.setItem("nearhome_active_tenant", args.tenantId);
    },
    { accessToken: loginBody.accessToken, tenantId }
  );

  for (const bp of BREAKPOINTS) {
    await page.setViewportSize(bp);
    await page.goto(`${adminUrl}/operations/control`);
    await expect(page).toHaveURL(/\/operations\/control/);
    await expect(page.getByText("NearHome Backoffice")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.goto(`${adminUrl}/resources/cameras`);
    await expect(page).toHaveURL(/\/resources\/cameras/);
    await expect(page.getByText("Cameras")).toBeVisible();
    await assertNoHorizontalOverflow(page);
  }
});
