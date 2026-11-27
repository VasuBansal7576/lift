import { bootstrapResponse } from "./bootstrap-source.js";
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_FLAG_NAME,
  FLAGSMITH_SDK_URL_DEFAULT,
  PERSONAL_CACHE_CONTROL,
  RUNTIME_PATH_PREFIX,
  SPEC_PATH_PREFIX,
  isSpecKey,
  originOf,
  trailingSlash,
} from "./constants.js";
import { visitorFromRequest } from "./cookie.js";
import { adjustCsp, sdkOriginFromUrl } from "./csp.js";
import { evaluateSpecId } from "./flagsmith.js";
import { buildHeadSnippet, injectHtmlResponse } from "./inject.js";

function cpuMeter() {
  let acc = 0;
  let mark = performance.now();
  return {
    pause() {
      acc += performance.now() - mark;
    },
    resume() {
      mark = performance.now();
    },
    ms() {
      return acc + (performance.now() - mark);
    },
  };
}

export function readEnv(env) {
  const timeout = Number(env?.FLAGSMITH_EVAL_TIMEOUT_MS);
  return {
    origin: String(env?.ORIGIN || "").replace(/\/+$/, ""),
    apiUrl: trailingSlash(String(env?.FLAGSMITH_API_URL || "")),
    environmentKey: String(env?.FLAGSMITH_ENVIRONMENT_KEY || ""),
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

export function buildOriginRequest(request, originBase) {
  const incoming = new URL(request.url);
  const dest = new URL(incoming.pathname + incoming.search, originBase.endsWith("/") ? originBase : `${originBase}/`);
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
  }
  return new Request(dest, init);
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

function withServerTiming(headers, cpu, failOpen) {
  const parts = [`liftcpu;dur=${cpu.toFixed(2)}`];
  if (failOpen) parts.push(`liftfail;desc="${failOpen}"`);
  headers.set("Server-Timing", parts.join(", "));
}

function applyHtmlHeaders(headers, opts) {
  headers.set("Cache-Control", PERSONAL_CACHE_CONTROL);
  headers.delete("Age");
  headers.delete("Expires");
  headers.delete("s-maxage");
  headers.delete("Surrogate-Control");
  const cspKeys = ["Content-Security-Policy", "content-security-policy"];
  for (const key of cspKeys) {
    if (!headers.has(key)) continue;
    headers.set(
      key,
      adjustCsp(headers.get(key), {
        sdkOrigin: sdkOriginFromUrl(opts.sdkUrl),
        flagsmithOrigin: originOf(opts.apiUrl),
      }),
    );
  }
  if (opts.setCookie) headers.append("Set-Cookie", opts.setCookie);
  withServerTiming(headers, opts.cpuMs, opts.failOpen);
}

function finalizePassthrough(response, opts) {
  const headers = new Headers(response.headers);
  rewriteLocation(headers, opts.originBase, opts.workerOrigin);
  if (opts.html) applyHtmlHeaders(headers, opts);
  else if (opts.cpuMs != null) withServerTiming(headers, opts.cpuMs, opts.failOpen);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveRuntime(request, url, cfg, cpu) {
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
        withServerTiming(headers, cpu.ms(), null);
        return new Response(res.body, { status: res.status, headers });
      }
    } catch {
      /* fall through to origin */
    }
  }
  if (!cfg.origin) return new Response("not found", { status: 404 });
  try {
    cpu.pause();
    const proxied = await fetch(buildOriginRequest(request, cfg.origin));
    cpu.resume();
    const headers = new Headers(proxied.headers);
    if (url.pathname.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
    withServerTiming(headers, cpu.ms(), null);
    return new Response(proxied.body, { status: proxied.status, headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function serveSpec(url, cfg, cpu) {
  const id = decodeURIComponent(url.pathname.slice(SPEC_PATH_PREFIX.length));
  if (!isSpecKey(id) || !cfg.specs || typeof cfg.specs.get !== "function") {
    const headers = new Headers({ "Cache-Control": "no-store" });
    withServerTiming(headers, cpu.ms(), "kv-miss");
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
    withServerTiming(headers, cpu.ms(), "kv-miss");
    return new Response("not found", { status: 404, headers });
  }
  const body = typeof raw === "string" ? raw : JSON.stringify(raw);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  withServerTiming(headers, cpu.ms(), null);
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

/**
 * Cloudflare Worker reverse proxy. Fail-open: origin HTML is returned
 * unmodified on Flagsmith errors, KV miss, timeout, parse errors, or non-HTML.
 */
export async function handleRequest(request, env) {
  const cpu = cpuMeter();
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
    withServerTiming(headers, cpu.ms(), null);
    return new Response(res.body, { status: 200, headers });
  }
  if (url.pathname.startsWith(SPEC_PATH_PREFIX)) {
    return serveSpec(url, cfg, cpu);
  }
  if (url.pathname.startsWith(RUNTIME_PATH_PREFIX)) {
    return serveRuntime(request, url, cfg, cpu);
  }

  if (!cfg.origin) {
    return new Response("ORIGIN is not configured", { status: 500 });
  }

  let originRes;
  try {
    cpu.pause();
    originRes = await fetch(buildOriginRequest(request, cfg.origin));
    cpu.resume();
  } catch {
    return new Response("origin unreachable", { status: 502 });
  }

  const html = isHtmlResponse(originRes);
  const visitor = html ? visitorFromRequest(request, url) : { id: null, setCookie: null };
  const baseOpts = {
    originBase: cfg.origin,
    workerOrigin: url.origin,
    sdkUrl: cfg.sdkUrl,
    apiUrl: cfg.apiUrl,
    setCookie: visitor.setCookie,
    cpuMs: cpu.ms(),
    html,
  };

  if (!html) {
    return finalizePassthrough(originRes, { ...baseOpts, failOpen: "non-html", cpuMs: cpu.ms() });
  }

  const passthrough = originRes.clone();
  const failOpen = (reason) =>
    finalizePassthrough(passthrough, { ...baseOpts, failOpen: reason, cpuMs: cpu.ms() });

  try {
    cpu.pause();
    const evaluated = await evaluateSpecId({
      apiUrl: cfg.apiUrl,
      environmentKey: cfg.environmentKey,
      identifier: visitor.id,
      flagName: cfg.flagName,
      timeoutMs: cfg.timeoutMs,
    });
    cpu.resume();

    if (!evaluated.ok) return failOpen(evaluated.reason);

    let spec = null;
    if (evaluated.specId) {
      const loaded = await loadSpecJson(cfg.specs, evaluated.specId);
      if (loaded.miss) return failOpen("kv-miss");
      if (loaded.parseError) return failOpen("parse-error");
      spec = loaded.spec;
    }

    const snippet = buildHeadSnippet({
      identity: visitor.id,
      flagName: cfg.flagName,
      apiUrl: cfg.apiUrl,
      environmentKey: cfg.environmentKey,
      specId: evaluated.specId,
      spec,
      sdkUrl: cfg.sdkUrl,
    });

    const extra = {
      "Cache-Control": PERSONAL_CACHE_CONTROL,
    };
    if (visitor.setCookie) extra["Set-Cookie"] = visitor.setCookie;
    extra["Server-Timing"] = `liftcpu;dur=${cpu.ms().toFixed(2)}`;

    const csp = originRes.headers.get("Content-Security-Policy") || originRes.headers.get("content-security-policy");
    if (csp) {
      extra["Content-Security-Policy"] = adjustCsp(csp, {
        sdkOrigin: sdkOriginFromUrl(cfg.sdkUrl),
        flagsmithOrigin: originOf(cfg.apiUrl),
      });
    }

    const injected = await injectHtmlResponse(originRes, snippet, extra);
    if (!injected) return failOpen("parse-error");
    rewriteLocation(injected.headers, cfg.origin, url.origin);
    injected.headers.delete("content-length");
    injected.headers.delete("Content-Length");
    withServerTiming(injected.headers, cpu.ms(), null);
    return injected;
  } catch {
    return failOpen("parse-error");
  }
}
