import { describe, expect, it } from "vitest";
import {
  IDENTITY_COOKIE,
  IDENTITY_MAX_AGE_SEC,
  cookieWriteValue,
} from "../../sites/shared/identity.js";
import { visitorFromRequest } from "../../edge/lib/cookie.js";
import { handleRequest } from "../../edge/lib/handler.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml } from "./edge-test-helpers.ts";

describe("lift_vid cookie", () => {
  it("matches the identity runtime: Lax, not HttpOnly, Secure only on https", () => {
    const http = cookieWriteValue("abc", false);
    expect(http).toContain(`${IDENTITY_COOKIE}=abc`);
    expect(http).toContain("SameSite=Lax");
    expect(http).toContain(`Max-Age=${IDENTITY_MAX_AGE_SEC}`);
    expect(http).toContain("Path=/");
    expect(http.toLowerCase()).not.toContain("httponly");
    expect(http).not.toContain("Secure");
    expect(cookieWriteValue("abc", true)).toContain("Secure");
  });

  it("reuses an existing cookie and does not mint another", () => {
    const req = new Request("http://edge.test/", {
      headers: { cookie: "lift_vid=sticky-visitor-1" },
    });
    const got = visitorFromRequest(req, new URL(req.url));
    expect(got.id).toBe("sticky-visitor-1");
    expect(got.setCookie).toBeNull();
    expect(got.minted).toBe(false);
  });

  it("mints lift_vid on HTML when missing", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      const cookie = res.headers.get("set-cookie") || "";
      expect(cookie).toContain(`${IDENTITY_COOKIE}=`);
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie.toLowerCase()).not.toContain("httponly");
      expect(cookie).not.toContain("Secure");
    } finally {
      restore();
    }
  });

  it("adds Secure when the Worker URL is https", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
    });
    try {
      const res = await handleRequest(new Request("https://edge.test/checkout/"), env);
      expect(res.headers.get("set-cookie") || "").toContain("Secure");
    } finally {
      restore();
    }
  });

  it("keeps the existing cookie on a subsequent HTML response", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
    });
    try {
      const res = await handleRequest(
        new Request("http://edge.test/checkout/", {
          headers: { cookie: "lift_vid=already-there" },
        }),
        env,
      );
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      restore();
    }
  });
});
