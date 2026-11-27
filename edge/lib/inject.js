import {
  BOOTSTRAP_PATH,
  CONFIG_SCRIPT_ID,
  FLAGSMITH_SDK_URL_DEFAULT,
  RUNTIME_PATH_PREFIX,
} from "./constants.js";

export function escapeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Snippet HTMLRewriter appends to <head>. No inline JS (CSP-safe). */
export function buildHeadSnippet(cfg) {
  const sdkUrl = cfg.sdkUrl || FLAGSMITH_SDK_URL_DEFAULT;
  const payload = {
    identity: cfg.identity,
    flagName: cfg.flagName,
    apiUrl: cfg.apiUrl,
    environmentKey: cfg.environmentKey,
    specId: cfg.specId || null,
    spec: cfg.spec || null,
    sdkUrl,
  };
  return [
    `<script type="application/json" id="${CONFIG_SCRIPT_ID}">${escapeJsonForScript(payload)}</script>`,
    `<script type="module" src="${escapeAttr(sdkUrl)}"></script>`,
    `<script type="module" src="${RUNTIME_PATH_PREFIX}runtime.js"></script>`,
    `<script type="module" src="${BOOTSTRAP_PATH}"></script>`,
  ].join("");
}

export function injectHead(html, snippet) {
  if (typeof html !== "string") return html;
  const lower = html.toLowerCase();
  const headClose = lower.lastIndexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + snippet + html.slice(headClose);
  }
  const htmlOpen = lower.indexOf("<html");
  if (htmlOpen !== -1) {
    const gt = html.indexOf(">", htmlOpen);
    if (gt !== -1) {
      return `${html.slice(0, gt + 1)}<head>${snippet}</head>${html.slice(gt + 1)}`;
    }
  }
  const bodyOpen = lower.search(/<body\b/);
  if (bodyOpen !== -1) {
    const gt = html.indexOf(">", bodyOpen);
    if (gt !== -1) return html.slice(0, gt + 1) + snippet + html.slice(gt + 1);
  }
  return snippet + html;
}

function applyExtraHeaders(headers, extra) {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (key.toLowerCase() === "set-cookie") headers.append("Set-Cookie", value);
    else headers.set(key, value);
  }
  headers.delete("content-length");
  headers.delete("Content-Length");
}

/**
 * HTMLRewriter in the Worker runtime; string inject in Node unit tests.
 * Returns null on rewriter/parse failure so the caller can fail open.
 */
export async function injectHtmlResponse(response, snippet, extraHeaders) {
  try {
    if (typeof HTMLRewriter === "function") {
      let injected = false;
      const rewritten = new HTMLRewriter()
        .on("head", {
          element(el) {
            el.append(snippet, { html: true });
            injected = true;
          },
        })
        .onDocument({
          end(end) {
            if (!injected) end.append(snippet, { html: true });
          },
        })
        .transform(response);
      const headers = new Headers(rewritten.headers);
      applyExtraHeaders(headers, extraHeaders);
      return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
    }
    const html = await response.text();
    const out = injectHead(html, snippet);
    const headers = new Headers(response.headers);
    applyExtraHeaders(headers, extraHeaders);
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return null;
  }
}
