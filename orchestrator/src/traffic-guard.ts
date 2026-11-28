import { pickPersona } from "../../shared/mix.ts";
import { mixSeed, mulberry32 } from "../../shared/rng.ts";
import { DEFAULT_PERSONA_MIX, type Persona, type PersonaMix } from "../../shared/types.ts";
import { focusIndicatorVisible, type CssFocusStyle } from "../../traffic/src/focus-visible.ts";

export { focusIndicatorVisible, type CssFocusStyle };

/** Same keep probability for every arm after the persona succeeds on the served surface. */
export const SHARED_KEEP_RATE = 0.9;

export const DEFAULT_CONTRAST_FLOOR = 4.5;

export interface PersonaSurface {
  /** Keyboard can Tab to the submit control. */
  submitReachableByTab: boolean;
  /** Keyboard can activate submit with Enter once focused. */
  submitActivatesWithEnter: boolean;
  /**
   * WCAG 2.4.7: focused submit has a visible outline or box-shadow vs unfocused.
   * Undefined means "not measured" (treated as visible so existing open surfaces stay open).
   */
  focusVisible?: boolean;
  /** Screen-reader: required fields/controls missing accessible names. */
  unlabeledControls: boolean;
  /** Low-vision: worst contrast among essential copy (computed styles / axe). */
  minContrast: number;
  contrastFloor?: number;
}

export const OPEN_SURFACE: PersonaSurface = {
  submitReachableByTab: true,
  submitActivatesWithEnter: true,
  focusVisible: true,
  unlabeledControls: false,
  minContrast: 7,
};

export const BLOCKED_SURFACE: PersonaSurface = {
  submitReachableByTab: false,
  submitActivatesWithEnter: false,
  focusVisible: false,
  unlabeledControls: true,
  minContrast: 2.1,
};

export function personaConvertsOnSurface(persona: Persona, surface: PersonaSurface): boolean {
  switch (persona) {
    case "mouse":
      return true;
    case "keyboard":
      return (
        surface.submitReachableByTab &&
        surface.submitActivatesWithEnter &&
        surface.focusVisible !== false
      );
    case "screen-reader":
      return !surface.unlabeledControls;
    case "low-vision":
      return surface.minContrast >= (surface.contrastFloor ?? DEFAULT_CONTRAST_FLOOR);
    default: {
      const _exhaustive: never = persona;
      throw new Error(`Unhandled persona ${String(_exhaustive)}`);
    }
  }
}

export function applySharedKeep(
  converted: boolean,
  rand: () => number,
  keepRate = SHARED_KEEP_RATE,
): { converted: boolean; dropped: boolean } {
  if (!converted) return { converted: false, dropped: false };
  if (rand() < keepRate) return { converted: true, dropped: false };
  return { converted: false, dropped: true };
}

export interface ArmRateResult {
  converted: number;
  n: number;
  rate: number;
}

/**
 * Test-only Monte Carlo model. Production traffic uses `runTrafficAgent`
 * (optionally with `surfaceForVariant`). Arm name does not change the keep rate.
 */
export function simulateArmRate(input: {
  surface: PersonaSurface;
  n: number;
  seed: number;
  arm?: string;
  mix?: PersonaMix;
  keepRate?: number;
}): ArmRateResult {
  const mix = input.mix ?? DEFAULT_PERSONA_MIX;
  const keepRate = input.keepRate ?? SHARED_KEEP_RATE;
  const runId = input.arm ?? "arm";
  let converted = 0;
  for (let i = 0; i < input.n; i += 1) {
    const persona = pickPersona(mulberry32(mixSeed(input.seed, runId, i, "persona")), mix);
    const personaOk = personaConvertsOnSurface(persona, input.surface);
    const keepRand = mulberry32(mixSeed(input.seed, runId, i, "dropout"));
    if (applySharedKeep(personaOk, keepRand, keepRate).converted) converted += 1;
  }
  return { converted, n: input.n, rate: input.n === 0 ? 0 : converted / input.n };
}

export function cookieMatchesIdentity(
  cookies: Array<{ name: string; value: string }>,
  identity: string,
): boolean {
  return cookies.some((cookie) => cookie.name === "lift_vid" && cookie.value === identity);
}

export function appliedVariantMatches(actual: string | undefined, expected: string): boolean {
  return Boolean(actual) && actual === expected;
}

export class TrafficAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficAbortError";
  }
}
