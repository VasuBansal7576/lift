/**
 * Continuous live recordings for Track 1 / Track 2.
 * Logs in to Flagsmith before ffmpeg starts so credentials are not on screen.
 * After ffmpeg starts: xdotool pointer moves + clicks, omnibox URL typing, or F5 only.
 * Real Flagsmith URLs (public client env key in the path is acceptable).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { chromium, type Locator, type Page } from "@playwright/test";
import { formatDecisionLine, formatGen2Inconclusive } from "../src/agents/analyst.ts";
import { LIVE_PATH, REPO_ROOT } from "../src/paths.ts";
import { viewportToScreen, RECORDING_TRAFFIC_N_T2, RECORDING_TRAFFIC_N_L2 } from "../src/record-nav.ts";
import type { AnalystRecommendation } from "../src/types.ts";

if (existsSync("/tmp/lift-flagsmith.env")) {
  loadEnv({ path: "/tmp/lift-flagsmith.env" });
}

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
    xdo(["mousemove_relative", "--", "8", "0"]);
    xdo(["mousemove_relative", "--", "-8", "0"]);
  } catch {
    /* display optional */
  }
}

async function hold(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    wiggleMouse();
    await sleep(Math.min(1600, Math.max(80, end - Date.now())));
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
}

function spawnEmptyXterm(title: string, geometry = "92x24+0+40"): void {
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
    { env: DISPLAY_ENV, stdio: "ignore" },
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

function pausedPhase(phase?: string): boolean {
  return (
    phase === "WAITING_FOR_HUMAN_APPROVAL" ||
    phase === "KEEP_COLLECTING" ||
    phase === "complete" ||
    phase === "aborted"
  );
}

async function openExperimentOnCamera(page: Page, flagName: string, dashboardUrl: string): Promise<void> {
  const experiments = page.getByRole("link", { name: /^Experiments$/ });
  if (await experiments.count()) {
    await pointerClick(page, experiments.first());
    await page.waitForTimeout(1000);
  } else {
    await typeUrlInOmnibox(page, dashboardUrl);
  }
  assertNotLogin(page, "openExperiment");
  const row = page.getByText(flagName, { exact: false }).first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.scrollIntoViewIfNeeded();
  await pointerClick(page, row);
  await page.waitForTimeout(1000);
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, `experiment ${flagName}`);
}

async function showRolledOutFeature(page: Page, flagName: string, dashboardUrl: string): Promise<void> {
  const featuresUrl = dashboardUrl.replace(/\/experiments\/\d+.*$/, "/features");
  await typeUrlInOmnibox(page, featuresUrl);
  const search = page.getByPlaceholder(/^Search$/);
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await pointerClick(page, search);
  await sleep(150);
  xdo(["type", "--delay", "28", flagName]);
  await sleep(800);
  const visibleName = page.getByText(flagName, { exact: true }).filter({ visible: true }).first();
  const row = page.locator("tr, li, [role='row'], [role='listitem'], a").filter({ hasText: flagName }).filter({ visible: true }).first();
  if (await visibleName.count()) {
    await pointerClick(page, visibleName);
  } else if (await row.count()) {
    await pointerClick(page, row);
  } else {
    await typeUrlInOmnibox(page, dashboardUrl);
  }
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
  assertNotLogin(page, "features winner");
}

async function typeApproveOnCamera(experimentId: number): Promise<void> {
  const title = `lift-approve-${experimentId}`;
  spawnEmptyXterm(title, "80x16+20+640");
  await sleep(700);
  await typeInXterm(
    title,
    `echo 'Recording harness typing APPROVE ${experimentId} standing in for the human approver.'`,
  );
  await sleep(600);
  await typeInXterm(
    title,
    `cd ${REPO_ROOT} && npx tsx orchestrator/src/cli.ts --approve ${experimentId} --apply --no-ui`,
  );
  await sleep(2500);
  await activateXterm(title);
  xdo(["type", "--delay", "110", `APPROVE ${experimentId}`]);
  await sleep(400);
  xdo(["key", "--clearmodifiers", "Return"]);
  await hold(7000);
}

async function withClip(
  name: string,
  minMs: number,
  fn: () => Promise<void>,
): Promise<string> {
  const path = resolve(OUT, `${name}.mp4`);
  const ff = startFfmpeg(path);
  await sleep(400);
  const started = Date.now();
  try {
    await fn();
    const elapsed = Date.now() - started;
    if (elapsed < minMs) await hold(minMs - elapsed);
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
  for (const title of ["lift-t2", "lift-t2b", "lift-t1", "lift-l2", "lift-l2a", "lift-l2b", "lift-approve"]) {
    try {
      const ids = execFileSync("xdotool", ["search", "--name", title], {
        env: DISPLAY_ENV,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const id of ids) xdo(["windowkill", id]);
    } catch {
      /* none */
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  closeOurXterms();
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY || "16";
  process.env.LIFT_ORCH_RESULTS_INITIAL_MS = process.env.LIFT_ORCH_RESULTS_INITIAL_MS || "4000";
  process.env.LIFT_ORCH_RESULTS_WAIT_MS = "240000";
  process.env.LIFT_TRAFFIC_SEED = process.env.LIFT_TRAFFIC_SEED || "20261127";
  process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS = "0";
  process.env.LIFT_RUN_ID = process.env.LIFT_RUN_ID || `rec${Date.now().toString().slice(-8)}`;

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
  const t2Args = [
    "--apply",
    "--keep-ui",
    "--traffic-n",
    String(RECORDING_TRAFFIC_N_T2),
    "--flag-name",
    t2Flag,
    "--site-url",
    "http://127.0.0.1:4184/checkout",
    "--ui-port",
    "4177",
  ];

  await withClip("t2a-gate-launch", 12_000, async () => {
    spawnEmptyXterm("lift-t2");
    await sleep(600);
    await typeInXterm("lift-t2", orchCommand(t2Args));
    await waitLive((s) => s.phase === "gating" || s.phase === "flagging" || s.phase === "traffic", 180_000, "t2 gate");
    const live = await waitLive((s) => Boolean(s.flag?.dashboardUrl || s.dashboardExperimentUrl), 180_000, "t2 flag");
    const dash = live.flag?.dashboardUrl || live.dashboardExperimentUrl || "";
    await typeUrlInOmnibox(page, dash);
    await openExperimentOnCamera(page, t2Flag, dash);
    await waitLive((s) => s.phase === "traffic", 120_000, "t2 traffic start");
    await hold(2500);
  });

  const t2Done = await waitLive((s) => pausedPhase(s.phase), 1_200_000, "t2 waiting");
  const t2Rec = t2Done.recommendation;
  const t2ExpId = t2Done.flag?.experimentId;
  const t2Dash = t2Done.flag?.dashboardUrl || t2Done.dashboardExperimentUrl || "";
  const t2Won = t2Rec?.kind === "winner";

  await withClip("t2b-approve-rollout", 12_000, async () => {
    spawnEmptyXterm("lift-t2b", "92x18+0+640");
    await sleep(500);
    const line = t2Rec ? formatDecisionLine(t2Rec) : "Flagsmith: n/a | Agent threshold: 95% | Decision: KEEP COLLECTING";
    await typeInXterm("lift-t2b", `echo '${line}'`);
    if (t2Dash) await typeUrlInOmnibox(page, t2Dash);
    await hold(3200);
    if (t2Won && t2ExpId && t2Done.flag) {
      await typeInXterm(
        "lift-t2b",
        `echo 'Recording harness typing APPROVE ${t2ExpId} standing in for the human approver.'`,
      );
      await typeApproveOnCamera(t2ExpId);
      await typeUrlInOmnibox(page, t2Dash);
      await showRolledOutFeature(page, t2Done.flag.flagName ?? t2Flag, t2Dash);
      await visibleReload(page);
      await hold(2500);
    } else {
      await typeInXterm("lift-t2b", "echo 'No winner at the pre-registered look; harness is not typing APPROVE.'");
      await hold(2800);
    }
    assertNotLogin(page, "t2b");
  });

  await withClip("t1-experiment", 15_000, async () => {
    spawnEmptyXterm("lift-t1", "92x12+0+40");
    await sleep(500);
    await typeInXterm("lift-t1", `echo t1 experiment ${t2ExpId ?? t2Flag}`);
    const experiments = page.getByRole("link", { name: /^Experiments$/ });
    await experiments.first().waitFor({ state: "visible", timeout: 12_000 });
    await pointerClick(page, experiments.first());
    await page.waitForTimeout(800);
    const row = page.getByText(t2Flag, { exact: false }).first();
    await row.waitFor({ state: "visible", timeout: 12_000 });
    await pointerClick(page, row);
    await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 10_000 });
    await hold(3200);
    const analysis = page.getByText(/^Analysis$/i).first();
    if (await analysis.count()) {
      await analysis.scrollIntoViewIfNeeded();
      await pointerClick(page, analysis);
    } else {
      xdo(["key", "--clearmodifiers", "End"]);
    }
    await hold(3500);
    assertNotLogin(page, "t1");
  });

  writeFileSync(LIVE_PATH, "{}\n");
  writeFileSync("/tmp/lift-orch.log", "");
  const l2Flag = `lift_orch_l2_${Date.now().toString().slice(-6)}`;
  const l2Args = [
    "--apply",
    "--keep-ui",
    "--generations",
    "2",
    "--traffic-n",
    String(RECORDING_TRAFFIC_N_L2),
    "--flag-name",
    l2Flag,
    "--site-url",
    "http://127.0.0.1:4185/checkout",
    "--ui-port",
    "4178",
  ];

  spawnEmptyXterm("lift-l2", "92x24+0+40");
  await sleep(600);
  await typeInXterm("lift-l2", orchCommand(l2Args));
  await waitLive(
    (s) => s.phase === "analysing" || Boolean(s.generations?.[0]) && s.phase === "traffic",
    420_000,
    "l2 gen-1 analysing",
  );

  await withClip("l2a-gen1-champion", 12_000, async () => {
    spawnEmptyXterm("lift-l2a", "92x14+0+640");
    await sleep(500);
    await typeInXterm("lift-l2a", "echo waiting gen-1 analyst result");
    const live0 = readLive();
    const dash = live0.generations?.[0]?.flag?.dashboardUrl || live0.dashboardExperimentUrl || "";
    if (dash) await typeUrlInOmnibox(page, dash);
    const live = await waitLive((s) => Boolean(s.generations?.[0]?.recommendation), 300_000, "l2 gen-1 result");
    const rec = live.generations?.[0]?.recommendation;
    const champion = rec?.kind === "winner" ? rec.arm : rec?.kind === "keep_collecting" ? rec.leading : "?";
    await typeInXterm(
      "lift-l2a",
      `echo 'gen-1 champion ${champion} chance_to_win=${rec && "chanceToWin" in rec ? rec.chanceToWin : "?"}'`,
    );
    await hold(3200);
    const gen1Id = live.generations?.[0]?.flag?.experimentId;
    if (!t2Won && rec?.kind === "winner" && gen1Id) {
      await typeInXterm(
        "lift-l2a",
        `echo 'T2 stayed below 0.95; recording harness typing APPROVE ${gen1Id} for the gen-1 winner.'`,
      );
      await typeApproveOnCamera(gen1Id);
      const gen1Dash = live.generations?.[0]?.flag?.dashboardUrl || dash;
      if (gen1Dash && live.generations?.[0]?.flag) {
        await typeUrlInOmnibox(page, gen1Dash);
        await showRolledOutFeature(page, live.generations[0].flag?.flagName ?? l2Flag, gen1Dash);
        await visibleReload(page);
      }
    }
    assertNotLogin(page, "l2a");
  });

  await waitLive(
    (s) => s.phase === "gating" && Boolean(s.generations?.[0]?.recommendation),
    300_000,
    "l2 gen-2 gating",
  );

  await withClip("l2b-gen2-gate-rollout", 12_000, async () => {
    spawnEmptyXterm("lift-l2b", "92x16+0+640");
    await sleep(500);
    await typeInXterm("lift-l2b", "echo 'Control = gen-1 champion full-v1 (payload key remains control)'");
    await typeInXterm(
      "lift-l2b",
      "echo 'Champion already at the measured ceiling: UA :focus-visible on Place order'",
    );
    await typeInXterm("lift-l2b", "tail -n 0 -f /tmp/lift-orch.log");
    await waitLive(
      (s) =>
        s.phase === "flagging" ||
        s.phase === "traffic" ||
        (s.events ?? []).some((event) => /g2-.*bad-contrast|added axe rules/i.test(event.message ?? "")),
      120_000,
      "l2 gen-2 gate done",
    );
    const hostile = (readLive().events ?? [])
      .filter((event) => event.kind === "reject")
      .find((event) => /bad-contrast|added axe rules/i.test(event.message ?? ""));
    await activateXterm("lift-l2b");
    xdo(["key", "--clearmodifiers", "ctrl+c"]);
    await sleep(200);
    await typeInXterm(
      "lift-l2b",
      `echo 'gen-2 axe ${hostile ? `REJECT ${hostile.message}` : "gate complete"}'`,
    );
    await hold(3200);
    assertNotLogin(page, "l2b");
  });

  const l2Done = await waitLive((s) => pausedPhase(s.phase), 900_000, "l2 waiting");
  const gen2Rec = l2Done.recommendation;
  const gen2Visits = l2Done.generations?.[1]?.visits?.length ?? 0;
  if (gen2Rec?.kind === "keep_collecting") {
    process.stdout.write(`${formatGen2Inconclusive(gen2Rec, gen2Visits)}\n`);
  }

  await Promise.race([
    context.close().then(() => browser.close()),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
