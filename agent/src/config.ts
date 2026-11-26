import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { DEFAULT_PERSONA_MIX, type PersonaMix } from "../../shared/types.ts";
import { parsePersonaMix } from "../../shared/mix.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: resolve(root, ".env") });

export const ROOT = root;

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig() {
  const apiUrl = env("FLAGSMITH_API_URL", "http://localhost:8000/api/v1/").replace(
    /\/?$/,
    "/",
  );
  const adminApiUrl = (
    env("FLAGSMITH_ADMIN_API_URL") || apiUrl
  ).replace(/\/?$/, "/");
  const cloud = /flagsmith\.com/i.test(apiUrl) || /flagsmith\.com/i.test(adminApiUrl);
  const eventsUrl = env(
    "FLAGSMITH_EVENTS_URL",
    cloud ? "https://events.api.flagsmith.com/" : "http://localhost:8000/api/",
  ).replace(/\/?$/, "/");
  return {
    apiUrl,
    adminApiUrl,
    eventsUrl,
    dashboardUrl: env("FLAGSMITH_DASHBOARD_URL", "http://localhost:8000").replace(
      /\/$/,
      "",
    ),
    environmentKey: env("FLAGSMITH_ENVIRONMENT_KEY"),
    serverKey: env("FLAGSMITH_SERVER_KEY"),
    adminToken: env("FLAGSMITH_ADMIN_API_TOKEN"),
    organisationId: env("FLAGSMITH_ORGANISATION_ID"),
    projectId: env("FLAGSMITH_PROJECT_ID"),
    environmentId: env("FLAGSMITH_ENVIRONMENT_ID"),
    environmentName: env("FLAGSMITH_ENVIRONMENT_NAME", "Development"),
    bootstrapEmail: env("FLAGSMITH_BOOTSTRAP_EMAIL", "admin@lift.local"),
    bootstrapPassword: env("FLAGSMITH_BOOTSTRAP_PASSWORD", "lift-dev-password"),
    flagName: env("LIFT_FLAG_NAME", "checkout_a11y"),
    metricEvent: env("LIFT_METRIC_EVENT", "checkout_completed"),
    siteUrl: env("LIFT_SITE_URL", "http://127.0.0.1:4174").replace(/\/$/, ""),
    trafficN: Math.max(8, Math.floor(envNumber("LIFT_TRAFFIC_N", 120))),
    trafficSeed: envNumber("LIFT_TRAFFIC_SEED", 20261126),
    winThreshold: envNumber("LIFT_WIN_THRESHOLD", 0.95),
    allowMock: env("LIFT_ALLOW_MOCK", "false") === "true",
    allowLocalDecision: env("LIFT_ALLOW_LOCAL_DECISION", "false") === "true",
    resultsWaitMs: Math.max(0, envNumber("LIFT_RESULTS_WAIT_MS", 420_000)),
    personaMix: parsePersonaMix(
      env("LIFT_PERSONA_MIX"),
      DEFAULT_PERSONA_MIX,
    ) as PersonaMix,
  };
}

export type LiftConfig = ReturnType<typeof loadConfig>;

export function statePath(): string {
  return resolve(ROOT, "data/state.json");
}

export function eventsPath(): string {
  return resolve(ROOT, "data/visits.jsonl");
}

export function resultsPath(): string {
  return resolve(ROOT, "dashboard/results.json");
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
