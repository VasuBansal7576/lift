import { describe, expect, it } from "vitest";
import {
  L3_CONSTANTS,
  hysteresisPhase,
  initialHysteresis,
  shouldApplySensorySafe,
  shouldIgnoreEscape,
  stepHysteresis,
} from "../../runtime/l3-balancer.js";
import { describeHysteresisEvent } from "../../shared/l3-hysteresis.ts";

const { ENTER_HOLD_MS, ENTER_THRESHOLD, EXIT_HOLD_MS, EXIT_THRESHOLD } = L3_CONSTANTS;

const cfg = {
  enterThreshold: ENTER_THRESHOLD,
  exitThreshold: EXIT_THRESHOLD,
  enterHoldMs: ENTER_HOLD_MS,
  exitHoldMs: EXIT_HOLD_MS,
  cooldownMs: 10_000,
};

function drive(
  score: number,
  start: number,
  duration: number,
  stepMs: number,
  state = initialHysteresis(),
) {
  let current = state;
  let last = "none";
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
    const enteredAt = entered.state.lastChangeAt ?? 0;
    const bounce = stepHysteresis(entered.state, 0.05, enteredAt + 200, cfg);
    expect(bounce.event).toBe("none");
    expect(bounce.state.overstimulated).toBe(true);
    expect(hysteresisPhase(bounce.state, enteredAt + 200)).toBe("cooldown");

    const afterCooldown = stepHysteresis(bounce.state, 0.05, bounce.state.cooldownUntil, cfg);
    expect(afterCooldown.event).toBe("none");
    const ready = stepHysteresis(
      afterCooldown.state,
      0.05,
      afterCooldown.state.exitStartedAt + EXIT_HOLD_MS,
      cfg,
    );
    expect(ready.event).toBe("exit");

    const reverse = stepHysteresis(ready.state, 0.99, ready.state.lastChangeAt + 100, cfg);
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

  it("fail-opens: never applies Sensory-Safe when Flagsmith is offline or the enter is stale", () => {
    expect(
      shouldApplySensorySafe({ offline: true, optedOut: false, flagOn: true, hysteresisOn: true }),
    ).toBe(false);
    expect(
      shouldApplySensorySafe({
        offline: false,
        optedOut: false,
        flagOn: true,
        hysteresisOn: false,
      }),
    ).toBe(false);
    expect(
      shouldApplySensorySafe({
        offline: false,
        optedOut: true,
        flagOn: true,
        hysteresisOn: true,
      }),
    ).toBe(false);
    expect(
      shouldApplySensorySafe({
        offline: false,
        optedOut: false,
        flagOn: true,
        hysteresisOn: true,
      }),
    ).toBe(true);
  });

  it("ignores Escape when a dialog is open, composing, or the target is editable", () => {
    const doc = {
      querySelector: (sel: string) => (sel.includes("dialog") ? { tagName: "DIALOG" } : null),
    };
    expect(
      shouldIgnoreEscape({ key: "Escape", defaultPrevented: false, isComposing: false, target: {} }, doc),
    ).toBe(true);
    expect(
      shouldIgnoreEscape({
        key: "Escape",
        defaultPrevented: true,
        isComposing: false,
        target: { closest: () => null },
      }, { querySelector: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreEscape({
        key: "Escape",
        defaultPrevented: false,
        isComposing: true,
        target: { closest: () => null },
      }, { querySelector: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreEscape({
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        target: { tagName: "INPUT", isContentEditable: false, closest: () => null },
      }, { querySelector: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreEscape({
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        target: { tagName: "DIV", isContentEditable: false, closest: (sel: string) => (sel.includes("listbox") ? {} : null) },
      }, { querySelector: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreEscape({
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        target: { tagName: "DIV", isContentEditable: false, closest: () => null },
      }, { querySelector: () => null }),
    ).toBe(false);
  });
});
