import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import { CONFIG_SCRIPT_ID, FLAGSMITH_SDK_URL_DEFAULT } from "../../edge/lib/constants.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { buildHeadSnippet, injectHead } from "../../edge/lib/inject.js";
import { adjustCsp } from "../../edge/lib/csp.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml, restoreFetch } from "./edge-test-helpers.ts";

const SDK = FLAGSMITH_SDK_URL_DEFAULT;

describe("buildHeadSnippet", () => {
  it("injects the Flagsmith SDK, runtime.js, bootstrap, and JSON config", () => {
    const html = buildHeadSnippet({
      identity: "vid-1",
      flagName: "lift_edge_spec",
      apiUrl: "http://127.0.0.1:8000/api/v1/",
      environmentKey: "env-public",
      specId: "checkout-treatment-v0",
      spec: { id: "checkout-treatment-v0", version: 0, ops: [] },
      sdkUrl: SDK,
    });
    expect(html).toContain(`id="${CONFIG_SCRIPT_ID}"`);
    expect(html).toContain(`src="${SDK}"`);
      expect(html).toContain('src="/__lift/runtime/runtime.js"');
    expect(html).toContain('src="/__lift/bootstrap.js"');
    expect(html).toContain("checkout-treatment-v0");
    expect(html).toContain('type="application/json"');
    expect(html).not.toContain("onclick=");
  });

  it("escapes </ so JSON cannot break out of the config script", () => {
    const html = buildHeadSnippet({
      identity: "vid",
      flagName: "lift_edge_spec",
      apiUrl: "http://flags.test/api/v1/",
      environmentKey: "k",
      spec: { id: "x", evil: "</script><script>alert(1)" },
      sdkUrl: SDK,
    });
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert");
  });
});

describe("injectHead", () => {
  it("inserts before </head>", () => {
    const out = injectHead("<html><head><title>t</title></head><body>hi</body></html>", "SNIP");
    expect(out).toContain("</title>SNIP</head>");
  });
});

describe("CSP widening", () => {
  it("adds self, jsdelivr, and the Flagsmith origin without unsafe-inline", () => {
    const out = adjustCsp("default-src 'self'; script-src 'none'", {
      sdkOrigin: "https://cdn.jsdelivr.net",
      flagsmithOrigin: "http://127.0.0.1:8000",
    });
    expect(out).toContain("script-src 'self' https://cdn.jsdelivr.net");
    expect(out).toContain("connect-src");
    expect(out).toContain("http://127.0.0.1:8000");
    expect(out).not.toContain("unsafe-inline");
    expect(out).not.toContain("unsafe-eval");
  });
});

describe("Worker HTML injection", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("injects Lift into origin HTML for a control visitor", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const body = await res.text();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(body).toContain(CONFIG_SCRIPT_ID);
      expect(body).toContain(SDK);
      expect(body).toContain("/__lift/runtime/runtime.js");
      expect(body).toContain('"evaluated":true');
      expect(body).toContain("/__lift/bootstrap.js");
      expect(body).toContain("Northline");
      expect(res.headers.get("cache-control")).toMatch(/private/);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(res.headers.get("server-timing")).toMatch(/liftwall/);
    } finally {
      restore();
    }
  });

  it("inlines the treatment spec id from Flagsmith + KV", async () => {
    const spec = JSON.parse(
      readFileSync(resolve(ROOT, "runtime/checkout-treatment.json"), "utf8"),
    );
    const env = mockEnv();
    await env.SPECS.put("checkout-treatment-v0", JSON.stringify(spec));
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload("checkout-treatment-v0"),
    });
    try {
      const res = await handleRequest(
        new Request("http://edge.test/checkout/", {
          headers: { cookie: "lift_vid=lift-e2e-treatment" },
        }),
        env,
      );
      const body = await res.text();
      expect(body).toContain("checkout-treatment-v0");
      expect(body).toContain("wrapLabel");
      expect(body).toContain("Northline");
    } finally {
      restore();
    }
  });

  it("serves bootstrap.js and runtime.js from the Worker", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: "export const x = 1;",
      originType: "text/javascript",
    });
    try {
      const boot = await handleRequest(new Request("http://edge.test/__lift/bootstrap.js"), env);
      expect(boot.headers.get("content-type")).toMatch(/javascript/);
      const bootText = await boot.text();
      expect(bootText).toContain("fail open");
      expect(bootText).toContain("applyPatchSpec");

      const runtime = await handleRequest(new Request("http://edge.test/__lift/runtime/runtime.js"), env);
      expect(runtime.status).toBe(200);
      expect(await runtime.text()).toContain("export const x = 1");
    } finally {
      restore();
    }
  });
});
