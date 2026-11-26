import { afterEach, describe, expect, it } from "vitest";
import { formatGitCommitSha, gitCommitSha } from "../../shared/git.ts";

describe("formatGitCommitSha", () => {
  it("appends -dirty only when the tree is dirty", () => {
    expect(formatGitCommitSha("abc123", false)).toBe("abc123");
    expect(formatGitCommitSha("abc123", true)).toBe("abc123-dirty");
    expect(formatGitCommitSha("abc123-dirty", true)).toBe("abc123-dirty");
    expect(formatGitCommitSha("unknown", true)).toBe("unknown");
  });
});

describe("gitCommitSha", () => {
  const previous = process.env.LIFT_COMMIT_SHA;

  afterEach(() => {
    if (previous === undefined) delete process.env.LIFT_COMMIT_SHA;
    else process.env.LIFT_COMMIT_SHA = previous;
  });

  it("returns LIFT_COMMIT_SHA without a dirty suffix", () => {
    process.env.LIFT_COMMIT_SHA = "deadbeef";
    expect(gitCommitSha()).toBe("deadbeef");
  });
});
