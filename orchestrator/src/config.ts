import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { ROOT, clampWinThreshold } from "../../agent/src/config.ts";
import { assertOrchFlagName } from "./names.ts";
import { REPO_ROOT } from "./paths.ts";
import type { OrchOptions } from "./types.ts";

loadEnv({ path: resolve(ROOT, ".env") });
const flagsmithEnvPath = process.env.LIFT_FLAGSMITH_ENV?.trim();
if (flagsmithEnvPath) {
  loadEnv({ path: flagsmithEnvPath });
}

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((item) => item.startsWith(`${name}=`));
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  const prefix = `${name}=`;
  const matched = argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function apiBase(raw: string): string {
  return raw.replace(/\/?$/, "/");
}

function parsePositiveIdArg(argv: string[], name: string): number | null {
  const index = argv.findIndex((item) => item === name || item.startsWith(`${name}=`));
  if (index < 0) return null;
  const token = argv[index];
  const raw = token.startsWith(`${name}=`)
    ? token.slice(`${name}=`.length)
    : argv[index + 1] && !argv[index + 1].startsWith("--")
      ? argv[index + 1]
      : undefined;
  if (!raw) {
    throw new Error(`${name} requires a positive experiment id, e.g. ${name} 12`);
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${name} requires a positive experiment id`);
  }
  return id;
}

export function parseApproveArg(argv: string[]): { approve: boolean; approveExperimentId: number | null } {
  const id = parsePositiveIdArg(argv, "--approve");
  if (id == null) return { approve: false, approveExperimentId: null };
  return { approve: true, approveExperimentId: id };
}

export function parseResultsArg(argv: string[]): number | null {
  return parsePositiveIdArg(argv, "--results");
}

export function parseArgv(argv: string[] = process.argv.slice(2)): OrchOptions {
  const apiUrl = apiBase(
    argValue(argv, "--api-url") || env("FLAGSMITH_API_URL", "http://127.0.0.1:8000/api/v1/"),
  );
  const adminApiUrl = apiBase(argValue(argv, "--admin-api-url") || env("FLAGSMITH_ADMIN_API_URL") || apiUrl);
  const cloud = /flagsmith\.com/i.test(apiUrl) || /flagsmith\.com/i.test(adminApiUrl);
  const eventsUrl = apiBase(
    argValue(argv, "--events-url") ||
      env("FLAGSMITH_EVENTS_URL", cloud ? "https://events.api.flagsmith.com/" : "http://127.0.0.1:8000/api/"),
  );
  const generations = Math.max(1, Math.min(3, Math.floor(Number(argValue(argv, "--generations") || env("LIFT_ORCH_GENERATIONS", "1")))));
  const trafficN = Math.max(4, Math.floor(Number(argValue(argv, "--traffic-n") || env("LIFT_ORCH_TRAFFIC_N", "220"))));
  const threshold = clampWinThreshold(Number(argValue(argv, "--threshold") || env("LIFT_WIN_THRESHOLD", "0.95")));
  const siteUrl = (
    argValue(argv, "--site-url") ||
    env("LIFT_SITE_URL", "http://127.0.0.1:4174/checkout")
  ).replace(/\/$/, "");
  const uiPort = Math.max(1, Math.floor(Number(argValue(argv, "--ui-port") || env("LIFT_ORCH_UI_PORT", "4177"))));
  const { approve, approveExperimentId } = parseApproveArg(argv);
  const resultsExperimentId = parseResultsArg(argv);
  const cleanup = hasFlag(argv, "--cleanup");
  const fromGeneration = Math.max(
    1,
    Math.min(3, Math.floor(Number(argValue(argv, "--from-generation") || "1"))),
  );
  const flagName = argValue(argv, "--flag-name") || env("LIFT_ORCH_FLAG", "lift_orch_checkout");
  if (!cleanup && !approve && resultsExperimentId == null) {
    assertOrchFlagName(flagName);
  }

  return {
    apply: hasFlag(argv, "--apply"),
    approve,
    approveExperimentId,
    resultsExperimentId,
    cleanup,
    fromGeneration,
    allowRemote: hasFlag(argv, "--allow-remote"),
    generations,
    siteUrl,
    uiPort,
    trafficN,
    threshold,
    flagName,
    metricEvent: argValue(argv, "--metric-event") || env("LIFT_METRIC_EVENT", "checkout_completed"),
    keepUi: hasFlag(argv, "--keep-ui"),
    noUi: hasFlag(argv, "--no-ui"),
    resultsWaitMs: Math.max(0, envNumber("LIFT_ORCH_RESULTS_WAIT_MS", 420_000)),
    apiUrl,
    adminApiUrl,
    eventsUrl,
    dashboardUrl: (argValue(argv, "--dashboard-url") || env("FLAGSMITH_DASHBOARD_URL", "http://127.0.0.1:8000")).replace(/\/$/, ""),
    environmentKey: env("FLAGSMITH_ENVIRONMENT_KEY"),
    serverKey: env("FLAGSMITH_SERVER_KEY"),
    adminToken: env("FLAGSMITH_ADMIN_API_TOKEN") || env("FLAGSMITH_API_KEY"),
    projectId: env("FLAGSMITH_PROJECT_ID"),
    organisationId: env("FLAGSMITH_ORGANISATION_ID"),
    environmentId: env("FLAGSMITH_ENVIRONMENT_ID"),
  };
}

export { REPO_ROOT };
