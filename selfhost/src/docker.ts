import { spawn } from "node:child_process";
import { COMPOSE_FILE, ENV_FILE, REPO_ROOT } from "./paths.ts";

export const DOCKER_MISSING =
  "docker info failed. Start Docker as this user and retry. VM-only tip: if compose DNS fails, set net.bridge.bridge-nf-call-iptables=0 and net.bridge.bridge-nf-call-ip6tables=0 manually.";

export function sh(
  bin: string,
  args: string[],
  cwd = REPO_ROOT,
  opts: { echo?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      stdout.push(c);
      if (opts.echo) process.stderr.write(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr.push(c);
      if (opts.echo) process.stderr.write(c);
    });
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
  });
}

export async function requireDocker(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await sh("docker", ["info"]);
  if (info.code === 0) return { ok: true };
  return { ok: false, reason: DOCKER_MISSING };
}

function composeArgs(extra: string[]): string[] {
  return ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "--project-name", "lift-selfhost", ...extra];
}

export async function composeUp(): Promise<{ code: number; stdout: string; stderr: string }> {
  return sh("docker", composeArgs(["up", "-d"]), REPO_ROOT, { echo: true });
}

export async function composePs(): Promise<string> {
  const out = await sh("docker", composeArgs(["ps"]));
  return `${out.stdout}\n${out.stderr}`;
}

export async function waitHttpOk(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for ${url} (${last})`);
}
