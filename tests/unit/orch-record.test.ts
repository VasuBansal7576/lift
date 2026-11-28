import { describe, expect, it } from "vitest";
import {
  viewportToScreen,
  RECORDING_TRAFFIC_N_T2,
  RECORDING_TRAFFIC_N_L2,
  RECORDING_TRAFFIC_N_GEN2,
  RECORDING_EXTRA_ROUNDS,
} from "../../orchestrator/src/record-nav.ts";
import { extraRoundsFromEnv, identitiesNeeded } from "../../orchestrator/src/conductor.ts";

describe("record-nav", () => {
  it("maps a viewport box onto the X11 screen including chrome offset", () => {
    const point = viewportToScreen(
      { x: 100, y: 40, width: 80, height: 20 },
      {
        screenX: 960,
        screenY: 0,
        outerWidth: 960,
        outerHeight: 1200,
        innerWidth: 960,
        innerHeight: 1100,
      },
    );
    expect(point.x).toBe(960 + 100 + 40);
    expect(point.y).toBe(100 + 40 + 10);
  });

  it("uses a single pre-registered T2 look of 1000 visits and no extra rounds", () => {
    expect(RECORDING_TRAFFIC_N_T2).toBe(1000);
    expect(RECORDING_TRAFFIC_N_L2).toBe(400);
    expect(RECORDING_TRAFFIC_N_GEN2).toBe(240);
    expect(RECORDING_EXTRA_ROUNDS).toBe(0);
  });

  it("waits for 0.98x identities on a single look and defaults extra rounds to 0", () => {
    const previous = process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS;
    delete process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS;
    try {
      expect(extraRoundsFromEnv()).toBe(0);
      expect(extraRoundsFromEnv("")).toBe(0);
      expect(extraRoundsFromEnv("6")).toBe(6);
      expect(identitiesNeeded(1000, 0)).toBe(980);
      expect(identitiesNeeded(220, 1)).toBe(88);
    } finally {
      if (previous === undefined) delete process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS;
      else process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = previous;
    }
  });
});
