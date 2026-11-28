export type Point = { x: number; y: number };

export type ShRunner = (
  bin: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type PointerCtl = {
  run: ShRunner;
  sleep: (ms: number) => Promise<void>;
  last: Point;
  beforeClick?: () => Promise<void>;
};

/** At 12fps a click glide must cover at least 8 frames with no teleport. */
export function glideScreenPoints(from: Point, to: Point, minFrames = 10): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const frames = Math.max(minFrames, Math.min(16, Math.round(dist / 80) || minFrames));
  const points: Point[] = [];
  for (let i = 1; i <= frames; i += 1) {
    const t = i / frames;
    const eased = t < 0.5 ? 2 * t * t : 1 - (2 * (1 - t)) ** 2 / 2;
    points.push({
      x: Math.round(from.x + (to.x - from.x) * eased),
      y: Math.round(from.y + (to.y - from.y) * eased),
    });
  }
  return points;
}

export async function glidePointerTo(ctl: PointerCtl, x: number, y: number): Promise<void> {
  const dest = { x: Math.round(x), y: Math.round(y) };
  const points = glideScreenPoints(ctl.last, dest);
  for (const point of points) {
    const out = await ctl.run("xdotool", ["mousemove", String(point.x), String(point.y)]);
    if (out.code !== 0) {
      throw new Error(`xdotool mousemove failed: ${out.stderr || out.stdout}`);
    }
    ctl.last = point;
    await ctl.sleep(84);
  }
  ctl.last = dest;
}

export async function xdotoolClick1(ctl: PointerCtl, x: number, y: number): Promise<void> {
  await ctl.beforeClick?.();
  await glidePointerTo(ctl, x, y);
  await ctl.sleep(550);
  const out = await ctl.run("xdotool", ["click", "1"]);
  if (out.code !== 0) {
    throw new Error(`xdotool click 1 failed: ${out.stderr || out.stdout}`);
  }
  await ctl.sleep(150);
}

export function experimentHref(experimentId: number): string {
  return `/experiments/${experimentId}`;
}

export function experimentOpenTarget(
  experimentId: number,
  listed: Array<{ id: number; name?: string }>,
): { href: string; name: string } {
  const match = listed.find((row) => Number(row.id) === experimentId);
  return { href: experimentHref(experimentId), name: match?.name ?? "" };
}

export function reloadButtonScreenPoint(
  windowLeft: number,
  windowTop: number,
): { x: number; y: number } {
  return {
    x: Math.round(windowLeft + 108),
    y: Math.round(windowTop + 56),
  };
}
