import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  maskSecret,
  originFromApiUrl,
  parseL3Args,
  segmentCreatePayload,
  segmentOverridePatch,
  upsertEnvFile,
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
    expect(patch.environment_default.value.type).toBe("string");
    expect(patch.segment_overrides[0]).toMatchObject({
      segment: { id: 99 },
      enabled: true,
    });
    expect(patch.segment_overrides[0].value.type).toBe("string");
  });

  it("throws a typed error class", () => {
    const err = new L3BootstrapError("nope", 401, "denied");
    expect(err.status).toBe(401);
  });

  it("derives the dashboard origin and masks secrets", () => {
    expect(originFromApiUrl("http://127.0.0.1:8000/api/v1/")).toBe("http://127.0.0.1:8000");
    expect(maskSecret("ser.abcdefghijklmnop")).toBe("ser.…mnop");
    expect(maskSecret("short")).toBe("********");
  });

  it("upserts a gitignored env file without dropping unrelated keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "l3-env-"));
    const path = join(dir, ".env");
    upsertEnvFile(path, { FLAGSMITH_API_URL: "http://127.0.0.1:8000/api/v1/" });
    upsertEnvFile(path, { FLAGSMITH_PROJECT_ID: "1", FLAGSMITH_API_URL: "http://127.0.0.1:8000/api/v1/" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("FLAGSMITH_API_URL=http://127.0.0.1:8000/api/v1/");
    expect(text).toContain("FLAGSMITH_PROJECT_ID=1");
    expect(text.match(/FLAGSMITH_API_URL=/g)?.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("L3 sticky identity", () => {
  it("prefers ?lift_identity= then the lift_vid cookie", () => {
    const queryId = "lift-aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const cookieId = "lift-aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
    const fromQuery = resolveStickyIdentity({
      queryIdentity: queryId,
      cookieHeader: `lift_vid=${cookieId}`,
    });
    expect(fromQuery.source).toBe("query");
    expect(fromQuery.identity).toBe(queryId);
    expect(parseCookie(fromQuery.cookie, "lift_vid")).toBe(queryId);

    const fromCookie = resolveStickyIdentity({
      cookieHeader: `other=1; lift_vid=${cookieId}; x=y`,
    });
    expect(fromCookie.source).toBe("cookie");
    expect(fromCookie.identity).toBe(cookieId);

    const created = resolveStickyIdentity({
      randomId: "lift-aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
    });
    expect(created.source).toBe("new");
    expect(created.identity).toBe("lift-aaaaaaaa-bbbb-4ccc-8ddd-333333333333");
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
    expect(src).toContain("WCAG AA ≥ 4.5:1");
    expect(src).toContain('setAttribute("aria-hidden", "true")');
    expect(src).not.toContain("innerHTML");
    expect(src).not.toMatch(/applySensorySafe\(\s*(score|runtime\.lastScore)/);
  });
});
