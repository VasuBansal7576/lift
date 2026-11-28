import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const MARKER_PREFIX = "lift-approve-";

/** Live path of the current prompt marker, if any. Created under mkdtemp. */
export let APPROVE_PROMPT_FILE = "";

export function expectedApprovalLine(experimentId: number): string {
  return `APPROVE ${experimentId}`;
}

export function parseApprovalLine(
  line: string,
  experimentId: number,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed === "") return { ok: false, reason: "empty approval line" };
  if (trimmed !== expectedApprovalLine(experimentId)) {
    return {
      ok: false,
      reason: `expected exactly ${expectedApprovalLine(experimentId)}`,
    };
  }
  return { ok: true };
}

export type LineResult = { ok: true; line: string } | { ok: false; reason: string };

/** Read one line from /dev/tty. Refuses when there is no controlling terminal. */
export function readTtyLine(): Promise<LineResult> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason });
    };
    const stream = createReadStream("/dev/tty");
    stream.once("error", () =>
      fail("no TTY; approval requires reading one line from /dev/tty"),
    );
    stream.once("open", () => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.once("line", (line) => {
        if (settled) return;
        settled = true;
        rl.close();
        stream.destroy();
        resolve({ ok: true, line });
      });
      rl.once("close", () => {
        fail("no TTY; approval requires reading one line from /dev/tty");
      });
    });
  });
}

export function findApprovePromptFile(): string | null {
  if (APPROVE_PROMPT_FILE && existsSync(APPROVE_PROMPT_FILE)) return APPROVE_PROMPT_FILE;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(MARKER_PREFIX)) continue;
      const candidate = join(tmpdir(), name, "prompt.json");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* */
  }
  return null;
}

export function writeApprovePromptMarker(
  experimentId: number,
  chances: Record<string, number>,
): void {
  clearApprovePromptMarker();
  const dir = mkdtempSync(join(tmpdir(), MARKER_PREFIX));
  APPROVE_PROMPT_FILE = join(dir, "prompt.json");
  writeFileSync(
    APPROVE_PROMPT_FILE,
    `${JSON.stringify({
      experimentId,
      chance_to_win: chances,
      typed: expectedApprovalLine(experimentId),
    })}\n`,
  );
}

export function clearApprovePromptMarker(): void {
  const file = APPROVE_PROMPT_FILE;
  APPROVE_PROMPT_FILE = "";
  if (!file) return;
  try {
    rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* */
  }
}

export async function promptApproveLine(
  experimentId: number,
  chances: Record<string, number>,
  readLine: () => Promise<LineResult> = readTtyLine,
): Promise<LineResult> {
  try {
    writeApprovePromptMarker(experimentId, chances);
    const expected = expectedApprovalLine(experimentId);
    process.stderr.write(`chance_to_win ${JSON.stringify(chances)}\n`);
    if (process.env.LIFT_RECORD_HARNESS === "1") {
      process.stderr.write("APPROVE typed by recording harness in place of a human approver\n");
    }
    process.stderr.write(`Type exactly: ${expected}\n`);
    const got = await readLine();
    if (got.ok === false) return got;
    const parsed = parseApprovalLine(got.line, experimentId);
    if (parsed.ok === false) return parsed;
    return { ok: true, line: got.line };
  } finally {
    clearApprovePromptMarker();
  }
}
