import { expect, test, type Page } from "@playwright/test";
import { portalUrl } from "./support/env";

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

test("NH-054 portal responsive + keyboard baseline", async ({ page }) => {
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize(bp);
    await page.goto(`${portalUrl}/login`);
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  }
});
