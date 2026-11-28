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

export function parsePolicy(policy) {
  const order = [];
  const map = new Map();
  for (const raw of String(policy || "").split(";")) {
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

export function nonceFromTokens(tokens) {
  if (!Array.isArray(tokens)) return null;
  for (const token of tokens) {
    const match = /^'nonce-([^']+)'$/.exec(token);
    if (match) return match[1];
  }
  return null;
}

/**
 * Whether Lift can inject scripts under this policy.
 * `'strict-dynamic'` requires a script nonce on parser-inserted tags.
 */
export function inspectCsp(header) {
  if (!header || typeof header !== "string") {
    return { ok: true, scriptNonce: null, styleNonce: null, strictDynamic: false };
  }
  let scriptNonce = null;
  let styleNonce = null;
  let strictDynamic = false;
  for (const chunk of header.split(",")) {
    const { map } = parsePolicy(chunk);
    const script = map.get("script-src") || map.get("script-src-elem") || map.get("default-src") || [];
    const style = map.get("style-src") || map.get("style-src-elem") || map.get("default-src") || [];
    const chunkNonce = nonceFromTokens(script);
    const chunkStyle = nonceFromTokens(style);
    if (script.includes("'strict-dynamic'")) {
      strictDynamic = true;
      if (!chunkNonce) {
        return {
          ok: false,
          reason: "csp-strict-dynamic-no-nonce",
          scriptNonce: null,
          styleNonce: chunkStyle || styleNonce,
          strictDynamic: true,
        };
      }
    }
    if (chunkNonce && !scriptNonce) scriptNonce = chunkNonce;
    if (chunkStyle && !styleNonce) styleNonce = chunkStyle;
  }
  return { ok: true, scriptNonce, styleNonce, strictDynamic };
}

/**
 * Minimally widen CSP so injected scripts and the Flagsmith / spec fetches work.
 * Never adds `'unsafe-inline'` or `'unsafe-eval'`. Keeps nonces, hashes, and
 * `'strict-dynamic'`. Host allowlists are still added for browsers that ignore
 * `'strict-dynamic'`; nonce'd parser-inserted scripts satisfy strict-dynamic.
 */
export function adjustCsp(header, opts) {
  if (!header || typeof header !== "string") return header;
  const sdkOrigin = opts?.sdkOrigin || originOf(FLAGSMITH_SDK_URL_DEFAULT);
  const flagsmithOrigin = opts?.flagsmithOrigin || null;
  const scriptExtras = ["'self'", sdkOrigin].filter(Boolean);
  const connectExtras = ["'self'", flagsmithOrigin].filter(Boolean);
  const nonce = opts?.scriptNonce ? `'nonce-${opts.scriptNonce}'` : null;
  if (nonce) scriptExtras.push(nonce);

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

function attrValue(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = re.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** First `<meta http-equiv=Content-Security-Policy>` in HTML, or null. */
export function findMetaCsp(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  const re = /<meta\b([^>]*?)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1];
    const equiv = attrValue(attrs, "http-equiv");
    if (equiv && equiv.toLowerCase() === "content-security-policy") {
      return {
        tag: match[0],
        content: attrValue(attrs, "content") || "",
        index: match.index,
        length: match[0].length,
      };
    }
  }
  return null;
}

export function rewriteMetaCspHtml(html, rewriteContent) {
  const found = findMetaCsp(html);
  if (!found) return html;
  const next = rewriteContent(found.content);
  if (typeof next !== "string") return html;
  const tag = found.tag.includes("content=")
    ? found.tag.replace(/content\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `content="${next.replace(/"/g, "&quot;")}"`)
    : found.tag.replace(/>$/, ` content="${next.replace(/"/g, "&quot;")}">`);
  return html.slice(0, found.index) + tag + html.slice(found.index + found.length);
}
