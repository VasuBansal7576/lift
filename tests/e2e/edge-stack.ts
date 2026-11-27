import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT } from "../../agent/src/config.ts";
import { putSpecToLocalKv, validateSpecFile } from "../../edge/put-spec.ts";

export const EDGE_PORT = 8787;
export const MOCK_FLAG_PORT = 18787;
export const TREATMENT_ID = "lift-e2e-treatment";
export const CONTROL_ID = "lift-e2e-control";
export const SPEC_ID = "checkout-treatment-v0";
export const EDGE_ORIGIN = `http://127.0.0.1:${EDGE_PORT}`;
export const FLAG_NAME = "lift_edge_spec";

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

function writeE2eDevVars() {
  writeFileSync(
    resolve(ROOT, "edge/.dev.vars"),
    [
      "FLAGSMITH_ENVIRONMENT_KEY=e2e-public-key",
      `FLAGSMITH_API_URL=http://127.0.0.1:${MOCK_FLAG_PORT}/api/v1/`,
      "ORIGIN=http://127.0.0.1:4174",
      "FLAGSMITH_FLAG_NAME=lift_edge_spec",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
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

export async function startWrangler(extraArgs: string[] = []): Promise<ChildProcess> {
  writeE2eDevVars();
  const wrangler = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      "edge/wrangler.toml",
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
    wrangler.kill("SIGTERM");
    throw new Error(`${err instanceof Error ? err.message : err}\nwrangler:\n${output.slice(-2500)}`);
  }
  return wrangler;
}

export type EdgeStack = {
  mock: MockFlagsmith;
  wrangler: ChildProcess;
  stop: () => Promise<void>;
};

export async function startEdgeStack(): Promise<EdgeStack> {
  const mock = await startMockFlagsmith();
  await seedSpecKv();
  const wrangler = await startWrangler();
  return {
    mock,
    wrangler,
    async stop() {
      if (wrangler.pid) {
        try {
          process.kill(-wrangler.pid, "SIGTERM");
        } catch {
          wrangler.kill("SIGTERM");
        }
      }
      await sleep(400);
      if (wrangler.pid) {
        try {
          process.kill(-wrangler.pid, "SIGKILL");
        } catch {
          wrangler.kill("SIGKILL");
        }
      }
      await new Promise<void>((r) => mock.server.close(() => r()));
    },
  };
}
