import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const evidenceDir = resolve(process.env.EVIDENCE_DIR || resolve(repoRoot, "artifacts/fir-9-a"));

export default defineConfig({
  testDir: "tests/evidence",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
    viewport: { width: 1280, height: 800 },
    video: "on",
    trace: "on",
    launchOptions: { slowMo: 350 },
  },
  outputDir: resolve(evidenceDir, "playwright"),
  webServer: {
    command: "npx tsx scripts/serve-site.ts --port 4174 --allow-mock",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
