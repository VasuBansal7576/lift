import { Flagsmith } from "@flagsmith/nodejs";
import type { Flag } from "@flagsmith/nodejs";
import { mixSeed, mulberry32 } from "../../shared/rng.ts";
import { PERSONAS, type Persona, type PersonaMix } from "../../shared/types.ts";
import { pickPersona } from "../../shared/mix.ts";
import { variantFromFlag } from "../../traffic/src/runner.ts";

export interface TrafficCounts {
  identities: number;
  control: { n: number; conversions: number };
  treatment: { n: number; conversions: number };
  event: string;
}

export interface A11yOutcome {
  hoverMenuBarrier: boolean;
  missingLabels: boolean;
  divButton: boolean;
  unlabeledIcon: boolean;
  lowContrast: boolean;
  axeKeyboardBarriers: boolean;
}

export interface PageA11yMeasurement {
  shopIsButton: boolean;
  fieldsLabeled: boolean;
  placeOrderIsButton: boolean;
  contrastFixed: boolean;
  cartLabeled: boolean;
  axeIds: string[];
}

export const EQUAL_BASE_RATE = 0.72;

/** More a11y-sensitive than the dashboard default mix so the measured-page gap is visible. */
export const SKILL_TRAFFIC_MIX: PersonaMix = {
  mouse: 0.4,
  keyboard: 0.25,
  "screen-reader": 0.25,
  "low-vision": 0.1,
};

const KEYBOARD_AXE = /label|button-name|color-contrast|keyboard|nested-interactive/i;

export function a11yOutcomeFromMeasurements(m: PageA11yMeasurement): A11yOutcome {
  return {
    hoverMenuBarrier: !m.shopIsButton,
    missingLabels: !m.fieldsLabeled,
    divButton: !m.placeOrderIsButton,
    unlabeledIcon: !m.cartLabeled,
    lowContrast: !m.contrastFixed,
    axeKeyboardBarriers: m.axeIds.some((id) => KEYBOARD_AXE.test(id)),
  };
}

function keyboardBlocked(outcome: A11yOutcome): boolean {
  return (
    outcome.hoverMenuBarrier ||
    outcome.divButton ||
    outcome.missingLabels ||
    outcome.axeKeyboardBarriers
  );
}

/** Equal base rate for both variants. Conversion follows the measured page, not the variant name. */
export function conversionProbability(
  persona: Persona,
  outcome: A11yOutcome,
  baseRate = EQUAL_BASE_RATE,
): number {
  switch (persona) {
    case "keyboard":
    case "screen-reader":
      return keyboardBlocked(outcome) ? 0 : baseRate;
    case "low-vision":
      return outcome.lowContrast ? baseRate * 0.2 : baseRate;
    case "mouse":
      return baseRate;
    default: {
      const _never: never = persona;
      throw new Error(`unknown persona ${_never}`);
    }
  }
}

export function expectedConversionRate(
  mix: PersonaMix,
  outcome: A11yOutcome,
  baseRate = EQUAL_BASE_RATE,
): number {
  let sum = 0;
  for (const persona of PERSONAS) {
    sum += mix[persona] * conversionProbability(persona, outcome, baseRate);
  }
  return sum;
}

function identityFor(runId: string, i: number): string {
  return `lift-skill-${runId}-${String(i).padStart(4, "0")}`;
}

async function waitUntilEnrolled(opts: {
  apiUrl: string;
  environmentKey: string;
  serverKey: string;
  flagName: string;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let last = "not tried";
  while (Date.now() < deadline) {
    const flagsmith = new Flagsmith({
      environmentKey: opts.environmentKey,
      apiUrl: opts.apiUrl,
      enableLocalEvaluation: false,
      enableEvents: false,
    });
    try {
      const flags = await flagsmith.getIdentityFlags(identityFor("probe", 0), {
        simulated: true,
        site: "skill",
      });
      const flag = flags.getFlag(opts.flagName) as Flag;
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
    process.stderr.write(`enroll wait ${last}\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Identities not enrolled in ${opts.flagName} (${last})`);
}

export function simulatedConversionsLabel(n = 120): string {
  return `SIMULATED conversions: ${n} real Flagsmith identities`;
}

/**
 * SIMULATED conversions: real Flagsmith identities. Both variants share the same
 * base rate; conversion is decided by the measured a11y outcome of the page that
 * identity was served, plus a seeded RNG. Keyboard and screen-reader personas
 * fail when hover-menu / unlabeled / div-button / axe keyboard barriers are present.
 */
export interface ConversionHooks {
  enroll?: () => Promise<void>;
  getVariant?: (identity: string, persona: Persona) => Promise<"control" | "treatment">;
  onConvert?: (identity: string, persona: Persona, variant: "control" | "treatment") => void;
}

export async function sendSimulatedConversions(opts: {
  apiUrl: string;
  eventsUrl: string;
  environmentKey: string;
  serverKey: string;
  flagName: string;
  event: string;
  n?: number;
  runId?: string;
  seed?: number;
  personaMix?: PersonaMix;
  outcomes: { control: A11yOutcome; treatment: A11yOutcome };
  hooks?: ConversionHooks;
}): Promise<TrafficCounts> {
  const n = opts.n ?? 120;
  const runId = opts.runId ?? `run-${Date.now()}`;
  const mix = opts.personaMix ?? SKILL_TRAFFIC_MIX;
  const rand = mulberry32(mixSeed(opts.seed ?? 1, runId, 0, "persona"));
  process.stderr.write(`traffic enroll start n=${n} runId=${runId}\n`);
  if (opts.hooks?.enroll) await opts.hooks.enroll();
  else await waitUntilEnrolled(opts);
  process.stderr.write(`traffic enroll done; sending ${n} identities\n`);

  const resolveVariant = opts.hooks?.getVariant;
  const flagsmith = resolveVariant
    ? null
    : new Flagsmith({
        environmentKey: opts.environmentKey,
        apiUrl: opts.apiUrl,
        enableLocalEvaluation: false,
        enableEvents: true,
        eventProcessorConfig: {
          eventsApiUrl: opts.eventsUrl,
        },
      });

  const counts: TrafficCounts = {
    identities: 0,
    control: { n: 0, conversions: 0 },
    treatment: { n: 0, conversions: 0 },
    event: opts.event,
  };

  try {
    for (let i = 0; i < n; i += 1) {
      const identity = identityFor(runId, i);
      const persona = pickPersona(rand, mix);
      const variant = resolveVariant
        ? await resolveVariant(identity, persona)
        : variantFromFlag(
            (await flagsmith!.getExperimentFlag(opts.flagName, identity, {
              simulated: true,
              persona,
              site: "skill",
            })) as Flag,
          );
      counts.identities += 1;
      counts[variant].n += 1;
      const outcome = opts.outcomes[variant];
      const converted = rand() < conversionProbability(persona, outcome);
      if (converted) {
        counts[variant].conversions += 1;
        if (opts.hooks?.onConvert) opts.hooks.onConvert(identity, persona, variant);
        else if (flagsmith) {
          flagsmith.trackEvent(opts.event, {
            identifier: identity,
            traits: {
              converted: true,
              simulated: true,
              persona,
              site: "skill",
            },
          });
        }
      }
      if ((i + 1) % 5 === 0 || i + 1 === n) {
        process.stderr.write(
          `identities ${i + 1}/${n} control=${counts.control.n} treatment=${counts.treatment.n}\n`,
        );
      }
    }
  } finally {
    if (flagsmith) {
      await flagsmith.flushEvents();
      await flagsmith.close(5000);
    }
  }
  return counts;
}
