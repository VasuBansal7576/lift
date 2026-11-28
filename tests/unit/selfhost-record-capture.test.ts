import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { ROOT } from "../../agent/src/config.ts";
import { finishCapture } from "../../selfhost/src/capture-finish.ts";
import {
  abortIfServerKeyInFiles,
  assertNoServerKeyVisible,
  collectDomSecretScanText,
  liftScanFiles,
} from "../../selfhost/src/redact.ts";
import { experimentOpenTarget, reloadButtonScreenPoint } from "../../selfhost/src/record-pointer.ts";

const RECORDER = resolve(ROOT, "scripts/selfhost-record-live.ts");
const PROOF_UP = resolve(ROOT, "scripts/selfhost-proof-up.sh");
const PROOF_COMPOSE = resolve(ROOT, "selfhost/docker-compose.proof.yml");

const HIDDEN_NAV = [
  /\.(click|fill|press|type|check|hover|dblclick|tap)\(/,
  /keyboard\./,
  /mouse\./,
  /location\.(href|assign|replace)/,
];

describe("E1 no hidden Playwright navigation after capture starts", () => {
  it("bans click/fill/press/type/check/hover/dblclick/tap, keyboard, mouse, and location.href file-wide after startFfmpeg", () => {
    const src = readFileSync(RECORDER, "utf8");
    const def = src.indexOf("function startFfmpeg");
    expect(def).toBeGreaterThan(-1);
    const captured = src.slice(src.indexOf("startFfmpeg(", def + 1));
    const helpers = src.slice(0, def);
    for (const ban of HIDDEN_NAV) {
      expect(captured, "after startFfmpeg").not.toMatch(ban);
      expect(helpers, "helpers used during capture").not.toMatch(ban);
    }
  });
});

describe("W1 proof-up project name", () => {
  it("refuses COMPOSE_PROJECT_NAME=lift-selfhost", () => {
    const out = spawnSync("bash", [PROOF_UP], {
      env: { ...process.env, COMPOSE_PROJECT_NAME: "lift-selfhost", LIFT_PROOF_UP_TEE: "1" },
      encoding: "utf8",
    });
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/refusing COMPOSE_PROJECT_NAME=lift-selfhost/);
  });

  it("refuses a project name without a -proof suffix", () => {
    const out = spawnSync("bash", [PROOF_UP], {
      env: { ...process.env, COMPOSE_PROJECT_NAME: "lift-other", LIFT_PROOF_UP_TEE: "1" },
      encoding: "utf8",
    });
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/must end with -proof/);
  });

  it("refuses FLAGSMITH_HTTP_PORT=8000", () => {
    const out = spawnSync("bash", [PROOF_UP], {
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: "lift-selfhost-proof",
        FLAGSMITH_HTTP_PORT: "8000",
        LIFT_PROOF_UP_TEE: "1",
      },
      encoding: "utf8",
    });
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/refusing FLAGSMITH_HTTP_PORT=8000/);
  });
});

describe("W2 FLAGSMITH_HTTP_PORT wiring", () => {
  it("interpolates FLAGSMITH_HTTP_PORT in the proof compose overlay", () => {
    const yml = readFileSync(PROOF_COMPOSE, "utf8");
    expect(yml).toContain("${FLAGSMITH_HTTP_PORT:-8010}:8000");
    expect(yml).toContain("localhost:${FLAGSMITH_HTTP_PORT:-8010}");
  });

  it("health-poll in-place line stays under 72 columns", () => {
    const out = spawnSync(
      "bash",
      [
        "-c",
        `filled=$((37 % 28 + 4)); bar=$(printf '%*s' "$filled" | tr ' ' '#')$(printf '%*s' $((32 - filled)) | tr ' ' '.'); printf '\\r\\033[2K%s' "health-poll 37 HTTP 000 \${bar}"`,
      ],
      { encoding: "utf8" },
    );
    const visible = out.stdout.replace(/\r|\x1b\[[0-9]*K/g, "");
    expect(visible.length).toBeLessThan(72);
    expect(visible).toMatch(/^health-poll 37 HTTP 000 /);
    expect(visible).not.toMatch(/\n/);
    const src = readFileSync(PROOF_UP, "utf8");
    expect(src).toContain("\\r\\033[2K");
    expect(src).not.toContain("%-80s");
  });

  it("cold-starts by down -v before up when run on its own", () => {
    const out = spawnSync("bash", [PROOF_UP], {
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: "lift-selfhost-proof",
        FLAGSMITH_HTTP_PORT: "8010",
        LIFT_PROOF_UP_CHECK: "1",
        LIFT_PROOF_UP_TEE: "1",
      },
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/would down -v then up project=lift-selfhost-proof port=8010/);
  });
});

describe("recorder guards", () => {
  it("aborts when terminal or page text matches a server-style key", () => {
    expect(() => assertNoServerKeyVisible("Environment with api_key ser.abc does not exist")).toThrow(
      /server-style ser/,
    );
    expect(() => assertNoServerKeyVisible("public env key in /api/v1/flags/")).not.toThrow();
  });

  it("throws when a fake ser.x log line is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "lift-scan-"));
    writeFileSync(join(dir, "lift-proof-up.log"), "health-poll 1\nser.x leftover\n");
    expect(() => abortIfServerKeyInFiles(liftScanFiles(dir))).toThrow(/server-style ser/);
  });

  it("places the reload icon click on the toolbar centre, not 24px left", () => {
    expect(reloadButtonScreenPoint(0, 0)).toEqual({ x: 108, y: 56 });
    expect(reloadButtonScreenPoint(10, 20)).toEqual({ x: 118, y: 76 });
  });

  it("aborts when a hidden input holds a server-style key", () => {
    const window = new Window({ url: "http://127.0.0.1/" });
    window.document.body.innerHTML = `<input type="hidden" value="ser.x">`;
    expect(() => assertNoServerKeyVisible(collectDomSecretScanText(window.document as never))).toThrow(
      /server-style ser/,
    );
  });

  it("does not publish when a thrown leak finishes the capture", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lift-clip-")), "t3-selfhost-up.mp4");
    writeFileSync(file, "fake");
    const published: string[] = [];
    const removed: string[] = [];
    await expect(async () => {
      try {
        throw new Error("server-style ser. key visible");
      } finally {
        await finishCapture(false, file, {
          stopFfmpeg: async () => undefined,
          exists: () => true,
          rm: (path) => {
            removed.push(path);
          },
          publish: (path) => {
            published.push(path);
          },
        });
      }
    }).rejects.toThrow(/server-style ser/);
    expect(published).toEqual([]);
    expect(removed).toEqual([file]);
  });

  it("opens the current experiment by id rather than the first lift a11y label", () => {
    const target = experimentOpenTarget(42, [
      { id: 7, name: "lift a11y older" },
      { id: 42, name: "lift a11y current" },
    ]);
    expect(target).toEqual({ href: "/experiments/42", name: "lift a11y current" });
    expect(target.href).not.toContain("lift a11y");
  });
});
