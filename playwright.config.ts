import { defineConfig, devices } from "@playwright/test";

// Needs a built client (pnpm build) and Docker for the throwaway Postgres.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  workers: 1,
  webServer: {
    command: "npx tsx scripts/e2e-server.ts",
    url: "http://localhost:3100/healthz",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
