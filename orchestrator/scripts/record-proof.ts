/**
 * Continuous live recordings for Track 1 / Track 2.
 * Logs in to Flagsmith before ffmpeg starts so credentials are not on screen.
 * After ffmpeg starts: xdotool pointer moves + clicks, omnibox URL typing, or F5 only.
 * Real Flagsmith URLs (public client env key in the path is acceptable).
 * Every judged line is stdout from cli.ts / approve / analyst. No echo stand-ins.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { chromium, type Locator, type Page } from "@playwright/test";
import { LIVE_PATH, REPO_ROOT } from "../src/paths.ts";
import {
  viewportToScreen,
  RECORDING_TRAFFIC_N_T2,
  RECORDING_TRAFFIC_N_L2,
  RECORDING_TRAFFIC_N_GEN2,
} from "../src/record-nav.ts";
import type { AnalystRecommendation } from "../src/types.ts";

if (!process.env.LIFT_FLAGSMITH_ENV && existsSync("/tmp/lift-flagsmith.env")) {
  process.env.LIFT_FLAGSMITH_ENV = "/tmp/lift-flagsmith.env";
}
if (process.env.LIFT_FLAGSMITH_ENV) {
  loadEnv({ path: process.env.LIFT_FLAGSMITH_ENV });
}

const OUT = resolve(REPO_ROOT, "recordings/t1-t2");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts/t1-t2");
const STORE = "/cursor/stores/self/recordings/t1-t2";
const OPT_ART = "/opt/cursor/artifacts";

function displayEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: ":1" };
}

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
  execFileSync("xdotool", args, { env: displayEnv(), stdio: "pipe" });
}

async function hold(ms: number): Promise<void> {
  await sleep(ms);
}

function activateChromium(): void {
  const classes = ["Chromium", "chromium", "Google-chrome", "chrome"];
  for (const cls of classes) {
    try {
      const ids = execFileSync("xdotool", ["search", "--onlyvisible", "--class", cls], {
        env: displayEnv(),
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
}

function spawnEmptyXterm(title: string, geometry = "92x28+0+40"): void {
  spawn(
    "xterm",
    [
      "-T",
      title,
      "-geometry",
      geometry,
      "-fa",
      "Monospace",
      "-fs",
      "12",
      "-e",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      "PS1='$ '; export PS1; exec bash --noprofile --norc",
    ],
    { env: displayEnv(), stdio: "ignore" },
  );
}

async function activateXterm(title: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      xdo(["search", "--name", title, "windowactivate", "--sync"]);
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`xterm ${title} not found`);
}

async function typeInXterm(title: string, text: string): Promise<void> {
  await activateXterm(title);
  await sleep(200);
  xdo(["type", "--delay", "18", text]);
  await sleep(120);
  xdo(["key", "--clearmodifiers", "Return"]);
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
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
}

async function visibleReload(page: Page): Promise<void> {
  activateChromium();
  await page.bringToFront();
  await sleep(200);
  xdo(["key", "--clearmodifiers", "F5"]);
  await page.waitForFunction(
    () => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav?.type === "reload";
    },
    undefined,
    { timeout: 12_000 },
  );
  await page.waitForLoadState("domcontentloaded");
}

async function pointerClick(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("pointerClick: no bounding box");
  const win = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  const { x, y } = viewportToScreen(box, win);
  activateChromium();
  xdo(["mousemove", "--sync", String(x), String(y)]);
  await sleep(180);
  xdo(["click", "1"]);
  await sleep(220);
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

async function resetToNeutral(page: Page): Promise<void> {
  await page.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded", timeout: 20_000 });
  assertNotLogin(page, "neutral");
}

interface LiveSnap {
  phase?: string;
  dashboardExperimentUrl?: string;
  flag?: { experimentId?: number; flagName?: string; dashboardUrl?: string };
  recommendation?: AnalystRecommendation;
  events?: Array<{ agent?: string; kind?: string; message?: string }>;
  generations?: Array<{
    generation?: number;
    recommendation?: AnalystRecommendation;
    gated?: Array<{ specId: string; passed: boolean; reason: string }>;
    rejected?: Array<{ specId: string; reason: string }>;
    flag?: { experimentId?: number; flagName?: string; dashboardUrl?: string };
    visits?: unknown[];
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
  opts: { failOnError?: boolean } = {},
): Promise<LiveSnap> {
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    const snap = readLive();
    if (opts.failOnError) {
      const err = (snap.events ?? []).find((event) => event.kind === "error");
      if (err) throw new Error(`Recording failed during ${label}: ${err.message}`);
    }
    if (predicate(snap)) return snap;
    const now = Date.now();
    if (now - lastBeat >= 4000) {
      lastBeat = now;
      process.stdout.write(`[record] waiting ${label} phase=${snap.phase ?? "?"} ${new Date().toISOString()}\n`);
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitLog(pattern: RegExp, timeoutMs: number, file = "/tmp/lift-orch.log"): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (pattern.test(text)) return text;
    if (/Approval phrase did not match/i.test(text)) {
      throw new Error(`Recording failed: approval phrase mismatch\n${text.slice(-800)}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for log ${pattern}`);
}

function pausedPhase(phase?: string): boolean {
  return (
    phase === "WAITING_FOR_HUMAN_APPROVAL" ||
    phase === "KEEP_COLLECTING" ||
    phase === "complete" ||
    phase === "aborted"
  );
}

async function pointerClickByName(
  page: Page,
  name: string,
  assert?: { experimentId?: number },
): Promise<void> {
  const box = await page.evaluate((n) => {
    const nodes = Array.from(document.querySelectorAll("a, tr, td, li, div, span, button, h1, h2, h3"));
    let best: { x: number; y: number; width: number; height: number; area: number; depth: number } | null = null;
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const text = el.innerText || el.textContent || "";
      if (!text.includes(n)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      let depth = 0;
      let cur: HTMLElement | null = el;
      while (cur?.parentElement) {
        depth += 1;
        cur = cur.parentElement;
      }
      const area = r.width * r.height;
      if (!best || depth > best.depth || (depth === best.depth && area < best.area)) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height, area, depth };
      }
    }
    return best;
  }, name);
  if (!box) throw new Error(`no on-screen box for ${name}`);
  const win = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  const { x, y } = viewportToScreen(box, win);
  activateChromium();
  xdo(["mousemove", "--sync", String(x), String(y)]);
  await sleep(180);
  xdo(["click", "1"]);
  await sleep(220);
  if (assert?.experimentId) {
    await assertExperimentUrl(page, assert.experimentId);
  }
}

async function assertExperimentUrl(page: Page, experimentId: number): Promise<void> {
  const needle = `/experiments/${experimentId}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (page.url().includes(needle)) return;
    await sleep(200);
  }
  throw new Error(`W-E: expected ${needle} got ${page.url()}`);
}

function experimentsListUrl(dashboardUrl: string): string {
  return dashboardUrl.replace(/\/experiments\/\d+.*$/, "/experiments");
}

async function openExperimentOnCamera(
  page: Page,
  flagName: string,
  dashboardUrl: string,
  experimentId: number,
): Promise<void> {
  const experiments = page.getByRole("link", { name: /^Experiments$/ });
  if (await experiments.count()) {
    await pointerClick(page, experiments.first());
    await page.waitForTimeout(1000);
  } else {
    await typeUrlInOmnibox(page, experimentsListUrl(dashboardUrl));
  }
  assertNotLogin(page, "openExperiment");
  try {
    await pointerClickByName(page, flagName, { experimentId });
  } catch {
    await typeUrlInOmnibox(page, dashboardUrl);
    await assertExperimentUrl(page, experimentId);
  }
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, `experiment ${flagName}`);
}

async function visibleScrollAnalysis(page: Page): Promise<void> {
  activateChromium();
  await page.bringToFront();
  const win = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  }));
  const x = Math.round(win.screenX + win.outerWidth * 0.5);
  const y = Math.round(win.screenY + win.outerHeight * 0.55);
  xdo(["mousemove", "--sync", String(x), String(y)]);
  await sleep(150);
  xdo(["click", "1"]);
  await sleep(120);
  xdo(["click", "--repeat", "8", "--delay", "90", "5"]);
  await sleep(200);
  xdo(["key", "--clearmodifiers", "Page_Down"]);
  await sleep(350);
}

async function assertFullV1At100(page: Page): Promise<void> {
  await page
    .locator(".loader, [class*='spinner'], [class*='Spinner']")
    .first()
    .waitFor({ state: "hidden", timeout: 8_000 })
    .catch(() => undefined);
  const ok = await page
    .waitForFunction(
      () => {
        const text = document.body.innerText || "";
        if (!/full-v1/i.test(text)) return false;
        const rows = Array.from(document.querySelectorAll("tr, li, div, span, label, td"));
        for (const el of rows) {
          const t = el.textContent || "";
          if (/full-v1/i.test(t) && /100\s*%/.test(t)) return true;
        }
        return /full-v1[\s\S]{0,120}100\s*%/i.test(text) || /100\s*%[\s\S]{0,120}full-v1/i.test(text);
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error(`W-G: full-v1 at 100% not visible on ${page.url()}`);
}

async function showRolledOutFeature(page: Page, flagName: string, dashboardUrl: string): Promise<void> {
  const featuresUrl = dashboardUrl.replace(/\/experiments\/\d+.*$/, "/features");
  await typeUrlInOmnibox(page, featuresUrl);
  const search = page.getByPlaceholder(/^Search$/);
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await pointerClick(page, search);
  await sleep(150);
  xdo(["type", "--delay", "22", flagName]);
  await sleep(400);
  try {
    await pointerClickByName(page, flagName);
  } catch {
    await typeUrlInOmnibox(page, dashboardUrl);
  }
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, "features winner");
  await visibleReload(page);
  await assertFullV1At100(page);
}

async function withClip(name: string, fn: () => Promise<void>): Promise<string> {
  const path = resolve(OUT, `${name}.mp4`);
  const ff = startFfmpeg(path);
  await sleep(400);
  try {
    await fn();
  } finally {
    await stopFfmpeg(ff);
    copyOut(path);
  }
  return path;
}

function orchCommand(args: string[]): string {
  return `cd ${REPO_ROOT} && npx tsx orchestrator/src/cli.ts ${args.join(" ")} 2>&1 | tee /tmp/lift-orch.log`;
}

function closeOurXterms(): void {
  try {
    const ids = execFileSync("xdotool", ["search", "--name", "lift-"], {
      env: displayEnv(),
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const id of ids) {
      try {
        xdo(["windowkill", id]);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* none */
  }
}

async function startFreshXterm(title: string, geometry?: string): Promise<void> {
  closeOurXterms();
  spawnEmptyXterm(title, geometry);
  await sleep(550);
}

function cleanupStaleOrchFlags(): void {
  execFileSync("npx", ["tsx", "orchestrator/src/cli.ts", "--cleanup", "--apply", "--no-ui"], {
    cwd: REPO_ROOT,
    env: displayEnv(),
    stdio: "inherit",
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  closeOurXterms();
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY || "16";
  process.env.LIFT_ORCH_RESULTS_INITIAL_MS = process.env.LIFT_ORCH_RESULTS_INITIAL_MS || "4000";
  process.env.LIFT_ORCH_RESULTS_WAIT_MS = process.env.LIFT_ORCH_RESULTS_WAIT_MS || "420000";
  process.env.LIFT_TRAFFIC_SEED = process.env.LIFT_TRAFFIC_SEED || "20261127";
  process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = "0";
  process.env.LIFT_ORCH_TRAFFIC_N_GEN2 = String(RECORDING_TRAFFIC_N_GEN2);
  process.env.LIFT_RECORDING_STANDIN = "1";
  process.env.LIFT_RUN_ID = process.env.LIFT_RUN_ID || `rec${Date.now().toString().slice(-8)}`;

  process.stdout.write("[record] cleaning stale lift_orch_ flags\n");
  try {
    cleanupStaleOrchFlags();
  } catch (err) {
    process.stdout.write(`[record] cleanup warning: ${err instanceof Error ? err.message : err}\n`);
  }

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
  await resetToNeutral(page);

  const stamp = Date.now().toString().slice(-6);
  const t2Flag = `lift_orch_t2_${stamp}`;
  const t2Args = [
    "--apply",
    "--keep-ui",
    "--traffic-n",
    String(RECORDING_TRAFFIC_N_T2),
    "--flag-name",
    t2Flag,
    "--site-url",
    "http://127.0.0.1:4190/checkout",
    "--ui-port",
    "4180",
  ];

  await startFreshXterm("lift-t2");
  await withClip("t2a-gate-launch", async () => {
    await typeInXterm("lift-t2", orchCommand(t2Args));
    await waitLive((s) => s.phase === "gating" || s.phase === "flagging" || s.phase === "traffic", 180_000, "t2 gate");
    const live = await waitLive(
      (s) => Boolean(s.flag?.experimentId && (s.flag?.dashboardUrl || s.dashboardExperimentUrl)),
      180_000,
      "t2 flag",
    );
    const dash = live.flag?.dashboardUrl || live.dashboardExperimentUrl || "";
    const expId = live.flag?.experimentId as number;
    await openExperimentOnCamera(page, t2Flag, dash, expId);
    await hold(3200);
  });

  const t2Done = await waitLive((s) => pausedPhase(s.phase), 1_200_000, "t2 waiting");
  const t2Rec = t2Done.recommendation;
  const t2ExpId = t2Done.flag?.experimentId;
  const t2Dash = t2Done.flag?.dashboardUrl || t2Done.dashboardExperimentUrl || "";
  if (t2Rec?.kind !== "winner" || !t2ExpId || !t2Done.flag) {
    throw new Error(`T2 did not produce a winner at the pre-registered look (phase=${t2Done.phase})`);
  }
  writeFileSync("/tmp/lift-t2-live.json", `${JSON.stringify(t2Done, null, 2)}\n`);
  try {
    copyFileSync("/tmp/lift-orch.log", "/tmp/lift-t2-orch.log");
  } catch {
    /* optional */
  }

  await resetToNeutral(page);
  await startFreshXterm("lift-t2b");
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  await withClip("t2b-approve-rollout", async () => {
    await typeInXterm("lift-t2b", orchCommand(["--approve", String(t2ExpId), "--apply", "--no-ui"]));
    await waitLog(/Type APPROVE/, 45_000);
    await activateXterm("lift-t2b");
    xdo(["type", "--delay", "90", `APPROVE ${t2ExpId}`]);
    await sleep(200);
    xdo(["key", "--clearmodifiers", "Return"]);
    await waitLive(
      (s) =>
        (s.events ?? []).some(
          (event) => /Flagsmith:/i.test(event.message ?? "") && /Decision:/i.test(event.message ?? ""),
        ),
      90_000,
      "t2b decision line",
      { failOnError: true },
    );
    await hold(3200);
    await waitLive(
      (s) =>
        s.phase === "complete" &&
        (s.events ?? []).some((event) => /Rolled out .+ Experiment \d+ completed/.test(event.message ?? "")),
      180_000,
      "t2b rollout done",
      { failOnError: true },
    );
    await hold(3200);
    await showRolledOutFeature(page, t2Done.flag?.flagName ?? t2Flag, t2Dash);
    await hold(3200);
    assertNotLogin(page, "t2b");
  });

  await resetToNeutral(page);
  await startFreshXterm("lift-t1", "92x16+0+40");
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  await withClip("t1-experiment", async () => {
    await typeInXterm("lift-t1", orchCommand(["--results", String(t2ExpId), "--no-ui"]));
    await waitLog(/Flagsmith:.*Decision:/, 60_000);
    await hold(2000);
    await openExperimentOnCamera(page, t2Flag, t2Dash, t2ExpId);
    await hold(3200);
    await visibleScrollAnalysis(page);
    await hold(3200);
    assertNotLogin(page, "t1");
  });

  writeFileSync(LIVE_PATH, "{}\n");
  writeFileSync("/tmp/lift-orch.log", "");
  const l2Flag = `lift_orch_l2_${Date.now().toString().slice(-6)}`;
  const l2Args = [
    "--apply",
    "--keep-ui",
    "--generations",
    "1",
    "--traffic-n",
    String(RECORDING_TRAFFIC_N_L2),
    "--flag-name",
    l2Flag,
    "--site-url",
    "http://127.0.0.1:4191/checkout",
    "--ui-port",
    "4181",
  ];

  await resetToNeutral(page);
  await startFreshXterm("lift-l2a");
  await withClip("l2a-gen1-champion", async () => {
    await typeInXterm("lift-l2a", orchCommand(l2Args));
    const live = await waitLive(
      (s) => (s.events ?? []).some((event) => /gen-1 champion /.test(event.message ?? "")),
      900_000,
      "l2 gen-1 champion",
    );
    await hold(3200);
    const gen1 = live.generations?.[0]?.flag ?? live.flag;
    const gen1Id = gen1?.experimentId;
    const gen1Dash = gen1?.dashboardUrl || live.dashboardExperimentUrl || "";
    if (!gen1Id || !gen1Dash) throw new Error("L2 gen-1 missing experiment id");
    await openExperimentOnCamera(page, l2Flag, gen1Dash, gen1Id);
    await hold(3200);
    assertNotLogin(page, "l2a");
  });

  const l2Gen1 = await waitLive((s) => pausedPhase(s.phase) && Boolean(s.generations?.[0]?.recommendation), 120_000, "l2a done");
  if (l2Gen1.generations?.[0]?.recommendation?.kind !== "winner") {
    throw new Error("L2 gen-1 did not produce a champion");
  }
  await sleep(2500);

  const l2bArgs = [
    "--apply",
    "--keep-ui",
    "--from-generation",
    "2",
    "--generations",
    "2",
    "--traffic-n",
    String(RECORDING_TRAFFIC_N_GEN2),
    "--flag-name",
    l2Flag,
    "--site-url",
    "http://127.0.0.1:4191/checkout",
    "--ui-port",
    "4182",
  ];

  await resetToNeutral(page);
  await startFreshXterm("lift-l2b");
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  await withClip("l2b-gen2-gate-rollout", async () => {
    await typeInXterm("lift-l2b", orchCommand(l2bArgs));
    await waitLive(
      (s) =>
        (s.events ?? []).some((event) => event.kind === "reject" && /g2-.*bad-contrast|added axe rules/i.test(event.message ?? "")),
      180_000,
      "l2 gen-2 REJECT canary",
    );
    await waitLive(
      (s) => (s.events ?? []).some((event) => /Control = gen-1 champion /.test(event.message ?? "")),
      60_000,
      "l2 gen-2 control label",
    );
    const live = await waitLive(
      (s) => (s.events ?? []).some((event) => /Gen-2 inconclusive/.test(event.message ?? "")) || pausedPhase(s.phase),
      600_000,
      "l2 gen-2 inconclusive",
    );
    if (!(live.events ?? []).some((event) => /Gen-2 inconclusive/.test(event.message ?? ""))) {
      throw new Error("L2 gen-2 did not print the inconclusive champion-stays line");
    }
    await hold(3200);
    const gen2 = live.generations?.find((item) => item.generation === 2)?.flag ?? live.flag;
    const gen2Id = gen2?.experimentId;
    const gen2Dash = gen2?.dashboardUrl || live.dashboardExperimentUrl || "";
    const gen2Name = gen2?.flagName ?? `${l2Flag}_g2`;
    if (!gen2Id || !gen2Dash) throw new Error("L2 gen-2 missing experiment id");
    await openExperimentOnCamera(page, gen2Name, gen2Dash, gen2Id);
    await hold(3200);
    assertNotLogin(page, "l2b");
  });

  await Promise.race([
    context.close().then(() => browser.close()),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
