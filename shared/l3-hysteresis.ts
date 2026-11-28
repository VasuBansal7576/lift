import {
  COOLDOWN_MS,
  ENTER_HOLD_MS,
  ENTER_THRESHOLD,
  EXIT_HOLD_MS,
  EXIT_THRESHOLD,
} from "./l3-constants.ts";

export type HysteresisEvent = "none" | "enter" | "exit";

export type HysteresisPhase =
  | "calm"
  | "enter_pending"
  | "overstimulated"
  | "exit_pending"
  | "cooldown";

export interface HysteresisState {
  overstimulated: boolean;
  enterStartedAt: number | null;
  exitStartedAt: number | null;
  lastChangeAt: number | null;
  cooldownUntil: number;
}

export interface HysteresisConfig {
  enterThreshold: number;
  exitThreshold: number;
  enterHoldMs: number;
  exitHoldMs: number;
  cooldownMs: number;
}

export const DEFAULT_HYSTERESIS: HysteresisConfig = {
  enterThreshold: ENTER_THRESHOLD,
  exitThreshold: EXIT_THRESHOLD,
  enterHoldMs: ENTER_HOLD_MS,
  exitHoldMs: EXIT_HOLD_MS,
  cooldownMs: COOLDOWN_MS,
};

export function initialHysteresis(): HysteresisState {
  return {
    overstimulated: false,
    enterStartedAt: null,
    exitStartedAt: null,
    lastChangeAt: null,
    cooldownUntil: 0,
  };
}

export function hysteresisPhase(state: HysteresisState, now: number): HysteresisPhase {
  if (now < state.cooldownUntil) return "cooldown";
  if (state.overstimulated) {
    return state.exitStartedAt != null ? "exit_pending" : "overstimulated";
  }
  return state.enterStartedAt != null ? "enter_pending" : "calm";
}

/**
 * Hysteresis + cooldown state machine.
 * ENTER: score >= enterThreshold for enterHoldMs, then overstimulated=true.
 * EXIT: score < exitThreshold for exitHoldMs, then overstimulated=false.
 * Cooldown after every transition blocks the opposite flip so the trait cannot flap.
 */
export function stepHysteresis(
  state: HysteresisState,
  score: number,
  now: number,
  cfg: HysteresisConfig = DEFAULT_HYSTERESIS,
): { state: HysteresisState; event: HysteresisEvent } {
  if (cfg.exitThreshold >= cfg.enterThreshold) {
    throw new Error("EXIT_THRESHOLD must be strictly lower than ENTER_THRESHOLD");
  }

  const next: HysteresisState = {
    overstimulated: state.overstimulated,
    enterStartedAt: state.enterStartedAt,
    exitStartedAt: state.exitStartedAt,
    lastChangeAt: state.lastChangeAt,
    cooldownUntil: state.cooldownUntil,
  };

  if (now < next.cooldownUntil) {
    next.enterStartedAt = null;
    next.exitStartedAt = null;
    return { state: next, event: "none" };
  }

  if (!next.overstimulated) {
    next.exitStartedAt = null;
    if (score >= cfg.enterThreshold) {
      if (next.enterStartedAt == null) next.enterStartedAt = now;
      if (now - next.enterStartedAt >= cfg.enterHoldMs) {
        next.overstimulated = true;
        next.enterStartedAt = null;
        next.lastChangeAt = now;
        next.cooldownUntil = now + cfg.cooldownMs;
        return { state: next, event: "enter" };
      }
    } else {
      next.enterStartedAt = null;
    }
    return { state: next, event: "none" };
  }

  next.enterStartedAt = null;
  if (score < cfg.exitThreshold) {
    if (next.exitStartedAt == null) next.exitStartedAt = now;
    if (now - next.exitStartedAt >= cfg.exitHoldMs) {
      next.overstimulated = false;
      next.exitStartedAt = null;
      next.lastChangeAt = now;
      next.cooldownUntil = now + cfg.cooldownMs;
      return { state: next, event: "exit" };
    }
  } else {
    next.exitStartedAt = null;
  }
  return { state: next, event: "none" };
}

export function describeHysteresisEvent(event: HysteresisEvent): string {
  switch (event) {
    case "none":
      return "none";
    case "enter":
      return "enter";
    case "exit":
      return "exit";
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

/**
 * Fail-open: Sensory-Safe is applied only from a live Flagsmith flag that
 * still matches the local hysteresis. Offline, opted-out, and stale enters
 * stay in the normal flag-off state.
 */
export function shouldApplySensorySafe(input: {
  offline: boolean;
  optedOut: boolean;
  flagOn: boolean;
  hysteresisOn: boolean;
}): boolean {
  if (input.offline || input.optedOut) return false;
  if (!input.flagOn) return false;
  if (!input.hysteresisOn) return false;
  return true;
}
