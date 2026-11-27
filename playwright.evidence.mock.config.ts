import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const evidenceDir = resolve(process.env.EVIDENCE_DIR || resolve(repoRoot, "artifacts/fir-9-a"));
const port = process.env.LIFT_MOCK_PORT || process.env.LIFT_PORT || process.env.PORT || "4175";

export default defineConfig({
  testDir: "tests/evidence",
  grepInvert: /05-sticky-identity/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    video: "on",
    trace: "on",
    launchOptions: {
      slowMo: 120,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  outputDir: resolve(evidenceDir, "playwright"),
  webServer: {
    command: `npx tsx scripts/serve-site.ts --port ${port} --allow-mock`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
