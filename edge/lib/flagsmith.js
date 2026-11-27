import { DEFAULT_EVAL_TIMEOUT_MS, trailingSlash } from "./constants.js";

export { DEFAULT_EVAL_TIMEOUT_MS };

export function flagsmithIdentitiesUrl(apiUrl, identifier) {
  const base = trailingSlash(apiUrl);
  return `${base}identities/?identifier=${encodeURIComponent(identifier)}`;
}

/**
 * Multivariate value is the spec id. Control is empty / "control" / disabled.
 */
export function specIdFromIdentityFlags(payload, flagName) {
  if (!payload || typeof payload !== "object") return null;
  const flags = Array.isArray(payload.flags) ? payload.flags : [];
  const flag = flags.find((row) => row && row.feature && row.feature.name === flagName);
  if (!flag) return null;
  if (flag.enabled === false) return null;
  const value = flag.feature_state_value;
  if (value == null) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (!text || text === "control" || text === "false" || text === "0") return null;
  return text;
}

function isTimeoutError(err) {
  if (!err || typeof err !== "object") return false;
  const name = err.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Server-side identity eval. Times out at 300 ms and never throws.
 * Does not log the environment key.
 */
export async function evaluateSpecId(input) {
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_EVAL_TIMEOUT_MS;
  const fetchFn = input.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") return { ok: false, reason: "flagsmith-down" };
  if (!input.apiUrl || !input.environmentKey) return { ok: false, reason: "flagsmith-down" };

  const url = flagsmithIdentitiesUrl(input.apiUrl, input.identifier);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Environment-Key": input.environmentKey,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: "flagsmith-down" };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, reason: "parse-error" };
    }
    return { ok: true, specId: specIdFromIdentityFlags(data, input.flagName) };
  } catch (err) {
    return { ok: false, reason: isTimeoutError(err) ? "flagsmith-timeout" : "flagsmith-down" };
  } finally {
    clearTimeout(timer);
  }
}
