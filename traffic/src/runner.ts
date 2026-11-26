import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { Flagsmith } from "@flagsmith/nodejs";
import { PERSONAS, type Persona, type Variant, type VisitRecord } from "../../shared/types.ts";
import { eventsPath, loadConfig, ROOT } from "../../agent/src/config.ts";
import { mulberry32 } from "./seed.ts";
import { runPersona } from "./personas.ts";

function identityFor(seed: number, index: number): string {
  return `lift-sim-${seed}-${String(index).padStart(4, "0")}`;
}

function variantFromFlag(flag: {
  value?: unknown;
  variant?: string | null;
  enabled?: boolean;
}): Variant {
  const value = flag.variant ?? flag.value;
  return value === "treatment" ? "treatment" : "control";
}

async function assignVariant(
  flagsmith: Flagsmith | null,
  flagName: string,
  identity: string,
  persona: Persona,
): Promise<Variant> {
  if (!flagsmith) {
    throw new Error("Flagsmith client is required for variant assignment");
  }
  const flag = await flagsmith.getExperimentFlag(flagName, identity, {
    simulated: true,
    persona,
    site: "checkout",
  });
  return variantFromFlag(flag);
}

export async function runTraffic() {
  const cfg = loadConfig();
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

  const flagsmith = new Flagsmith({
    environmentKey: cfg.serverKey || cfg.environmentKey,
    apiUrl: cfg.apiUrl,
    enableLocalEvaluation: Boolean(cfg.serverKey),
    enableEvents: true,
    eventProcessorConfig: {
      eventsApiUrl: cfg.eventsUrl,
      maxBuffer: 25,
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
      const persona = PERSONAS[Math.floor(rand() * PERSONAS.length)];
      const identity = identityFor(cfg.trafficSeed, i);
      const variant = await assignVariant(
        flagsmith,
        cfg.flagName,
        identity,
        persona,
      );

      const context = await browser.newContext();
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
    `${JSON.stringify({ traffic: "simulated", seed: cfg.trafficSeed, visits }, null, 2)}\n`,
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
