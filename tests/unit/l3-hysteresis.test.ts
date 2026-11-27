import { describe, expect, it } from "vitest";
import {
  ENTER_HOLD_MS,
  ENTER_THRESHOLD,
  EXIT_HOLD_MS,
  EXIT_THRESHOLD,
} from "../../shared/l3-constants.ts";
import {
  describeHysteresisEvent,
  hysteresisPhase,
  initialHysteresis,
  stepHysteresis,
  type HysteresisEvent,
} from "../../shared/l3-hysteresis.ts";

const cfg = {
  enterThreshold: ENTER_THRESHOLD,
  exitThreshold: EXIT_THRESHOLD,
  enterHoldMs: ENTER_HOLD_MS,
  exitHoldMs: EXIT_HOLD_MS,
  cooldownMs: 10_000,
};

function drive(score: number, start: number, duration: number, stepMs: number, state = initialHysteresis()) {
  let current = state;
  let last: HysteresisEvent = "none";
  let t = start;
  for (; t <= start + duration; t += stepMs) {
    const next = stepHysteresis(current, score, t, cfg);
    current = next.state;
    if (next.event !== "none") last = next.event;
  }
  return { state: current, last, t };
}

describe("L3 hysteresis and cooldown", () => {
  it("requires the score to stay at ENTER for 1.5s before flipping on", () => {
    const early = drive(0.9, 0, ENTER_HOLD_MS - 50, 50);
    expect(early.state.overstimulated).toBe(false);
    expect(early.last).toBe("none");
    const entered = drive(0.9, 0, ENTER_HOLD_MS, 50);
    expect(entered.state.overstimulated).toBe(true);
    expect(entered.last).toBe("enter");
  });

  it("requires the score to stay below EXIT for 8s before flipping off", () => {
    let { state } = drive(0.9, 0, ENTER_HOLD_MS, 50);
    expect(state.overstimulated).toBe(true);
    const stillOn = stepHysteresis(state, 0.1, state.cooldownUntil, cfg);
    const duringExit = drive(
      0.1,
      stillOn.state.cooldownUntil,
      EXIT_HOLD_MS - 100,
      100,
      stillOn.state,
    );
    expect(duringExit.state.overstimulated).toBe(true);
    const exited = drive(0.1, stillOn.state.cooldownUntil, EXIT_HOLD_MS, 100, stillOn.state);
    expect(exited.state.overstimulated).toBe(false);
    expect(exited.last).toBe("exit");
  });

  it("does not flap on borderline scores in the hysteresis band", () => {
    const mid = (ENTER_THRESHOLD + EXIT_THRESHOLD) / 2;
    expect(mid).toBeGreaterThan(EXIT_THRESHOLD);
    expect(mid).toBeLessThan(ENTER_THRESHOLD);
    const calm = drive(mid, 0, 20_000, 100);
    expect(calm.state.overstimulated).toBe(false);
    expect(hysteresisPhase(calm.state, 20_000)).toBe("calm");

    let { state } = drive(0.95, 0, ENTER_HOLD_MS, 50);
    const afterCooldown = stepHysteresis(state, mid, state.cooldownUntil + 1, cfg).state;
    const held = drive(mid, afterCooldown.cooldownUntil + 1, 20_000, 200, afterCooldown);
    expect(held.state.overstimulated).toBe(true);
  });

  it("cooldown blocks an immediate reverse after enter or exit", () => {
    const entered = drive(0.95, 0, ENTER_HOLD_MS, 50);
    const bounce = stepHysteresis(entered.state, 0.05, entered.state.lastChangeAt! + 200, cfg);
    expect(bounce.event).toBe("none");
    expect(bounce.state.overstimulated).toBe(true);
    expect(hysteresisPhase(bounce.state, entered.state.lastChangeAt! + 200)).toBe("cooldown");

    const afterCooldown = stepHysteresis(bounce.state, 0.05, bounce.state.cooldownUntil, cfg);
    expect(afterCooldown.event).toBe("none");
    const ready = stepHysteresis(
      afterCooldown.state,
      0.05,
      afterCooldown.state.exitStartedAt! + EXIT_HOLD_MS,
      cfg,
    );
    expect(ready.event).toBe("exit");

    const reverse = stepHysteresis(ready.state, 0.99, ready.state.lastChangeAt! + 100, cfg);
    expect(reverse.event).toBe("none");
    expect(reverse.state.overstimulated).toBe(false);
  });

  it("resets the enter timer if the score dips below ENTER", () => {
    let state = initialHysteresis();
    state = stepHysteresis(state, 0.9, 0, cfg).state;
    state = stepHysteresis(state, 0.9, 1_000, cfg).state;
    state = stepHysteresis(state, 0.4, 1_200, cfg).state;
    expect(state.enterStartedAt).toBeNull();
    const done = stepHysteresis(state, 0.9, 1_200 + ENTER_HOLD_MS - 1, cfg);
    expect(done.state.overstimulated).toBe(false);
  });

  it("names events exhaustively", () => {
    expect(describeHysteresisEvent("none")).toBe("none");
    expect(describeHysteresisEvent("enter")).toBe("enter");
    expect(describeHysteresisEvent("exit")).toBe("exit");
  });
});
