import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test.describe.configure({ timeout: 1_200_000 });

test("full orchestrator flow against self-hosted Flagsmith", async () => {
  test.skip(!hasFlagsmith, "self-hosted Flagsmith env is not configured");
  const dir = mkdtempSync(join(tmpdir(), "lift-orch-"));
  const previousStateDir = process.env.LIFT_ORCH_STATE_DIR;
  const previousExtra = process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS;
  process.env.LIFT_ORCH_STATE_DIR = dir;
  const flagName = `lift_orch_e2e_${Date.now().toString(36)}`;
  try {
    const opts = parseArgv([
      "--apply",
      "--no-ui",
      "--traffic-n",
      "220",
      "--generations",
      "1",
      "--flag-name",
      flagName,
      "--site-url",
      "http://127.0.0.1:4184/checkout",
    ]);
    opts.resultsWaitMs = 90_000;
    process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = "1";
    process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY || "16";
    const state = await runOrchestrator(opts);
    expect(state.generations).toHaveLength(1);
    const gen = state.generations[0];
    expect(gen.rejected.some((item) => item.specId.includes("bad-contrast"))).toBe(true);
    const hostile = gen.rejected.find((item) => item.specId.includes("bad-contrast"));
    expect(hostile?.reason).toMatch(/added axe rules|nodes increased/i);
    expect(gen.passed.length).toBeGreaterThan(0);
    expect(gen.flag?.flagName.startsWith("lift_orch_")).toBe(true);
    expect(gen.flag?.flagId).toBeGreaterThan(0);
    expect(gen.flag?.experimentId).toBeGreaterThan(0);
    expect(gen.flag?.metricId).toBeGreaterThan(0);
    expect(["WAITING_FOR_HUMAN_APPROVAL", "KEEP_COLLECTING"]).toContain(state.phase);
    expect(gen.visits?.length ?? 0).toBeGreaterThan(0);

    if (state.recommendation?.kind === "winner" && gen.flag?.experimentId) {
      const approveOpts = parseArgv(["--approve", String(gen.flag.experimentId), "--apply", "--no-ui"]);
      const rolled = await runOrchestrator(approveOpts, {
        approvalIo: {
          isTTY: true,
          readLine: async () => `APPROVE ${gen.flag?.experimentId}`,
        },
      });
      expect(rolled.phase).toBe("complete");
      expect(rolled.recommendation?.kind).toBe("winner");
    }
  } finally {
    try {
      const cleanup = parseArgv(["--cleanup", "--apply", "--no-ui"]);
      cleanup.flagName = flagName;
      await runOrchestrator(cleanup);
    } catch {
      /* best-effort */
    }
    if (previousStateDir === undefined) delete process.env.LIFT_ORCH_STATE_DIR;
    else process.env.LIFT_ORCH_STATE_DIR = previousStateDir;
    if (previousExtra === undefined) delete process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS;
    else process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = previousExtra;
    rmSync(dir, { recursive: true, force: true });
  }
});
