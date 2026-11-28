import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";

const cli = resolve(ROOT, "tests/helpers/approve-prompt-cli.ts");

function runWithScript(
  typed: string | null,
  outFile: string,
  opts: { tty: boolean } = { tty: true },
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const command = `npx tsx ${JSON.stringify(cli)} --experiment-id 7 --out ${JSON.stringify(outFile)}`;
    const child = spawn("script", ["-qefc", command, "/dev/null"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let sent = false;
    const onChunk = (buf: Buffer) => {
      output += buf.toString();
      if (opts.tty && typed !== null && !sent && (output.includes("Type exactly:") || output.includes("chance_to_win"))) {
        sent = true;
        child.stdin?.write(typed);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 40_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

function runNoTty(outFile: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("setsid", ["npx", "tsx", cli, "--experiment-id", "7", "--out", outFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (buf: Buffer) => {
      output += buf.toString();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      output += buf.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

describe("TTY APPROVE prompt", () => {
  it("accepts the exact line, rejects a wrong id, rejects empty, and refuses without a TTY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lift-approve-"));
    try {
      const correctOut = join(dir, "correct.json");
      const correct = await runWithScript("APPROVE 7\n", correctOut);
      if (!existsSync(correctOut)) {
        throw new Error(`correct out missing: ${correct.output.slice(-1500)}`);
      }
      expect(JSON.parse(readFileSync(correctOut, "utf8")).ok).toBe(true);
      expect(correct.code).toBe(0);

      const wrongOut = join(dir, "wrong.json");
      await runWithScript("APPROVE 99\n", wrongOut);
      expect(JSON.parse(readFileSync(wrongOut, "utf8")).ok).toBe(false);

      const emptyOut = join(dir, "empty.json");
      await runWithScript("\n", emptyOut);
      expect(JSON.parse(readFileSync(emptyOut, "utf8")).ok).toBe(false);

      const noTtyOut = join(dir, "notty.json");
      const noTty = await runNoTty(noTtyOut);
      expect(noTty.code).not.toBe(0);
      if (!existsSync(noTtyOut)) {
        throw new Error(`no-tty out missing: ${noTty.output.slice(-1500)}`);
      }
      const noTtyDoc = JSON.parse(readFileSync(noTtyOut, "utf8")) as { ok: boolean; reason?: string };
      expect(noTtyDoc.ok).toBe(false);
      expect(String(noTtyDoc.reason)).toMatch(/no TTY/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
