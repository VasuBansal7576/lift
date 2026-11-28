import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { redactSecrets } from "./redact.ts";

export interface CliResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface CliOpts {
  apiUrl: string;
  apiKey?: string;
  project?: string;
  environment?: string;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

function flagsmithBin(): string {
  const local = resolve(homedir(), ".local/bin/flagsmith");
  if (existsSync(local)) return local;
  return "flagsmith";
}

export function cliAvailable(): boolean {
  const bin = flagsmithBin();
  if (bin !== "flagsmith") return true;
  try {
    return existsSync("/usr/bin/flagsmith") || existsSync("/usr/local/bin/flagsmith");
  } catch {
    return false;
  }
}

function hostScopedKeyName(apiUrl: string): string {
  const u = new URL(apiUrl.includes("://") ? apiUrl : `http://${apiUrl}`);
  const host = u.hostname.replace(/\./g, "_").replace(/-/g, "__");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if ((u.protocol === "http:" && port === "80") || (u.protocol === "https:" && port === "443")) {
    return `FLAGSMITH_API_KEY_${host}`;
  }
  return `FLAGSMITH_API_KEY_${host}_${port}`;
}

export async function runFlagsmith(args: string[], opts: CliOpts): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLAGSMITH_API_URL: opts.apiUrl,
    FLAGSMITH_JSON_OUTPUT: "1",
    FLAGSMITH_NO_INPUT: "1",
  };
  if (opts.apiKey) {
    env.FLAGSMITH_API_KEY = opts.apiKey;
    env[hostScopedKeyName(opts.apiUrl)] = opts.apiKey;
  }
  if (opts.project) env.FLAGSMITH_PROJECT = opts.project;
  if (opts.environment) env.FLAGSMITH_ENVIRONMENT = opts.environment;

  const bin = flagsmithBin();
  const command = redactSecrets(["flagsmith", ...args].join(" "));
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        code: code ?? 1,
        stdout: stdout.join(""),
        stderr: redactSecrets(stderr.join("")),
        command,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        code: 127,
        stdout: "",
        stderr: redactSecrets(err.message),
        command,
      });
    });
  });
}

export async function flagsmithApi(
  path: string,
  opts: CliOpts & { method?: string; body?: unknown },
): Promise<CliResult> {
  const args = ["api", path, "--json", "--no-input"];
  if (opts.method) args.push("-X", opts.method);
  if (opts.body !== undefined) args.push("--input", "-");
  return runFlagsmith(args, {
    ...opts,
    input: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
