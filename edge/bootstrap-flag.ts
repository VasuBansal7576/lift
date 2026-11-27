/**
 * Bootstrap a self-hosted Flagsmith (Track 3) with a multivariate flag whose
 * treatment value is the checkout spec id. Control has no spec.
 *
 * Usage (after docker compose in a scratch dir):
 *   FLAGSMITH_ADMIN_API_URL=http://127.0.0.1:8000/api/v1/ npx tsx edge/bootstrap-flag.ts
 *
 * Never logs secret tokens. Writes edge/.dev.vars with the public client key.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const API = (process.env.FLAGSMITH_ADMIN_API_URL || "http://127.0.0.1:8000/api/v1/").replace(
  /\/?$/,
  "/",
);
const EMAIL = process.env.FLAGSMITH_BOOTSTRAP_EMAIL || "admin@lift.local";
const PASSWORD = process.env.FLAGSMITH_BOOTSTRAP_PASSWORD || "LiftDev123!";
const FLAG_NAME = process.env.FLAGSMITH_FLAG_NAME || "lift_edge_spec";
const SPEC_ID = process.env.LIFT_SPEC_ID || "checkout-treatment-v0";
const TREATMENT_PCT = Math.min(100, Math.max(0, Number(process.env.LIFT_TREATMENT_PCT || "50")));

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(`${API}${path.replace(/^\//, "")}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

function tokenFrom(data: unknown): string {
  if (!data || typeof data !== "object") throw new Error("no token in response");
  const rec = data as Record<string, unknown>;
  const key = rec.key || rec.token || rec.auth_token;
  if (typeof key !== "string" || !key) throw new Error("no token in response");
  return key;
}

async function registerOrLogin(): Promise<string> {
  try {
    const created = await req("POST", "auth/users/", {
      email: EMAIL,
      password: PASSWORD,
      re_password: PASSWORD,
      first_name: "Lift",
      last_name: "Edge",
    });
    try {
      return tokenFrom(created);
    } catch {
      /* some versions need a separate login */
    }
  } catch {
    /* already registered */
  }
  const logged = await req("POST", "auth/login/", { email: EMAIL, password: PASSWORD });
  return tokenFrom(logged);
}

async function main() {
  const token = await registerOrLogin();
  const orgs = (await req("GET", "organisations/", undefined, token)) as {
    results?: { id: number; name: string }[];
  };
  let org = (orgs.results || []).find((o) => o.name === "Lift") || (orgs.results || [])[0];
  if (!org) {
    org = (await req("POST", "organisations/", { name: "Lift" }, token)) as {
      id: number;
      name: string;
    };
  }
  const projects = (await req(
    "GET",
    `projects/?organisation=${org.id}`,
    undefined,
    token,
  )) as { results?: { id: number; name: string }[] } | { id: number; name: string }[];
  const projectList = Array.isArray(projects) ? projects : projects.results || [];
  let project = projectList.find((p) => p.name === "Lift Edge") || projectList[0];
  if (!project) {
    project = (await req(
      "POST",
      "projects/",
      { name: "Lift Edge", organisation: org.id },
      token,
    )) as { id: number; name: string };
  }
  const envs = (await req(
    "GET",
    `environments/?project=${project.id}`,
    undefined,
    token,
  )) as
    | { results?: { id: number; name: string; api_key: string }[] }
    | { id: number; name: string; api_key: string }[];
  const envList = Array.isArray(envs) ? envs : envs.results || [];
  let environment = envList[0];
  if (!environment?.api_key) {
    environment = (await req(
      "POST",
      "environments/",
      { name: "Development", project: project.id },
      token,
    )) as { id: number; name: string; api_key: string };
  }
  if (!environment?.api_key) throw new Error("no environment client key");

  const features = (await req(
    "GET",
    `projects/${project.id}/features/?search=${encodeURIComponent(FLAG_NAME)}`,
    undefined,
    token,
  )) as { results?: { id: number; name: string }[] };
  let feature = (features.results || []).find((f) => f.name === FLAG_NAME);
  if (!feature) {
    feature = (await req(
      "POST",
      `projects/${project.id}/features/`,
      {
        name: FLAG_NAME,
        default_enabled: true,
        initial_value: "",
        description: "Edge worker spec id. Control has no spec; treatment is the KV spec key.",
        type: "MULTIVARIATE",
        multivariate_options: [
          {
            type: "unicode",
            string_value: SPEC_ID,
            default_percentage_allocation: TREATMENT_PCT,
            key: "treatment",
          },
        ],
      },
      token,
    )) as { id: number; name: string };
  }

  const devVars = [
    "# Generated by edge/bootstrap-flag.ts. Public client key only.",
    `FLAGSMITH_ENVIRONMENT_KEY=${environment.api_key}`,
    "",
  ].join("\n");
  writeFileSync(resolve(root, "edge/.dev.vars"), devVars, { mode: 0o600 });

  process.stdout.write(
    [
      `org=${org.id} project=${project.id} env=${environment.name}`,
      `flag=${FLAG_NAME} treatment_value=${SPEC_ID} treatment_pct=${TREATMENT_PCT}`,
      "wrote edge/.dev.vars with the public client environment key",
      `dashboard=${API.replace(/\/api\/v1\/$/, "")}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
