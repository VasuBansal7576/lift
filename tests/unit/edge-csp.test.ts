import { describe, expect, it } from "vitest";
import { BOOTSTRAP_JS } from "../../edge/lib/bootstrap-source.js";
import { adjustCsp, findMetaCsp, inspectCsp, rewriteMetaCspHtml } from "../../edge/lib/csp.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { buildHeadSnippet } from "../../edge/lib/inject.js";
import { FLAGSMITH_SDK_URL_DEFAULT } from "../../edge/lib/constants.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml } from "./edge-test-helpers.ts";

describe("CSP nonce, strict-dynamic, meta", () => {
  it("copies the script nonce onto injected tags", () => {
    const html = buildHeadSnippet({
      identity: "vid",
      flagName: "lift_edge_spec",
      apiUrl: "http://flags.test/api/v1/",
      environmentKey: "k",
      sdkUrl: FLAGSMITH_SDK_URL_DEFAULT,
      evaluated: true,
      scriptNonce: "abc123",
      styleNonce: "style-n",
    });
    expect(html).toMatch(/id="lift-edge-config"[^>]*nonce="abc123"/);
    expect(html.match(/nonce="abc123"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('"evaluated":true');
    expect(html).toContain('"styleNonce":"style-n"');
  });

  it("keeps strict-dynamic and fails open when it has no nonce", () => {
    const withNonce = inspectCsp("script-src 'nonce-xyz' 'strict-dynamic'");
    expect(withNonce.ok).toBe(true);
    expect(withNonce.strictDynamic).toBe(true);
    expect(withNonce.scriptNonce).toBe("xyz");

    const noNonce = inspectCsp("script-src 'strict-dynamic' https://cdn.example");
    expect(noNonce.ok).toBe(false);

    const widened = adjustCsp("script-src 'nonce-xyz' 'strict-dynamic'", {
      sdkOrigin: "https://cdn.jsdelivr.net",
      flagsmithOrigin: "http://flags.test",
      scriptNonce: "xyz",
    });
    expect(widened).toContain("'strict-dynamic'");
    expect(widened).toContain("'nonce-xyz'");
    expect(widened).not.toContain("unsafe-inline");
  });

  it("rewrites a meta CSP or leaves HTML unchanged on inspect failure", () => {
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><title>t</title></head><body></body></html>`;
    const found = findMetaCsp(html);
    expect(found?.content).toContain("script-src");
    const out = rewriteMetaCspHtml(html, (p: string) =>
      adjustCsp(p, { sdkOrigin: "https://cdn.jsdelivr.net", flagsmithOrigin: "http://flags.test" }),
    );
    expect(out).toContain("cdn.jsdelivr.net");
    expect(out).toContain("http-equiv");
  });

  it("stamps nonce from the origin CSP header onto the injected HTML", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
      originHeaders: {
        "Content-Security-Policy": "script-src 'nonce-from-origin' 'strict-dynamic'; style-src 'nonce-style-n'",
      },
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const body = await res.text();
      expect(body).toContain('nonce="from-origin"');
      expect(body).toContain('"evaluated":true');
      expect(res.headers.get("content-security-policy") || "").toContain("'strict-dynamic'");
      expect(res.headers.get("content-security-policy") || "").toContain("nonce-from-origin");
    } finally {
      restore();
    }
  });

  it("fail-opens when meta CSP is strict-dynamic without a nonce", async () => {
    const env = mockEnv();
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'strict-dynamic'"><title>Northline</title></head><body>hi</body></html>`;
    const restore = installEdgeFetch({ originBody: html, flagsmith: flagsPayload(null) });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/csp-strict-dynamic-no-nonce/);
    } finally {
      restore();
    }
  });

  it("uses adoptedStyleSheets (or the style nonce) for injectCSS", () => {
    expect(BOOTSTRAP_JS).toContain("adoptedStyleSheets");
    expect(BOOTSTRAP_JS).toContain("CSSStyleSheet");
    expect(BOOTSTRAP_JS).toContain("styleNonce");
    expect(BOOTSTRAP_JS).toContain("cfg.evaluated === true");
    expect(BOOTSTRAP_JS).not.toContain('import("/runtime/runtime.js")');
    expect(BOOTSTRAP_JS).toContain("/__lift/runtime/runtime.js");
  });
});
