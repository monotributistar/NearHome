import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.E2E_API_PORT ?? 3001);
const adminPort = Number(process.env.E2E_ADMIN_PORT ?? 4173);
const portalPort = Number(process.env.E2E_PORTAL_PORT ?? 4174);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    headless: true
  },
  webServer: [
    {
      command:
        `pnpm --filter @app/api build && PORT=${apiPort} LOGIN_RATE_LIMIT_MAX=500 CORS_ORIGIN_ADMIN=http://localhost:${adminPort} CORS_ORIGIN_PORTAL=http://localhost:${portalPort} pnpm --filter @app/api start`,
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: `VITE_API_URL=http://localhost:${apiPort} pnpm --filter @app/admin exec vite --port ${adminPort}`,
      url: `http://localhost:${adminPort}`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: `VITE_API_URL=http://localhost:${apiPort} VITE_EVENT_GATEWAY_URL=http://localhost:3011 pnpm --filter @app/portal exec vite --port ${portalPort}`,
      url: `http://localhost:${portalPort}`,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
