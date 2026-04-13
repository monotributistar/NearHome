/**
 * E2E: Admin Edge Fleet workflow
 *
 * Covers the production admin UX for:
 *   1. Login as super_admin
 *   2. Create a new tenant
 *   3. Navigate to Infrastructure → Flotas Edge
 *   4. Create a fleet for the tenant
 *   5. Navigate to Edge Gateways list
 *   6. Verify empty state / gateway table renders
 *   7. (Simulated) View edge gateway detail with tabs:
 *      cameras, IoT devices, tunnels, logs
 *
 * Note: real gateway registration + discovery require the docker test-env stack.
 * These tests validate the UI rendering and navigation paths; API calls are
 * intercepted/mocked at the network layer where hardware is unavailable.
 */

import { expect, test, type Page } from "@playwright/test";
import { loginAsBackoffice } from "./support/admin";
import { adminUrl, apiUrl } from "./support/env";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function goToInfraFleets(page: Page) {
  await page.getByRole("link", { name: "Flotas Edge" }).click();
  await expect(page.getByRole("heading", { name: "Flotas Edge" })).toBeVisible();
}

async function goToInfraGateways(page: Page) {
  await page.getByRole("link", { name: "Edge Gateways" }).click();
  await expect(page.getByRole("heading", { name: "Edge Gateways" })).toBeVisible();
}

// ─── test suite ───────────────────────────────────────────────────────────────

test.describe("Admin Edge Fleet – Infrastructure nav", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsBackoffice(page, "admin@nearhome.dev");
  });

  test("NH-EF-001 infra nav items are visible in sidebar", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Flotas Edge" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edge Gateways" })).toBeVisible();
  });

  test("NH-EF-002 fleet list page renders with create button", async ({ page }) => {
    await goToInfraFleets(page);
    await expect(page.getByTestId("btn-create-fleet")).toBeVisible();
    // Table or empty state should be visible
    const hasTable = await page.getByTestId("fleet-table").isVisible().catch(() => false);
    const hasEmpty = await page.getByText("No hay flotas configuradas").isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });

  test("NH-EF-003 create fleet form appears and validates", async ({ page }) => {
    await goToInfraFleets(page);
    await page.getByTestId("btn-create-fleet").click();
    await expect(page.getByTestId("input-fleet-name")).toBeVisible();
    await expect(page.getByTestId("input-fleet-desc")).toBeVisible();
    await expect(page.getByTestId("btn-submit-fleet")).toBeVisible();

    // Cancel hides the form
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByTestId("input-fleet-name")).not.toBeVisible();
  });

  test("NH-EF-004 create fleet end-to-end", async ({ page }) => {
    await goToInfraFleets(page);

    const fleetName = `E2E Fleet ${Date.now()}`;
    await page.getByTestId("btn-create-fleet").click();
    await page.getByTestId("input-fleet-name").fill(fleetName);
    await page.getByTestId("input-fleet-desc").fill("Flota de prueba E2E");
    await page.getByTestId("btn-submit-fleet").click();

    // Form closes after submission
    await expect(page.getByTestId("input-fleet-name")).not.toBeVisible({ timeout: 10000 });

    // Fleet appears in table
    await expect(page.getByText(fleetName)).toBeVisible({ timeout: 10000 });
  });

  test("NH-EF-005 edge gateway list page renders", async ({ page }) => {
    await goToInfraGateways(page);
    const hasTable = await page.getByTestId("gateway-table").isVisible().catch(() => false);
    const hasEmpty = await page.getByText("No hay gateways registrados").isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });
});

// ─── Gateway detail: mock API responses ───────────────────────────────────────

test.describe("Admin Edge Fleet – Gateway detail page", () => {
  const MOCK_GATEWAY_ID = "mock-gw-e2e-001";

  test.beforeEach(async ({ page }) => {
    // Intercept API calls so we can test the detail UI without real hardware
    await page.route(`${apiUrl}/api/v1/edge-gateways/${MOCK_GATEWAY_ID}`, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: MOCK_GATEWAY_ID,
          deviceName: "E2E Test Gateway",
          balenaDeviceUUID: "aaaa-bbbb-cccc-dddd",
          osVersion: "2.114.0",
          status: "active",
          lastHeartbeatAt: new Date().toISOString(),
          customMetrics: {
            cpuUsagePercent: 32.4,
            cpuTemperatureCelsius: 51.0,
            memoryUsedBytes: 512_000_000,
            memoryTotalBytes: 1_024_000_000,
            discoveredCamerasCount: 2,
            registeredCamerasCount: 2
          }
        })
      });
    });

    await page.route(`${apiUrl}/api/v1/edge-gateways/${MOCK_GATEWAY_ID}/cameras`, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "cam-001",
              ipAddress: "192.168.1.100",
              macAddress: "aa:bb:cc:dd:ee:01",
              manufacturer: "Hikvision",
              model: "DS-2CD2043G2",
              rtspUrl: "rtsp://192.168.1.100/stream",
              status: "confirmed"
            },
            {
              id: "cam-002",
              ipAddress: "192.168.1.101",
              macAddress: "aa:bb:cc:dd:ee:02",
              manufacturer: "Dahua",
              model: "IPC-HDW3849H",
              rtspUrl: null,
              status: "discovered"
            }
          ]
        })
      });
    });

    await page.route(`${apiUrl}/api/v1/edge-gateways/${MOCK_GATEWAY_ID}/devices`, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "dev-001",
              deviceType: "light",
              manufacturer: "NearHome",
              model: "NHB-100",
              ipAddress: "192.168.1.200",
              status: "discovered",
              currentState: JSON.stringify({ on: true, brightness: 80, color_temp: 4000 })
            }
          ]
        })
      });
    });

    await page.route(`${apiUrl}/api/v1/edge-gateways/${MOCK_GATEWAY_ID}/tunnels/status`, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tunnels: [
            { cameraId: "cam-001", rtspPort: 8554, status: "connected" }
          ]
        })
      });
    });

    await loginAsBackoffice(page, "admin@nearhome.dev");
    await page.goto(`${adminUrl}/infrastructure/edge-gateways/${MOCK_GATEWAY_ID}`);
    await expect(page.getByText("E2E Test Gateway")).toBeVisible({ timeout: 10000 });
  });

  test("NH-EF-010 gateway detail shows status cards", async ({ page }) => {
    await expect(page.getByTestId("gw-status")).toContainText("active");
    await expect(page.getByTestId("gw-cpu")).toContainText("32.4%");
    await expect(page.getByTestId("gw-mem")).toContainText("50%");
    await expect(page.getByTestId("gw-temp")).toContainText("51");
  });

  test("NH-EF-011 cameras tab shows discovered cameras", async ({ page }) => {
    await expect(page.getByTestId("tab-cameras")).toBeVisible();
    // Default tab is cameras
    await expect(page.getByTestId("cameras-table")).toBeVisible();
    await expect(page.getByText("Hikvision")).toBeVisible();
    await expect(page.getByText("Dahua")).toBeVisible();
  });

  test("NH-EF-012 devices tab shows IoT devices with toggle", async ({ page }) => {
    await page.getByTestId("tab-devices").click();
    await expect(page.getByTestId("devices-table")).toBeVisible();
    await expect(page.getByText("NHB-100")).toBeVisible();
    await expect(page.getByTestId("toggle-device-dev-001")).toBeVisible();
    await expect(page.getByTestId("toggle-device-dev-001")).toContainText("Apagar");
  });

  test("NH-EF-013 tunnels tab shows RTSP tunnel status", async ({ page }) => {
    await page.getByTestId("tab-tunnels").click();
    await expect(page.getByTestId("tunnels-table")).toBeVisible();
    await expect(page.getByTestId("tunnel-status-cam-001")).toContainText("connected");
  });

  test("NH-EF-014 logs tab shows heartbeat metrics", async ({ page }) => {
    await page.getByTestId("tab-logs").click();
    await expect(page.getByTestId("heartbeat-logs")).toBeVisible();
    await expect(page.getByText("cpuUsagePercent")).toBeVisible();
  });
});

// ─── Full admin workflow: tenant → fleet → assign gateway ─────────────────────

test.describe("Admin Edge Fleet – Full admin provisioning workflow", () => {
  test("NH-EF-020 full workflow: tenant → fleet → gateway list", async ({ page }) => {
    await loginAsBackoffice(page, "admin@nearhome.dev");

    // Step 1: Create tenant
    await page.getByRole("link", { name: "Tenants" }).click();
    await expect(page.getByRole("heading", { name: "Tenants" })).toBeVisible();

    const tenantName = `Edge Tenant ${Date.now()}`;
    await page.getByPlaceholder("Tenant name").fill(tenantName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(tenantName)).toBeVisible({ timeout: 15000 });

    // Step 2: Navigate to Infrastructure → Flotas Edge
    await page.getByRole("link", { name: "Flotas Edge" }).click();
    await expect(page.getByRole("heading", { name: "Flotas Edge" })).toBeVisible();

    // Step 3: Create a fleet
    const fleetName = `Fleet for ${tenantName}`;
    await page.getByTestId("btn-create-fleet").click();
    await page.getByTestId("input-fleet-name").fill(fleetName);
    await page.getByTestId("btn-submit-fleet").click();
    await expect(page.getByText(fleetName)).toBeVisible({ timeout: 15000 });

    // Step 4: Navigate to Edge Gateways
    await page.getByRole("link", { name: "Edge Gateways" }).click();
    await expect(page.getByRole("heading", { name: "Edge Gateways" })).toBeVisible();

    // Gateway list renders (empty is fine — no real hardware in CI)
    const hasTable = await page.getByTestId("gateway-table").isVisible().catch(() => false);
    const hasEmpty = await page.getByText("No hay gateways registrados").isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });
});
