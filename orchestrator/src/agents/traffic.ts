import { Flagsmith } from "@flagsmith/nodejs";
import type { Flag } from "@flagsmith/nodejs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { pickPersona } from "../../../shared/mix.ts";
import { DEFAULT_PERSONA_MIX } from "../../../shared/types.ts";
import { mixSeed, mulberry32 } from "../../../shared/rng.ts";
import { identityFor } from "../../../traffic/src/identity.ts";
import { runPersona, type AttemptResult } from "../../../traffic/src/personas.ts";
import { gotoSite } from "../browser.ts";
import type { EventLog } from "../log.ts";
import { assertAllowedUrl } from "../loopback.ts";
import {
  SHARED_KEEP_RATE,
  TrafficAbortError,
  appliedVariantMatches,
  applySharedKeep,
  cookieMatchesIdentity,
  personaConvertsOnSurface,
  type PersonaSurface,
} from "../traffic-guard.ts";
import type { FlagSetup, GateResult, OrchOptions, TrafficVisit } from "../types.ts";

const PERSONA_TIMEOUT_ABORT_RATE = 0.02;
const PERSONA_BUDGET_MS = 15_000;

export interface TrafficFlagsmith {
  getExperimentFlag: (
    name: string,
    identity: string,
    traits?: Record<string, unknown>,
  ) => Promise<{ variant?: string | null; experiment?: { inExperiment?: boolean } | null }>;
  trackEvent: (event: string, payload: Record<string, unknown>) => void;
  flushEvents: () => Promise<void>;
  close: (ms?: number) => Promise<void>;
}

export interface TrafficAgentDeps {
  flagsmith?: TrafficFlagsmith;
  launchBrowser?: () => Promise<Browser>;
  runPersona?: typeof runPersona;
  gotoSite?: typeof gotoSite;
  waitForAppliedVariant?: (page: Page, expected: string) => Promise<string>;
  /** Test-only stub. Production traffic does not set this. */
  surfaceForVariant?: (variant: string) => PersonaSurface;
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

export function trafficSeedFromEnv(): number {
  const raw = process.env.LIFT_TRAFFIC_SEED?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return 20261127;
}

export function trafficConcurrencyFromEnv(): number {
  const raw = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY?.trim();
  if (raw) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 24);
  }
  return 12;
}

export function trafficRunIdFromEnv(): string {
  const raw = process.env.LIFT_RUN_ID?.trim();
  if (raw && /^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;
  return `orch${Date.now().toString().slice(-8)}`;
}

export function oneLineError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function waitForAppliedVariant(page: Page, expected: string): Promise<string> {
  await page.waitForFunction(
    (wanted) => document.documentElement.dataset.liftAppliedVariant === wanted,
    expected,
    { timeout: 15_000 },
  );
  return page.evaluate(() => document.documentElement.dataset.liftAppliedVariant ?? "");
}

async function mapPool(count: number, limit: number, fn: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await fn(index);
    }
  }
  const n = Math.min(Math.max(1, limit), count);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

function failureRateByArm(visits: TrafficVisit[]): Map<string, { n: number; failures: number }> {
  const byArm = new Map<string, { n: number; failures: number }>();
  for (const visit of visits) {
    const row = byArm.get(visit.variant) ?? { n: 0, failures: 0 };
    row.n += 1;
    if (/timed out/i.test(visit.reason) || /persona failed/i.test(visit.reason)) row.failures += 1;
    byArm.set(visit.variant, row);
  }
  return byArm;
}

export async function runTrafficAgent(
  opts: OrchOptions,
  flag: FlagSetup,
  _passed: GateResult[],
  _controlSpec: unknown,
  log: EventLog,
  deps: TrafficAgentDeps = {},
): Promise<TrafficVisit[]> {
  const seed = trafficSeedFromEnv();
  const concurrency = trafficConcurrencyFromEnv();
  const runId = trafficRunIdFromEnv();
  log.emit(
    "traffic",
    "start",
    `SIMULATED personas × ${opts.trafficN} sticky identities (runId=${runId} seed=${seed}, keep=${SHARED_KEEP_RATE} all arms, concurrency=${concurrency})`,
    { runId, seed, keepRate: SHARED_KEEP_RATE, concurrency, mix: DEFAULT_PERSONA_MIX },
  );
  assertAllowedUrl(opts.siteUrl, opts.allowRemote, "LIFT_SITE_URL");

  if (!opts.apply || flag.dryRun) {
    log.emit("traffic", "info", "Dry-run: not firing Flagsmith conversion events");
    log.emit("traffic", "done", "Skipped live traffic");
    return [];
  }
  if (!deps.flagsmith && !opts.environmentKey && !opts.serverKey) {
    throw new Error("FLAGSMITH_SERVER_KEY or FLAGSMITH_ENVIRONMENT_KEY is required for traffic");
  }

  const flagsmith: TrafficFlagsmith =
    deps.flagsmith ??
    (new Flagsmith({
      environmentKey: opts.serverKey || opts.environmentKey,
      apiUrl: opts.adminApiUrl || opts.apiUrl,
      enableLocalEvaluation: Boolean(opts.serverKey),
      enableEvents: true,
      eventProcessorConfig: { eventsApiUrl: opts.eventsUrl },
    }) as unknown as TrafficFlagsmith);

  const launchBrowser = deps.launchBrowser ?? (() => chromium.launch({ headless: true }));
  const runPersonaImpl = deps.runPersona ?? runPersona;
  const gotoSiteImpl = deps.gotoSite ?? gotoSite;
  const waitApplied = deps.waitForAppliedVariant ?? waitForAppliedVariant;

  const browser = await launchBrowser();
  const visits: TrafficVisit[] = [];
  const siteOrigin = new URL(opts.siteUrl);

  try {
    await mapPool(opts.trafficN, concurrency, async (i) => {
      const personaRand = mulberry32(mixSeed(seed, runId, i, "persona"));
      const dropoutRand = mulberry32(mixSeed(seed, runId, i, "dropout"));
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
        await gotoSiteImpl(page, opts.siteUrl);
        const cookiesAfter = await context.cookies();
        if (!cookieMatchesIdentity(cookiesAfter, identity)) {
          throw new TrafficAbortError(`lift_vid cookie did not persist for ${identity}`);
        }
        let applied: string;
        try {
          applied = await waitApplied(page, variant);
        } catch (err) {
          const actual = await page.evaluate(() => document.documentElement.dataset.liftAppliedVariant ?? "");
          const status = await page.evaluate(() => document.getElementById("flag-status")?.textContent ?? "");
          throw new TrafficAbortError(
            `No runtime variant marker for ${identity} (expected ${variant}, page=${actual || "(none)"}, status=${status || "(none)"}): ${oneLineError(err)}`,
          );
        }
        if (!appliedVariantMatches(applied, variant)) {
          throw new TrafficAbortError(
            `Variant mismatch for ${identity}: page=${applied || "(none)"} expected=${variant}. Dropping visit.`,
          );
        }

        let attempt: AttemptResult;
        try {
          if (deps.surfaceForVariant) {
            const ok = personaConvertsOnSurface(persona, deps.surfaceForVariant(variant));
            attempt = {
              converted: ok,
              blockedBy: [],
              reason: ok ? "surface stub converted" : "surface stub blocked",
            };
          } else {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
              attempt = await Promise.race([
                runPersonaImpl(page, persona),
                new Promise<AttemptResult>((resolve) => {
                  timeoutHandle = setTimeout(
                    () =>
                      resolve({
                        converted: false,
                        blockedBy: [],
                        reason: `persona timed out after ${PERSONA_BUDGET_MS}ms`,
                      }),
                    PERSONA_BUDGET_MS,
                  );
                }),
              ]);
            } finally {
              if (timeoutHandle) clearTimeout(timeoutHandle);
            }
          }
        } catch (err) {
          attempt = {
            converted: false,
            blockedBy: [],
            reason: `persona failed: ${oneLineError(err)}`,
          };
        }
        const baseline = applySharedKeep(attempt.converted, dropoutRand, SHARED_KEEP_RATE);
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
          reason: baseline.dropped ? "baseline drop-off (seeded, shared keep)" : attempt.reason,
          simulated: true,
          at: new Date().toISOString(),
        };
        visits.push(visit);
        process.stdout.write(
          `${identity} ${persona} ${variant} ${converted ? "converted" : "blocked"} ${visit.reason}\n`,
        );
        if (visits.length % 20 === 0) {
          process.stdout.write(`traffic progress ${visits.length}/${opts.trafficN} (runId=${runId} seed=${seed})\n`);
        }
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    await flagsmith.flushEvents();
    await flagsmith.close(5000);
  }

  const failureRows = failureRateByArm(visits);
  for (const [arm, row] of failureRows) {
    const rate = row.n === 0 ? 0 : row.failures / row.n;
    log.emit(
      "traffic",
      rate > PERSONA_TIMEOUT_ABORT_RATE ? "warn" : "info",
      `persona timeouts/failures arm=${arm} ${row.failures}/${row.n} (${(rate * 100).toFixed(1)}%)`,
      { arm, failures: row.failures, n: row.n, rate },
    );
    if (rate > PERSONA_TIMEOUT_ABORT_RATE) {
      throw new TrafficAbortError(
        `persona timeout/failure rate ${(rate * 100).toFixed(1)}% on ${arm} exceeds ${PERSONA_TIMEOUT_ABORT_RATE * 100}%`,
      );
    }
  }

  const converted = visits.filter((item) => item.converted).length;
  log.emit("traffic", "done", `${visits.length} visits, ${converted} conversions (SIMULATED, runId=${runId} seed=${seed})`, {
    visits: visits.length,
    conversions: converted,
    seed,
    runId,
    keepRate: SHARED_KEEP_RATE,
  });
  return visits;
}
