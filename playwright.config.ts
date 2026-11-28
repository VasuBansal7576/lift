import { defineConfig } from "@playwright/test";

const port = process.env.LIFT_PORT || process.env.PORT || "4174";
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: origin,
    headless: true,
  },
  webServer: {
    command: `npx tsx scripts/serve-site.ts --port ${port} --allow-mock`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
