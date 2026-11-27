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
