import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT } from "../../agent/src/config.ts";
import { putSpecToLocalKv, validateSpecFile } from "../../edge/put-spec.ts";

export const EDGE_PORT = 8787;
export const MOCK_FLAG_PORT = 18787;
export const ORIGIN_PORT = 4175;
export const TREATMENT_ID = "lift-e2e-treatment";
export const CONTROL_ID = "lift-e2e-control";
export const SPEC_ID = "checkout-treatment-v0";
export const EDGE_ORIGIN = `http://127.0.0.1:${EDGE_PORT}`;
export const SITE_ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
export const FLAG_NAME = "lift_edge_spec";

const E2E_DEV_VARS = resolve(ROOT, "tests/e2e/.dev.vars");
const LIVE_DEV_VARS = resolve(ROOT, "edge/.dev.vars");

export type MockFlagsmith = {
  server: Server;
  assignments: Map<string, string | null>;
  port: number;
};

export function startMockFlagsmith(port = MOCK_FLAG_PORT): Promise<MockFlagsmith> {
  const assignments = new Map<string, string | null>([
    [TREATMENT_ID, SPEC_ID],
    [CONTROL_ID, null],
  ]);

  const payload = (identifier: string) => {
    let value: string | null = null;
    if (assignments.has(identifier)) value = assignments.get(identifier) ?? null;
    else if (/treatment/i.test(identifier)) value = SPEC_ID;
    return {
      identifier,
      flags: [
        {
          feature: { name: FLAG_NAME },
          enabled: true,
          feature_state_value: value,
        },
      ],
    };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname.includes("identities") || url.pathname.includes("/flags")) {
      const id = url.searchParams.get("identifier") || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload(id)));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolveP({ server, assignments, port });
    });
  });
}

export async function waitForUrl(url: string, timeoutMs = 45_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || (res.status >= 200 && res.status < 500)) return;
      last = `${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

export function snapshotLiveDevVars(): { existed: boolean; body: string | null } {
  if (!existsSync(LIVE_DEV_VARS)) return { existed: false, body: null };
  return { existed: true, body: readFileSync(LIVE_DEV_VARS, "utf8") };
}

export function assertLiveDevVarsUnchanged(snap: { existed: boolean; body: string | null }) {
  const now = snapshotLiveDevVars();
  if (snap.existed !== now.existed || snap.body !== now.body) {
    throw new Error("edge/.dev.vars was modified by the e2e stack");
  }
}

function writeE2eDevVars() {
  writeFileSync(
    E2E_DEV_VARS,
    [
      "FLAGSMITH_ENVIRONMENT_KEY=e2e-public-key",
      `FLAGSMITH_API_URL=http://127.0.0.1:${MOCK_FLAG_PORT}/api/v1/`,
      `ORIGIN=http://127.0.0.1:${ORIGIN_PORT}`,
      "FLAGSMITH_FLAG_NAME=lift_edge_spec",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function killGroup(child: ChildProcess) {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function killGroupHard(child: ChildProcess) {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export async function seedSpecKv() {
  const specFile = resolve(ROOT, "runtime/checkout-treatment.json");
  const valid = validateSpecFile(specFile);
  if (!valid.ok) throw new Error(valid.error);
  const put = putSpecToLocalKv(valid.spec.id, valid.path);
  if (put.status !== 0) {
    throw new Error(`edge:put-spec failed: ${(put.stderr || put.stdout || "").slice(0, 1500)}`);
  }
}

export async function startOrigin(): Promise<ChildProcess> {
  const child = spawn(
    "npx",
    ["tsx", "scripts/serve-site.ts", "--port", String(ORIGIN_PORT), "--edge-origin"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let output = "";
  const collect = (buf: Buffer) => {
    output += buf.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  try {
    await waitForUrl(`${SITE_ORIGIN}/checkout/`);
  } catch (err) {
    killGroup(child);
    throw new Error(`${err instanceof Error ? err.message : err}\norigin:\n${output.slice(-1500)}`);
  }
  return child;
}

export async function startWrangler(extraArgs: string[] = []): Promise<ChildProcess> {
  writeE2eDevVars();
  const wrangler = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      "tests/e2e/edge-wrangler.toml",
      "--persist-to",
      "edge/.wrangler/state",
      "--ip",
      "127.0.0.1",
      "--port",
      String(EDGE_PORT),
      ...extraArgs,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_LOG: process.env.WRANGLER_LOG || "error" },
    },
  );
  let output = "";
  const collect = (buf: Buffer) => {
    output += buf.toString();
  };
  wrangler.stdout?.on("data", collect);
  wrangler.stderr?.on("data", collect);
  try {
    await waitForUrl(`${EDGE_ORIGIN}/__lift/bootstrap.js`);
  } catch (err) {
    killGroup(wrangler);
    throw new Error(`${err instanceof Error ? err.message : err}\nwrangler:\n${output.slice(-2500)}`);
  }
  return wrangler;
}

export type EdgeStack = {
  mock: MockFlagsmith;
  wrangler: ChildProcess;
  origin: ChildProcess;
  liveDevVars: { existed: boolean; body: string | null };
  stop: () => Promise<void>;
};

export async function startEdgeStack(): Promise<EdgeStack> {
  const liveDevVars = snapshotLiveDevVars();
  const mock = await startMockFlagsmith();
  const origin = await startOrigin();
  await seedSpecKv();
  const wrangler = await startWrangler();
  assertLiveDevVarsUnchanged(liveDevVars);
  return {
    mock,
    wrangler,
    origin,
    liveDevVars,
    async stop() {
      killGroup(wrangler);
      killGroup(origin);
      await sleep(400);
      killGroupHard(wrangler);
      killGroupHard(origin);
      await new Promise<void>((r) => mock.server.close(() => r()));
      assertLiveDevVarsUnchanged(liveDevVars);
    },
  };
}
