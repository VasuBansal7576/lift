import { Flagsmith } from "@flagsmith/nodejs";
import type { Flag } from "@flagsmith/nodejs";
import { chromium } from "@playwright/test";
import { pickPersona } from "../../../shared/mix.ts";
import { DEFAULT_PERSONA_MIX } from "../../../shared/types.ts";
import { mixSeed, mulberry32 } from "../../../shared/rng.ts";
import { identityFor } from "../../../traffic/src/identity.ts";
import { applyBaselineDropout } from "../../../traffic/src/runner.ts";
import { runPersona } from "../../../traffic/src/personas.ts";
import { gotoSite } from "../browser.ts";
import type { EventLog } from "../log.ts";
import { assertAllowedUrl } from "../loopback.ts";
import {
  TrafficAbortError,
  appliedVariantMatches,
  cookieMatchesIdentity,
} from "../traffic-guard.ts";
import type { FlagSetup, GateResult, OrchOptions, TrafficVisit } from "../types.ts";

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

async function waitForAppliedVariant(page: import("@playwright/test").Page, expected: string): Promise<string> {
  await page.waitForFunction(
    (wanted) => document.documentElement.dataset.liftAppliedVariant === wanted,
    expected,
    { timeout: 15_000 },
  );
  return page.evaluate(() => document.documentElement.dataset.liftAppliedVariant ?? "");
}

export async function runTrafficAgent(
  opts: OrchOptions,
  flag: FlagSetup,
  _passed: GateResult[],
  _controlSpec: unknown,
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
  const siteOrigin = new URL(opts.siteUrl);

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

      const context = await browser.newContext(
        persona === "low-vision" ? { deviceScaleFactor: 2 } : {},
      );
      await context.addCookies([
        {
          name: "lift_vid",
          value: identity,
          url: `${siteOrigin.protocol}//${siteOrigin.host}/`,
        },
      ]);
      const page = await context.newPage();
      try {
        await gotoSite(page, opts.siteUrl);
        const cookiesAfter = await context.cookies();
        if (!cookieMatchesIdentity(cookiesAfter, identity)) {
          throw new TrafficAbortError(`lift_vid cookie did not persist for ${identity}`);
        }
        let applied: string;
        try {
          applied = await waitForAppliedVariant(page, variant);
        } catch {
          const actual = await page.evaluate(() => document.documentElement.dataset.liftAppliedVariant ?? "");
          const status = await page.evaluate(() => document.getElementById("flag-status")?.textContent ?? "");
          throw new TrafficAbortError(
            `No runtime variant marker for ${identity} (expected ${variant}, page=${actual || "(none)"}, status=${status || "(none)"})`,
          );
        }
        if (!appliedVariantMatches(applied, variant)) {
          throw new TrafficAbortError(
            `Variant mismatch for ${identity}: page=${applied || "(none)"} expected=${variant}. Dropping visit.`,
          );
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
      } finally {
        await context.close();
      }
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
