import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import {
  L3_FLAG_CONFIG,
  L3_FLAG_NAME,
  L3_SDK_URL,
  L3_SEGMENT_NAME,
  L3_TRAIT_NAME,
  WEIGHTS,
} from "../../shared/l3-constants.ts";
import {
  assertLoopback,
  DEFAULT_L3_API_URL,
  flagCreatePayload,
  isLoopbackUrl,
  L3BootstrapError,
  parseL3Args,
  segmentCreatePayload,
  segmentOverridePatch,
} from "../../scripts/l3-bootstrap.ts";
import { parseCookie, resolveStickyIdentity } from "../../shared/l3-identity.ts";

describe("L3 Flagsmith bootstrap", () => {
  it("defaults to loopback Flagsmith and rejects remote URLs without --allow-remote", () => {
    expect(DEFAULT_L3_API_URL).toContain("127.0.0.1:8000");
    expect(isLoopbackUrl("http://127.0.0.1:8000/api/v1/")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8000/api/v1/")).toBe(true);
    expect(isLoopbackUrl("https://api.flagsmith.com/api/v1/")).toBe(false);
    expect(() => assertLoopback("https://api.flagsmith.com/api/v1/", false)).toThrow(
      /loopback-only/,
    );
    expect(() => assertLoopback("https://api.flagsmith.com/api/v1/", true)).not.toThrow();
  });

  it("parses CLI flags", () => {
    expect(parseL3Args(["--dry-run", "--allow-remote", "--api-url", "http://127.0.0.1:9/"])).toEqual(
      {
        allowRemote: true,
        dryRun: true,
        apiUrl: "http://127.0.0.1:9/",
      },
    );
  });

  it("creates the sensory_safe segment rule overstimulated == true", () => {
    const body = segmentCreatePayload(56470);
    expect(body.name).toBe(L3_SEGMENT_NAME);
    const condition = body.rules[0].rules[0].conditions[0];
    expect(condition).toEqual({
      operator: "EQUAL",
      property: L3_TRAIT_NAME,
      value: "true",
    });
  });

  it("creates l3_sensory_safe as a STANDARD flag default-off with JSON config", () => {
    const body = flagCreatePayload();
    expect(body.name).toBe(L3_FLAG_NAME);
    expect(body.type).toBe("STANDARD");
    expect(body.default_enabled).toBe(false);
    expect(JSON.parse(body.initial_value)).toMatchObject({
      pauseMedia: true,
      pauseMotion: true,
      softenContrast: true,
      showSummaries: true,
      hideMarketing: true,
      fadeMs: L3_FLAG_CONFIG.fadeMs,
    });
  });

  it("enables the flag only via the segment override", () => {
    const patch = segmentOverridePatch(99);
    expect(patch.environment_default.enabled).toBe(false);
    expect(patch.segment_overrides[0]).toMatchObject({
      segment: { id: 99 },
      enabled: true,
    });
  });

  it("throws a typed error class", () => {
    const err = new L3BootstrapError("nope", 401, "denied");
    expect(err.status).toBe(401);
  });
});

describe("L3 sticky identity", () => {
  it("prefers ?lift_identity= then the lift_vid cookie", () => {
    const fromQuery = resolveStickyIdentity({
      queryIdentity: "lift-from-query",
      cookieHeader: "lift_vid=from-cookie",
    });
    expect(fromQuery.source).toBe("query");
    expect(fromQuery.identity).toBe("lift-from-query");
    expect(parseCookie(fromQuery.cookie, "lift_vid")).toBe("lift-from-query");

    const fromCookie = resolveStickyIdentity({
      cookieHeader: "other=1; lift_vid=sticky-user; x=y",
    });
    expect(fromCookie.source).toBe("cookie");
    expect(fromCookie.identity).toBe("sticky-user");

    const created = resolveStickyIdentity({ randomId: "lift-new" });
    expect(created.source).toBe("new");
    expect(created.identity).toBe("lift-new");
  });
});

describe("L3 runtime stays aligned with shared constants", () => {
  it("embeds the same SDK URL, weights, thresholds, and trait names", () => {
    const src = readFileSync(resolve(ROOT, "runtime/l3-balancer.js"), "utf8");
    expect(src).toContain(L3_SDK_URL);
    expect(src).not.toContain("npm/flagsmith@12.4.0");
    expect(src).toContain(`erraticMouse: ${WEIGHTS.erraticMouse}`);
    expect(src).toContain("ENTER_THRESHOLD = 0.62");
    expect(src).toContain("EXIT_THRESHOLD = 0.38");
    expect(src).toContain('L3_TRAIT_NAME = "overstimulated"');
    expect(src).toContain("flagsmith.setTrait");
    expect(src).toContain("hasFeature(L3_FLAG_NAME)");
    expect(src).toContain("OFFLINE FALLBACK — tests only");
    expect(src).not.toMatch(/applySensorySafe\(\s*(score|runtime\.lastScore)/);
  });
});
