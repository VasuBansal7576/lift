export type SafetyDecision =
  | { ok: true }
  | { ok: false; reason: string; code: "production" | "remote" };

const PROD = /prod/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isProductionEnvironmentName(name: string): boolean {
  return PROD.test(name);
}

/** True for 127.0.0.1, localhost, and ::1. Everything else is remote. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function assertSafeToMutate(opts: {
  environmentName: string;
  confirmProd?: boolean;
  apiUrl?: string;
  adminApiUrl?: string;
  cliApiUrl?: string;
  eventsUrl?: string;
  allowRemote?: boolean;
}): SafetyDecision {
  const urls = [opts.apiUrl, opts.adminApiUrl, opts.cliApiUrl, opts.eventsUrl].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  for (const url of urls) {
    if (!isLoopbackUrl(url) && !opts.allowRemote) {
      return {
        ok: false,
        reason: `Refusing non-loopback Flagsmith URL ${url}. Pass --allow-remote (and --confirm-prod for production-like names).`,
        code: "remote",
      };
    }
  }
  if (isProductionEnvironmentName(opts.environmentName) && !opts.confirmProd) {
    return {
      ok: false,
      reason: `Refusing to mutate environment "${opts.environmentName}" without --confirm-prod`,
      code: "production",
    };
  }
  return { ok: true };
}

export function wantApply(flags: Record<string, unknown>): boolean {
  if (flags["dry-run"] === true || flags["dry-run"] === "true") return false;
  return flags.apply === true || flags.apply === "true";
}

export function wantConfirmProd(flags: Record<string, unknown>): boolean {
  return flags["confirm-prod"] === true || flags["confirm-prod"] === "true";
}

export function wantAllowRemote(flags: Record<string, unknown>): boolean {
  return flags["allow-remote"] === true || flags["allow-remote"] === "true";
}
