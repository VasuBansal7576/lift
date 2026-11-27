import type { TimeSaved } from "./types.ts";

/**
 * Documented manual estimate for one Track 2 run on the checkout fixture:
 * axe scan and triage (10 min), write 4–5 patch specs (40 min), apply each
 * and re-run axe (20 min), create multivariate flag + metric + experiment in
 * the Flagsmith UI (15 min), drive four personas through checkout (20 min),
 * read chance_to_win and roll out (10 min). Total 115 minutes.
 */
export const MANUAL_ESTIMATE_MINUTES = 115;
export const MANUAL_ESTIMATE_MS = MANUAL_ESTIMATE_MINUTES * 60_000;

export function measureTimeSaved(wallClockMs: number): TimeSaved {
  const savedMs = Math.max(0, MANUAL_ESTIMATE_MS - wallClockMs);
  return {
    wallClockMs,
    manualEstimateMs: MANUAL_ESTIMATE_MS,
    savedMs,
    manualEstimateMinutes: MANUAL_ESTIMATE_MINUTES,
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}
