import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ORCH_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(ORCH_ROOT, "..");
export const UI_DIR = resolve(ORCH_ROOT, "ui");
export const DATA_DIR = resolve(ORCH_ROOT, "data");
export const LIVE_PATH = resolve(UI_DIR, "live.json");

export function dataDir(): string {
  const override = process.env.LIFT_ORCH_STATE_DIR?.trim();
  return override ? resolve(override) : DATA_DIR;
}

export function statePath(): string {
  return resolve(dataDir(), "run-state.json");
}

export function eventsPath(): string {
  return resolve(dataDir(), "events.jsonl");
}

export function specsDir(): string {
  const override = process.env.LIFT_ORCH_SPECS_DIR?.trim();
  if (override) return resolve(override);
  return resolve(dataDir(), "specs");
}
