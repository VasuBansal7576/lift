import { FLAGSMITH_SDK_URL_DEFAULT, originOf } from "./constants.js";

function tokensFor(map, name, fallbackName) {
  if (map.has(name)) return map.get(name);
  if (fallbackName && map.has(fallbackName)) return [...map.get(fallbackName)];
  return null;
}

function addTokens(values, extras) {
  if (values.length === 1 && values[0] === "'none'") values.length = 0;
  for (const token of extras) {
    if (token && !values.includes(token)) values.push(token);
  }
  if (values.length === 0) values.push("'none'");
}

function parsePolicy(policy) {
  const order = [];
  const map = new Map();
  for (const raw of policy.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const sp = part.search(/\s/);
    const name = (sp === -1 ? part : part.slice(0, sp)).toLowerCase();
    const values = sp === -1 ? [] : part.slice(sp + 1).trim().split(/\s+/).filter(Boolean);
    if (!map.has(name)) order.push(name);
    map.set(name, values);
  }
  return { order, map };
}

function serializePolicy(order, map) {
  return order
    .filter((name) => map.has(name))
    .map((name) => {
      const values = map.get(name);
      return values.length ? `${name} ${values.join(" ")}` : name;
    })
    .join("; ");
}

/**
 * Minimally widen CSP so injected scripts and the Flagsmith / spec fetches work.
 * Only `'self'`, the SDK host, and the Flagsmith API origin are added.
 * Existing nonces and hashes are kept. `'unsafe-inline'` is never added.
 */
export function adjustCsp(header, opts) {
  if (!header || typeof header !== "string") return header;
  const sdkOrigin = opts?.sdkOrigin || originOf(FLAGSMITH_SDK_URL_DEFAULT);
  const flagsmithOrigin = opts?.flagsmithOrigin || null;
  const scriptExtras = ["'self'", sdkOrigin].filter(Boolean);
  const connectExtras = ["'self'", flagsmithOrigin].filter(Boolean);

  return header
    .split(",")
    .map((chunk) => {
      const { order, map } = parsePolicy(chunk);
      const hasDefault = map.has("default-src");

      const script = tokensFor(map, "script-src", hasDefault ? "default-src" : null);
      if (script) {
        if (!map.has("script-src")) order.push("script-src");
        map.set("script-src", script);
        addTokens(script, scriptExtras);
      } else {
        order.push("script-src");
        map.set("script-src", [...scriptExtras]);
      }

      if (map.has("script-src-elem")) {
        addTokens(map.get("script-src-elem"), scriptExtras);
      }

      const connect = tokensFor(map, "connect-src", hasDefault ? "default-src" : null);
      if (connect) {
        if (!map.has("connect-src")) order.push("connect-src");
        map.set("connect-src", connect);
        addTokens(connect, connectExtras);
      } else {
        order.push("connect-src");
        map.set("connect-src", [...connectExtras]);
      }

      return serializePolicy(order, map);
    })
    .join(", ");
}

export function sdkOriginFromUrl(sdkUrl) {
  return originOf(sdkUrl) || originOf(FLAGSMITH_SDK_URL_DEFAULT);
}
