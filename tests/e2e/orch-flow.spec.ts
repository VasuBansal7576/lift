import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { expect, test } from "@playwright/test";
import { parseArgv } from "../../orchestrator/src/config.ts";
import { runOrchestrator } from "../../orchestrator/src/conductor.ts";

if (existsSync("/tmp/lift-flagsmith.env")) {
  loadEnv({ path: "/tmp/lift-flagsmith.env" });
}

const hasFlagsmith = Boolean(
  process.env.FLAGSMITH_ADMIN_API_TOKEN &&
    process.env.FLAGSMITH_ENVIRONMENT_KEY &&
    process.env.FLAGSMITH_PROJECT_ID,
);

test.describe.configure({ timeout: 600_000 });

test("full orchestrator flow against self-hosted Flagsmith", async () => {
  test.skip(!hasFlagsmith, "self-hosted Flagsmith env is not configured");
  const opts = parseArgv([
    "--apply",
    "--no-ui",
    "--traffic-n",
    "8",
    "--generations",
    "1",
    "--site-url",
    "http://127.0.0.1:4174/checkout",
  ]);
  opts.resultsWaitMs = 20_000;
  const state = await runOrchestrator(opts);
  expect(state.generations).toHaveLength(1);
  const gen = state.generations[0];
  expect(gen.rejected.some((item) => item.specId.includes("bad-contrast"))).toBe(true);
  expect(gen.passed.length).toBeGreaterThan(0);
  expect(gen.flag?.flagId).toBeGreaterThan(0);
  expect(gen.flag?.experimentId).toBeGreaterThan(0);
  expect(gen.flag?.metricId).toBeGreaterThan(0);
  expect(state.phase).toBe("WAITING_FOR_HUMAN_APPROVAL");
  expect(gen.visits?.length ?? 0).toBeGreaterThan(0);
});
