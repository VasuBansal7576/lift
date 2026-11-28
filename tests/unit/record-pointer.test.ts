import { describe, expect, it } from "vitest";
import {
  experimentOpenTarget,
  glidePointerTo,
  glideScreenPoints,
  reloadButtonScreenPoint,
  xdotoolClick1,
  type PointerCtl,
  type ShRunner,
} from "../../selfhost/src/record-pointer.ts";

function capturingCtl(): { ctl: PointerCtl; calls: string[][] } {
  const calls: string[][] = [];
  const run: ShRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const ctl: PointerCtl = {
    run,
    sleep: async () => undefined,
    last: { x: 0, y: 0 },
  };
  return { ctl, calls };
}

describe("pointer glides", () => {
  it("covers at least 8 frames with no single-frame teleport", () => {
    const pts = glideScreenPoints({ x: 0, y: 0 }, { x: 1900, y: 40 });
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(pts.at(-1)).toEqual({ x: 1900, y: 40 });
    for (let i = 1; i < pts.length; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      expect(Math.hypot(cur.x - prev.x, cur.y - prev.y)).toBeLessThan(900);
    }
  });

  it("selects an experiment by id href", () => {
    expect(experimentOpenTarget(9, [{ id: 9, name: "lift a11y 9" }]).href).toBe("/experiments/9");
  });
});

describe("injected xdotool runner", () => {
  it("glidePointerTo moves through every interpolated point", async () => {
    const { ctl, calls } = capturingCtl();
    await glidePointerTo(ctl, 160, 80);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.every((c) => c[0] === "xdotool" && c[1] === "mousemove")).toBe(true);
    expect(calls.at(-1)).toEqual(["xdotool", "mousemove", "160", "80"]);
    expect(ctl.last).toEqual({ x: 160, y: 80 });
  });

  it("xdotoolClick1 glides, pauses, then clicks", async () => {
    const sleeps: number[] = [];
    const { ctl, calls } = capturingCtl();
    ctl.sleep = async (ms) => {
      sleeps.push(ms);
    };
    await xdotoolClick1(ctl, 108, 56);
    expect(calls.at(-1)).toEqual(["xdotool", "click", "1"]);
    expect(calls.slice(0, -1).every((c) => c[1] === "mousemove")).toBe(true);
    expect(sleeps).toContain(550);
    expect(reloadButtonScreenPoint(0, 0)).toEqual({ x: 108, y: 56 });
  });
});
