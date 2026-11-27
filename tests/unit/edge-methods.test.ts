import { describe, expect, it } from "vitest";
import { CONFIG_SCRIPT_ID } from "../../edge/lib/constants.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml } from "./edge-test-helpers.ts";

describe("HEAD and non-GET skip eval, injection, and the cookie", () => {
  it("HEAD HTML is passed through with no Lift scripts and no lift_vid", async () => {
    const env = mockEnv();
    let flagsmithHits = 0;
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload("checkout-treatment-v0"),
      onFetch: (url) => {
        if (url.includes("/identities/")) flagsmithHits += 1;
      },
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/", { method: "HEAD" }), env);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(CONFIG_SCRIPT_ID);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(flagsmithHits).toBe(0);
      expect(res.headers.get("server-timing") || "").toMatch(/head/);
    } finally {
      restore();
    }
  });

  it("POST HTML is proxied without injection or a cookie", async () => {
    const env = mockEnv();
    let flagsmithHits = 0;
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload("checkout-treatment-v0"),
      onFetch: (url) => {
        if (url.includes("/identities/")) flagsmithHits += 1;
      },
    });
    try {
      const res = await handleRequest(
        new Request("http://edge.test/checkout/", { method: "POST", body: "x" }),
        env,
      );
      const body = await res.text();
      expect(body).not.toContain(CONFIG_SCRIPT_ID);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(flagsmithHits).toBe(0);
      expect(res.headers.get("server-timing") || "").toMatch(/method/);
    } finally {
      restore();
    }
  });
});

describe("injected HTML validators and wall time", () => {
  it("strips ETag and Last-Modified on injected HTML", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
      originHeaders: {
        ETag: '"abc"',
        "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      },
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const body = await res.text();
      expect(body).toContain(CONFIG_SCRIPT_ID);
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("last-modified")).toBeNull();
      expect(res.headers.get("server-timing") || "").toMatch(/liftwall/);
      expect(res.headers.get("server-timing") || "").not.toMatch(/liftcpu/);
    } finally {
      restore();
    }
  });

  it("starts Flagsmith eval in parallel with the origin fetch", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
      originDelayMs: 70,
      flagsmithDelayMs: 70,
    });
    try {
      const t0 = performance.now();
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(CONFIG_SCRIPT_ID);
      expect(elapsed).toBeLessThan(145);
    } finally {
      restore();
    }
  });
});

describe("HTMLRewriter streaming-error fail-open", () => {
  it("returns the buffered origin HTML when HTMLRewriter throws", async () => {
    const html = originHtml();
    const env = mockEnv();
    const g = globalThis as typeof globalThis & { HTMLRewriter?: unknown };
    const Orig = g.HTMLRewriter;
    class Boom {
      on() {
        return this;
      }
      onDocument() {
        return this;
      }
      transform() {
        throw new Error("miniflare streaming boom");
      }
    }
    g.HTMLRewriter = Boom;
    const restore = installEdgeFetch({ originBody: html, flagsmith: flagsPayload(null) });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/parse-error/);
    } finally {
      if (Orig) g.HTMLRewriter = Orig;
      else delete g.HTMLRewriter;
      restore();
    }
  });
});
