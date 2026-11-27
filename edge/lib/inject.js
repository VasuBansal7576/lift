import {
  BOOTSTRAP_PATH,
  CONFIG_SCRIPT_ID,
  FLAGSMITH_SDK_URL_DEFAULT,
  RUNTIME_PATH_PREFIX,
} from "./constants.js";
import { adjustCsp, rewriteMetaCspHtml } from "./csp.js";

export function escapeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function nonceAttr(nonce) {
  if (!nonce) return "";
  return ` nonce="${escapeAttr(nonce)}"`;
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
    evaluated: cfg.evaluated !== false,
    styleNonce: cfg.styleNonce || null,
  };
  const n = nonceAttr(cfg.scriptNonce);
  const tags = [
    `<script type="application/json" id="${CONFIG_SCRIPT_ID}"${n}>${escapeJsonForScript(payload)}</script>`,
  ];
  if (cfg.evaluated === false) {
    tags.push(`<script type="module" src="${escapeAttr(sdkUrl)}"${n}></script>`);
  }
  tags.push(
    `<script type="module" src="${RUNTIME_PATH_PREFIX}runtime.js"${n}></script>`,
    `<script type="module" src="${BOOTSTRAP_PATH}"${n}></script>`,
  );
  return tags.join("");
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

export function stripValidators(headers) {
  for (const key of ["ETag", "etag", "Last-Modified", "last-modified"]) {
    headers.delete(key);
  }
  headers.delete("content-length");
  headers.delete("Content-Length");
}

function applyExtraHeaders(headers, extra) {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (key.toLowerCase() === "set-cookie") headers.append("Set-Cookie", value);
    else headers.set(key, value);
  }
  stripValidators(headers);
}

/**
 * HTMLRewriter in the Worker runtime; string inject in Node unit tests.
 * Returns null on rewriter/parse failure so the caller can fail open from
 * buffered origin bytes (Miniflare HTMLRewriter can drop the original
 * stream after transform() starts).
 */
export async function injectHtmlResponse(response, snippet, extraHeaders, injectOpts) {
  const cspOpts = injectOpts?.cspOpts || null;
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
        .on("meta", {
          element(el) {
            const equiv = (el.getAttribute("http-equiv") || "").toLowerCase();
            if (equiv !== "content-security-policy") return;
            const content = el.getAttribute("content");
            if (!content || !cspOpts) return;
            el.setAttribute("content", adjustCsp(content, cspOpts));
          },
        })
        .onDocument({
          end(end) {
            if (!injected) end.append(snippet, { html: true });
          },
        })
        .transform(response);
      // Drain inside the try so a mid-stream HTMLRewriter error cannot
      // escape and truncate the response. Caller fail-opens on null.
      const out = await rewritten.arrayBuffer();
      const headers = new Headers(rewritten.headers);
      applyExtraHeaders(headers, extraHeaders);
      return new Response(out, { status: rewritten.status, statusText: rewritten.statusText, headers });
    }
    const html = await response.text();
    let out = injectHead(html, snippet);
    if (cspOpts) {
      out = rewriteMetaCspHtml(out, (policy) => adjustCsp(policy, cspOpts));
    }
    const headers = new Headers(response.headers);
    applyExtraHeaders(headers, extraHeaders);
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return null;
  }
}
