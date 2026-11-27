import { Flagsmith } from "@flagsmith/nodejs";
import type { Flag } from "@flagsmith/nodejs";
import { chromium } from "@playwright/test";
import type { PatchSpec } from "../../../shared/patch-spec.ts";
import { pickPersona } from "../../../shared/mix.ts";
import { DEFAULT_PERSONA_MIX } from "../../../shared/types.ts";
import { mixSeed, mulberry32 } from "../../../shared/rng.ts";
import { identityFor } from "../../../traffic/src/identity.ts";
import { applyBaselineDropout } from "../../../traffic/src/runner.ts";
import { runPersona } from "../../../traffic/src/personas.ts";
import { applySpecOnPage, gotoControl } from "../browser.ts";
import type { EventLog } from "../log.ts";
import { assertAllowedUrl } from "../loopback.ts";
import type { FlagSetup, GateResult, OrchOptions, TrafficVisit } from "../types.ts";

function specForVariant(
  variant: string,
  controlKey: string,
  controlSpec: PatchSpec | null,
  passed: GateResult[],
): PatchSpec | null {
  if (variant === controlKey || variant === "control") return controlSpec;
  return passed.find((item) => item.specId === variant)?.spec ?? null;
}

export function variantKeyFromFlag(flag: {
  variant?: string | null;
  experiment?: { inExperiment?: boolean } | null;
}): string {
  if (!flag.experiment?.inExperiment) {
    throw new Error("Identity is not enrolled in a running experiment");
  }
  if (!flag.variant) {
    throw new Error("Experiment flag has no variant key");
  }
  return flag.variant;
}

export async function runTrafficAgent(
  opts: OrchOptions,
  flag: FlagSetup,
  passed: GateResult[],
  controlSpec: PatchSpec | null,
  log: EventLog,
): Promise<TrafficVisit[]> {
  log.emit("traffic", "start", `SIMULATED personas × ${opts.trafficN} sticky identities`);
  assertAllowedUrl(opts.siteUrl, opts.allowRemote, "LIFT_SITE_URL");

  if (!opts.apply || flag.dryRun) {
    log.emit("traffic", "info", "Dry-run: not firing Flagsmith conversion events");
    log.emit("traffic", "done", "Skipped live traffic");
    return [];
  }
  if (!opts.environmentKey && !opts.serverKey) {
    throw new Error("FLAGSMITH_SERVER_KEY or FLAGSMITH_ENVIRONMENT_KEY is required for traffic");
  }

  const flagsmith = new Flagsmith({
    environmentKey: opts.serverKey || opts.environmentKey,
    apiUrl: opts.adminApiUrl || opts.apiUrl,
    enableLocalEvaluation: Boolean(opts.serverKey),
    enableEvents: true,
    eventProcessorConfig: { eventsApiUrl: opts.eventsUrl },
  });

  const runId = `orch${Date.now().toString().slice(-8)}`;
  const seed = 20261127;
  const personaRand = mulberry32(mixSeed(seed, runId, 0, "persona"));
  const dropoutRand = mulberry32(mixSeed(seed, runId, 0, "dropout"));
  const browser = await chromium.launch({ headless: true });
  const visits: TrafficVisit[] = [];

  try {
    for (let i = 0; i < opts.trafficN; i += 1) {
      const persona = pickPersona(personaRand, DEFAULT_PERSONA_MIX);
      const identity = identityFor(runId, seed, i);
      const flagResult = (await flagsmith.getExperimentFlag(flag.flagName, identity, {
        simulated: true,
        persona,
        site: "checkout",
      })) as Flag;
      const variant = variantKeyFromFlag(flagResult);
      const spec = specForVariant(variant, flag.controlKey, controlSpec, passed);

      const context = await browser.newContext(
        persona === "low-vision" ? { deviceScaleFactor: 2 } : {},
      );
      const page = await context.newPage();
      await gotoControl(page, opts.siteUrl);
      if (spec) {
        const applied = await applySpecOnPage(page, spec);
        if (!applied.ok) {
          log.emit("traffic", "warn", `${identity} spec ${spec.id} failed to apply`);
        }
      }
      let attempt;
      try {
        attempt = await runPersona(page, persona);
      } catch (err) {
        attempt = {
          converted: false,
          blockedBy: [],
          reason: `persona failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
        };
      }
      const baseline = applyBaselineDropout(attempt.converted, dropoutRand, 0.75);
      const converted = baseline.converted;
      await context.close();

      if (converted) {
        flagsmith.trackEvent(opts.metricEvent, {
          identifier: identity,
          traits: { converted: true, simulated: true, persona, site: "checkout" },
        });
      }
      const visit: TrafficVisit = {
        identity,
        persona,
        variant,
        converted,
        reason: baseline.dropped ? "baseline drop-off (seeded)" : attempt.reason,
        simulated: true,
        at: new Date().toISOString(),
      };
      visits.push(visit);
      process.stdout.write(
        `${identity} ${persona} ${variant} ${converted ? "converted" : "blocked"} ${visit.reason}\n`,
      );
    }
  } finally {
    await browser.close();
    await flagsmith.flushEvents();
    await flagsmith.close(5000);
  }

  const converted = visits.filter((item) => item.converted).length;
  log.emit("traffic", "done", `${visits.length} visits, ${converted} conversions (SIMULATED)`, {
    visits: visits.length,
    conversions: converted,
  });
  return visits;
}
