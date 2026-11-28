import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import {
  experimentOpenTarget,
  f5ReloadArgs,
  glideScreenPoints,
  pointerPressReleaseArgs,
  reloadButtonScreenPoint,
  runF5Reload,
  runPointerPressRelease,
  runReloadButtonClick,
  type ShRunner,
} from "../../selfhost/src/record-pointer.ts";

function capturingRunner(): { run: ShRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ShRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("close-panel pointer sequence", () => {
  it("moves then presses the real mouse button — never evaluate/click", async () => {
    const { run, calls } = capturingRunner();
    await runPointerPressRelease(run, 1842, 96);
    expect(pointerPressReleaseArgs(1842, 96)).toEqual([
      ["mousemove", "1842", "96"],
      ["mousedown", "1"],
      ["mouseup", "1"],
    ]);
    expect(calls).toEqual([
      ["xdotool", "mousemove", "1842", "96"],
      ["xdotool", "mousedown", "1"],
      ["xdotool", "mouseup", "1"],
    ]);
    const src = readFileSync(resolve(ROOT, "selfhost/src/record-pointer.ts"), "utf8");
    expect(src).not.toMatch(/page\.mouse|page\.click|page\.goto|page\.reload|locator\.click|evaluate\(|dispatchEvent/);
  });
});

describe("pointer glides", () => {
  it("covers at least 8 frames with no single-frame teleport", () => {
    const pts = glideScreenPoints({ x: 0, y: 0 }, { x: 1900, y: 40 });
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(pts.at(-1)).toEqual({ x: 1900, y: 40 });
    for (let i = 1; i < pts.length; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      expect(Math.hypot(cur.x - prev.x, cur.y - prev.y)).toBeLessThan(400);
    }
  });

  it("selects an experiment by id href", () => {
    expect(experimentOpenTarget(9, [{ id: 9, name: "lift a11y 9" }]).href).toBe("/experiments/9");
  });
});

describe("visible reload pointer sequence", () => {
  it("clicks the Chrome reload button from window bounds", async () => {
    const { run, calls } = capturingRunner();
    await runReloadButtonClick(run, 0, 0);
    expect(reloadButtonScreenPoint(0, 0)).toEqual({ x: 108, y: 56 });
    expect(calls).toEqual([
      ["xdotool", "mousemove", "108", "56"],
      ["xdotool", "click", "1"],
    ]);
    expect(calls.map((c) => c[0])).toEqual(["xdotool", "xdotool"]);
    expect(calls[0]?.slice(1)).toEqual(["mousemove", "108", "56"]);
    expect(calls[1]?.slice(1)).toEqual(["click", "1"]);
  });

  it("F5 is a key press, not a Playwright reload", async () => {
    const { run, calls } = capturingRunner();
    expect(f5ReloadArgs()).toEqual(["key", "F5"]);
    await runF5Reload(run);
    expect(calls).toEqual([["xdotool", "key", "F5"]]);
  });
});
