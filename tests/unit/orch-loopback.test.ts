import { describe, expect, it } from "vitest";
import { assertAllowedUrl, isLoopbackHost, isLoopbackUrl } from "../../orchestrator/src/loopback.ts";

describe("loopback guard", () => {
  it("accepts loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8000/api/v1/")).toBe(true);
  });

  it("rejects non-loopback URLs unless --allow-remote", () => {
    expect(isLoopbackUrl("https://api.flagsmith.com/api/v1/")).toBe(false);
    expect(() => assertAllowedUrl("https://api.flagsmith.com/api/v1/", false, "FLAGSMITH_API_URL")).toThrow(
      /not loopback/,
    );
    expect(() => assertAllowedUrl("https://api.flagsmith.com/api/v1/", true, "FLAGSMITH_API_URL")).not.toThrow();
    expect(() =>
      assertAllowedUrl("https://api.flagsmith.com/api/v1/", false, "FLAGSMITH_ADMIN_API_URL"),
    ).toThrow(/not loopback/);
    expect(() =>
      assertAllowedUrl("https://events.api.flagsmith.com/", false, "FLAGSMITH_EVENTS_URL"),
    ).toThrow(/not loopback/);
  });

  it("rejects invalid URLs", () => {
    expect(() => assertAllowedUrl("not-a-url", false, "site URL")).toThrow(/not a valid URL/);
  });
});
