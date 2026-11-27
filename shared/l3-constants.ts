/** Layer 3 Cognitive Overload Balancer — documented constants.
 *  Keep in sync with runtime/l3-balancer.js (the browser module).
 */

export const L3_FLAG_NAME = "l3_sensory_safe";
export const L3_SEGMENT_NAME = "sensory_safe";
export const L3_TRAIT_NAME = "overstimulated";
export const L3_COOKIE = "lift_vid";
export const L3_SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

/** Rolling sample window for all detectors. */
export const WINDOW_MS = 5_000;

/** Score must stay at or above this for ENTER_HOLD_MS before the trait flips on. */
export const ENTER_THRESHOLD = 0.62;

/** Score must stay below this for EXIT_HOLD_MS before the trait flips off.
 *  Strictly lower than ENTER_THRESHOLD so the band between them cannot flap.
 */
export const EXIT_THRESHOLD = 0.38;

export const ENTER_HOLD_MS = 1_500;
export const EXIT_HOLD_MS = 8_000;
export const COOLDOWN_MS = 10_000;
export const FADE_MS = 2_000;

export const RAGE_CLICK_COUNT = 3;
export const RAGE_CLICK_MS = 700;
export const RAGE_CLICK_RADIUS_PX = 30;
/** Consecutive mouse samples closer than this are treated as tremor, not erratic motion. */
export const TREMOR_MIN_PX = 3;
export const SET_TRAIT_TIMEOUT_MS = 4_000;
/** Sticky identity must be `lift-` plus a UUID. Anything else is rejected. */
export const L3_IDENTITY_RE =
  /^lift-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Weights sum to 1. Each component is itself in [0, 1]. */
export const WEIGHTS = {
  erraticMouse: 0.3,
  rageClicks: 0.25,
  scrollThrash: 0.25,
  biometric: 0.2,
} as const;

export const WCAG_AA_MIN = 4.5;

/** Sensory-safe ink/paper after the soften transform (not pure black on white). */
export const SOFT_INK: [number, number, number] = [44, 48, 56];
export const SOFT_PAPER: [number, number, number] = [244, 240, 232];
export const SOFT_INK_HEX = "#2c3038";
export const SOFT_PAPER_HEX = "#f4f0e8";

export const L3_FLAG_CONFIG = {
  pauseMedia: true,
  pauseMotion: true,
  softenContrast: true,
  showSummaries: true,
  hideMarketing: true,
  fadeMs: FADE_MS,
  ink: SOFT_INK_HEX,
  paper: SOFT_PAPER_HEX,
} as const;

export type L3FlagConfig = {
  pauseMedia: boolean;
  pauseMotion: boolean;
  softenContrast: boolean;
  showSummaries: boolean;
  hideMarketing: boolean;
  fadeMs: number;
  ink: string;
  paper: string;
};

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
