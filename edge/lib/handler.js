import { bootstrapResponse } from "./bootstrap-source.js";
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_FLAG_NAME,
  FLAGSMITH_SDK_URL_DEFAULT,
  MAX_HTML_BYTES,
  PERSONAL_CACHE_CONTROL,
  RUNTIME_PATH_PREFIX,
  SPEC_PATH_PREFIX,
  WALL_TIMING_NAME,
  isSpecKey,
  originOf,
  trailingSlash,
} from "./constants.js";
import { visitorFromRequest } from "./cookie.js";
import { adjustCsp, findMetaCsp, inspectCsp, sdkOriginFromUrl } from "./csp.js";
import { evaluateSpecId } from "./flagsmith.js";
import { buildHeadSnippet, injectHtmlResponse, stripValidators } from "./inject.js";
import { buildOriginRequest } from "./origin-url.js";

export { buildOriginRequest, resolveOriginDestination } from "./origin-url.js";

function wallMeter() {
  const start = performance.now();
  return {
    ms() {
      return performance.now() - start;
    },
  };
}

function clientEnvironmentKey(raw) {
  const key = String(raw || "").trim();
  if (!key) return "";
  if (key.startsWith("ser.")) {
    console.warn("FLAGSMITH_ENVIRONMENT_KEY looks like a server-side key; treating as unset");
    return "";
  }
  return key;
}

export function readEnv(env) {
  const timeout = Number(env?.FLAGSMITH_EVAL_TIMEOUT_MS);
  return {
    origin: String(env?.ORIGIN || "").replace(/\/+$/, ""),
    apiUrl: trailingSlash(String(env?.FLAGSMITH_API_URL || "")),
    environmentKey: clientEnvironmentKey(env?.FLAGSMITH_ENVIRONMENT_KEY),
    flagName: String(env?.FLAGSMITH_FLAG_NAME || DEFAULT_FLAG_NAME),
    sdkUrl: String(env?.FLAGSMITH_SDK_URL || FLAGSMITH_SDK_URL_DEFAULT),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_EVAL_TIMEOUT_MS,
    specs: env?.SPECS || null,
    assets: env?.ASSETS || null,
  };
}

export function isHtmlResponse(response) {
  if (!response) return false;
  const type = response.headers.get("content-type") || response.headers.get("Content-Type") || "";
  return /text\/html/i.test(type);
}

/** Document navigations only. CSS/JS/image/empty fetches skip eval and identity. */
export function isDocumentRequest(request) {
  if (request.method !== "GET") return false;
  const dest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
  if (dest === "document") return true;
  if (dest) return false;
  const accept = request.headers.get("Accept") || "";
  return /text\/html/i.test(accept);
}

export function rewriteLocation(headers, originBase, workerOrigin) {
  const loc = headers.get("Location") || headers.get("location");
  if (!loc) return;
  try {
    const dest = new URL(loc, originBase);
    const origin = new URL(originBase);
    if (dest.host === origin.host) {
      const worker = new URL(workerOrigin);
      dest.protocol = worker.protocol;
      dest.host = worker.host;
      headers.set("Location", dest.toString());
    }
  } catch {
    /* leave origin Location */
  }
}

function withServerTiming(headers, wallMs, failOpen) {
  const parts = [`${WALL_TIMING_NAME};dur=${Number(wallMs).toFixed(2)}`];
  if (failOpen) parts.push(`liftfail;desc="${failOpen}"`);
  headers.set("Server-Timing", parts.join(", "));
}

function applyInjectedHtmlHeaders(headers, opts) {
  headers.set("Cache-Control", PERSONAL_CACHE_CONTROL);
  headers.delete("Age");
  headers.delete("Expires");
  headers.delete("s-maxage");
  headers.delete("Surrogate-Control");
  stripValidators(headers);
  const cspKeys = ["Content-Security-Policy", "content-security-policy"];
  for (const key of cspKeys) {
    if (!headers.has(key)) continue;
    headers.set(
      key,
      adjustCsp(headers.get(key), {
        sdkOrigin: sdkOriginFromUrl(opts.sdkUrl),
        flagsmithOrigin: originOf(opts.apiUrl),
        scriptNonce: opts.scriptNonce || null,
      }),
    );
  }
  if (opts.setCookie) headers.append("Set-Cookie", opts.setCookie);
  withServerTiming(headers, opts.cpuMs, opts.failOpen);
}

function finalizePassthrough(response, opts) {
  const headers = new Headers(response.headers);
  rewriteLocation(headers, opts.originBase, opts.workerOrigin);
  if (opts.injected) {
    applyInjectedHtmlHeaders(headers, opts);
  } else {
    if (opts.setCookie) headers.append("Set-Cookie", opts.setCookie);
    if (opts.cpuMs != null) withServerTiming(headers, opts.cpuMs, opts.failOpen);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function statusFor(error) {
  return error === 400 ? 400 : 404;
}

async function serveRuntime(request, url, cfg, wall) {
  const relative = url.pathname.slice(RUNTIME_PATH_PREFIX.length - 1) || "/";
  if (relative.includes("..") || relative.includes("\\")) {
    return new Response("not found", { status: 404 });
  }
  if (cfg.assets && typeof cfg.assets.fetch === "function") {
    try {
      const assetUrl = new URL(relative, url.origin);
      const res = await cfg.assets.fetch(new Request(assetUrl, { method: "GET" }));
      if (res && res.ok) {
        const headers = new Headers(res.headers);
        if (relative.endsWith(".js") || url.pathname.endsWith(".js")) {
          headers.set("Content-Type", "text/javascript; charset=utf-8");
        }
        if (relative.endsWith(".json")) {
          headers.set("Content-Type", "application/json; charset=utf-8");
        }
        headers.set("Cache-Control", "public, max-age=60");
        withServerTiming(headers, wall.ms(), null);
        return new Response(res.body, { status: res.status, headers });
      }
    } catch {
      /* fall through to origin */
    }
  }
  if (!cfg.origin) return new Response("not found", { status: 404 });
  try {
    const built = buildOriginRequest(request, cfg.origin);
    if ("error" in built) {
      return new Response("not found", { status: statusFor(built.error) });
    }
    const proxied = await fetch(built.request);
    const headers = new Headers(proxied.headers);
    if (url.pathname.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
    withServerTiming(headers, wall.ms(), null);
    return new Response(proxied.body, { status: proxied.status, headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function serveSpec(url, cfg, wall) {
  let id;
  try {
    id = decodeURIComponent(url.pathname.slice(SPEC_PATH_PREFIX.length));
  } catch {
    const headers = new Headers({ "Cache-Control": "no-store" });
    withServerTiming(headers, wall.ms(), "malformed-path");
    return new Response("not found", { status: 404, headers });
  }
  if (!isSpecKey(id) || !cfg.specs || typeof cfg.specs.get !== "function") {
    const headers = new Headers({ "Cache-Control": "no-store" });
    withServerTiming(headers, wall.ms(), "kv-miss");
    return new Response("not found", { status: 404, headers });
  }
  let raw;
  try {
    raw = await cfg.specs.get(id);
  } catch {
    raw = null;
  }
  if (raw == null || raw === "") {
    const headers = new Headers({ "Cache-Control": "no-store" });
    withServerTiming(headers, wall.ms(), "kv-miss");
    return new Response("not found", { status: 404, headers });
  }
  const body = typeof raw === "string" ? raw : JSON.stringify(raw);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  withServerTiming(headers, wall.ms(), null);
  return new Response(body, { status: 200, headers });
}

async function loadSpecJson(specs, specId) {
  if (!specId || !isSpecKey(specId) || !specs || typeof specs.get !== "function") {
    return { miss: true };
  }
  let raw;
  try {
    raw = await specs.get(specId);
  } catch {
    return { miss: true };
  }
  if (raw == null || raw === "") return { miss: true };
  if (typeof raw === "object") return { spec: raw };
  try {
    return { spec: JSON.parse(raw) };
  } catch {
    return { parseError: true };
  }
}

async function decodedOriginBytes(originRes, raw) {
  const enc = (originRes.headers.get("content-encoding") || "").toLowerCase().split(",")[0].trim();
  if (enc !== "gzip" && enc !== "deflate" && enc !== "br") return raw;
  try {
    const body = new Response(raw).body;
    if (!body) return raw;
    const ds = new DecompressionStream(enc);
    return await new Response(body.pipeThrough(ds)).arrayBuffer();
  } catch {
    return raw;
  }
}

async function bufferHtml(originRes) {
  const raw = await originRes.arrayBuffer();
  const bytes = await decodedOriginBytes(originRes, raw);
  if (bytes.byteLength > MAX_HTML_BYTES) {
    return { tooLarge: true, bytes };
  }
  return { bytes, html: new TextDecoder("utf-8").decode(bytes) };
}

function replayResponse(originRes, bytes) {
  const headers = new Headers(originRes.headers);
  headers.delete("Content-Length");
  headers.delete("content-length");
  headers.delete("Content-Encoding");
  headers.delete("content-encoding");
  return new Response(bytes, {
    status: originRes.status,
    statusText: originRes.statusText,
    headers,
  });
}

/**
 * Cloudflare Worker reverse proxy. Fail-open: origin HTML is returned
 * unmodified on Flagsmith errors, KV miss, timeout, parse errors, or non-HTML.
 * Exceptions and malformed percent-encoding return 404 (never 502).
 */
export async function handleRequest(request, env) {
  const wall = wallMeter();
  const cfg = readEnv(env);
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (url.pathname === "/__lift/bootstrap.js") {
    const res = bootstrapResponse();
    const headers = new Headers(res.headers);
    withServerTiming(headers, wall.ms(), null);
    return new Response(res.body, { status: 200, headers });
  }
  if (url.pathname.startsWith(SPEC_PATH_PREFIX)) {
    return serveSpec(url, cfg, wall);
  }
  if (url.pathname.startsWith(RUNTIME_PATH_PREFIX)) {
    return serveRuntime(request, url, cfg, wall);
  }

  if (!cfg.origin) {
    return new Response("ORIGIN is not configured", { status: 500 });
  }

  const built = buildOriginRequest(request, cfg.origin);
  if ("error" in built) {
    return new Response(built.reason === "open-proxy" ? "bad request" : "not found", {
      status: statusFor(built.error),
    });
  }

  const personalize = isDocumentRequest(request);
  const visitor = personalize ? visitorFromRequest(request, url) : { id: null, setCookie: null, minted: false };

  const evalPromise =
    personalize && visitor.id
      ? evaluateSpecId({
          apiUrl: cfg.apiUrl,
          environmentKey: cfg.environmentKey,
          identifier: visitor.id,
          flagName: cfg.flagName,
          timeoutMs: cfg.timeoutMs,
        })
      : Promise.resolve({ skipped: true, ok: false, reason: "skipped" });

  let originRes;
  let evaluated;
  try {
    const originPromise = fetch(built.request).then(
      (res) => ({ ok: true, res }),
      (err) => ({ ok: false, err }),
    );
    const [evalResult, originSettled] = await Promise.all([evalPromise, originPromise]);
    evaluated = evalResult;
    if (!originSettled.ok) {
      return new Response("not found", { status: 404 });
    }
    originRes = originSettled.res;
  } catch {
    return new Response("not found", { status: 404 });
  }

  const html = isHtmlResponse(originRes);
  const baseOpts = {
    originBase: cfg.origin,
    workerOrigin: url.origin,
    sdkUrl: cfg.sdkUrl,
    apiUrl: cfg.apiUrl,
    setCookie: personalize ? visitor.setCookie : null,
    cpuMs: wall.ms(),
    html,
  };

  if (!html || !personalize) {
    const reason = !html
      ? "non-html"
      : request.method === "HEAD"
        ? "head"
        : request.method === "GET"
          ? "non-document"
          : "method";
    return finalizePassthrough(originRes, { ...baseOpts, failOpen: reason, cpuMs: wall.ms() });
  }

  const failOpenFrom = (bytes, originLike, reason) =>
    finalizePassthrough(replayResponse(originLike, bytes), {
      ...baseOpts,
      failOpen: reason,
      cpuMs: wall.ms(),
    });

  let buffered;
  try {
    buffered = await bufferHtml(originRes);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (buffered.tooLarge) {
    if (buffered.bytes) {
      return failOpenFrom(buffered.bytes, originRes, "html-too-large");
    }
    return finalizePassthrough(originRes, { ...baseOpts, failOpen: "html-too-large", cpuMs: wall.ms() });
  }

  const headerCsp =
    originRes.headers.get("Content-Security-Policy") || originRes.headers.get("content-security-policy") || "";
  const metaCsp = findMetaCsp(buffered.html);
  const cspSource = headerCsp || (metaCsp ? metaCsp.content : "");
  const cspInfo = inspectCsp(cspSource);
  if (!cspInfo.ok) {
    return failOpenFrom(buffered.bytes, originRes, cspInfo.reason || "csp");
  }

  try {
    if (!evaluated || evaluated.skipped) {
      return failOpenFrom(buffered.bytes, originRes, "flagsmith-down");
    }
    if (!evaluated.ok) return failOpenFrom(buffered.bytes, originRes, evaluated.reason);

    let spec = null;
    if (evaluated.specId) {
      const loaded = await loadSpecJson(cfg.specs, evaluated.specId);
      if (loaded.miss) return failOpenFrom(buffered.bytes, originRes, "kv-miss");
      if (loaded.parseError) return failOpenFrom(buffered.bytes, originRes, "parse-error");
      spec = loaded.spec;
    }

    const cspOpts = {
      sdkOrigin: sdkOriginFromUrl(cfg.sdkUrl),
      flagsmithOrigin: originOf(cfg.apiUrl),
      scriptNonce: cspInfo.scriptNonce,
    };

    const snippet = buildHeadSnippet({
      identity: visitor.id,
      flagName: cfg.flagName,
      apiUrl: cfg.apiUrl,
      environmentKey: cfg.environmentKey,
      specId: evaluated.specId,
      spec,
      sdkUrl: cfg.sdkUrl,
      evaluated: true,
      scriptNonce: cspInfo.scriptNonce,
      styleNonce: cspInfo.styleNonce,
    });

    const extra = {
      "Cache-Control": PERSONAL_CACHE_CONTROL,
    };
    if (visitor.setCookie) extra["Set-Cookie"] = visitor.setCookie;
    extra["Server-Timing"] = `${WALL_TIMING_NAME};dur=${wall.ms().toFixed(2)}`;
    if (headerCsp) {
      extra["Content-Security-Policy"] = adjustCsp(headerCsp, cspOpts);
    }

    const toInject = replayResponse(originRes, buffered.bytes);
    const injected = await injectHtmlResponse(toInject, snippet, extra, { cspOpts });
    if (!injected) return failOpenFrom(buffered.bytes, originRes, "parse-error");
    rewriteLocation(injected.headers, cfg.origin, url.origin);
    stripValidators(injected.headers);
    withServerTiming(injected.headers, wall.ms(), null);
    return injected;
  } catch {
    return failOpenFrom(buffered.bytes, originRes, "parse-error");
  }
}
