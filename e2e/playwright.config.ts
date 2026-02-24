import { defineConfig, devices } from "@playwright/test";

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
        "pnpm --filter @app/api build && CORS_ORIGIN_ADMIN=http://localhost:4173 CORS_ORIGIN_PORTAL=http://localhost:4174 pnpm --filter @app/api start",
      url: "http://localhost:3001/health",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "pnpm --filter @app/admin exec vite --port 4173",
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "pnpm --filter @app/portal exec vite --port 4174",
      url: "http://localhost:4174",
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
