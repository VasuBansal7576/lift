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
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  dashboardUrl: string;
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

export function originFromApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  return `${url.protocol}//${url.host}`;
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function upsertEnvFile(path: string, values: Record<string, string>): void {
  let existing = "";
  if (existsSync(path)) existing = readFileSync(path, "utf8");
  const lines = existing.split("\n");
  const pending = new Map(Object.entries(values));
  const out: string[] = [];
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match && pending.has(match[1])) {
      out.push(`${match[1]}=${pending.get(match[1])}`);
      pending.delete(match[1]);
    } else if (line.length > 0 || out.length > 0) {
      out.push(line);
    }
  }
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  writeFileSync(path, `${out.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function randomBootstrapPassword(): string {
  return `lift-${randomBytes(12).toString("base64url")}`;
}

async function jsonRequest<T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
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
      `${method} ${url} -> ${res.status}: ${text.slice(0, 800)}`,
      res.status,
      text,
    );
  }
  return { status: res.status, data };
}

async function userRequest<T>(
  origin: string,
  userToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { data } = await jsonRequest<T>(
    `${origin.replace(/\/+$/, "")}/api/v1${path.startsWith("/") ? path : `/${path}`}`,
    method,
    userToken ? { Authorization: `Token ${userToken}` } : {},
    body,
  );
  return data;
}

interface AuthKey {
  key?: string;
}

interface InstanceIds {
  token: string;
  projectId: string;
  environmentId: string;
  environmentKey: string;
  orgId: string;
}

async function createOrLoginUser(origin: string, email: string, password: string): Promise<string> {
  try {
    const data = await userRequest<AuthKey>(origin, "", "POST", "/auth/users/", {
      email,
      password,
      re_password: password,
      first_name: "Lift",
      last_name: "Admin",
    });
    if (!data.key) throw new L3BootstrapError("Flagsmith signup did not return an auth token");
    return data.key;
  } catch (err) {
    if (!(err instanceof L3BootstrapError) || (err.status !== 400 && err.status !== 409)) {
      throw err;
    }
    const data = await userRequest<AuthKey>(origin, "", "POST", "/auth/login/", {
      email,
      password,
    });
    if (!data.key) throw new L3BootstrapError("Flagsmith login did not return an auth token");
    return data.key;
  }
}

async function ensureOrg(
  origin: string,
  userToken: string,
  name: string,
): Promise<NamedRecord> {
  const listed = await userRequest<unknown>(origin, userToken, "GET", "/organisations/");
  const match = listResults<NamedRecord>(listed).find((row) => row.name === name);
  if (match) return match;
  return userRequest<NamedRecord>(origin, userToken, "POST", "/organisations/", { name });
}

async function ensureProject(
  origin: string,
  userToken: string,
  orgId: number,
  name: string,
): Promise<NamedRecord> {
  const listed = await userRequest<unknown>(
    origin,
    userToken,
    "GET",
    `/projects/?organisation=${orgId}`,
  );
  const match = listResults<NamedRecord>(listed).find((row) => row.name === name);
  if (match) return match;
  return userRequest<NamedRecord>(origin, userToken, "POST", "/projects/", {
    name,
    organisation: orgId,
  });
}

async function ensureEnvironment(
  origin: string,
  userToken: string,
  projectId: string,
  name: string,
): Promise<NamedRecord> {
  const listed = await userRequest<unknown>(
    origin,
    userToken,
    "GET",
    `/projects/${projectId}/environments/`,
  );
  const match = listResults<NamedRecord>(listed).find((row) => row.name === name);
  if (match) return match;
  return userRequest<NamedRecord>(origin, userToken, "POST", "/environments/", {
    name,
    project: Number(projectId),
  });
}

async function ensureMasterKey(origin: string, userToken: string, orgId: number): Promise<string> {
  const data = await userRequest<AuthKey>(
    origin,
    userToken,
    "POST",
    `/organisations/${orgId}/master-api-keys/`,
    {
      name: "lift-l3-admin",
      organisation: orgId,
      is_admin: true,
      revoked: false,
    },
  );
  if (!data.key) throw new L3BootstrapError("Flagsmith did not return a master API key");
  return data.key;
}

async function ensureInstance(apiUrl: string): Promise<InstanceIds> {
  const origin = originFromApiUrl(apiUrl);
  let token = env("FLAGSMITH_ADMIN_API_TOKEN");
  let projectId = env("FLAGSMITH_PROJECT_ID");
  let environmentId = env("FLAGSMITH_ENVIRONMENT_ID");
  let environmentKey = env("FLAGSMITH_ENVIRONMENT_KEY");
  let orgId = env("FLAGSMITH_ORG_ID");

  if (token && projectId && environmentKey) {
    return { token, projectId, environmentId, environmentKey, orgId };
  }

  const email = env("FLAGSMITH_BOOTSTRAP_EMAIL", "admin@lift.local");
  const password = env("FLAGSMITH_BOOTSTRAP_PASSWORD") || randomBootstrapPassword();
  const userToken = await createOrLoginUser(origin, email, password);
  const org = await ensureOrg(origin, userToken, env("FLAGSMITH_ORG_NAME", "Lift"));
  const project = await ensureProject(
    origin,
    userToken,
    Number(org.id),
    env("FLAGSMITH_PROJECT_NAME", "Lift"),
  );
  const environment = await ensureEnvironment(
    origin,
    userToken,
    String(project.id),
    env("FLAGSMITH_ENVIRONMENT_NAME", "Development"),
  );
  if (!token) token = await ensureMasterKey(origin, userToken, Number(org.id));
  projectId = String(project.id);
  environmentId = String(environment.id);
  environmentKey = environment.api_key ?? environmentKey;
  orgId = String(org.id);
  if (!environmentKey) throw new L3BootstrapError("Flagsmith environment did not return an api_key");

  upsertEnvFile(resolve(ROOT, ".env"), {
    FLAGSMITH_API_URL: apiUrl,
    FLAGSMITH_ADMIN_API_URL: `${origin}/api/v1/`,
    FLAGSMITH_BOOTSTRAP_EMAIL: email,
    FLAGSMITH_BOOTSTRAP_PASSWORD: password,
    FLAGSMITH_ADMIN_API_TOKEN: token,
    FLAGSMITH_PROJECT_ID: projectId,
    FLAGSMITH_ENVIRONMENT_ID: environmentId,
    FLAGSMITH_ENVIRONMENT_KEY: environmentKey,
    FLAGSMITH_ENVIRONMENT_NAME: environment.name || "Development",
    FLAGSMITH_ORG_ID: orgId,
  });

  return { token, projectId, environmentId, environmentKey, orgId };
}

function writeStateFile(state: {
  dashboardUrl: string;
  projectId: string;
  environmentId: string;
  environmentUuid?: string;
  segmentId: number;
  flagId: number;
  orgId: string;
}): void {
  const dir = resolve(ROOT, "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "l3-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function resolveL3ApiUrl(override = ""): string {
  const raw =
    override ||
    env("FLAGSMITH_ADMIN_API_URL") ||
    env("FLAGSMITH_API_URL") ||
    DEFAULT_L3_API_URL;
  return raw.replace(/\/?$/, "/");
}

export function collectSegmentProperties(rules: unknown, out: string[] = []): string[] {
  if (rules == null) return out;
  const list = Array.isArray(rules) ? rules : [rules];
  for (const rule of list) {
    if (!rule || typeof rule !== "object") continue;
    const node = rule as { property?: unknown; conditions?: unknown; rules?: unknown };
    if (typeof node.property === "string" && node.property) out.push(node.property);
    collectSegmentProperties(node.conditions, out);
    collectSegmentProperties(node.rules, out);
  }
  return out;
}

export function segmentUsesTrait(segment: unknown, traitName = L3_TRAIT_NAME): boolean {
  const rules =
    segment && typeof segment === "object" && "rules" in segment
      ? (segment as { rules?: unknown }).rules
      : undefined;
  const props = collectSegmentProperties(rules);
  if (props.includes("is_sensory_safe")) return false;
  return props.length > 0 && props.every((property) => property === traitName);
}

export function segmentCreatePayload(projectId: number | string) {
  return {
    name: L3_SEGMENT_NAME,
    description:
      "Lift L3 Sensory-Safe: identities whose overstimulated trait is true. Evaluated by Flagsmith, not by the page. Rule: overstimulated Exactly Matches true.",
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
  const jsonValue = JSON.stringify(L3_FLAG_CONFIG);
  return {
    environment_default: {
      enabled: false,
      value: { type: "string", value: jsonValue },
    },
    segment_overrides: [
      {
        segment: { id: segmentId },
        enabled: true,
        priority: 0,
        value: { type: "string", value: jsonValue },
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
  uuid?: string;
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

async function listNamedSegments(
  apiUrl: string,
  token: string,
  projectId: string,
): Promise<NamedRecord[]> {
  const searched = await adminRequest<unknown>(
    apiUrl,
    token,
    "GET",
    `/projects/${projectId}/segments/?search=${encodeURIComponent(L3_SEGMENT_NAME)}`,
  );
  const listed = await adminRequest<unknown>(
    apiUrl,
    token,
    "GET",
    `/segments/?project=${encodeURIComponent(projectId)}`,
  );
  const rows = [...listResults<NamedRecord>(searched.data), ...listResults<NamedRecord>(listed.data)];
  const seen = new Set<number>();
  const matches: NamedRecord[] = [];
  for (const row of rows) {
    if (row.name !== L3_SEGMENT_NAME || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    matches.push(row);
  }
  return matches;
}

async function writeSegmentRules(
  apiUrl: string,
  token: string,
  projectId: string,
  segmentId: number,
): Promise<NamedRecord> {
  const payload = { ...segmentCreatePayload(projectId), id: segmentId };
  const { data } = await adminRequest<NamedRecord>(
    apiUrl,
    token,
    "PUT",
    `/projects/${projectId}/segments/${segmentId}/`,
    payload,
  );
  return data;
}

async function ensureSegment(
  apiUrl: string,
  token: string,
  projectId: string,
): Promise<NamedRecord> {
  const existing = await listNamedSegments(apiUrl, token, projectId);
  if (existing.length === 0) {
    const { data } = await adminRequest<NamedRecord>(
      apiUrl,
      token,
      "POST",
      `/projects/${projectId}/segments/`,
      segmentCreatePayload(projectId),
    );
    return data;
  }
  const first = existing[0];
  if (!first) {
    throw new L3BootstrapError("Segment list was empty after lookup");
  }
  let chosen = first;
  for (const row of existing) {
    chosen = await writeSegmentRules(apiUrl, token, projectId, row.id);
  }
  return chosen;
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
  const value = {
    type: "unicode",
    string_value: JSON.stringify(L3_FLAG_CONFIG),
  };
  if (!match) {
    await adminRequest(apiUrl, token, "POST", "/features/featurestates/", {
      enabled: true,
      feature: featureId,
      environment: Number(environmentId),
      feature_segment: featureSegmentId,
      feature_state_value: value,
    });
    return true;
  }
  await adminRequest(apiUrl, token, "PATCH", `/features/featurestates/${match.id}/`, {
    enabled: true,
    feature_state_value: value,
  });
  return true;
}

export function writeDemoConfig(
  environmentKey: string,
  apiUrl: string,
  allowRemote = false,
): void {
  const dir = resolve(ROOT, "demo/l3");
  mkdirSync(dir, { recursive: true });
  const sdkApi = apiUrl.replace(/\/?$/, "/");
  assertLoopback(sdkApi, allowRemote);
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

  let token = env("FLAGSMITH_ADMIN_API_TOKEN");
  let projectId = env("FLAGSMITH_PROJECT_ID");
  let environmentKey = env("FLAGSMITH_ENVIRONMENT_KEY");
  let environmentId = env("FLAGSMITH_ENVIRONMENT_ID");
  const environmentName = env("FLAGSMITH_ENVIRONMENT_NAME", "Development");

  const dashboardUrl = originFromApiUrl(apiUrl);

  if (args.dryRun) {
    return {
      apiUrl,
      dashboardUrl,
      projectId: projectId || "(dry-run)",
      environmentId: environmentId || "(dry-run)",
      environmentKey: environmentKey || "(dry-run)",
      segmentId: 0,
      flagId: 0,
      overrideApplied: false,
      dryRun: true,
    };
  }

  const instance = await ensureInstance(apiUrl);
  token = instance.token;
  projectId = instance.projectId;
  environmentKey = instance.environmentKey || environmentKey;
  if (instance.environmentId) environmentId = instance.environmentId;

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

  if (environmentKey) writeDemoConfig(environmentKey, apiUrl, args.allowRemote);
  let environmentUuid = "";
  try {
    const { data: envList } = await adminRequest<unknown>(
      apiUrl,
      token,
      "GET",
      `/projects/${projectId}/environments/`,
    );
    const envMatch = listResults<NamedRecord>(envList).find(
      (item) => String(item.id) === String(environmentId),
    );
    environmentUuid = envMatch?.uuid ?? "";
  } catch {
    environmentUuid = "";
  }
  writeStateFile({
    dashboardUrl,
    projectId,
    environmentId,
    environmentUuid,
    segmentId: segment.id,
    flagId: flag.id,
    orgId: instance.orgId,
  });

  return {
    apiUrl,
    dashboardUrl,
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
  const publicResult = {
    apiUrl: result.apiUrl,
    dashboardUrl: result.dashboardUrl,
    projectId: result.projectId,
    environmentId: result.environmentId,
    environmentKey: maskSecret(result.environmentKey),
    segmentId: result.segmentId,
    flagId: result.flagId,
    overrideApplied: result.overrideApplied,
    dryRun: result.dryRun,
  };
  process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
