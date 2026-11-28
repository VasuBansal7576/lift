import { describe, expect, it } from "vitest";
import { handleRequest } from "../../edge/lib/handler.js";
import { isOpenProxyPathname, resolveOriginDestination } from "../../edge/lib/origin-url.js";
import { flagsPayload, installEdgeFetch, mockEnv, originHtml } from "./edge-test-helpers.ts";

const VARIANTS = [
  { name: "//host", url: "http://edge.test//evil.example/" },
  { name: "///host", url: "http://edge.test///evil.example/" },
  { name: "/\\host", url: "http://edge.test/\\evil.example/" },
  { name: "/%2F%2Fhost", url: "http://edge.test/%2F%2Fevil.example/" },
] as const;

describe("open-proxy / SSRF", () => {
  it("classifies each host-changing path as an open proxy", () => {
    expect(isOpenProxyPathname("//evil.example/")).toBe(true);
    expect(isOpenProxyPathname("///evil.example/")).toBe(true);
    expect(isOpenProxyPathname("/\\evil.example/")).toBe(true);
    expect(isOpenProxyPathname("/%2F%2Fevil.example/")).toBe(true);
    expect(isOpenProxyPathname("/checkout/")).toBe(false);
  });

  it("builds the origin URL from parts and rejects dest.origin !== origin", () => {
    for (const row of VARIANTS) {
      const resolved = resolveOriginDestination(row.url, "http://origin.test");
      expect(resolved, row.name).toMatchObject({ error: 400, reason: "open-proxy" });
    }
    const ok = resolveOriginDestination("http://edge.test/checkout/?q=1", "http://origin.test");
    expect("dest" in ok && ok.dest.origin).toBe("http://origin.test");
    expect("dest" in ok && ok.dest.pathname).toBe("/checkout/");
    expect("dest" in ok && ok.dest.search).toBe("?q=1");
  });

  it("returns 400 for each variant and never fetches the attacker host", async () => {
    const env = mockEnv();
    for (const row of VARIANTS) {
      const fetched: string[] = [];
      const restore = installEdgeFetch({
        originBody: originHtml(),
        flagsmith: flagsPayload(null),
        onFetch: (url) => fetched.push(url),
      });
      try {
        const res = await handleRequest(
          new Request(row.url, { headers: { cookie: "lift_vid=victim; session=secret" } }),
          env,
        );
        expect(res.status, row.name).toBe(400);
        expect(fetched.some((u) => u.includes("evil.example")), row.name).toBe(false);
        expect(
          fetched.some((u) => {
            try {
              return new URL(u).origin !== "http://origin.test" && !u.includes("/identities/");
            } catch {
              return false;
            }
          }),
          `${row.name} leaked off-origin fetch ${fetched.join(",")}`,
        ).toBe(false);
      } finally {
        restore();
      }
    }
  });

  it("returns 404 (never 502) for malformed percent-encoding", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({
      originBody: originHtml(),
      flagsmith: flagsPayload(null),
    });
    try {
      const res = await handleRequest(new Request("http://edge.test/%E0%A4"), env);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(502);
    } finally {
      restore();
    }
  });

  it("returns 404 (never 502) when the origin fetch throws", async () => {
    const env = mockEnv();
    const restore = installEdgeFetch({ originThrow: true });
    try {
      const res = await handleRequest(new Request("http://edge.test/checkout/"), env);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(502);
    } finally {
      restore();
    }
  });
});
