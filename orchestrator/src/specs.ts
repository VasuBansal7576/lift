import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PatchSpec } from "../../shared/patch-spec.ts";
import { assertSpecId } from "./names.ts";
import { specsDir } from "./paths.ts";
import type { GateResult } from "./types.ts";

export function writePassedSpecs(passed: GateResult[], controlSpec?: PatchSpec | null): void {
  const dir = specsDir();
  mkdirSync(dir, { recursive: true });
  for (const item of passed) {
    assertSpecId(item.specId);
    writeFileSync(resolve(dir, `${item.specId}.json`), `${JSON.stringify(item.spec)}\n`);
  }
  if (controlSpec) {
    writeFileSync(resolve(dir, "control.json"), `${JSON.stringify(controlSpec)}\n`);
  }
}
