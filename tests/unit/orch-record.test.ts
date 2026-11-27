import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../orchestrator/src/paths.ts";

describe("record-proof", () => {
  const source = readFileSync(resolve(REPO_ROOT, "orchestrator/scripts/record-proof.ts"), "utf8");

  it("does not fake the address bar", () => {
    expect(source).not.toMatch(/replaceState/);
    expect(source).not.toMatch(/history\.replace/);
  });

  it("does not auto-approve and has no default bootstrap creds", () => {
    expect(source).not.toMatch(/parseArgv\(\[\"--approve\"/);
    expect(source).not.toMatch(/admin@lift\.local/);
    expect(source).not.toMatch(/lift-dev-password/);
    expect(source).toMatch(/FLAGSMITH_BOOTSTRAP_EMAIL/);
    expect(source).toMatch(/APPROVE \$\{/);
  });
});
