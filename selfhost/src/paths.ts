import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const SELFHOST_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SELFHOST_DIR, "..");
export const COMPOSE_FILE = resolve(SELFHOST_DIR, "docker-compose.yml");
export const ENV_FILE = resolve(SELFHOST_DIR, ".env");
export const PROOF_ENV_FILE = resolve(SELFHOST_DIR, ".env.proof");
export const ENV_EXAMPLE = resolve(SELFHOST_DIR, ".env.example");
export const COMPOSE_PROOF_FILE = resolve(SELFHOST_DIR, "docker-compose.proof.yml");
export const STATE_FILE = resolve(SELFHOST_DIR, "state.json");
export const FLAGSMITH_ENV_FILE = resolve(SELFHOST_DIR, "flagsmith.env");
export const FLAGSMITH_JSON = resolve(SELFHOST_DIR, "flagsmith.json");
export const DASHBOARD_DIR = resolve(SELFHOST_DIR, "dashboard");
export const PROOF_LOG = resolve(SELFHOST_DIR, "bootstrap-proof.json");
export const ROOT_ENV_FILE = resolve(REPO_ROOT, ".env");
export const LAST_RUN_FILE = resolve(REPO_ROOT, "skills/flagsmith-a11y-experiment/last-run.json");
