import { describe, expect, it } from "vitest";
import {
  containsSecretKeys,
  isBlockedBasename,
  resolveL3PublicPath,
} from "../../scripts/serve-l3.ts";

describe("L3 demo static server path rules", () => {
  it("allows demo/l3 and runtime files only", () => {
    expect(resolveL3PublicPath("/").status).toBe(200);
    expect(resolveL3PublicPath("/index.html").filePath).toMatch(/demo\/l3\/index\.html$/);
    expect(resolveL3PublicPath("/runtime/l3-balancer.js").filePath).toMatch(
      /runtime\/l3-balancer\.js$/,
    );
    expect(resolveL3PublicPath("/styles.css").status).toBe(200);
  });

  it("rejects path escapes and never serves env files", () => {
    expect(resolveL3PublicPath("/../.env").status).toBe(403);
    expect(resolveL3PublicPath("/runtime/../.env").status).toBe(403);
    expect(resolveL3PublicPath("/runtime/../../.env").status).toBe(403);
    expect(resolveL3PublicPath("/%2e%2e/.env").status).toBe(403);
    expect(resolveL3PublicPath("/.env").status).toBe(403);
    expect(resolveL3PublicPath("/.env.local").status).toBe(403);
    expect(resolveL3PublicPath("/flagsmith.env").status).toBe(403);
    expect(isBlockedBasename(".env")).toBe(true);
    expect(isBlockedBasename(".env.local")).toBe(true);
    expect(isBlockedBasename("flagsmith.env")).toBe(true);
    expect(containsSecretKeys("FLAGSMITH_ADMIN_API_TOKEN=secret")).toBe(true);
    expect(containsSecretKeys('{"flagsmithEnvironmentKey":"public"}')).toBe(false);
  });
});
