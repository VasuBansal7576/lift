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
import type { BootstrapState } from "../../agent/src/bootstrap.ts";
import { FlagsmithAdmin, type ExperimentRecord } from "../../agent/src/flagsmith-admin.ts";
import { mixSeed, mulberry32 } from "../../shared/rng.ts";
import { pickPersona } from "../../shared/mix.ts";
import { isLoopbackHost } from "../../sites/shared/identity.js";
import { identityFor } from "./identity.ts";
import { runPersona } from "./personas.ts";

export { identityFor };

export function applyBaselineDropout(
  converted: boolean,
  rand: () => number,
  probability: number,
): { converted: boolean; dropped: boolean } {
  if (!converted) return { converted: false, dropped: false };
  if (rand() < probability) return { converted: true, dropped: false };
  return { converted: false, dropped: true };
}

/**
 * Extra seeded keep/drop when treatment added a friction step.
 * `keepRate` is P(keep): rand() < keepRate keeps the conversion.
 * Not a hard-coded loser — pricing's 0.4 keep rate is a designed-to-lose
 * pipeline check of pull_to_control.
 */
export function applyFrictionKeep(
  converted: boolean,
  rand: () => number,
  hasFriction: boolean,
  keepRate: number,
): { converted: boolean; dropped: boolean } {
  if (!converted || !hasFriction) {
    return { converted, dropped: false };
  }
  if (keepRate <= 0) return { converted: false, dropped: true };
  if (keepRate >= 1) return { converted: true, dropped: false };
  if (rand() < keepRate) return { converted: true, dropped: false };
  return { converted: false, dropped: true };
}

/** @deprecated Use applyFrictionKeep. Same keep-rate semantics. */
export const applyFrictionDropout = applyFrictionKeep;

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
  if (flag.variant === "treatment" || flag.variant === "control") {
    return flag.variant;
  }
  throw new Error(`Unknown variant key "${flag.variant}"; expected control or treatment.`);
}

export async function assignVariant(
  flagsmith: Flagsmith,
  flagName: string,
  identity: string,
  persona: Persona,
  site = "checkout",
): Promise<{ variant: Variant; flag: Flag }> {
  const flag = await flagsmith.getExperimentFlag(flagName, identity, {
    simulated: true,
    persona,
    site,
  });
  const variant = variantFromFlag(flag);
  return { variant, flag: flag as Flag };
}

/**
 * Poll local eval until visitor #0 would enroll. Events stay off so this
 * records zero fake exposures. The traffic loop then uses the same identity.
 */
async function waitUntilEnrolled(cfg: LiftConfig, timeoutMs = 120_000) {
  const identity = identityFor(cfg.trafficRunId, cfg.trafficSeed, 0);
  const deadline = Date.now() + timeoutMs;
  let last = "not tried";
  while (Date.now() < deadline) {
    const flagsmith = new Flagsmith({
      environmentKey: cfg.serverKey || cfg.environmentKey,
      apiUrl: cfg.adminApiUrl || cfg.apiUrl,
      enableLocalEvaluation: Boolean(cfg.serverKey),
      enableEvents: false,
      environmentRefreshIntervalSeconds: 1,
    });
    try {
      const flags = await flagsmith.getIdentityFlags(identity, {
        simulated: true,
        site: cfg.siteId,
      });
      const flag = flags.getFlag(cfg.flagName) as Flag;
      if (
        flag.experiment?.inExperiment &&
        (flag.variant === "control" || flag.variant === "treatment")
      ) {
        return;
      }
      last = `inExperiment=${Boolean(flag.experiment?.inExperiment)} variant=${String(flag.variant)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    } finally {
      await flagsmith.close(2000);
    }
    process.stderr.write(`Waiting for ${cfg.flagName} enrollment (${last})\n`);
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`Identities not enrolled in ${cfg.flagName} after ${timeoutMs}ms (${last})`);
}

async function assertExperimentRunning(cfg: LiftConfig) {
  if (!cfg.adminToken) {
    throw new Error(
      "FLAGSMITH_ADMIN_API_TOKEN is required to verify the experiment is running before sending traffic.",
    );
  }
  if (!cfg.environmentKey) {
    throw new Error(
      "FLAGSMITH_ENVIRONMENT_KEY is required to verify the experiment is running before sending traffic.",
    );
  }
  const state = readJson<BootstrapState>(statePath(cfg.siteId));
  if (!state) {
    throw new Error(
      "Missing bootstrap state. Run npm run bootstrap before sending traffic.",
    );
  }
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

export function assertTrafficSiteUrl(
  siteUrl: string,
  env: { LIFT_ALLOW_BOT_OVERRIDE?: string } = process.env,
): void {
  let hostname = "";
  try {
    hostname = new URL(siteUrl).hostname;
  } catch {
    throw new Error(`Refusing traffic: LIFT_SITE_URL is not a valid URL (${siteUrl})`);
  }
  if (isLoopbackHost(hostname)) return;
  if (env.LIFT_ALLOW_BOT_OVERRIDE === "true") return;
  throw new Error(
    `Refusing bot traffic to ${siteUrl}: host "${hostname}" is not loopback. Set LIFT_ALLOW_BOT_OVERRIDE=true only for a controlled environment.`,
  );
}

export async function runTraffic(overrides?: Partial<LiftConfig>) {
  const cfg = { ...loadConfig(), ...overrides };
  assertTrafficSiteUrl(cfg.siteUrl);
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
  await waitUntilEnrolled(cfg);

  const flagsmith = new Flagsmith({
    environmentKey: cfg.serverKey || cfg.environmentKey,
    apiUrl: cfg.adminApiUrl || cfg.apiUrl,
    enableLocalEvaluation: Boolean(cfg.serverKey),
    enableEvents: true,
    eventProcessorConfig: {
      eventsApiUrl: cfg.eventsUrl,
    },
  });

  const personaRand = mulberry32(
    mixSeed(cfg.trafficSeed, cfg.trafficRunId, cfg.trafficBatch, "persona"),
  );
  const dropoutRand = mulberry32(
    mixSeed(cfg.trafficSeed, cfg.trafficRunId, cfg.trafficBatch, "dropout"),
  );
  const frictionRand = mulberry32(
    mixSeed(cfg.trafficSeed, cfg.trafficRunId, cfg.trafficBatch, "friction"),
  );
  const visitsPath = eventsPath(cfg.siteId);
  mkdirSync(dirname(visitsPath), { recursive: true });
  if (!cfg.appendVisits) {
    writeFileSync(visitsPath, "");
  }

  const browser = await chromium.launch({ headless: true });
  const visits: VisitRecord[] = [];

  try {
    for (let i = 0; i < cfg.trafficN; i += 1) {
      const persona = pickPersona(personaRand, cfg.personaMix);
      const identity = identityFor(cfg.trafficRunId, cfg.trafficSeed, i);
      const { variant } = await assignVariant(
        flagsmith,
        cfg.flagName,
        identity,
        persona,
        cfg.siteId,
      );

      const context = await browser.newContext(
        persona === "low-vision" ? { deviceScaleFactor: 2 } : {},
      );
      const page = await context.newPage();
      const url = `${cfg.siteUrl}/?lift_variant=${variant}&lift_bot=1&lift_identity=${encodeURIComponent(identity)}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        ({ expected }) =>
          document.body.dataset.variant === expected &&
          (document.getElementById("flag-status")?.textContent ?? "").includes(
            "URL override",
          ),
        { expected: variant },
        { timeout: 10_000 },
      );
      const seen = await page.evaluate(() => ({
        variant: document.body.dataset.variant,
        status: document.getElementById("flag-status")?.textContent ?? "",
      }));
      if (seen.variant !== variant) {
        throw new Error(
          `${cfg.siteId} dataset.variant=${seen.variant} does not match assigned ${variant}`,
        );
      }
      if (!seen.status.includes("URL override")) {
        throw new Error(
          `Expected #flag-status to show URL override, got ${JSON.stringify(seen.status)}`,
        );
      }
      const attempt = await runPersona(page, persona);
      const hasFriction = await page.evaluate(
        () => document.body.dataset.friction === "true",
      );
      const baseline = applyBaselineDropout(
        attempt.converted,
        dropoutRand,
        cfg.baselineConvert,
      );
      const friction = applyFrictionKeep(
        baseline.converted,
        frictionRand,
        hasFriction,
        cfg.frictionKeepRate,
      );
      const converted = friction.converted;
      const reason = friction.dropped
        ? "friction step drop-off (seeded; treatment extra confirm)"
        : baseline.dropped
          ? "baseline drop-off (seeded; independent of barriers)"
          : attempt.reason;
      await context.close();

      if (converted) {
        flagsmith.trackEvent(cfg.metricEvent, {
          identifier: identity,
          traits: {
            converted: true,
            simulated: true,
            persona,
            site: cfg.siteId,
          },
        });
      }

      const visit: VisitRecord = {
        identity,
        persona,
        variant,
        converted,
        blockedBy: baseline.dropped || friction.dropped ? [] : attempt.blockedBy,
        reason,
        simulated: true,
        at: new Date().toISOString(),
      };
      visits.push(visit);
      appendFileSync(visitsPath, `${JSON.stringify(visit)}\n`);
      process.stdout.write(
        `${identity} ${persona} ${variant} ${converted ? "converted" : "blocked"} ${reason}\n`,
      );
    }
  } finally {
    await browser.close();
    await flagsmith.flushEvents();
    await flagsmith.close(5000);
  }

  writeFileSync(
    resolve(ROOT, "data/traffic-summary.json"),
    `${JSON.stringify({ traffic: "simulated", site: cfg.siteId, seed: cfg.trafficSeed, mix: cfg.personaMix, visits }, null, 2)}\n`,
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
