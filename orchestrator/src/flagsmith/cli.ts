import { spawn } from "node:child_process";
import { stripSecretsFromText } from "../secrets.ts";
import { cliOrigin } from "./http.ts";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<CliResult>;

export async function runFlagsmithCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("flagsmith", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({
        code: 127,
        stdout: "",
        stderr: stripSecretsFromText(err instanceof Error ? err.message : String(err)),
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stripSecretsFromText(stdout),
        stderr: stripSecretsFromText(stderr),
      });
    });
  });
}

function selfHostApiKeyEnv(origin: string, token: string): Record<string, string> {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/\./g, "_");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const key = `FLAGSMITH_API_KEY_${host}_${port}`;
    return { [key]: token };
  } catch {
    return {};
  }
}

export function flagsmithEnv(opts: {
  apiUrl: string;
  token: string;
  projectId: string;
  environmentKey: string;
}): NodeJS.ProcessEnv {
  const origin = cliOrigin(opts.apiUrl);
  return {
    ...process.env,
    FLAGSMITH_API_URL: origin,
    FLAGSMITH_API_KEY: opts.token,
    FLAGSMITH_PROJECT: opts.projectId,
    FLAGSMITH_ENVIRONMENT: opts.environmentKey,
    FLAGSMITH_NO_INPUT: "1",
    FLAGSMITH_JSON_OUTPUT: "1",
    ...selfHostApiKeyEnv(origin, opts.token),
  };
}

export async function tryCliJson<T>(
  run: RunCli,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const result = await run(["--json", "--no-input", ...args], env);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `flagsmith exit ${result.code}` };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch {
    return { ok: false, error: "flagsmith JSON parse failed" };
  }
}
