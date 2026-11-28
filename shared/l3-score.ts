import {
  RAGE_CLICK_COUNT,
  RAGE_CLICK_MS,
  RAGE_CLICK_RADIUS_PX,
  TREMOR_MIN_PX,
  WEIGHTS,
  WINDOW_MS,
  clamp01,
} from "./l3-constants.ts";

export interface PointSample {
  t: number;
  x: number;
  y: number;
  detail?: number;
  pointerType?: string;
}

export interface ScrollSample {
  t: number;
  y: number;
  dy: number;
}

export interface StressComponents {
  erraticMouse: number;
  rageClicks: number;
  scrollThrash: number;
  biometric: number;
}

export function inWindow<T extends { t: number }>(
  samples: readonly T[],
  now: number,
  windowMs = WINDOW_MS,
): T[] {
  const cut = now - windowMs;
  return samples.filter((s) => s.t >= cut && s.t <= now);
}

function dist(a: PointSample, b: PointSample): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

/** Path length / displacement. 1 = straight line; higher = jitter. */
export function mouseJitter(points: readonly PointSample[]): number {
  if (points.length < 2) return 1;
  let path = 0;
  for (let i = 1; i < points.length; i += 1) {
    path += dist(points[i - 1], points[i]);
  }
  const displacement = dist(points[0], points[points.length - 1]);
  if (path < 40) return 1;
  return path / Math.max(displacement, 1);
}

/** Fraction of consecutive segments whose turning angle exceeds 60°. */
export function directionChangeRate(points: readonly PointSample[]): number {
  if (points.length < 3) return 0;
  let changes = 0;
  let counted = 0;
  for (let i = 2; i < points.length; i += 1) {
    const a = points[i - 2];
    const b = points[i - 1];
    const c = points[i];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 < 1 || n2 < 1) continue;
    counted += 1;
    const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
    if (Math.acos(cos) > Math.PI / 3) changes += 1;
  }
  if (counted === 0) return 0;
  return changes / counted;
}

/** Drop sub-pixel tremor so Parkinson's-like jitter does not look like rage-mouse. */
export function dampenTremor(
  points: readonly PointSample[],
  minPx = TREMOR_MIN_PX,
): PointSample[] {
  if (points.length === 0) return [];
  const kept: PointSample[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (dist(kept[kept.length - 1], points[i]) >= minPx) kept.push(points[i]);
  }
  return kept;
}

export function isKeyboardOrNonPointerClick(click: PointSample): boolean {
  if (click.detail === 0) return true;
  const pointerType = click.pointerType;
  if (!pointerType) return false;
  return pointerType !== "mouse" && pointerType !== "pen" && pointerType !== "touch";
}

export function scoreErraticMouse(
  points: readonly PointSample[],
  now: number,
  windowMs = WINDOW_MS,
): number {
  const recent = dampenTremor(inWindow(points, now, windowMs));
  if (recent.length < 5) return 0;
  const jitter = mouseJitter(recent);
  const turns = directionChangeRate(recent);
  const jitterScore = clamp01((jitter - 1.5) / 10);
  const turnScore = clamp01(turns / 0.55);
  return clamp01(0.55 * jitterScore + 0.45 * turnScore);
}

export function detectRageClicks(
  clicks: readonly PointSample[],
  now: number,
  windowMs = WINDOW_MS,
): number {
  const recent = inWindow(clicks, now, windowMs).filter((click) => !isKeyboardOrNonPointerClick(click));
  for (let i = 0; i < recent.length; i += 1) {
    const origin = recent[i];
    let n = 0;
    for (let j = 0; j < recent.length; j += 1) {
      const other = recent[j];
      if (Math.abs(other.t - origin.t) > RAGE_CLICK_MS) continue;
      if (dist(origin, other) > RAGE_CLICK_RADIUS_PX) continue;
      n += 1;
    }
    if (n >= RAGE_CLICK_COUNT) return 1;
  }
  return 0;
}

export function scoreScrollThrash(
  scrolls: readonly ScrollSample[],
  now: number,
  windowMs = WINDOW_MS,
): number {
  const recent = inWindow(scrolls, now, windowMs);
  if (recent.length < 3) return 0;
  let reversals = 0;
  let distPx = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const dy = recent[i].dy !== 0 ? recent[i].dy : recent[i].y - recent[i - 1].y;
    distPx += Math.abs(dy);
    if (i >= 2) {
      const prevDy =
        recent[i - 1].dy !== 0
          ? recent[i - 1].dy
          : recent[i - 1].y - recent[i - 2].y;
      if (Math.sign(dy) !== 0 && Math.sign(prevDy) !== 0 && Math.sign(dy) !== Math.sign(prevDy)) {
        reversals += 1;
      }
    }
  }
  const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
  if (dt <= 0) return 0;
  const velScore = clamp01(distPx / dt / 2500);
  const revScore = clamp01(reversals / dt / 4);
  return clamp01(0.5 * velScore + 0.5 * revScore);
}

/** Demo-only wearable/HR stand-in. 0–100 → 0–1. */
export function scoreBiometric(value0to100: number): number {
  return clamp01(value0to100 / 100);
}

export function combineStress(parts: StressComponents): number {
  return clamp01(
    WEIGHTS.erraticMouse * parts.erraticMouse +
      WEIGHTS.rageClicks * parts.rageClicks +
      WEIGHTS.scrollThrash * parts.scrollThrash +
      WEIGHTS.biometric * parts.biometric,
  );
}

export function scoreFromSamples(input: {
  mouse: readonly PointSample[];
  clicks: readonly PointSample[];
  scrolls: readonly ScrollSample[];
  biometric: number;
  now: number;
  windowMs?: number;
}): { score: number; components: StressComponents } {
  const windowMs = input.windowMs ?? WINDOW_MS;
  const components: StressComponents = {
    erraticMouse: scoreErraticMouse(input.mouse, input.now, windowMs),
    rageClicks: detectRageClicks(input.clicks, input.now, windowMs),
    scrollThrash: scoreScrollThrash(input.scrolls, input.now, windowMs),
    biometric: scoreBiometric(input.biometric),
  };
  return { score: combineStress(components), components };
}
