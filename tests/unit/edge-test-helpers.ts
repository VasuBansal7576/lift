import { FLAGSMITH_SDK_URL_DEFAULT } from "../../edge/lib/constants.js";

const nativeFetch = globalThis.fetch;

export function restoreFetch() {
  globalThis.fetch = nativeFetch;
}

export const DOCUMENT_HEADERS = {
  "Sec-Fetch-Dest": "document",
  Accept: "text/html",
} as const;

export function documentRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Sec-Fetch-Dest")) headers.set("Sec-Fetch-Dest", "document");
  if (!headers.has("Accept")) headers.set("Accept", "text/html");
  return new Request(url, { ...init, headers });
}

export function originHtml(extra = "") {
  return `<!doctype html><html><head><title>Northline</title></head><body><span id="shop-trigger">Shop</span>${extra}</body></html>`;
}

export function flagsPayload(value: unknown, flagName = "lift_edge_spec") {
  return {
    flags: [
      {
        feature: { name: flagName },
        enabled: true,
        feature_state_value: value,
      },
    ],
  };
}

export function mockEnv(overrides: Record<string, unknown> = {}) {
  const specs = new Map<string, string>();
  return {
    ORIGIN: "http://origin.test",
    FLAGSMITH_API_URL: "http://flags.test/api/v1/",
    FLAGSMITH_ENVIRONMENT_KEY: "env-public-key",
    FLAGSMITH_FLAG_NAME: "lift_edge_spec",
    FLAGSMITH_SDK_URL: FLAGSMITH_SDK_URL_DEFAULT,
    FLAGSMITH_EVAL_TIMEOUT_MS: "300",
    SPECS: {
      async get(key: string) {
        return specs.has(key) ? specs.get(key)! : null;
      },
      async put(key: string, value: string) {
        specs.set(key, value);
      },
    },
    ASSETS: null,
    ...overrides,
  };
}

async function delay(ms: number, signal?: AbortSignal | null) {
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

export function installEdgeFetch(opts: {
  originBody?: string | Uint8Array | ArrayBuffer | ReadableStream;
  originType?: string;
  originStatus?: number;
  originHeaders?: Record<string, string>;
  flagsmith?: unknown | "down" | "http500";
  flagsmithDelayMs?: number;
  flagsmithStatus?: number;
  originDelayMs?: number;
  originThrow?: boolean;
  onFetch?: (url: string, init?: RequestInit) => void;
}) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    opts.onFetch?.(url, init);
    if (url.startsWith("http://origin.test")) {
      if (opts.originDelayMs) await delay(opts.originDelayMs);
      if (opts.originThrow) throw new TypeError("origin fetch failed");
      const status = opts.originStatus ?? 200;
      const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
      return new Response(nullBody ? null : ((opts.originBody ?? originHtml()) as BodyInit), {
        status,
        headers: {
          "content-type": opts.originType ?? "text/html; charset=utf-8",
          ...(opts.originHeaders || {}),
        },
      });
    }
    if (url.includes("/identities/")) {
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      if (opts.flagsmithDelayMs) await delay(opts.flagsmithDelayMs, signal);
      if (opts.flagsmith === "down") throw new TypeError("fetch failed");
      if (opts.flagsmith === "http500" || (opts.flagsmithStatus && opts.flagsmithStatus >= 400)) {
        return new Response("nope", { status: opts.flagsmithStatus ?? 500 });
      }
      return new Response(JSON.stringify(opts.flagsmith ?? flagsPayload(null)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return orig(input as RequestInfo, init);
  };
  const restore = () => {
    globalThis.fetch = nativeFetch;
  };
  return restore;
}
