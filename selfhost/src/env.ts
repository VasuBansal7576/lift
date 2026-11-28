import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ENV_FILE, ROOT_ENV_FILE } from "./paths.ts";
import { isLoopbackUrl } from "./safety.ts";

export interface SelfhostEnv {
  apiUrl: string;
  adminApiUrl: string;
  eventsUrl: string;
  dashboardUrl: string;
  cliApiUrl: string;
  environmentKey: string;
  serverKey: string;
  adminToken: string;
  organisationId: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  bootstrapEmail: string;
  bootstrapPassword: string;
  bootstrapFirstName: string;
  bootstrapLastName: string;
  orgName: string;
  projectName: string;
}

/** Compose instance this repo starts. Never taken from the root .env. */
export const COMPOSE_ORIGIN = "http://127.0.0.1:8000";

export function splitApiUrl(apiUrl: string): { origin: string; sdk: string } {
  const trimmed = apiUrl.replace(/\/+$/, "");
  if (/\/api\/v1$/i.test(trimmed)) {
    return { origin: trimmed.replace(/\/api\/v1$/i, ""), sdk: `${trimmed}/` };
  }
  return { origin: trimmed, sdk: `${trimmed}/api/v1/` };
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const URL_KEYS = new Set([
  "FLAGSMITH_API_URL",
  "FLAGSMITH_ADMIN_API_URL",
  "FLAGSMITH_EVENTS_URL",
  "FLAGSMITH_DASHBOARD_URL",
  "FLAGSMITH_CLI_API_URL",
]);

export function generateBootstrapPassword(): string {
  return randomBytes(18).toString("base64url");
}

export function loadSelfhostEnv(opts?: {
  includeRoot?: boolean;
  includeProcess?: boolean;
}): SelfhostEnv {
  const merged: Record<string, string> = {};
  if (opts?.includeRoot) Object.assign(merged, readEnvFile(ROOT_ENV_FILE));
  if (opts?.includeProcess !== false) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
  }
  Object.assign(merged, readEnvFile(ENV_FILE));
  const val = (key: string, fallback = "") => merged[key] || fallback;
  const apiUrl = val("FLAGSMITH_API_URL", `${COMPOSE_ORIGIN}/api/v1/`);
  const split = splitApiUrl(apiUrl);
  return {
    apiUrl: split.sdk,
    adminApiUrl: val("FLAGSMITH_ADMIN_API_URL", split.sdk),
    eventsUrl: val("FLAGSMITH_EVENTS_URL", `${split.origin}/api/`),
    dashboardUrl: val("FLAGSMITH_DASHBOARD_URL", split.origin),
    cliApiUrl: val("FLAGSMITH_CLI_API_URL", split.origin),
    environmentKey: val("FLAGSMITH_ENVIRONMENT_KEY"),
    serverKey: val("FLAGSMITH_SERVER_KEY"),
    adminToken: val("FLAGSMITH_ADMIN_API_TOKEN"),
    organisationId: val("FLAGSMITH_ORGANISATION_ID"),
    projectId: val("FLAGSMITH_PROJECT_ID"),
    environmentId: val("FLAGSMITH_ENVIRONMENT_ID"),
    environmentName: val("FLAGSMITH_ENVIRONMENT_NAME", "Development"),
    bootstrapEmail: val("FLAGSMITH_BOOTSTRAP_EMAIL", "admin@lift.local"),
    bootstrapPassword: val("FLAGSMITH_BOOTSTRAP_PASSWORD"),
    bootstrapFirstName: val("FLAGSMITH_BOOTSTRAP_FIRST_NAME", "Lift"),
    bootstrapLastName: val("FLAGSMITH_BOOTSTRAP_LAST_NAME", "Admin"),
    orgName: val("FLAGSMITH_ORG_NAME", "Lift"),
    projectName: val("FLAGSMITH_PROJECT_NAME", "Lift"),
  };
}

/**
 * Env for the compose stack this command just started.
 * URLs are always loopback :8000 — never copied from the root .env.
 */
export function composeLocalEnv(): SelfhostEnv {
  const file = loadSelfhostEnv({ includeRoot: false, includeProcess: false });
  return {
    ...file,
    apiUrl: `${COMPOSE_ORIGIN}/api/v1/`,
    adminApiUrl: `${COMPOSE_ORIGIN}/api/v1/`,
    eventsUrl: `${COMPOSE_ORIGIN}/api/`,
    dashboardUrl: COMPOSE_ORIGIN,
    cliApiUrl: COMPOSE_ORIGIN,
  };
}

export function publicEnvSummary(env: SelfhostEnv): Record<string, string> {
  return {
    apiUrl: env.apiUrl,
    dashboardUrl: env.dashboardUrl,
    environmentName: env.environmentName,
    organisationId: env.organisationId,
    projectId: env.projectId,
    environmentId: env.environmentId,
  };
}

export function upsertEnvFile(path: string, patch: Record<string, string>): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current ? current.split("\n") : [];
  const keys = new Set(Object.keys(patch));
  const next = lines
    .filter((line) => {
      const key = line.split("=")[0]?.trim();
      return !key || !keys.has(key);
    })
    .filter((line, i, arr) => !(i === arr.length - 1 && line === ""));
  for (const [key, value] of Object.entries(patch)) {
    next.push(`${key}=${value}`);
  }
  writeFileSync(path, `${next.join("\n").trimEnd()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const COMPOSE_SECRET_KEYS = [
  "POSTGRES_PASSWORD",
  "DJANGO_SECRET_KEY",
  "WAREHOUSE_CREDENTIALS_SECRET",
] as const;

export function generateComposeSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** Generate compose secrets into selfhost/.env (0600) if missing. */
export function ensureComposeSecrets(path = ENV_FILE): Record<string, string> {
  const current = readEnvFile(path);
  const patch: Record<string, string> = {};
  for (const key of COMPOSE_SECRET_KEYS) {
    if (!current[key]) patch[key] = generateComposeSecret();
  }
  if (Object.keys(patch).length > 0 || !existsSync(path)) {
    upsertEnvFile(path, patch);
  } else {
    chmodSync(path, 0o600);
  }
  return { ...current, ...patch };
}

export function rootEnvHoldsNonLocalApiUrl(): boolean {
  const url = readEnvFile(ROOT_ENV_FILE).FLAGSMITH_API_URL;
  if (!url) return false;
  return !isLoopbackUrl(url);
}

export function envLinesForWrite(env: SelfhostEnv): Record<string, string> {
  return {
    FLAGSMITH_API_URL: env.apiUrl,
    FLAGSMITH_ADMIN_API_URL: env.adminApiUrl,
    FLAGSMITH_EVENTS_URL: env.eventsUrl,
    FLAGSMITH_DASHBOARD_URL: env.dashboardUrl,
    FLAGSMITH_CLI_API_URL: env.cliApiUrl,
    FLAGSMITH_ENVIRONMENT_KEY: env.environmentKey,
    FLAGSMITH_SERVER_KEY: env.serverKey,
    FLAGSMITH_ADMIN_API_TOKEN: env.adminToken,
    FLAGSMITH_ORGANISATION_ID: env.organisationId,
    FLAGSMITH_PROJECT_ID: env.projectId,
    FLAGSMITH_ENVIRONMENT_ID: env.environmentId,
    FLAGSMITH_ENVIRONMENT_NAME: env.environmentName,
    FLAGSMITH_BOOTSTRAP_EMAIL: env.bootstrapEmail,
    FLAGSMITH_BOOTSTRAP_PASSWORD: env.bootstrapPassword,
    FLAGSMITH_ORG_NAME: env.orgName,
    FLAGSMITH_PROJECT_NAME: env.projectName,
  };
}

export { URL_KEYS };
