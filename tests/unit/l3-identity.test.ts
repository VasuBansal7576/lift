import { describe, expect, it } from "vitest";
import { isSafeIdentity, parseCookie, stickyIdentity } from "../../runtime/l3-balancer.js";
import { L3_COOKIE } from "../../shared/l3-constants.ts";
import { newLiftIdentity, resolveStickyIdentity, serializeCookie } from "../../shared/l3-identity.ts";

const QUERY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const COOKIE = "lift-aaaaaaaa-bbbb-4ccc-8ddd-222222222222";

describe("lift_vid cookie helpers", () => {
  it("round-trips the sticky visitor cookie", () => {
    const header = serializeCookie(L3_COOKIE, QUERY);
    expect(header).toContain(`${L3_COOKIE}=${QUERY}`);
    expect(parseCookie(header, L3_COOKIE)).toBe(QUERY);
    expect(parseCookie(`a=1; lift_vid=${QUERY}; b=2`, L3_COOKIE)).toBe(QUERY);
    expect(parseCookie("", L3_COOKIE)).toBe("");
    expect(parseCookie("lift_vid=%E0%A4%A", L3_COOKIE)).toBe("");
  });

  it("mints a fresh identity when lift_vid is malformed", () => {
    const doc = {
      defaultView: { location: { search: "" } },
      cookie: "lift_vid=%E0%A4%A",
    };
    const id = stickyIdentity(doc as unknown as Document);
    expect(isSafeIdentity(id)).toBe(true);
    expect(id).not.toBe("%E0%A4%A");
  });
});

describe("L3 identity charset", () => {
  it("accepts only lift-<uuid>", () => {
    expect(isSafeIdentity(QUERY)).toBe(true);
    expect(isSafeIdentity("lift-l3-record")).toBe(false);
    expect(isSafeIdentity("<img src=x onerror=alert(1)>")).toBe(false);
    expect(isSafeIdentity("lift-")).toBe(false);
    expect(newLiftIdentity(() => "aaaaaaaa-bbbb-4ccc-8ddd-444444444444")).toBe(
      "lift-aaaaaaaa-bbbb-4ccc-8ddd-444444444444",
    );
  });

  it("rejects XSS and other non-uuid query values", () => {
    const evil = resolveStickyIdentity({
      queryIdentity: "<img src=x onerror=alert(1)>",
      cookieHeader: `lift_vid=${COOKIE}`,
    });
    expect(evil.source).toBe("cookie");
    expect(evil.identity).toBe(COOKIE);

    const bothBad = resolveStickyIdentity({
      queryIdentity: "lift-not-a-uuid",
      cookieHeader: "lift_vid=also-bad",
      randomId: "lift-new",
    });
    expect(bothBad.source).toBe("new");
    expect(isSafeIdentity(bothBad.identity)).toBe(true);
  });
});
