/**
 * Idempotent Flagsmith Admin API bootstrap for Lift Layer 3.
 *
 * Creates:
 *   - STANDARD flag `l3_sensory_safe` (default OFF, JSON config value)
 *   - segment `sensory_safe` with rule overstimulated == true
 *   - segment override that enables the flag for that segment
 *
 * Loopback only (127.0.0.1 / localhost / ::1) unless --allow-remote.
 * Reads FLAGSMITH_API_URL and FLAGSMITH_ADMIN_API_TOKEN from a gitignored .env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  L3_FLAG_CONFIG,
  L3_FLAG_NAME,
  L3_SEGMENT_NAME,
  L3_TRAIT_NAME,
} from "../shared/l3-constants.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(ROOT, ".env") });

export const DEFAULT_L3_API_URL = "http://127.0.0.1:8000/api/v1/";

export interface L3BootstrapArgs {
  allowRemote: boolean;
  dryRun: boolean;
  apiUrl: string;
}

export interface L3BootstrapResult {
  apiUrl: string;
  projectId: string;
  environmentId: string;
  environmentKey: string;
  segmentId: number;
  flagId: number;
  overrideApplied: boolean;
  dryRun: boolean;
}

export class L3BootstrapError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly body = "",
  ) {
    super(message);
  }
}

export function parseL3Args(argv: string[]): L3BootstrapArgs {
  const allowRemote = argv.includes("--allow-remote");
  const dryRun = argv.includes("--dry-run");
  const apiIdx = argv.indexOf("--api-url");
  const apiUrl = (apiIdx >= 0 ? argv[apiIdx + 1] : "").trim();
  return { allowRemote, dryRun, apiUrl };
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function assertLoopback(url: string, allowRemote: boolean): void {
  if (allowRemote) return;
  if (!isLoopbackUrl(url)) {
    throw new L3BootstrapError(
      `L3 bootstrap is loopback-only (got ${url}). Pass --allow-remote to target a non-local Flagsmith.`,
    );
  }
}

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export function resolveL3ApiUrl(override = ""): string {
  const raw =
    override ||
    env("FLAGSMITH_ADMIN_API_URL") ||
    env("FLAGSMITH_API_URL") ||
    DEFAULT_L3_API_URL;
  return raw.replace(/\/?$/, "/");
}

export function segmentCreatePayload(projectId: number | string) {
  return {
    name: L3_SEGMENT_NAME,
    description:
      "Lift L3 Sensory-Safe: identities whose overstimulated trait is true. Evaluated by Flagsmith, not by the page.",
    project: Number(projectId),
    rules: [
      {
        type: "ALL",
        rules: [
          {
            type: "ANY",
            rules: [],
            conditions: [
              {
                operator: "EQUAL",
                property: L3_TRAIT_NAME,
                value: "true",
              },
            ],
          },
        ],
        conditions: [],
      },
    ],
  };
}

export function flagCreatePayload() {
  return {
    name: L3_FLAG_NAME,
    type: "STANDARD",
    default_enabled: false,
    initial_value: JSON.stringify(L3_FLAG_CONFIG),
    description:
      "Lift L3 Sensory-Safe mode. Default off. Enabled only via the sensory_safe segment override.",
  };
}

export function segmentOverridePatch(segmentId: number) {
  return {
    environment_default: {
      enabled: false,
      value: { type: "unicode", value: JSON.stringify(L3_FLAG_CONFIG) },
    },
    segment_overrides: [
      {
        segment: { id: segmentId },
        enabled: true,
        priority: 0,
        value: { type: "unicode", value: JSON.stringify(L3_FLAG_CONFIG) },
      },
    ],
  };
}

function listResults<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "results" in payload) {
    const results = (payload as { results: unknown }).results;
    if (Array.isArray(results)) return results as T[];
  }
  return [];
}

async function adminRequest<T>(
  apiUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const base = apiUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${base}${suffix}`, {
    method,
    headers: {
      Authorization: `Api-Key ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: T = null as T;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = text as T;
    }
  }
  if (!res.ok) {
    throw new L3BootstrapError(
      `${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`,
      res.status,
      text,
    );
  }
  return { status: res.status, data };
}

interface NamedRecord {
  id: number;
  name?: string;
  api_key?: string;
}

async function findNamed(
  apiUrl: string,
  token: string,
  path: string,
  name: string,
): Promise<NamedRecord | null> {
  const { data } = await adminRequest<unknown>(apiUrl, token, "GET", path);
  return listResults<NamedRecord>(data).find((row) => row.name === name) ?? null;
}

async function ensureSegment(
  apiUrl: string,
  token: string,
  projectId: string,
): Promise<NamedRecord> {
  const existing =
    (await findNamed(
      apiUrl,
      token,
      `/projects/${projectId}/segments/?search=${encodeURIComponent(L3_SEGMENT_NAME)}`,
      L3_SEGMENT_NAME,
    )) ??
    (await findNamed(
      apiUrl,
      token,
      `/segments/?project=${encodeURIComponent(projectId)}`,
      L3_SEGMENT_NAME,
    ));
  if (existing) return existing;

  const { data } = await adminRequest<NamedRecord>(
    apiUrl,
    token,
    "POST",
    `/projects/${projectId}/segments/`,
    segmentCreatePayload(projectId),
  );
  return data;
}

async function ensureFlag(
  apiUrl: string,
  token: string,
  projectId: string,
): Promise<NamedRecord> {
  const existing = await findNamed(
    apiUrl,
    token,
    `/projects/${projectId}/features/?search=${encodeURIComponent(L3_FLAG_NAME)}`,
    L3_FLAG_NAME,
  );
  if (existing) return existing;
  const { data } = await adminRequest<NamedRecord>(
    apiUrl,
    token,
    "POST",
    `/projects/${projectId}/features/`,
    flagCreatePayload(),
  );
  return data;
}

function futureFeatureUrl(apiUrl: string, envKey: string, featureId: number): string {
  const v1 = apiUrl.replace(/\/+$/, "");
  const apiRoot = v1.replace(/\/v1$/i, "");
  return `${apiRoot}/__future__/environments/${encodeURIComponent(envKey)}/features/${featureId}/`;
}

async function applyOverrideFuture(
  apiUrl: string,
  token: string,
  envKey: string,
  featureId: number,
  segmentId: number,
): Promise<boolean> {
  const url = futureFeatureUrl(apiUrl, envKey, featureId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Api-Key ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(segmentOverridePatch(segmentId)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new L3BootstrapError(
      `PATCH future feature ${featureId} -> ${res.status}: ${text.slice(0, 800)}`,
      res.status,
      text,
    );
  }
  return true;
}

async function applyOverrideClassic(
  apiUrl: string,
  token: string,
  environmentId: string,
  featureId: number,
  segmentId: number,
): Promise<boolean> {
  const { data: existing } = await adminRequest<unknown>(
    apiUrl,
    token,
    "GET",
    `/features/feature-segments/?environment=${encodeURIComponent(environmentId)}&feature=${featureId}`,
  );
  const rows = listResults<{ id: number; segment: number }>(existing);
  let featureSegmentId = rows.find((row) => row.segment === segmentId)?.id;
  if (!featureSegmentId) {
    const created = await adminRequest<{ id: number }>(
      apiUrl,
      token,
      "POST",
      "/features/feature-segments/",
      {
        feature: featureId,
        segment: segmentId,
        environment: Number(environmentId),
        priority: 0,
      },
    );
    featureSegmentId = created.data.id;
  }

  const { data: states } = await adminRequest<unknown>(
    apiUrl,
    token,
    "GET",
    `/features/featurestates/?environment=${encodeURIComponent(environmentId)}&feature=${featureId}`,
  );
  const stateRows = listResults<{
    id: number;
    feature_segment?: number | { id: number } | null;
  }>(states);
  const match = stateRows.find((row) => {
    const fs = row.feature_segment;
    const id = typeof fs === "number" ? fs : fs?.id;
    return id === featureSegmentId;
  });
  if (!match) {
    throw new L3BootstrapError("Feature state for the sensory_safe override was not created");
  }
  await adminRequest(apiUrl, token, "PATCH", `/features/featurestates/${match.id}/`, {
    enabled: true,
    feature_state_value: {
      type: "unicode",
      string_value: JSON.stringify(L3_FLAG_CONFIG),
    },
  });
  return true;
}

function writeDemoConfig(environmentKey: string, apiUrl: string): void {
  const dir = resolve(ROOT, "demo/l3");
  mkdirSync(dir, { recursive: true });
  const sdkApi = env("FLAGSMITH_API_URL", apiUrl).replace(/\/?$/, "/");
  writeFileSync(
    resolve(dir, "config.json"),
    `${JSON.stringify(
      {
        site: "l3",
        flagsmithApiUrl: sdkApi,
        flagsmithEnvironmentKey: environmentKey,
        flagName: L3_FLAG_NAME,
        segmentName: L3_SEGMENT_NAME,
        traitName: L3_TRAIT_NAME,
      },
      null,
      2,
    )}\n`,
  );
}

export async function bootstrapL3(
  args: L3BootstrapArgs = parseL3Args(process.argv.slice(2)),
): Promise<L3BootstrapResult> {
  const apiUrl = resolveL3ApiUrl(args.apiUrl);
  assertLoopback(apiUrl, args.allowRemote);

  const token = env("FLAGSMITH_ADMIN_API_TOKEN");
  const projectId = env("FLAGSMITH_PROJECT_ID");
  const environmentKey = env("FLAGSMITH_ENVIRONMENT_KEY");
  let environmentId = env("FLAGSMITH_ENVIRONMENT_ID");
  const environmentName = env("FLAGSMITH_ENVIRONMENT_NAME", "Development");

  if (args.dryRun) {
    return {
      apiUrl,
      projectId: projectId || "(dry-run)",
      environmentId: environmentId || "(dry-run)",
      environmentKey: environmentKey || "(dry-run)",
      segmentId: 0,
      flagId: 0,
      overrideApplied: false,
      dryRun: true,
    };
  }

  if (!token) {
    throw new L3BootstrapError(
      "FLAGSMITH_ADMIN_API_TOKEN is required (from gitignored .env). Never commit this token.",
    );
  }
  if (!projectId) {
    throw new L3BootstrapError("FLAGSMITH_PROJECT_ID is required.");
  }

  if (!environmentId) {
    const { data } = await adminRequest<unknown>(
      apiUrl,
      token,
      "GET",
      `/projects/${projectId}/environments/`,
    );
    const envs = listResults<NamedRecord>(data);
    const match =
      (environmentKey ? envs.find((item) => item.api_key === environmentKey) : undefined) ??
      envs.find((item) => item.name === environmentName) ??
      envs[0];
    if (!match) throw new L3BootstrapError("No Flagsmith environment found");
    environmentId = String(match.id);
  }

  const segment = await ensureSegment(apiUrl, token, projectId);
  const flag = await ensureFlag(apiUrl, token, projectId);
  if (!segment.id || !flag.id) {
    throw new L3BootstrapError("Flagsmith did not return segment or flag ids");
  }

  let overrideApplied = false;
  if (environmentKey) {
    try {
      overrideApplied = await applyOverrideFuture(
        apiUrl,
        token,
        environmentKey,
        flag.id,
        segment.id,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Future segment override failed (${detail.slice(0, 180)}); trying classic API.\n`);
    }
  }
  if (!overrideApplied) {
    overrideApplied = await applyOverrideClassic(
      apiUrl,
      token,
      environmentId,
      flag.id,
      segment.id,
    );
  }

  if (environmentKey) writeDemoConfig(environmentKey, apiUrl);

  return {
    apiUrl,
    projectId,
    environmentId,
    environmentKey,
    segmentId: segment.id,
    flagId: flag.id,
    overrideApplied,
    dryRun: false,
  };
}

async function main() {
  const args = parseL3Args(process.argv.slice(2));
  if (args.dryRun) {
    const apiUrl = resolveL3ApiUrl(args.apiUrl);
    assertLoopback(apiUrl, args.allowRemote);
    const payload = {
      apiUrl,
      segment: segmentCreatePayload(env("FLAGSMITH_PROJECT_ID") || "0"),
      flag: flagCreatePayload(),
      override: segmentOverridePatch(0),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const result = await bootstrapL3(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
