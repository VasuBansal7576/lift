import { defineConfig } from "@playwright/test";

const port = process.env.LIFT_PORT || process.env.PORT || "4174";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  projects: [
    {
      name: "site",
      testIgnore: /l3-balancer/,
      use: { baseURL: `http://127.0.0.1:${port}` },
    },
    {
      name: "l3-live",
      testMatch: /l3-balancer/,
      use: { baseURL: "http://127.0.0.1:4176" },
    },
    {
      name: "l3-stub",
      testMatch: /l3-balancer/,
      use: { baseURL: "http://127.0.0.1:4176" },
    },
  ],
  webServer: [
    {
      command: `npx tsx scripts/serve-site.ts --port ${port} --allow-mock`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npx tsx scripts/serve-l3.ts --port 4176",
      url: "http://127.0.0.1:4176",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
