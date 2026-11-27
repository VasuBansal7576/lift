import { resolve } from "node:path";
import { isInsideRoot } from "./fs-path.ts";

const SPEC_FILE = /^[a-z0-9-]{1,40}\.json$/;

export function orchSpecsRoot(repoRoot: string): string {
  const specs = process.env.LIFT_ORCH_SPECS_DIR?.trim();
  if (specs) return resolve(specs);
  const state = process.env.LIFT_ORCH_STATE_DIR?.trim();
  if (state) return resolve(state, "specs");
  return resolve(repoRoot, "orchestrator/data/specs");
}

export function orchConfigOverlay(): Record<string, unknown> {
  const orchFlagName = (process.env.LIFT_ORCH_FLAG ?? "").trim();
  if (!orchFlagName) return {};
  return {
    orchFlagName,
    orchControlSpecRequired: process.env.LIFT_ORCH_CONTROL_SPEC === "1",
    flagsmithEnvironmentKey: (process.env.FLAGSMITH_ENVIRONMENT_KEY ?? "").trim(),
    flagsmithApiUrl: (process.env.FLAGSMITH_API_URL ?? "").trim(),
    flagsmithEventsUrl: (process.env.FLAGSMITH_EVENTS_URL ?? "").trim(),
  };
}

export function resolveOrchSpecPath(pathname: string, repoRoot: string): string | null {
  if (!pathname.startsWith("/orch-specs/")) return null;
  const file = pathname.slice("/orch-specs/".length);
  if (!SPEC_FILE.test(file) || file.includes("..") || file.includes("/")) return null;
  const specsRoot = orchSpecsRoot(repoRoot);
  const filePath = resolve(specsRoot, file);
  if (!isInsideRoot(specsRoot, filePath)) return null;
  return filePath;
}
