import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ORCH_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(ORCH_ROOT, "..");
export const UI_DIR = resolve(ORCH_ROOT, "ui");
export const DATA_DIR = resolve(ORCH_ROOT, "data");
export const STATE_PATH = resolve(DATA_DIR, "run-state.json");
export const LIVE_PATH = resolve(UI_DIR, "live.json");
export const EVENTS_PATH = resolve(DATA_DIR, "events.jsonl");
