import { describe, expect, it } from "vitest";
import { viewportToScreen, RECORDING_TRAFFIC_N_T2, RECORDING_EXTRA_ROUNDS } from "../../orchestrator/src/record-nav.ts";

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
    expect(RECORDING_EXTRA_ROUNDS).toBe(0);
  });
});
