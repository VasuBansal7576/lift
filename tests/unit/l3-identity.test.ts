import { describe, expect, it } from "vitest";
import { L3_COOKIE } from "../../shared/l3-constants.ts";
import { parseCookie, serializeCookie } from "../../shared/l3-identity.ts";

describe("lift_vid cookie helpers", () => {
  it("round-trips the sticky visitor cookie", () => {
    const header = serializeCookie(L3_COOKIE, "lift-abc");
    expect(header).toContain(`${L3_COOKIE}=lift-abc`);
    expect(parseCookie(header, L3_COOKIE)).toBe("lift-abc");
    expect(parseCookie("a=1; lift_vid=lift-abc; b=2", L3_COOKIE)).toBe("lift-abc");
    expect(parseCookie("", L3_COOKIE)).toBe("");
  });
});
