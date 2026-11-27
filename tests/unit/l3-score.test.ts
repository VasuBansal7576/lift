import { describe, expect, it } from "vitest";
import {
  L3_CONSTANTS,
  combineStress,
  dampenTremor,
  detectRageClicks,
  directionChangeRate,
  isKeyboardOrNonPointerClick,
  mouseJitter,
  scoreBiometric,
  scoreErraticMouse,
  scoreFromSamples,
  scoreScrollThrash,
} from "../../runtime/l3-balancer.js";

const WEIGHTS = L3_CONSTANTS.WEIGHTS;

/** @typedef {{ t: number, x: number, y: number, detail?: number, pointerType?: string }} PointSample */

function line(n: number, t0 = 1_000) {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * 16, x: i * 20, y: 10 }));
}

function zigzag(n: number, t0 = 1_000) {
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * 16,
    x: 100 + (i % 2 === 0 ? -40 : 40) + i,
    y: 100 + (i % 3 === 0 ? -50 : 50),
  }));
}

describe("L3 detectors and score", () => {
  it("weights sum to 1", () => {
    const sum =
      WEIGHTS.erraticMouse + WEIGHTS.rageClicks + WEIGHTS.scrollThrash + WEIGHTS.biometric;
    expect(sum).toBeCloseTo(1, 10);
  });

  it("treats a straight mouse path as low jitter", () => {
    expect(mouseJitter(line(20))).toBeLessThan(1.05);
    expect(scoreErraticMouse(line(20), 1_000 + 19 * 16)).toBeLessThan(0.15);
  });

  it("scores zigzag mouse as high direction-change and jitter", () => {
    const points = zigzag(40);
    expect(mouseJitter(points)).toBeGreaterThan(3);
    expect(directionChangeRate(points)).toBeGreaterThan(0.4);
    expect(scoreErraticMouse(points, points[points.length - 1].t)).toBeGreaterThan(0.45);
  });

  it("detects 3 clicks within 700ms and 30px as rage", () => {
    const clicks = [
      { t: 1000, x: 50, y: 50 },
      { t: 1200, x: 55, y: 48 },
      { t: 1400, x: 52, y: 60 },
    ];
    expect(detectRageClicks(clicks, 1400)).toBe(1);
  });

  it("does not treat two clicks, spaced clicks, or far clicks as rage", () => {
    expect(
      detectRageClicks(
        [
          { t: 1000, x: 50, y: 50 },
          { t: 1100, x: 51, y: 50 },
        ],
        1100,
      ),
    ).toBe(0);
    expect(
      detectRageClicks(
        [
          { t: 1000, x: 50, y: 50 },
          { t: 1900, x: 50, y: 50 },
          { t: 2800, x: 50, y: 50 },
        ],
        2800,
      ),
    ).toBe(0);
    expect(
      detectRageClicks(
        [
          { t: 1000, x: 0, y: 0 },
          { t: 1100, x: 80, y: 0 },
          { t: 1200, x: 160, y: 0 },
        ],
        1200,
      ),
    ).toBe(0);
  });

  it("scores rapid scroll reversals and high velocity", () => {
    const calm = [
      { t: 0, y: 0, dy: 40 },
      { t: 400, y: 40, dy: 40 },
      { t: 800, y: 80, dy: 40 },
    ];
    expect(scoreScrollThrash(calm, 800)).toBeLessThan(0.2);
    const thrash = [
      { t: 0, y: 0, dy: 900 },
      { t: 80, y: 900, dy: -900 },
      { t: 160, y: 0, dy: 900 },
      { t: 240, y: 900, dy: -900 },
      { t: 320, y: 0, dy: 900 },
      { t: 400, y: 900, dy: -900 },
    ];
    expect(scoreScrollThrash(thrash, 400)).toBeGreaterThan(0.5);
  });

  it("ignores keyboard clicks (detail 0) and non-pointer types for rage", () => {
    const keyboard = [
      { t: 1000, x: 50, y: 50, detail: 0, pointerType: "mouse" },
      { t: 1100, x: 50, y: 50, detail: 0 },
      { t: 1200, x: 50, y: 50, detail: 0 },
    ];
    expect(keyboard.every(isKeyboardOrNonPointerClick)).toBe(true);
    expect(detectRageClicks(keyboard, 1200)).toBe(0);
    const penOk = [
      { t: 1000, x: 50, y: 50, detail: 1, pointerType: "pen" },
      { t: 1100, x: 51, y: 50, detail: 1, pointerType: "pen" },
      { t: 1200, x: 52, y: 50, detail: 1, pointerType: "pen" },
    ];
    expect(detectRageClicks(penOk, 1200)).toBe(1);
  });

  it("damps tiny high-frequency tremor so it does not look erratic", () => {
    const tremor = Array.from({ length: 40 }, (_, i) => ({
      t: 1000 + i * 8,
      x: 100 + (i % 2),
      y: 100,
    }));
    expect(dampenTremor(tremor).length).toBeLessThan(5);
    expect(scoreErraticMouse(tremor, tremor[tremor.length - 1].t)).toBeLessThan(0.15);
  });

  it("maps the simulated biometric slider 0–100 onto 0–1", () => {
    expect(scoreBiometric(0)).toBe(0);
    expect(scoreBiometric(50)).toBeCloseTo(0.5);
    expect(scoreBiometric(100)).toBe(1);
    expect(scoreBiometric(140)).toBe(1);
  });

  it("combines components with the documented weights", () => {
    expect(
      combineStress({
        erraticMouse: 1,
        rageClicks: 0,
        scrollThrash: 0,
        biometric: 0,
      }),
    ).toBeCloseTo(0.3);
    expect(
      combineStress({
        erraticMouse: 1,
        rageClicks: 1,
        scrollThrash: 1,
        biometric: 1,
      }),
    ).toBeCloseTo(1);
    const scored = scoreFromSamples({
      mouse: zigzag(40),
      clicks: [
        { t: 1000, x: 10, y: 10 },
        { t: 1100, x: 12, y: 11 },
        { t: 1200, x: 9, y: 12 },
      ],
      scrolls: [
        { t: 1000, y: 0, dy: 800 },
        { t: 1080, y: 800, dy: -800 },
        { t: 1160, y: 0, dy: 800 },
        { t: 1240, y: 800, dy: -800 },
      ],
      biometric: 80,
      now: 1640,
    });
    expect(scored.score).toBeGreaterThan(0.7);
    expect(scored.components.rageClicks).toBe(1);
    expect(scored.components.biometric).toBeCloseTo(0.8);
  });
});
