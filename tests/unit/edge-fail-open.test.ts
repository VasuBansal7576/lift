import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_SCRIPT_ID } from "../../edge/lib/constants.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml, restoreFetch } from "./edge-test-helpers.ts";

describe("fail-open", () => {
  afterEach(restoreFetch);

  it("passes non-HTML through unmodified", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: '{"ok":true}',
      originType: "application/json",
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/api"), env);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect(await res.text()).toBe('{"ok":true}');
      expect(res.headers.get("server-timing") || "").toMatch(/non-html/);
    } finally {
      restore();
    }
  });

  it("does not inject when Flagsmith is down", async () => {
    const env = mockEnv();
    const html = originHtml();
    const restore = installEdgeFetch({ originBody: html, flagsmith: "down" });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const body = await res.text();
      expect(body).toBe(html);
      expect(body).not.toContain(CONFIG_SCRIPT_ID);
      expect(res.headers.get("server-timing") || "").toMatch(/flagsmith-down/);
    } finally {
      restore();
    }
  });

  it("does not inject when Flagsmith returns HTTP 500", async () => {
    const env = mockEnv();
    const html = originHtml();
    const restore = installEdgeFetch({ originBody: html, flagsmith: "http500" });
    try {
      const res = await handleRequest(new Request("http://edge.test/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/flagsmith-down/);
    } finally {
      restore();
    }
  });

  it("does not inject when Flagsmith exceeds 300 ms", async () => {
    const env = mockEnv({ FLAGSMITH_EVAL_TIMEOUT_MS: "40" });
    const html = originHtml();
    const restore = installEdgeFetch({
      originBody: html,
      flagsmith: flagsPayload("checkout-treatment-v0"),
      flagsmithDelayMs: 80,
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/flagsmith-timeout/);
    } finally {
      restore();
    }
  });

  it("does not inject on KV miss for a treatment spec id", async () => {
    const env = mockEnv();
    const html = originHtml();
    const restore = installEdgeFetch({
      originBody: html,
      flagsmith: flagsPayload("missing-spec-id"),
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/kv-miss/);
    } finally {
      restore();
    }
  });

  it("does not inject when the KV spec is not JSON", async () => {
    const env = mockEnv();
    await env.SPECS.put("bad-spec", "not-json{");
    const html = originHtml();
    const restore = installEdgeFetch({
      originBody: html,
      flagsmith: flagsPayload("bad-spec"),
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/"), env);
      expect(await res.text()).toBe(html);
      expect(res.headers.get("server-timing") || "").toMatch(/parse-error/);
    } finally {
      restore();
    }
  });

  it("never logs the environment key while failing open", async () => {
    const env = mockEnv({ FLAGSMITH_ENVIRONMENT_KEY: "super-secret-env-key" });
    const logs: string[] = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const restore = installEdgeFetch({ originBody: originHtml(), flagsmith: "down" });
    try {
      await handleRequest(new Request("http://edge.test/"), env);
      expect(logs.join("\n")).not.toContain("super-secret-env-key");
    } finally {
      console.log = orig;
      console.error = origErr;
      restore();
    }
  });
});
