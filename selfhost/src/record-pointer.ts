export type Point = { x: number; y: number };

export type ShRunner = (
  bin: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function pointerPressReleaseArgs(x: number, y: number): string[][] {
  const sx = String(Math.round(x));
  const sy = String(Math.round(y));
  return [
    ["mousemove", sx, sy],
    ["mousedown", "1"],
    ["mouseup", "1"],
  ];
}

export async function runPointerPressRelease(run: ShRunner, x: number, y: number): Promise<void> {
  for (const args of pointerPressReleaseArgs(x, y)) {
    const out = await run("xdotool", args);
    if (out.code !== 0) {
      throw new Error(`xdotool ${args.join(" ")} failed: ${out.stderr || out.stdout}`);
    }
  }
}

/** At 12fps a click glide must cover at least 8 frames with no teleport. */
export function glideScreenPoints(from: Point, to: Point, minFrames = 10): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const frames = Math.max(minFrames, Math.min(48, Math.round(dist / 36) || minFrames));
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

export async function runReloadButtonClick(
  run: ShRunner,
  windowLeft: number,
  windowTop: number,
): Promise<void> {
  const point = reloadButtonScreenPoint(windowLeft, windowTop);
  const move = await run("xdotool", ["mousemove", String(point.x), String(point.y)]);
  if (move.code !== 0) throw new Error(`xdotool mousemove failed: ${move.stderr}`);
  const click = await run("xdotool", ["click", "1"]);
  if (click.code !== 0) throw new Error(`xdotool click failed: ${click.stderr}`);
}

export function f5ReloadArgs(): string[] {
  return ["key", "F5"];
}

export async function runF5Reload(run: ShRunner): Promise<void> {
  const out = await run("xdotool", f5ReloadArgs());
  if (out.code !== 0) throw new Error(`xdotool F5 failed: ${out.stderr}`);
}
