import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { DEFAULT_PERSONA_MIX, type PersonaMix } from "../../shared/types.ts";
import { parsePersonaMix } from "../../shared/mix.ts";
import { getSite } from "../../shared/catalog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: resolve(root, ".env") });

export const ROOT = root;

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function defaultRunId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

/** Exclusive (0.5, 1) so a coin-flip or a certainty cannot be a win threshold. */
export function clampWinThreshold(n: number): number {
  if (!Number.isFinite(n)) return 0.95;
  return Math.min(0.999, Math.max(0.501, n));
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
  const siteId = env("LIFT_SITE", "checkout");
  const site = getSite(siteId);
  const targetArmN = Math.max(50, Math.floor(envNumber("LIFT_TARGET_ARM_N", 300)));
  const trafficNRaw = env("LIFT_TRAFFIC_N");
  const trafficN = Math.max(
    8,
    Math.floor(trafficNRaw ? envNumber("LIFT_TRAFFIC_N", 2 * targetArmN) : 2 * targetArmN),
  );
  return {
    siteId,
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
    flagName: env("LIFT_FLAG_NAME", site.flagName),
    metricEvent: env("LIFT_METRIC_EVENT", site.metricEvent),
    siteUrl: env(
      "LIFT_SITE_URL",
      siteId === "checkout" ? "http://127.0.0.1:4174" : `http://127.0.0.1:4174/${siteId}`,
    ).replace(/\/$/, ""),
    frictionKeepRate: site.harmfulFix?.frictionKeepRate ?? 0,
    trafficN,
    trafficSeed: envNumber("LIFT_TRAFFIC_SEED", 20261126),
    trafficRunId: env("LIFT_RUN_ID") || defaultRunId(),
    trafficBatch: Math.max(0, Math.floor(envNumber("LIFT_TRAFFIC_BATCH", 0))),
    winThreshold: clampWinThreshold(envNumber("LIFT_WIN_THRESHOLD", 0.95)),
    appendVisits: env("LIFT_APPEND_VISITS") === "true",
    continueUntilDecision: env("LIFT_CONTINUE_UNTIL") === "true",
    targetArmN,
    maxArmN: Math.max(50, Math.floor(envNumber("LIFT_MAX_ARM_N", 600))),
    baselineConvert: Math.min(1, Math.max(0, envNumber("LIFT_BASELINE_CONVERT", 0.75))),
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

export function statePath(siteId = env("LIFT_SITE", "checkout")): string {
  const override = env("LIFT_STATE_PATH");
  if (override) return resolve(override);
  if (siteId === "checkout") return resolve(ROOT, "data/state.json");
  return resolve(ROOT, `data/state-${siteId}.json`);
}

export function eventsPath(siteId = env("LIFT_SITE", "checkout")): string {
  if (siteId === "checkout") return resolve(ROOT, "data/visits.jsonl");
  return resolve(ROOT, `data/visits-${siteId}.jsonl`);
}

export function resultsPath(siteId = env("LIFT_SITE", "checkout")): string {
  return resolve(ROOT, `dashboard/sites/${siteId}.json`);
}

export function fleetResultsPath(): string {
  return resolve(ROOT, "dashboard/results.json");
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
