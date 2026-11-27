/** Public Flagsmith JS SDK. Same pin as the rest of Lift. */
export const FLAGSMITH_SDK_URL_DEFAULT =
  "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

export const DEFAULT_FLAG_NAME = "lift_edge_spec";
export const DEFAULT_EVAL_TIMEOUT_MS = 300;
export const BOOTSTRAP_PATH = "/__lift/bootstrap.js";
export const SPEC_PATH_PREFIX = "/__lift/spec/";
/** Worker-owned runtime assets. Never collide with the origin `/runtime/`. */
export const RUNTIME_PATH_PREFIX = "/__lift/runtime/";
export const CONFIG_SCRIPT_ID = "lift-edge-config";
export const PERSONAL_CACHE_CONTROL = "private, no-store, no-cache, must-revalidate";
export const SPEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 1 MiB buffer cap so HTMLRewriter streaming errors can fail-open from origin bytes. */
export const MAX_HTML_BYTES = 1_048_576;
export const WALL_TIMING_NAME = "liftwall";

export function isSpecKey(value) {
  return typeof value === "string" && SPEC_ID_RE.test(value);
}

export function trailingSlash(url) {
  if (typeof url !== "string" || url.length === 0) return url;
  return url.endsWith("/") ? url : `${url}/`;
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
