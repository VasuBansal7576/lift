/**
 * Continuous live recordings for Track 1 / Track 2.
 * Logs in to Flagsmith before ffmpeg starts so credentials are not on screen.
 * After ffmpeg starts: visible pointer clicks, omnibox URL typing, or F5 only.
 * Real Flagsmith URLs (public client env key in the path is acceptable).
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { parseArgv } from "../src/config.ts";
import { runOrchestrator } from "../src/conductor.ts";
import { LIVE_PATH, REPO_ROOT } from "../src/paths.ts";

const OUT = resolve(REPO_ROOT, "recordings/t1-t2");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts/t1-t2");
const STORE = "/cursor/stores/self/recordings/t1-t2";
const OPT_ART = "/opt/cursor/artifacts";
const DISPLAY_ENV = { ...process.env, DISPLAY: ":1" };

function copyOut(file: string) {
  const name = file.split("/").pop()!;
  for (const dir of [ARTIFACTS, STORE, OPT_ART]) {
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, resolve(dir, name));
    } catch {
      /* optional destinations (size caps on some mounts) */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function xdo(args: string[]): void {
  execFileSync("xdotool", args, { env: DISPLAY_ENV, stdio: "pipe" });
}

function wiggleMouse(): void {
  try {
    xdo(["mousemove_relative", "--", "6", "0"]);
    xdo(["mousemove_relative", "--", "-6", "0"]);
  } catch {
    /* display optional */
  }
}

function activateChromium(): void {
  const classes = ["Chromium", "chromium", "Google-chrome", "chrome"];
  for (const cls of classes) {
    try {
      const ids = execFileSync("xdotool", ["search", "--onlyvisible", "--class", cls], {
        env: DISPLAY_ENV,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      if (ids[0]) {
        xdo(["windowactivate", "--sync", ids[0]]);
        return;
      }
    } catch {
      /* try next class */
    }
  }
  try {
    xdo(["search", "--onlyvisible", "--name", "Chromium", "windowactivate", "--sync"]);
  } catch {
    /* headed window may already be focused */
  }
}

async function typeUrlInOmnibox(page: Page, url: string): Promise<void> {
  activateChromium();
  await sleep(200);
  xdo(["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(200);
  xdo(["key", "--clearmodifiers", "ctrl+a"]);
  await sleep(80);
  xdo(["type", "--delay", "18", url]);
  await sleep(150);
  xdo(["key", "--clearmodifiers", "Return"]);
  const target = new URL(url);
  const prefix = `${target.origin}${target.pathname.replace(/\/$/, "")}`;
  await page.waitForURL((next) => next.toString().startsWith(prefix) || next.href.includes(target.pathname), {
    timeout: 20_000,
  });
  await page.waitForLoadState("domcontentloaded");
}

async function visibleReload(page: Page): Promise<void> {
  activateChromium();
  await page.bringToFront();
  await sleep(200);
  xdo(["key", "--clearmodifiers", "F5"]);
  await page.waitForFunction(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload";
  }, { timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded");
}

function startFfmpeg(path: string) {
  mkdirSync(OUT, { recursive: true });
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      "1920x1200",
      "-i",
      ":1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      path,
    ],
    { stdio: "ignore" },
  );
}

async function stopFfmpeg(proc: ReturnType<typeof spawn>) {
  if (proc.exitCode !== null) return;
  proc.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 2000));
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

function requireBootstrapCreds(): { email: string; password: string } {
  const email = process.env.FLAGSMITH_BOOTSTRAP_EMAIL?.trim();
  const password = process.env.FLAGSMITH_BOOTSTRAP_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error("FLAGSMITH_BOOTSTRAP_EMAIL and FLAGSMITH_BOOTSTRAP_PASSWORD are required (no default creds)");
  }
  return { email, password };
}

async function loginFlagsmith(page: Page) {
  const { email, password } = requireBootstrapCreds();
  await page.goto("http://127.0.0.1:8000/login", { waitUntil: "domcontentloaded", timeout: 20_000 });
  const emailBox = page.getByLabel(/email/i);
  await emailBox.waitFor({ timeout: 10_000 });
  await emailBox.fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 15_000 });
}

function assertNotLogin(page: Page, label: string): void {
  if (page.url().includes("login")) {
    throw new Error(`${label}: Flagsmith session expired; landed on sign-in`);
  }
}

interface LiveSnap {
  phase?: string;
  dashboardExperimentUrl?: string;
  flag?: { experimentId?: number; flagName?: string; dashboardUrl?: string };
  recommendation?: { kind?: string; arm?: string; chanceToWin?: number; reason?: string };
  generations?: Array<{
    generation?: number;
    recommendation?: { kind?: string; arm?: string; chanceToWin?: number };
    gated?: Array<{ specId: string; passed: boolean; reason: string }>;
    rejected?: Array<{ specId: string; reason: string }>;
    flag?: { experimentId?: number; flagName?: string; dashboardUrl?: string };
  }>;
}

function readLive(): LiveSnap {
  try {
    return JSON.parse(readFileSync(LIVE_PATH, "utf8")) as LiveSnap;
  } catch {
    return {};
  }
}

async function waitLive(
  predicate: (snap: LiveSnap) => boolean,
  timeoutMs: number,
  label: string,
): Promise<LiveSnap> {
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    const snap = readLive();
    if (predicate(snap)) return snap;
    const now = Date.now();
    if (now - lastBeat >= 2500) {
      lastBeat = now;
      process.stdout.write(`[record] waiting ${label} phase=${snap.phase ?? "?"} ${new Date().toISOString()}\n`);
      wiggleMouse();
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickNav(page: Page, name: RegExp, urlPart: RegExp, label: string): Promise<void> {
  const link = page.getByRole("link", { name });
  await link.first().waitFor({ state: "visible", timeout: 12_000 });
  await link.first().click();
  await page.waitForURL((url) => urlPart.test(url.pathname + url.search), { timeout: 15_000 });
  const heading = page.getByRole("heading").first();
  await heading.waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, label);
}

async function openExperimentOnCamera(page: Page, flagName: string, dashboardUrl: string): Promise<void> {
  const experiments = page.getByRole("link", { name: /^Experiments$/ });
  if (await experiments.count()) {
    await experiments.first().click();
    await page.waitForTimeout(1200);
  } else {
    await typeUrlInOmnibox(page, dashboardUrl);
  }
  assertNotLogin(page, "openExperiment");
  const row = page.getByText(flagName, { exact: false }).first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForTimeout(1200);
  const heading = page.getByRole("heading").first();
  await heading.waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, `experiment ${flagName}`);
}

async function showRolledOutFeature(page: Page, flagName: string): Promise<void> {
  const features = page.getByRole("link", { name: /^Features$/ });
  if (!(await features.count())) {
    throw new Error("Features sidebar link not visible");
  }
  await features.first().click();
  await page.waitForTimeout(1500);
  const row = page.getByText(flagName, { exact: false }).first();
  await row.waitFor({ state: "visible", timeout: 12_000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForTimeout(2000);
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, "features winner");
}

async function typeApproveOnCamera(experimentId: number): Promise<void> {
  const title = "lift-approve";
  const cmd = [
    `echo "Recording harness typing APPROVE ${experimentId} standing in for the human approver."`,
    "echo",
    `cd ${REPO_ROOT} && npx tsx orchestrator/src/cli.ts --approve ${experimentId} --apply --no-ui`,
    "echo DONE",
    "sleep 8",
  ].join("; ");
  spawn("xterm", ["-T", title, "-geometry", "80x18+20+640", "-fa", "Monospace", "-fs", "14", "-e", "bash", "-lc", cmd], {
    env: DISPLAY_ENV,
    stdio: "ignore",
  });
  await sleep(4000);
  xdo(["search", "--name", title, "windowactivate", "--sync"]);
  await sleep(200);
  xdo(["type", "--delay", "110", `APPROVE ${experimentId}`]);
  await sleep(600);
  xdo(["search", "--name", title, "windowactivate", "--sync", "key", "Return"]);
  await sleep(12_000);
}

async function withClip(name: string, fn: () => Promise<void>): Promise<string> {
  const path = resolve(OUT, `${name}.mp4`);
  const ff = startFfmpeg(path);
  await sleep(500);
  try {
    await fn();
  } finally {
    await stopFfmpeg(ff);
    copyOut(path);
  }
  return path;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY || "16";
  process.env.LIFT_ORCH_RESULTS_INITIAL_MS = process.env.LIFT_ORCH_RESULTS_INITIAL_MS || "4000";
  process.env.LIFT_ORCH_RESULTS_WAIT_MS = process.env.LIFT_ORCH_RESULTS_WAIT_MS || "240000";
  process.env.LIFT_TRAFFIC_SEED = process.env.LIFT_TRAFFIC_SEED || "20261127";
  process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS || "2";

  spawn(
    "xterm",
    ["-geometry", "92x28+0+40", "-fa", "Monospace", "-fs", "12", "-e", "bash", "-lc", "tail -n +1 -f /tmp/lift-orch.log"],
    { env: DISPLAY_ENV, stdio: "ignore" },
  );
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    appendFileSync(
      "/tmp/lift-orch.log",
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return origWrite(chunk, ...(rest as []));
  }) as typeof process.stdout.write;

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-position=960,0", "--window-size=960,1200"],
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await loginFlagsmith(page);

  const stamp = Date.now().toString().slice(-6);
  const t2Flag = `lift_orch_t2_${stamp}`;
  const opts = parseArgv([
    "--apply",
    "--keep-ui",
    "--traffic-n",
    "220",
    "--flag-name",
    t2Flag,
    "--site-url",
    "http://127.0.0.1:4184/checkout",
    "--ui-port",
    "4177",
  ]);

  const orchPromise = runOrchestrator(opts);
  orchPromise.catch((err) => {
    process.stderr.write(`t2 orchestrator failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
  });

  await withClip("t2a-gate-launch", async () => {
    await waitLive((s) => s.phase === "gating" || s.phase === "flagging" || s.phase === "traffic", 180_000, "t2 gate");
    const live = await waitLive((s) => Boolean(s.flag?.dashboardUrl || s.dashboardExperimentUrl), 180_000, "t2 flag");
    const dash = live.flag?.dashboardUrl || live.dashboardExperimentUrl || "";
    await typeUrlInOmnibox(page, dash);
    await openExperimentOnCamera(page, t2Flag, dash);
    await waitLive((s) => s.phase === "traffic", 120_000, "t2 traffic start");
    await sleep(2800);
  });

  await waitLive(
    (s) =>
      s.phase === "WAITING_FOR_HUMAN_APPROVAL" || s.phase === "complete" || s.phase === "aborted",
    900_000,
    "t2 waiting",
  );
  const state = await orchPromise;

  await withClip("t2b-approve-rollout", async () => {
    process.stdout.write(
      `t2 seed=${process.env.LIFT_TRAFFIC_SEED} recommendation=${JSON.stringify(state.recommendation)}\n`,
    );
    if (state.flag?.dashboardUrl) {
      await typeUrlInOmnibox(page, state.flag.dashboardUrl);
      await visibleReload(page);
    }
    if (state.recommendation?.kind === "winner" && state.flag) {
      process.stdout.write(
        `Recording harness will type APPROVE ${state.flag.experimentId} standing in for the human approver.\n`,
      );
      await typeApproveOnCamera(state.flag.experimentId);
      await typeUrlInOmnibox(page, state.flag.dashboardUrl);
      await visibleReload(page);
      await showRolledOutFeature(page, state.flag.flagName);
    } else {
      process.stdout.write("No winner; harness is not typing APPROVE.\n");
      await sleep(2500);
    }
  });

  await withClip("t1-experiment", async () => {
    await typeUrlInOmnibox(page, "http://127.0.0.1:8000/organisation/1/projects");
    const lift = page.getByText("Lift", { exact: true });
    await lift.nth(1).waitFor({ state: "visible", timeout: 10_000 });
    await lift.nth(1).click();
    await page.waitForTimeout(1200);
    await clickNav(page, /^Experiments$/, /experiment/i, "t1 experiments");
    if (state.flag) {
      const row = page.getByText(state.flag.flagName, { exact: false }).first();
      await row.waitFor({ state: "visible", timeout: 12_000 });
      await row.click();
      await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
    }
    await sleep(2500);
    assertNotLogin(page, "t1");
  });

  writeFileSync(LIVE_PATH, "{}\n");
  const l2Flag = `lift_orch_l2_${Date.now().toString().slice(-6)}`;
  const opts2 = parseArgv([
    "--apply",
    "--keep-ui",
    "--generations",
    "2",
    "--traffic-n",
    "220",
    "--flag-name",
    l2Flag,
    "--site-url",
    "http://127.0.0.1:4185/checkout",
    "--ui-port",
    "4178",
  ]);
  const gen2Promise = runOrchestrator(opts2);
  gen2Promise.catch((err) => {
    process.stderr.write(`l2 orchestrator failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
  });

  await waitLive((s) => Boolean(s.generations?.[0]?.recommendation), 420_000, "l2 gen-1 result");

  await withClip("l2a-gen1-champion", async () => {
    const live = readLive();
    const rec = live.generations?.[0]?.recommendation;
    const dash = live.generations?.[0]?.flag?.dashboardUrl || live.dashboardExperimentUrl || "";
    process.stdout.write(`gen-1 champion ${rec?.arm ?? "?"} chance_to_win=${rec?.chanceToWin ?? "?"}\n`);
    if (dash) {
      await typeUrlInOmnibox(page, dash);
      await openExperimentOnCamera(page, live.generations?.[0]?.flag?.flagName || l2Flag, dash);
    }
    await sleep(2500);
  });

  await waitLive(
    (s) =>
      s.phase === "WAITING_FOR_HUMAN_APPROVAL" || s.phase === "complete" || s.phase === "aborted",
    900_000,
    "l2 waiting",
  );
  const gen2 = await gen2Promise;

  await withClip("l2b-gen2-gate-rollout", async () => {
    const rejected = gen2.generations[1]?.rejected ?? [];
    for (const item of rejected) {
      process.stdout.write(`gen-2 rejected ${item.specId}: ${item.reason}\n`);
    }
    const rec = gen2.recommendation;
    process.stdout.write(`gen-2 recommendation ${JSON.stringify(rec)}\n`);
    if (gen2.flag?.dashboardUrl) {
      await typeUrlInOmnibox(page, gen2.flag.dashboardUrl);
      await visibleReload(page);
    }
    if (rec?.kind === "winner" && gen2.flag) {
      if (rec.arm === "control") {
        process.stdout.write("Gen-2 did not beat the champion; rolling out control (keep the champion).\n");
      }
      process.stdout.write(
        `Recording harness will type APPROVE ${gen2.flag.experimentId} standing in for the human approver.\n`,
      );
      await typeApproveOnCamera(gen2.flag.experimentId);
      await typeUrlInOmnibox(page, gen2.flag.dashboardUrl);
      await visibleReload(page);
      await showRolledOutFeature(page, gen2.flag.flagName);
    } else {
      process.stdout.write(
        "Gen-2 did not beat the champion; keeping the champion. Harness is not typing APPROVE.\n",
      );
      if (gen2.flag?.dashboardUrl) {
        await visibleReload(page);
      }
      await sleep(2800);
    }
    assertNotLogin(page, "l2b");
  });

  await Promise.race([
    context.close().then(() => browser.close()),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
