import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  namedSegmentsSearchPath,
  originFromApiUrl,
  parseL3Args,
  pickCanonicalSegment,
  segmentCreatePayload,
  segmentOverridePatch,
  segmentUsesTrait,
  randomBootstrapPassword,
  upsertEnvFile,
  writeDemoConfig,
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

  it("lists existing segments only via /projects/:id/segments/?search=", () => {
    expect(namedSegmentsSearchPath("7")).toBe("/projects/7/segments/?search=sensory_safe");
    const src = readFileSync(resolve(ROOT, "scripts/l3-bootstrap.ts"), "utf8");
    expect(src).toContain("namedSegmentsSearchPath(projectId)");
    expect(src).not.toContain("/segments/?project=");
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
    expect(condition.property).toBe("overstimulated");
    expect(condition.property).not.toBe("is_sensory_safe");
    expect(segmentUsesTrait(body)).toBe(true);
    expect(
      segmentUsesTrait({
        rules: [
          {
            conditions: [{ property: "is_sensory_safe", operator: "EQUAL", value: "true" }],
          },
        ],
      }),
    ).toBe(false);
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a random bootstrap password when unset", () => {
    expect(randomBootstrapPassword()).toMatch(/^lift-/);
    expect(randomBootstrapPassword()).not.toBe(randomBootstrapPassword());
  });

  it("refuses to write a demo config pointing at a remote Flagsmith", () => {
    expect(() => writeDemoConfig("env-key", "https://api.flagsmith.com/api/v1/")).toThrow(
      /loopback-only/,
    );
    expect(() => assertLoopback("https://api.flagsmith.com/api/v1/", true)).not.toThrow();
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
    expect(src).toContain("(default, Flagsmith unreachable)");
    expect(src).toContain("scheduleFlagsmithReconnect");
    expect(src).toMatch(
      /const abandoned = await initFlagsmith\(config\);\s*if \(abandoned \|\| !runtime\.started/,
    );
    expect(src).toMatch(/await initFlagsmith\(config\);\s*if \(!runtime\.started\) return runtime;/);
    expect(src).toMatch(
      /window\.clearInterval\(runtime\.timer\);\s*runtime\.timer = window\.setInterval\(tick, 120\)/,
    );
    expect(src).toMatch(/runtime\.startGen \+= 1/);
    expect(src).toMatch(/if \(!runtime\.started \|\| startGen !== runtime\.startGen\) return/);
    expect(src).toMatch(/const gen = \+\+runtime\.initGen/);
    expect(src).toMatch(/runtime\.initGen \+= 1/);
    expect(src).toMatch(/gen !== runtime\.initGen \|\| !runtime\.started/);
    expect(src).toContain("flagsmith.setTrait");
    expect(src).toContain("hasFeature(L3_FLAG_NAME)");
    expect(src).toContain("OFFLINE FALLBACK — tests only");
    expect(src).toContain("WCAG AA ≥ 4.5:1");
    expect(src).toContain('setAttribute("aria-hidden", "true")');
    expect(src).not.toContain("innerHTML");
    expect(src).not.toMatch(/applySensorySafe\(\s*(score|runtime\.lastScore)/);
  });
});

describe("L3 recorder never stops shared Flagsmith", () => {
  it("blocks 127.0.0.1:8000 in the app DevTools and reloads with click XOR F5", () => {
    const src = readFileSync(resolve(ROOT, "scripts/l3-record.ts"), "utf8");
    expect(src).not.toMatch(/docker\s+stop/);
    expect(src).not.toContain("flagsmith-flagsmith-1");
    expect(src).not.toContain("about:blank");
    expect(src).not.toContain("setContent");
    expect(src).toContain("Show Request conditions");
    expect(src).toContain("*://127.0.0.1:8000/*");
    expect(src).not.toContain("page.route(");
    expect(src).not.toContain("setBlockedURLs");
    expect(src).not.toContain("persistFlagsmithBlock");
    expect(src).toContain("reloadAppWithBlockedFlagsmith");
    expect(src).not.toContain("assertFlagsmithBlockedFromPage");
    expect(src).not.toContain("/api/v1/flags/");
    expect(src).not.toMatch(/fetch\(\s*["']http:\/\/127\.0\.0\.1:8000/);
    const blockCheck = src.match(
      /async function reloadAppWithBlockedFlagsmith[\s\S]*?\nasync function /,
    )?.[0];
    expect(blockCheck).toBeTruthy();
    expect(blockCheck).not.toContain("!res.ok");
    const dragFn = src.match(/async function visibleDragSlider[\s\S]*?\nasync function /)?.[0];
    expect(dragFn).toBeTruthy();
    expect(dragFn).not.toContain("scrollIntoView");
    expect(src).toContain("allow-stop-shared-flagsmith");
    expect(src).toContain("LiftL3.forceScore(");
    expect(src).toContain("visiblePointerStress");
    expect(src).toContain("visibleDragSlider");
    expect(src).toContain('mode: "click" | "f5"');
    expect(src).not.toMatch(/xdo\(\["click", "1"\]\);\s*xdo\(\["key".*F5/);
    expect(src).toContain("features/feature-segments/?environment=");
    expect(src).toContain("&feature=");
    const html = readFileSync(resolve(ROOT, "demo/l3/index.html"), "utf8");
    expect(html).toContain('id="lift-l3-offline"');
    expect(html).toContain("Flagsmith unreachable. Staying in the normal flag-off state.");
    expect(src).not.toContain("sweepScore");
    expect(src).not.toContain("driftScore");
    expect(src).toContain("visibleFocusReload");
  });

  it("has no '!res.ok' in its Flagsmith block check and no capture-time probe fetch", () => {
    const src = readFileSync(resolve(ROOT, "scripts/l3-record.ts"), "utf8");
    const blockCheck = src.match(
      /async function reloadAppWithBlockedFlagsmith[\s\S]*?\nasync function /,
    )?.[0];
    expect(blockCheck).toBeTruthy();
    expect(blockCheck).not.toContain("!res.ok");
    expect(blockCheck).not.toContain("res.ok()");
    expect(blockCheck).toMatch(/BLOCKED_BY_\(CLIENT\|DEVTOOLS\)/);
    expect(blockCheck).toContain("|inspector");
    expect(blockCheck).toContain("framenavigated");
    expect(src).not.toContain("assertFlagsmithBlockedFromPage");
    expect(src).not.toContain("/api/v1/flags/");
    expect(src).not.toMatch(/page\.evaluate\([\s\S]*?127\.0\.0\.1:8000[\s\S]*?api\/v1\/flags/);
    expect(src).toContain("waitForURL(/\\/identities/");
    expect(src).toContain("inBandMs < 12_000");
    expect(src).toContain("max - min < 0.04");
    expect(src).toContain("min > 0.43");
    expect(src).toContain("max < 0.47");
    expect(src).toContain("NOFLAP_SLIDER_LO = 0.45");
    expect(src).toContain("NOFLAP_SLIDER_HI = 0.97");
    expect(src).not.toContain("unfocusUrlBar(admin, 520, 520)");
    expect(src).toContain("unfocusAdminPage");
    expect(src).toContain("clickLocatorVisible");
    expect(src).toContain("View and manage feature states and traits for this identity.");
    expect(src).toContain("Include users when all of the following rules apply");
    expect(src).not.toContain("bandPointerWiggle");
    expect(src).toContain("{ cause: clipErr }");
    const unfocus = src.match(/async function unfocusAdminPage[\s\S]*?\nasync function /)?.[0];
    expect(unfocus).toBeTruthy();
    expect(unfocus).not.toContain(".or(");
    expect(unfocus).toContain(".first()");
  });
});

describe("L3 bootstrap keeps the lowest duplicate sensory_safe segment", () => {
  it("writes rules to the lowest id and warns about extras without deleting them", () => {
    const extras = pickCanonicalSegment([
      { id: 9, name: "sensory_safe" },
      { id: 3, name: "sensory_safe" },
      { id: 12, name: "sensory_safe" },
    ]);
    expect(extras.chosen.id).toBe(3);
    expect(extras.extras.map((row) => row.id)).toEqual([9, 12]);

    const src = readFileSync(resolve(ROOT, "scripts/l3-bootstrap.ts"), "utf8");
    expect(src).toContain("pickCanonicalSegment(existing)");
    expect(src).toContain("warnDuplicateSegments(chosen, extras)");
    expect(src).toContain("using lowest id=");
    expect(src).toContain("(not deleted)");
    expect(src).not.toMatch(/adminRequest<[^>]+>\(\s*apiUrl,\s*token,\s*"DELETE"/);
    expect(src).not.toMatch(/for \(const row of existing\) \{\s*chosen = await writeSegmentRules/);
  });
});
