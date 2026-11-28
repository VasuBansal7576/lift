/**
 * Build the origin Request URL from parts of a copy of ORIGIN.
 * Never pass the incoming path to `new URL(path, origin)` — a path of
 * `//host`, `///host`, `/\host`, or `/%2F%2Fhost` would change the host
 * (open proxy / SSRF) and forward the visitor's Cookie.
 */

const OPEN_PROXY_LEADING = /^(?:\/{2,}|\/\\)/;
const ENCODED_DOUBLE_SLASH = /%2f%2f/i;

export function isOpenProxyPathname(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return true;
  if (OPEN_PROXY_LEADING.test(pathname)) return true;
  if (pathname.includes("\\")) return true;
  if (ENCODED_DOUBLE_SLASH.test(pathname)) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (OPEN_PROXY_LEADING.test(decoded)) return true;
  if (decoded.includes("\\")) return true;
  return false;
}

export function pathPercentEncodingOk(pathname) {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ dest: URL, origin: URL } | { error: 400 | 404, reason: string }}
 */
export function resolveOriginDestination(requestUrl, originBase) {
  let origin;
  try {
    origin = new URL(originBase);
  } catch {
    return { error: 400, reason: "bad-origin" };
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return { error: 400, reason: "bad-origin" };
  }

  let incoming;
  try {
    incoming = new URL(requestUrl);
  } catch {
    return { error: 400, reason: "bad-request" };
  }

  const pathname = incoming.pathname;
  if (!pathPercentEncodingOk(pathname)) {
    return { error: 404, reason: "malformed-path" };
  }
  if (isOpenProxyPathname(pathname)) {
    return { error: 400, reason: "open-proxy" };
  }

  const dest = new URL(origin.href);
  dest.username = "";
  dest.password = "";
  dest.hash = "";
  dest.search = incoming.search;
  dest.pathname = pathname;

  if (dest.origin !== origin.origin) {
    return { error: 400, reason: "open-proxy" };
  }
  return { dest, origin };
}

function hopByHop() {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
  ]);
}

/**
 * @returns {{ request: Request, dest: URL } | { error: 400 | 404, reason: string }}
 */
export function buildOriginRequest(request, originBase) {
  const resolved = resolveOriginDestination(request.url, originBase);
  if ("error" in resolved) return resolved;
  const headers = new Headers();
  const skip = hopByHop();
  for (const [key, value] of request.headers) {
    if (skip.has(key.toLowerCase())) continue;
    headers.append(key, value);
  }
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    if (init.body) init.duplex = "half";
  }
  return { request: new Request(resolved.dest, init), dest: resolved.dest, origin: resolved.origin };
}
