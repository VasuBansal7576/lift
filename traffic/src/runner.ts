import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { Flagsmith } from "@flagsmith/nodejs";
import type { Flag } from "@flagsmith/nodejs";
import type { Persona, Variant, VisitRecord } from "../../shared/types.ts";
import {
  eventsPath,
  loadConfig,
  readJson,
  ROOT,
  statePath,
  type LiftConfig,
} from "../../agent/src/config.ts";
import { writeCheckoutConfig, type BootstrapState } from "../../agent/src/bootstrap.ts";
import { FlagsmithAdmin, type ExperimentRecord } from "../../agent/src/flagsmith-admin.ts";
import { mulberry32 } from "../../shared/rng.ts";
import { pickPersona } from "../../shared/mix.ts";
import { runPersona } from "./personas.ts";

function identityFor(seed: number, index: number): string {
  return `lift-sim-${seed}-${String(index).padStart(4, "0")}`;
}

export function variantFromFlag(flag: {
  value?: unknown;
  variant?: string | null;
  enabled?: boolean;
  experiment?: { inExperiment?: boolean } | null;
}): Variant {
  if (!flag.experiment?.inExperiment) {
    throw new Error(
      "Identity is not enrolled in a running experiment (flag.experiment.inExperiment !== true). Refusing to assign.",
    );
  }
  if (flag.variant === undefined || flag.variant === null || flag.variant === "") {
    throw new Error("Experiment flag has no variant key; exposures cannot be recorded.");
  }
  return flag.variant === "treatment" ? "treatment" : "control";
}

export async function assignVariant(
  flagsmith: Flagsmith,
  flagName: string,
  identity: string,
  persona: Persona,
): Promise<{ variant: Variant; flag: Flag }> {
  const flag = await flagsmith.getExperimentFlag(flagName, identity, {
    simulated: true,
    persona,
    site: "checkout",
  });
  const variant = variantFromFlag(flag);
  return { variant, flag: flag as Flag };
}

async function assertExperimentRunning(cfg: LiftConfig) {
  if (!cfg.adminToken || !cfg.environmentKey) return;
  const state = readJson<BootstrapState>(statePath());
  if (!state) return;
  const admin = new FlagsmithAdmin(cfg);
  const { data } = await admin.get<ExperimentRecord>(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/`,
  );
  if (data.status === "completed") {
    throw new Error(
      `Experiment ${state.experimentId} is completed. Refusing to send traffic.`,
    );
  }
  if (data.status !== "running") {
    throw new Error(
      `Experiment ${state.experimentId} status is ${data.status}, expected running.`,
    );
  }
}

export async function runTraffic(overrides?: Partial<LiftConfig>) {
  const cfg = { ...loadConfig(), ...overrides };
  if (!cfg.serverKey && !cfg.environmentKey) {
    throw new Error(
      "FLAGSMITH_SERVER_KEY (preferred, local evaluation) or FLAGSMITH_ENVIRONMENT_KEY is required",
    );
  }
  if (!cfg.serverKey) {
    process.stderr.write(
      "Warning: FLAGSMITH_SERVER_KEY missing; remote evaluation will cost one Flags API call per visitor.\n",
    );
  }

  await assertExperimentRunning(cfg);
  writeCheckoutConfig(cfg, { allowMock: true });

  const flagsmith = new Flagsmith({
    environmentKey: cfg.serverKey || cfg.environmentKey,
    apiUrl: cfg.adminApiUrl || cfg.apiUrl,
    enableLocalEvaluation: Boolean(cfg.serverKey),
    enableEvents: true,
    eventProcessorConfig: {
      eventsApiUrl: cfg.eventsUrl,
    },
  });

  const rand = mulberry32(cfg.trafficSeed);
  const visitsPath = eventsPath();
  mkdirSync(dirname(visitsPath), { recursive: true });
  writeFileSync(visitsPath, "");

  const browser = await chromium.launch({ headless: true });
  const visits: VisitRecord[] = [];

  try {
    for (let i = 0; i < cfg.trafficN; i += 1) {
      const persona = pickPersona(rand, cfg.personaMix);
      const identity = identityFor(cfg.trafficSeed, i);
      const { variant } = await assignVariant(
        flagsmith,
        cfg.flagName,
        identity,
        persona,
      );

      const context = await browser.newContext(
        persona === "low-vision" ? { deviceScaleFactor: 2 } : {},
      );
      const page = await context.newPage();
      const url = `${cfg.siteUrl}/?lift_variant=${variant}&lift_identity=${encodeURIComponent(identity)}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => Boolean(document.body.dataset.variant),
        null,
        { timeout: 10_000 },
      );
      const attempt = await runPersona(page, persona);
      await context.close();

      if (attempt.converted) {
        flagsmith.trackEvent(cfg.metricEvent, {
          identifier: identity,
          traits: {
            converted: true,
            simulated: true,
            persona,
            site: "checkout",
          },
        });
      }

      const visit: VisitRecord = {
        identity,
        persona,
        variant,
        converted: attempt.converted,
        blockedBy: attempt.blockedBy,
        reason: attempt.reason,
        simulated: true,
      };
      visits.push(visit);
      appendFileSync(visitsPath, `${JSON.stringify(visit)}\n`);
      process.stdout.write(
        `${identity} ${persona} ${variant} ${attempt.converted ? "converted" : "blocked"} ${attempt.reason}\n`,
      );
    }
  } finally {
    await browser.close();
    await flagsmith.flushEvents();
    await flagsmith.close(5000);
  }

  writeFileSync(
    resolve(ROOT, "data/traffic-summary.json"),
    `${JSON.stringify({ traffic: "simulated", seed: cfg.trafficSeed, mix: cfg.personaMix, visits }, null, 2)}\n`,
  );
  return visits;
}

async function main() {
  await runTraffic();
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
