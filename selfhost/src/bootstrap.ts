import { chmodSync, writeFileSync } from "node:fs";
import { AdminHttp, listResults } from "./http.ts";
import {
  composeLocalEnv,
  envLinesForWrite,
  generateBootstrapPassword,
  rootEnvHoldsNonLocalApiUrl,
  upsertEnvFile,
  type SelfhostEnv,
} from "./env.ts";
import { ENV_FILE, FLAGSMITH_ENV_FILE, FLAGSMITH_JSON, PROOF_LOG, ROOT_ENV_FILE, STATE_FILE } from "./paths.ts";
import { redactSecrets } from "./redact.ts";
import { writeSiteConfigForSelfhost } from "./site-config.ts";

const COMPOSE_ORIGIN = "http://127.0.0.1:8000";

export interface BootstrapResult {
  ok: boolean;
  origin: string;
  version?: unknown;
  health?: { url: string; status: number };
  organisationId?: number;
  projectId?: number;
  environmentId?: number;
  environmentName?: string;
  warehouse?: unknown;
  flag?: string;
  wroteEnv: string[];
  generatedPassword: boolean;
  reusedAdminToken: boolean;
  reason?: string;
}

interface User {
  id: number;
  email: string;
}

function publicHttp(origin: string): AdminHttp {
  return new AdminHttp(`${origin.replace(/\/+$/, "")}/api/v1/`, "");
}

function authed(origin: string, token: string): AdminHttp {
  return new AdminHttp(`${origin.replace(/\/+$/, "")}/api/v1/`, token);
}

function sessionHttp(origin: string, token: string): AdminHttp {
  return new AdminHttp(`${origin.replace(/\/+$/, "")}/api/v1/`, token, fetch, "Token");
}

async function login(origin: string, email: string, password: string): Promise<string> {
  const data = await publicHttp(origin).post<{ key?: string }>("/auth/login/", { email, password });
  if (!data.key) throw new Error("Login did not return a session key");
  return data.key;
}

async function register(
  origin: string,
  cfg: SelfhostEnv,
): Promise<{ token: string; user: User }> {
  const data = await publicHttp(origin).post<{ key?: string; user?: User }>("/auth/users/", {
    email: cfg.bootstrapEmail,
    password: cfg.bootstrapPassword,
    first_name: cfg.bootstrapFirstName,
    last_name: cfg.bootstrapLastName,
  });
  if (data.key && data.user) return { token: data.key, user: data.user };
  const token = await login(origin, cfg.bootstrapEmail, cfg.bootstrapPassword);
  const me = await sessionHttp(origin, token).get<User>("/auth/users/me/");
  return { token, user: me };
}

async function ensureOrg(origin: string, token: string, name: string): Promise<number> {
  const existing = listResults<{ id: number; name: string }>(
    await sessionHttp(origin, token).get("/organisations/"),
  );
  const match = existing.find((row) => row.name === name);
  if (match) return match.id;
  const created = await sessionHttp(origin, token).post<{ id: number }>("/organisations/", { name });
  return created.id;
}

async function ensureProject(
  origin: string,
  token: string,
  organisation: number,
  name: string,
): Promise<number> {
  const existing = listResults<{ id: number; name: string }>(
    await sessionHttp(origin, token).get(`/projects/?organisation=${organisation}`),
  );
  const match = existing.find((row) => row.name === name);
  if (match) return match.id;
  const created = await sessionHttp(origin, token).post<{ id: number }>("/projects/", {
    name,
    organisation,
  });
  return created.id;
}

async function ensureEnvironment(
  origin: string,
  token: string,
  project: number,
  name: string,
): Promise<{ id: number; api_key: string; name: string }> {
  const existing = listResults<{ id: number; name: string; api_key: string }>(
    await sessionHttp(origin, token).get(`/environments/?project=${project}`),
  );
  const match = existing.find((row) => row.name === name);
  if (match) return match;
  return sessionHttp(origin, token).post(`/environments/`, { name, project });
}

async function tokenStillValid(origin: string, token: string): Promise<boolean> {
  if (!token) return false;
  try {
    await authed(origin, token).get("/organisations/");
    return true;
  } catch {
    return false;
  }
}

const MASTER_KEY_NAME = "Lift self-host";

async function ensureMasterKey(
  origin: string,
  session: string,
  organisation: number,
  existingToken: string,
): Promise<{ token: string; reused: boolean }> {
  if (await tokenStillValid(origin, existingToken)) {
    return { token: existingToken, reused: true };
  }
  const listed = listResults<{ id: number; name: string; revoked?: boolean }>(
    await sessionHttp(origin, session).get(`/organisations/${organisation}/master-api-keys/`),
  );
  for (const key of listed) {
    if (key.name !== MASTER_KEY_NAME || key.revoked) continue;
    try {
      await sessionHttp(origin, session).put(
        `/organisations/${organisation}/master-api-keys/${key.id}/`,
        { name: MASTER_KEY_NAME, organisation, revoked: true, is_admin: true },
      );
    } catch {
      await sessionHttp(origin, session).delete(
        `/organisations/${organisation}/master-api-keys/${key.id}/`,
      );
    }
  }
  const created = await sessionHttp(origin, session).post<{ key?: string }>(
    `/organisations/${organisation}/master-api-keys/`,
    {
      name: MASTER_KEY_NAME,
      organisation,
      revoked: false,
      is_admin: true,
    },
  );
  if (!created.key) throw new Error("Master API key create did not return key");
  return { token: created.key, reused: false };
}

async function serverKeyUsable(origin: string, key: string): Promise<boolean> {
  if (!key) return false;
  try {
    const res = await fetch(`${origin.replace(/\/+$/, "")}/api/v1/environment-document/`, {
      headers: { "X-Environment-Key": key, Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function serverSideKey(
  origin: string,
  adminToken: string,
  envKey: string,
  existing: string,
): Promise<string> {
  if (await serverKeyUsable(origin, existing)) return existing;
  const created = await authed(origin, adminToken).post<{ key?: string }>(
    `/environments/${envKey}/api-keys/`,
    { name: "Lift server key" },
  );
  if (!created.key) throw new Error("server-side API key create did not return key");
  return created.key;
}

async function ensureWarehouse(origin: string, admin: AdminHttp, envKey: string) {
  const listed = listResults<Record<string, unknown>>(
    await admin.get(`/environments/${envKey}/warehouse-connections/`),
  );
  if (listed[0]) return listed[0];
  return admin.post(`/environments/${envKey}/warehouse-connections/`, {
    name: "Lift postgres warehouse",
    warehouse_type: "postgres",
    config: { source: "flagsmith_database" },
  });
}

async function ensureDemoSegment(admin: AdminHttp, projectId: number) {
  const listed = listResults<{ id: number; name: string }>(
    await admin.get(`/projects/${projectId}/segments/`),
  );
  const matches = listed.filter((row) => row.name === "lift-demo-site");
  for (const extra of matches.slice(1)) {
    try {
      await admin.delete(`/projects/${projectId}/segments/${extra.id}/`);
    } catch {
      /* leftover duplicate */
    }
  }
  if (matches[0]) return;
  await admin.post(`/projects/${projectId}/segments/`, {
    name: "lift-demo-site",
    description: "Identities with site=checkout",
    project: projectId,
    rules: [
      {
        type: "ALL",
        rules: [
          {
            type: "ANY",
            rules: [],
            conditions: [{ operator: "EQUAL", property: "site", value: "checkout" }],
          },
        ],
        conditions: [],
      },
    ],
  });
}

async function ensureCheckoutFlag(origin: string, admin: AdminHttp, projectId: number) {
  const existing = listResults<{ id: number; name: string }>(
    await admin.get(`/projects/${projectId}/features/?search=checkout_a11y`),
  );
  if (existing.find((f) => f.name === "checkout_a11y")) return;
  await admin.post(`/projects/${projectId}/features/`, {
    name: "checkout_a11y",
    default_enabled: true,
    initial_value: "control",
    description: "Checkout a11y experiment (self-host demo)",
    type: "MULTIVARIATE",
    multivariate_options: [
      {
        type: "unicode",
        string_value: "treatment",
        default_percentage_allocation: 0,
        key: "treatment",
      },
    ],
  });
}

export interface BootstrapOptions {
  writeRootEnv?: boolean;
  origin?: string;
  envFile?: string;
  persistSharedState?: boolean;
  freshInstance?: boolean;
}

export async function bootstrapSelfhost(
  cfg: SelfhostEnv = composeLocalEnv(),
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const origin = options.origin ?? COMPOSE_ORIGIN;
  const envFile = options.envFile ?? ENV_FILE;
  const persistSharedState = options.persistSharedState !== false;
  const healthUrl = `${origin}/health/liveness/`;
  let healthRes: Response;
  try {
    healthRes = await fetch(healthUrl);
  } catch (err) {
    return {
      ok: false,
      origin,
      wroteEnv: [],
      generatedPassword: false,
      reusedAdminToken: false,
      health: { url: healthUrl, status: 0 },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!healthRes.ok) {
    return {
      ok: false,
      origin,
      wroteEnv: [],
      generatedPassword: false,
      reusedAdminToken: false,
      health: { url: healthUrl, status: healthRes.status },
      reason: `health check ${healthRes.status}`,
    };
  }
  const version = await fetch(`${origin}/version/`).then((r) => r.json() as Promise<unknown>);

  let generatedPassword = false;
  if (!cfg.bootstrapPassword) {
    cfg = { ...cfg, bootstrapPassword: generateBootstrapPassword() };
    generatedPassword = true;
  }
  upsertEnvFile(envFile, {
    FLAGSMITH_BOOTSTRAP_EMAIL: cfg.bootstrapEmail,
    FLAGSMITH_BOOTSTRAP_PASSWORD: cfg.bootstrapPassword,
  });

  let session: string;
  process.stderr.write(`bootstrap health ${healthRes.status} ${origin}\n`);
  if (options.freshInstance) {
    cfg = { ...cfg, serverKey: "", adminToken: "", environmentKey: "" };
    process.stderr.write("bootstrap register (fresh instance, empty SDK keys)\n");
    session = (await register(origin, cfg)).token;
  } else {
    try {
      session = await login(origin, cfg.bootstrapEmail, cfg.bootstrapPassword);
    } catch {
      try {
        session = (await register(origin, cfg)).token;
      } catch {
        session = await login(origin, cfg.bootstrapEmail, cfg.bootstrapPassword);
      }
    }
  }

  const organisationId = await ensureOrg(origin, session, cfg.orgName);
  process.stderr.write(`bootstrap org id=${organisationId}\n`);
  const projectId = await ensureProject(origin, session, organisationId, cfg.projectName);
  process.stderr.write(`bootstrap project id=${projectId}\n`);
  const environment = await ensureEnvironment(origin, session, projectId, cfg.environmentName);
  process.stderr.write(`bootstrap environment id=${environment.id}\n`);
  const master = await ensureMasterKey(origin, session, organisationId, cfg.adminToken);
  const admin = authed(origin, master.token);
  const serverKey = await serverSideKey(origin, master.token, environment.api_key, cfg.serverKey);
  const warehouse = await ensureWarehouse(origin, admin, environment.api_key);
  await ensureCheckoutFlag(origin, admin, projectId);
  await ensureDemoSegment(admin, projectId);

  const next: SelfhostEnv = {
    ...cfg,
    apiUrl: `${origin}/api/v1/`,
    adminApiUrl: `${origin}/api/v1/`,
    eventsUrl: `${origin}/api/`,
    dashboardUrl: origin,
    cliApiUrl: origin,
    environmentKey: environment.api_key,
    serverKey,
    adminToken: master.token,
    organisationId: String(organisationId),
    projectId: String(projectId),
    environmentId: String(environment.id),
    environmentName: environment.name,
  };

  const lines = envLinesForWrite(next);
  upsertEnvFile(envFile, lines);
  const wroteEnv = [envFile];
  if (persistSharedState) {
    writeFileSync(FLAGSMITH_ENV_FILE, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", {
      mode: 0o600,
    });
    chmodSync(FLAGSMITH_ENV_FILE, 0o600);
    writeFileSync(FLAGSMITH_JSON, `${JSON.stringify(publicIds(next), null, 2)}\n`);
    writeFileSync(STATE_FILE, `${JSON.stringify(publicIds(next), null, 2)}\n`);
    writeSiteConfigForSelfhost(next);
  }

  if (options.writeRootEnv) {
    if (rootEnvHoldsNonLocalApiUrl()) {
      process.stderr.write(
        "Skipping root .env: FLAGSMITH_API_URL is not loopback. Pass a local URL or omit --write-root-env.\n",
      );
    } else {
      upsertEnvFile(ROOT_ENV_FILE, lines);
      wroteEnv.push(ROOT_ENV_FILE);
    }
  }

  const proof: BootstrapResult = {
    ok: true,
    origin,
    version,
    health: { url: healthUrl, status: healthRes.status },
    organisationId,
    projectId,
    environmentId: environment.id,
    environmentName: environment.name,
    warehouse,
    flag: "checkout_a11y",
    wroteEnv,
    generatedPassword,
    reusedAdminToken: master.reused,
  };
  if (persistSharedState) {
    writeFileSync(PROOF_LOG, `${redactSecrets(JSON.stringify(proof, null, 2))}\n`);
  }
  return proof;
}

function publicIds(env: SelfhostEnv) {
  return {
    organisationId: env.organisationId,
    projectId: env.projectId,
    environmentId: env.environmentId,
    environmentName: env.environmentName,
    apiUrl: env.apiUrl,
  };
}
