/**
 * NH-080  Portal — full new-user onboarding
 *
 * Scenario: a brand-new customer self-registers, sets up their first place,
 * adds two mock IP security cameras, registers two smart lightbulbs as
 * household devices, and finally invites a viewer (client_user) via a
 * shareable link.
 *
 * All data is created fresh for each run using a timestamp-based unique
 * suffix, so the test is safe to run in parallel with other suites.
 *
 * Coverage:
 *   ✓ POST /auth/register           (register page wizard)
 *   ✓ GET  /auth/me                 (session load after login)
 *   ✓ POST /cameras                 (create two IP cameras)
 *   ✓ GET  /cameras                 (list appears in UI)
 *   ✓ POST /households              (create one household)
 *   ✓ POST /households/:id/members  (add two smart-bulb devices)
 *   ✓ GET  /households/:id/members  (list appears in UI)
 *   ✓ POST /auth/invite             (generate viewer invite link)
 *   ✓ POST /auth/invite/accept      (viewer accepts invite)
 */

import { expect, test, type Page } from "@playwright/test";
import { apiUrl, portalUrl } from "./support/env";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Strong password that satisfies the shared StrongPasswordSchema */
const STRONG_PASSWORD = "Nearhome1!";

function uniqueSuffix() {
  return Date.now().toString(36).toUpperCase();
}

async function registerNewUser(
  page: Page,
  opts: { name: string; email: string; password: string; placeName: string; placeAddress?: string }
) {
  await page.goto(`${portalUrl}/register`);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  // Step 1 — account details
  await page.getByLabel("Full name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password").fill(opts.password);
  await page.getByLabel("Confirm password").fill(opts.password);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — place details
  await expect(page.getByRole("heading", { name: "Name your place" })).toBeVisible();
  await page.getByPlaceholder(/e\.g\. My Home/i).fill(opts.placeName);
  if (opts.placeAddress) {
    await page.getByPlaceholder("123 Main St").fill(opts.placeAddress);
  }
  await page.getByRole("button", { name: "Create my place" }).click();

  // Step 3 — success screen
  await expect(page.getByText(/NearHome hub is on its way/i)).toBeVisible({ timeout: 10_000 });
}

async function addCamera(
  page: Page,
  opts: { name: string; rtspUrl: string; location?: string; description?: string }
) {
  await page.getByPlaceholder("Camera name").fill(opts.name);
  await page.getByPlaceholder("RTSP URL").fill(opts.rtspUrl);
  if (opts.location) await page.getByPlaceholder("Location").fill(opts.location);
  if (opts.description) await page.getByPlaceholder("Description").fill(opts.description);
  await page.getByRole("button", { name: "Create" }).click();

  // wait for row to appear
  await expect(page.locator("tr", { hasText: opts.name })).toBeVisible({ timeout: 8_000 });
}

// ── test ─────────────────────────────────────────────────────────────────────

test("NH-080 portal new-user onboarding: register → IP cameras → smart-bulb devices → viewer invite", async ({ page }) => {
  const id = uniqueSuffix();
  const user = {
    name:      `E2E User ${id}`,
    email:     `e2e-onboarding-${id}@nearhome.dev`,
    password:  STRONG_PASSWORD,
    placeName: `E2E Home ${id}`,
    placeAddress: "42 Test Street, E2E City"
  };

  // ── 1. Self-registration ────────────────────────────────────────────────────
  await test.step("register new user via portal sign-up wizard", async () => {
    await registerNewUser(page, user);
  });

  // ── 2. Proceed to portal after registration ─────────────────────────────────
  await test.step("navigate to place after success screen", async () => {
    await page.getByRole("button", { name: "Go to my place" }).click();
    await expect(page.getByText("NearHome")).toBeVisible({ timeout: 10_000 });
    // The tenant switcher should show the newly created place
    await expect(page.getByRole("combobox").first()).toContainText(user.placeName, { timeout: 8_000 });
  });

  // ── 3. Add mock IP security cameras ────────────────────────────────────────
  await test.step("navigate to cameras section", async () => {
    await page.locator('a[href="/operations/cameras"]').click();
    await expect(page.getByRole("heading", { name: "RTSP Cameras" })).toBeVisible();
  });

  const cam1 = {
    name:        `Front Door Cam ${id}`,
    rtspUrl:     "rtsp://192.168.1.101:554/stream1",
    location:    "Front Door",
    description: "Mock IP camera — front entrance"
  };
  const cam2 = {
    name:        `Backyard Cam ${id}`,
    rtspUrl:     "rtsp://192.168.1.102:554/stream2",
    location:    "Backyard",
    description: "Mock IP camera — rear garden"
  };

  await test.step("add first IP camera (front door)", async () => {
    await addCamera(page, cam1);
    const row = page.locator("tr", { hasText: cam1.name });
    await expect(row.getByText("Front Door")).toBeVisible();
  });

  await test.step("add second IP camera (backyard)", async () => {
    await addCamera(page, cam2);
    const row = page.locator("tr", { hasText: cam2.name });
    await expect(row.getByText("Backyard")).toBeVisible();
  });

  await test.step("both cameras appear in the list", async () => {
    await expect(page.locator("tr", { hasText: cam1.name })).toBeVisible();
    await expect(page.locator("tr", { hasText: cam2.name })).toBeVisible();
  });

  // ── 4. Smart lightbulb devices via Households ───────────────────────────────
  // NearHome models smart home devices (including IP-connected lightbulbs) as
  // Household members so alerts and camera access can be scoped per device/person.
  await test.step("navigate to households section", async () => {
    await page.locator('a[href="/account/households"]').click();
    await expect(page.getByRole("heading", { name: "Households & Members" })).toBeVisible();
  });

  const householdName = `Smart Home ${id}`;

  await test.step("create a household for smart devices", async () => {
    await page.getByPlaceholder("Household name").fill(householdName);
    await page.getByPlaceholder("Address").fill(user.placeAddress!);
    await page.getByPlaceholder("Notes").fill("Mock smart home setup");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Household created")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("combobox").filter({ hasText: householdName })).toBeVisible();
  });

  const bulb1 = { name: `Living Room Smart Bulb ${id}`, relationship: "iot_device" };
  const bulb2 = { name: `Kitchen Smart Bulb ${id}`,      relationship: "iot_device" };

  await test.step("add first smart lightbulb device", async () => {
    await page.getByPlaceholder("Full name").fill(bulb1.name);
    await page.getByPlaceholder("Relationship").fill(bulb1.relationship);
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText("Member added")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("tr", { hasText: bulb1.name })).toBeVisible();
  });

  await test.step("add second smart lightbulb device", async () => {
    await page.getByPlaceholder("Full name").fill(bulb2.name);
    await page.getByPlaceholder("Relationship").fill(bulb2.relationship);
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText("Member added")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("tr", { hasText: bulb2.name })).toBeVisible();
  });

  await test.step("both lightbulb devices appear in the members list", async () => {
    await expect(page.locator("tr", { hasText: bulb1.name })).toBeVisible();
    await expect(page.locator("tr", { hasText: bulb2.name })).toBeVisible();
    // both should show "active" status badge
    for (const name of [bulb1.name, bulb2.name]) {
      await expect(
        page.locator("tr", { hasText: name }).getByText("active")
      ).toBeVisible();
    }
  });

  // ── 5. Generate viewer invite link ──────────────────────────────────────────
  await test.step("navigate to viewers section", async () => {
    await page.locator('a[href="/viewers"]').click();
    await expect(page.getByRole("heading", { name: "Viewers" })).toBeVisible();
  });

  let capturedInviteUrl = "";

  await test.step("generate a shareable viewer invite link", async () => {
    const inviteResponse = page.waitForResponse(
      (res) => res.url().includes("/auth/invite") && res.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Generate invite link" }).click();
    const res = await inviteResponse;
    expect(res.status()).toBe(201);

    const body = (await res.json()) as { inviteUrl?: string; role?: string; expiresAt?: string };
    expect(body.role).toBe("client_user");
    expect(body.inviteUrl).toContain("/invite/");
    capturedInviteUrl = body.inviteUrl!;

    // invite link code block should be visible in the UI
    await expect(page.locator("code")).toContainText("/invite/", { timeout: 8_000 });
    await expect(page.getByText("Expires:")).toBeVisible();
  });

  // ── 6. Viewer accepts invite in a new browser context ──────────────────────
  await test.step("viewer accepts invite and creates their account", async () => {
    // Extract the token from the URL captured above
    const tokenMatch = capturedInviteUrl.match(/\/invite\/([^?]+)/);
    expect(tokenMatch).not.toBeNull();
    const inviteToken = tokenMatch![1];

    const viewerEmail    = `e2e-viewer-${id}@nearhome.dev`;
    const viewerName     = `E2E Viewer ${id}`;
    const viewerPassword = STRONG_PASSWORD;

    // Accept invite via the API directly (avoids needing a second browser context)
    const acceptRes = await page.request.post(`${apiUrl}/auth/invite/accept`, {
      data: {
        token:    inviteToken,
        name:     viewerName,
        email:    viewerEmail,
        password: viewerPassword
      }
    });
    expect(acceptRes.status()).toBe(201);

    const acceptBody = (await acceptRes.json()) as {
      accessToken?: string;
      role?: string;
      tenant?: { name?: string };
    };
    expect(acceptBody.accessToken).toBeTruthy();
    expect(acceptBody.role).toBe("client_user");
    expect(acceptBody.tenant?.name).toBe(user.placeName);
  });

  // ── 7. Newly-invited viewer appears in the viewers list ────────────────────
  await test.step("refresh viewers list and verify invited viewer appears", async () => {
    // Reload the viewers page to pick up the new membership
    await page.reload();
    await expect(page.getByRole("heading", { name: "Viewers" })).toBeVisible();

    // The viewer's email should now appear in the table
    await expect(
      page.locator("tr", { hasText: `e2e-viewer-${id}@nearhome.dev` })
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.locator("tr", { hasText: `e2e-viewer-${id}@nearhome.dev` }).getByText("active")
    ).toBeVisible();
  });

  // ── 8. Summary check — cameras still visible ───────────────────────────────
  await test.step("cameras added earlier are still visible after full flow", async () => {
    await page.locator('a[href="/operations/cameras"]').click();
    await expect(page.getByRole("heading", { name: "RTSP Cameras" })).toBeVisible();
    await expect(page.locator("tr", { hasText: cam1.name })).toBeVisible();
    await expect(page.locator("tr", { hasText: cam2.name })).toBeVisible();
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test("NH-081 portal register: duplicate email is rejected", async ({ page }) => {
  const id = uniqueSuffix();
  const email = `e2e-dup-${id}@nearhome.dev`;

  // First registration should succeed
  await registerNewUser(page, {
    name:      `Dup User ${id}`,
    email,
    password:  STRONG_PASSWORD,
    placeName: `Dup Place ${id}`
  });
  await expect(page.getByText(/NearHome hub is on its way/i)).toBeVisible({ timeout: 10_000 });

  // Second registration with same email — should show an error on the place step
  await registerNewUser(page, {
    name:      `Dup User 2 ${id}`,
    email,                          // same email!
    password:  STRONG_PASSWORD,
    placeName: `Dup Place 2 ${id}`
  });
  await expect(page.getByText(/already|duplicate|taken|exists/i)).toBeVisible({ timeout: 8_000 });
});

test("NH-082 portal register: weak password is rejected client-side", async ({ page }) => {
  await page.goto(`${portalUrl}/register`);
  await page.getByLabel("Full name").fill("Weak Password User");
  await page.getByLabel("Email").fill("weakpw@nearhome.dev");
  await page.getByLabel("Password").fill("short");        // too short, no uppercase/number
  await page.getByLabel("Confirm password").fill("short");
  await page.getByRole("button", { name: "Continue" }).click();

  // The HTML5 minlength constraint blocks submit; still on step 1
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  // password field should be invalid (browser native constraint)
  const passwordInput = page.getByLabel("Password");
  await expect(passwordInput).toHaveAttribute("minlength", "8");
});

test("NH-083 portal register: mismatched passwords are rejected", async ({ page }) => {
  await page.goto(`${portalUrl}/register`);
  await page.getByLabel("Full name").fill("Mismatch User");
  await page.getByLabel("Email").fill(`mismatch-${uniqueSuffix()}@nearhome.dev`);
  await page.getByLabel("Password").fill(STRONG_PASSWORD);
  await page.getByLabel("Confirm password").fill("DifferentPass1!");
  await page.getByRole("button", { name: "Continue" }).click();

  // Should stay on step 1 with "Passwords do not match" error
  await expect(page.getByText("Passwords do not match")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

test("NH-084 portal camera: RTSP URL and name are required", async ({ page }) => {
  const id = uniqueSuffix();
  // Register + navigate to cameras
  await registerNewUser(page, {
    name:      `Cam Validation ${id}`,
    email:     `e2e-camval-${id}@nearhome.dev`,
    password:  STRONG_PASSWORD,
    placeName: `Cam Val Place ${id}`
  });
  await page.getByRole("button", { name: "Go to my place" }).click();
  await page.locator('a[href="/operations/cameras"]').click();
  await expect(page.getByRole("heading", { name: "RTSP Cameras" })).toBeVisible();

  // Attempt to create with no name/URL
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(/required|Name and RTSP/i)).toBeVisible({ timeout: 5_000 });

  // Only name filled — still should fail
  await page.getByPlaceholder("Camera name").fill("Incomplete Cam");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(/required|Name and RTSP/i)).toBeVisible({ timeout: 5_000 });
});
