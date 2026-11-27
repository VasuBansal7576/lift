import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CONFIG_SCRIPT_ID } from "../../edge/lib/constants.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { injectHtmlResponse } from "../../edge/lib/inject.js";
import { documentRequest, flagsPayload, installEdgeFetch, mockEnv, originHtml } from "./edge-test-helpers.ts";

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
      const res = await handleRequest(documentRequest("http://edge.test/checkout/"), env);
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
      const res = await handleRequest(documentRequest("http://edge.test/checkout/"), env);
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
      const res = await handleRequest(documentRequest("http://edge.test/checkout/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/parse-error/);
    } finally {
      if (Orig) g.HTMLRewriter = Orig;
      else delete g.HTMLRewriter;
      restore();
    }
  });

  it("returns null when the rewriter body stream errors after transform()", async () => {
    const g = globalThis as typeof globalThis & { HTMLRewriter?: unknown };
    const Orig = g.HTMLRewriter;
    class StreamBoom {
      on() {
        return this;
      }
      onDocument() {
        return this;
      }
      transform(response: Response) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<html><head></head><body>"));
              controller.error(new Error("stream boom"));
            },
          }),
          { status: response.status, headers: response.headers },
        );
      }
    }
    g.HTMLRewriter = StreamBoom;
    try {
      const out = await injectHtmlResponse(
        new Response("<html><head></head><body></body></html>", {
          headers: { "content-type": "text/html" },
        }),
        "SNIP",
        {},
      );
      expect(out).toBeNull();
    } finally {
      if (Orig) g.HTMLRewriter = Orig;
      else delete g.HTMLRewriter;
    }
  });

  it("fail-opens when the rewriter body stream errors partway through", async () => {
    const html = originHtml();
    const env = mockEnv();
    const g = globalThis as typeof globalThis & { HTMLRewriter?: unknown };
    const Orig = g.HTMLRewriter;
    class StreamBoom {
      on() {
        return this;
      }
      onDocument() {
        return this;
      }
      transform() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<html><head></head><body>partial"));
              controller.error(new Error("stream boom"));
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
    }
    g.HTMLRewriter = StreamBoom;
    const restore = installEdgeFetch({ originBody: html, flagsmith: flagsPayload(null) });
    try {
      const res = await handleRequest(documentRequest("http://edge.test/checkout/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/parse-error/);
    } finally {
      if (Orig) g.HTMLRewriter = Orig;
      else delete g.HTMLRewriter;
      restore();
    }
  });
});

describe("document-only eval", () => {
  it("CSS, JS, and image requests make 0 Flagsmith calls", async () => {
    const env = mockEnv();
    const cases = [
      { path: "/checkout/styles.css", dest: "style", type: "text/css", body: "body{}" },
      { path: "/checkout/app.js", dest: "script", type: "text/javascript", body: "void 0;" },
      { path: "/checkout/logo.png", dest: "image", type: "image/png", body: "png" },
    ];
    for (const row of cases) {
      let flagsmithHits = 0;
      const restore = installEdgeFetch({
        originBody: row.body,
        originType: row.type,
        flagsmith: flagsPayload("checkout-treatment-v0"),
        onFetch: (url) => {
          if (url.includes("/identities/")) flagsmithHits += 1;
        },
      });
      try {
        const res = await handleRequest(
          new Request(`http://edge.test${row.path}`, {
            headers: { "Sec-Fetch-Dest": row.dest, Accept: row.type },
          }),
          env,
        );
        expect(flagsmithHits, row.path).toBe(0);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(await res.text()).toBe(row.body);
        expect(res.headers.get("server-timing") || "").toMatch(/non-html/);
      } finally {
        restore();
      }
    }
  });
});

describe("gzip origin replay", () => {
  it("strips Content-Encoding and Content-Length after decoding gzip HTML", async () => {
    const html = originHtml();
    const gz = gzipSync(html);
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: gz,
      flagsmith: flagsPayload(null),
      originHeaders: {
        "Content-Encoding": "gzip",
        "Content-Length": String(gz.length),
        ETag: '"g1"',
      },
    });
    try {
      const res = await handleRequest(documentRequest("http://edge.test/checkout/"), env);
      const body = await res.text();
      expect(body).toContain(CONFIG_SCRIPT_ID);
      expect(body).toContain("Northline");
      expect(res.headers.get("content-encoding")).toBeNull();
      const cl = res.headers.get("content-length");
      if (cl) expect(Number(cl)).not.toBe(gz.length);
      expect(res.headers.get("etag")).toBeNull();
    } finally {
      restore();
    }
  });
});
