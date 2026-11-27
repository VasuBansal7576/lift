/** Seeded keep-rate after the page conversion. Higher = more conversions kept. SIMULATED. */
export function dropoutKeepRate(variant: string): number {
  switch (variant) {
    case "g2-type":
      return 0.97;
    case "full-v1":
      return 0.92;
    case "g2-focus":
      return 0.55;
    case "labels-v1":
      return 0.62;
    case "contrast-v1":
      return 0.58;
    case "g2-cursor":
      return 0.4;
    default:
      return 0.75;
  }
}

export function cookieMatchesIdentity(
  cookies: Array<{ name: string; value: string }>,
  identity: string,
): boolean {
  return cookies.some((cookie) => cookie.name === "lift_vid" && cookie.value === identity);
}

export function appliedVariantMatches(actual: string | undefined, expected: string): boolean {
  return Boolean(actual) && actual === expected;
}

export class TrafficAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficAbortError";
  }
}
