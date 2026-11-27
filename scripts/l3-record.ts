/**
 * Headed Chrome recordings for Lift L3 against a real self-hosted Flagsmith.
 * Captures the whole DISPLAY with ffmpeg x11grab so both tiled windows
 * (demo + Flagsmith) keep their URL bars. Never --app, never Playwright video.
 * Overlay captions are not used as evidence.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type Page } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { ROOT } from "../agent/src/config.ts";

declare global {
  interface Window {
    LiftL3: {
      forceScore: (n: number | null) => void;
      ingest: (kind: string, sample: unknown) => void;
      stop: () => void;
      start: () => Promise<unknown>;
      getRuntime: () => {
        flagsmith: unknown;
        offline: boolean;
        optedOut: boolean;
        traitRetryTimer: number;
        traitSeq: number;
      };
    };
  }
}

loadEnv({ path: resolve(ROOT, ".env") });

const PORT = 4175;
const BASE = `http://127.0.0.1:${PORT}`;
const FLAGSMITH_ORIGIN = "http://127.0.0.1:8000";
const OUT_DIRS = [
  resolve("/opt/cursor/artifacts"),
  resolve("/cursor/stores/self/artifacts"),
  resolve(ROOT, "test-results/l3-recordings"),
];
const RECORD_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-777777777777";
const NOFLAP_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-999999999999";
const SEGMENT_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-666666666666";
const FAILOPEN_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-888888888888";
const TILE = { w: 960, h: 1020 };

interface L3State {
  dashboardUrl: string;
  projectId: string;
  environmentId: string;
  environmentUuid?: string;
  segmentId: number;
  flagId: number;
}

interface HeadedWindow {
  browser: Browser;
  page: Page;
  winId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function loadState(): L3State {
  const path = resolve(ROOT, "data/l3-state.json");
  if (!existsSync(path)) {
    throw new Error("data/l3-state.json missing — run npm run l3:bootstrap first");
  }
  return JSON.parse(readFileSync(path, "utf8")) as L3State;
}

function loadDemoConfig(): { flagsmithApiUrl: string; flagsmithEnvironmentKey: string } {
  const path = resolve(ROOT, "demo/l3/config.json");
  if (!existsSync(path)) {
    throw new Error("demo/l3/config.json missing — run npm run l3:bootstrap first");
  }
  return JSON.parse(readFileSync(path, "utf8")) as {
    flagsmithApiUrl: string;
    flagsmithEnvironmentKey: string;
  };
}

function chromePath(): string | undefined {
  return existsSync("/usr/local/bin/google-chrome") ? "/usr/local/bin/google-chrome" : undefined;
}

function environmentRef(state: L3State): string {
  return env("FLAGSMITH_ENVIRONMENT_KEY") || state.environmentUuid || state.environmentId;
}

function identitiesUrl(state: L3State): string {
  const origin = state.dashboardUrl || FLAGSMITH_ORIGIN;
  return `${origin}/project/${state.projectId}/environment/${environmentRef(state)}/identities`;
}

function projectSegmentsUrl(state: L3State): string {
  const origin = state.dashboardUrl || FLAGSMITH_ORIGIN;
  return `${origin}/project/${state.projectId}/segments/${state.segmentId}`;
}

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* boot */
    }
    await sleep(150);
  }
  throw new Error("L3 demo server did not start");
}

function chromeWindowIds(): string[] {
  try {
    const out = execFileSync("xdotool", ["search", "--class", "Google-chrome"], {
      encoding: "utf8",
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
    });
    return out
      .trim()
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    try {
      const out = execFileSync("xdotool", ["search", "--class", "google-chrome"], {
        encoding: "utf8",
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
      });
      return out
        .trim()
        .split("\n")
        .map((id) => id.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function placeWin(winId: string, x: number, y: number, w: number, h: number): void {
  if (!winId) return;
  const envx = { ...process.env, DISPLAY: process.env.DISPLAY || ":1" };
  const run = (args: string[]) => {
    try {
      execFileSync("xdotool", args, { env: envx, stdio: "ignore" });
    } catch {
      /* the window may still be mapping */
    }
  };
  run(["windowmap", winId]);
  run(["windowsize", "--sync", winId, String(w), String(h)]);
  run(["windowmove", "--sync", winId, String(x), String(y)]);
  run(["windowsize", winId, String(w), String(h)]);
  run(["windowmove", winId, String(x), String(y)]);
}

function pin(win: HeadedWindow): void {
  placeWin(win.winId, win.x, win.y, win.w, win.h);
}

function retile(win: HeadedWindow): void {
  placeWin(win.winId, win.x, win.y, win.w, win.h);
}

async function hideFlagsmithSnippets(page: Page) {
  await page
    .addStyleTag({
      content: `
        [class*="CodeExample"], [class*="code-example"], [class*="SDKToken"],
        [class*="sdk-token"], .hljs, pre code, .CodeMirror {
          display: none !important;
        }
      `,
    })
    .catch(() => {});
  await page
    .evaluate(() => {
      const leak = /\bser\.[A-Za-z0-9]{8,}/;
      for (const el of document.querySelectorAll(
        "pre, code, textarea, [class*='CodeExample'], [class*='SDKToken'], [class*='sdk-token']",
      )) {
        if (!leak.test(el.textContent ?? "")) continue;
        const node = el as HTMLElement;
        node.style.setProperty("display", "none", "important");
        node.hidden = true;
      }
    })
    .catch(() => {});
}

function publishMp4(src: string, name: string) {
  for (const dir of OUT_DIRS) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, resolve(dir, name));
  }
}

async function adminGet<T>(path: string): Promise<T> {
  const api = env("FLAGSMITH_API_URL", `${FLAGSMITH_ORIGIN}/api/v1/`).replace(/\/?$/, "/");
  const token = env("FLAGSMITH_ADMIN_API_TOKEN");
  const res = await fetch(`${api}${path.replace(/^\//, "")}`, {
    headers: {
      Authorization: `Api-Key ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Admin GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

async function waitForIdentityId(identifier: string): Promise<number> {
  const ekey = env("FLAGSMITH_ENVIRONMENT_KEY");
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const data = await adminGet<{ results?: Array<{ id: number; identifier: string }> }>(
      `environments/${encodeURIComponent(ekey)}/identities/?q=${encodeURIComponent(identifier)}`,
    );
    const match = (data.results ?? []).find((row) => row.identifier === identifier);
    if (match) return match.id;
    await sleep(400);
  }
  throw new Error("Identity did not appear in Flagsmith");
}

async function loginFlagsmith(page: Page, state: L3State): Promise<void> {
  const origin = state.dashboardUrl || FLAGSMITH_ORIGIN;
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  await hideFlagsmithSnippets(page);
  const features = page.locator('[data-test="features-page"], [data-test="home-link"]');
  if (await features.first().isVisible({ timeout: 2_000 }).catch(() => false)) return;

  const email = env("FLAGSMITH_BOOTSTRAP_EMAIL");
  const password = env("FLAGSMITH_BOOTSTRAP_PASSWORD");
  if (!email || !password) {
    throw new Error("FLAGSMITH_BOOTSTRAP_EMAIL / PASSWORD missing from gitignored .env");
  }
  const emailBox = page.locator('[data-test="email"]');
  await emailBox.waitFor({ timeout: 20_000 });
  await emailBox.fill(email);
  const passwordBox = page.locator('[data-test="password"]');
  await passwordBox.waitFor();
  if ((await passwordBox.getAttribute("type")) !== "password") {
    throw new Error("Flagsmith password field is not type=password");
  }
  await passwordBox.fill(password);
  await passwordBox.press("Enter");
  await page.waitForTimeout(2_000);
  await hideFlagsmithSnippets(page);
}

async function openIdentity(page: Page, state: L3State, identifier: string): Promise<void> {
  await waitForIdentityId(identifier);
  await page.goto(identitiesUrl(state), { waitUntil: "domcontentloaded" });
  await hideFlagsmithSnippets(page);
  const search = page.getByPlaceholder(/search/i).locator("visible=true");
  await search.waitFor({ timeout: 15_000 });
  await search.fill(identifier);
  await page.getByText(identifier, { exact: true }).first().waitFor({ timeout: 15_000 });
  await page.getByText(identifier, { exact: true }).first().click();
  await page.getByText("Traits", { exact: true }).first().waitFor({ timeout: 15_000 });
  await hideFlagsmithSnippets(page);
  await page.waitForTimeout(400);
}

function xenv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: process.env.DISPLAY || ":1" };
}

function xdo(args: string[]): void {
  try {
    execFileSync("xdotool", args, { env: xenv(), stdio: "ignore" });
  } catch {
    /* window may still be mapping */
  }
}

function visibleReload(win: HeadedWindow, mode: "click" | "f5" = "click"): void {
  pin(win);
  xdo(["windowactivate", "--sync", win.winId]);
  if (mode === "f5") {
    xdo(["key", "--window", win.winId, "F5"]);
  } else {
    // Reload sits in the toolbar past the back/forward buttons, not on window controls.
    const x = win.x + 72;
    const y = win.y + 82;
    xdo(["mousemove", "--sync", String(x), String(y)]);
    xdo(["sleep", "0.35"]);
    xdo(["click", "1"]);
  }
  pin(win);
}

async function refreshIdentity(win: HeadedWindow, others: HeadedWindow[] = []): Promise<void> {
  visibleReload(win, "f5");
  for (const other of others) pin(other);
  await sleep(900);
  await hideFlagsmithSnippets(win.page);
  await win.page.getByText("Traits", { exact: true }).first().waitFor({ timeout: 15_000 });
  await hideFlagsmithSnippets(win.page);
  pin(win);
  for (const other of others) pin(other);
}

async function xType(text: string, delayMs = 55): Promise<void> {
  try {
    execFileSync("xdotool", ["type", "--delay", String(delayMs), "--", text], {
      env: xenv(),
      stdio: "ignore",
    });
  } catch {
    /* compositor may drop keys */
  }
  await sleep(delayMs);
}

async function visibleDragSlider(page: Page, from01: number, to01: number): Promise<void> {
  const box = await page.locator("#lift-biometric").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const topChrome = Math.max(0, window.outerHeight - window.innerHeight);
    return {
      x: Math.round(window.screenX + r.left),
      y: Math.round(window.screenY + topChrome + r.top + r.height / 2),
      w: Math.round(r.width),
    };
  });
  const start = box.x + Math.round(box.w * Math.min(1, Math.max(0, from01)));
  const end = box.x + Math.round(box.w * Math.min(1, Math.max(0, to01)));
  const y = box.y;
  xdo(["mousemove", "--sync", String(start), String(y)]);
  await sleep(120);
  xdo(["mousedown", "1"]);
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(start + ((end - start) * i) / steps);
    xdo(["mousemove", "--sync", String(x), String(y)]);
    await sleep(35);
  }
  xdo(["mouseup", "1"]);
  await sleep(200);
}

async function visiblePointerStress(win: HeadedWindow, page: Page, ms = 4_200): Promise<void> {
  xdo(["windowactivate", "--sync", win.winId]);
  // Cookie overlay covers the left of the slider; grab from mid-track instead.
  await visibleDragSlider(page, 0.55, 1);
  await sleep(400);
  const originX = win.x + 220;
  const originY = win.y + 260;
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < ms) {
    const x = originX + (n % 2 === 0 ? -70 : 80) + (n % 5) * 6;
    const y = originY + (n % 3 === 0 ? -80 : 55) + (n % 4) * 8;
    xdo(["mousemove", "--sync", String(x), String(y)]);
    if (n % 7 === 0) {
      xdo(["click", "1"]);
      await sleep(40);
      xdo(["click", "1"]);
      await sleep(40);
      xdo(["click", "1"]);
    }
    if (n % 5 === 0) {
      xdo(["click", "5"]);
      await sleep(30);
      xdo(["click", "4"]);
    }
    await sleep(18);
    n += 1;
  }
}

async function assertFlagsmithBlockedFromPage(page: Page): Promise<void> {
  const blocked = await page.evaluate(async () => {
    try {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch("http://127.0.0.1:8000/api/v1/flags/", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      window.clearTimeout(timer);
      return !res.ok;
    } catch {
      return true;
    }
  });
  if (!blocked) {
    throw new Error("Flagsmith still reachable from the L3 app window after request blocking");
  }
}

async function assertFlagsmithReachableFromPage(page: Page): Promise<void> {
  const ok = await page.evaluate(async () => {
    try {
      const res = await fetch("/version/", { cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  });
  if (!ok) {
    throw new Error("Flagsmith window lost connectivity; the shared container must stay up");
  }
}

async function persistFlagsmithBlock(page: Page): Promise<void> {
  await page.unroute("http://127.0.0.1:8000/**").catch(() => {});
  await page.unroute("http://127.0.0.1:8000").catch(() => {});
  await page.route("http://127.0.0.1:8000/**", (route) => route.abort());
  await page.route("http://127.0.0.1:8000", (route) => route.abort());
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.setBlockedURLs", {
      urls: ["*://127.0.0.1:8000/*", "*://127.0.0.1:8000*", "127.0.0.1:8000"],
    });
  } catch {
    /* DevTools UI is the evidence; CDP/route keep the reload blocked */
  }
}

async function blockFlagsmithInDevTools(
  win: HeadedWindow,
  page: Page,
  alreadyOpen = false,
): Promise<void> {
  xdo(["windowactivate", "--sync", win.winId]);
  pin(win);
  await sleep(300);
  if (!alreadyOpen) {
    xdo(["key", "--window", win.winId, "F12"]);
    await sleep(1_100);
  }
  pin(win);
  xdo(["key", "Escape"]);
  await sleep(200);
  xdo(["key", "Escape"]);
  await sleep(200);
  // DevTools is docked right. Click the panel so Ctrl+Shift+P is the
  // command palette, not Chrome's print dialog.
  xdo(["mousemove", "--sync", String(win.x + 720), String(win.y + 260)]);
  await sleep(280);
  xdo(["click", "1"]);
  await sleep(350);
  xdo(["key", "ctrl+shift+p"]);
  await sleep(550);
  await xType("Show Network", 35);
  await sleep(280);
  xdo(["key", "Return"]);
  await sleep(800);
  xdo(["key", "ctrl+shift+p"]);
  await sleep(550);
  await xType("Show Request conditions", 35);
  await sleep(280);
  xdo(["key", "Return"]);
  await sleep(1_000);
  // "Add rule" in the Request conditions drawer; adding a rule auto-enables blocking.
  xdo(["mousemove", "--sync", String(win.x + 650), String(win.y + 968)]);
  await sleep(250);
  xdo(["click", "1"]);
  await sleep(600);
  await xType("*://127.0.0.1:8000/*", 35);
  await sleep(400);
  xdo(["key", "Return"]);
  await sleep(800);
  await persistFlagsmithBlock(page);
  await assertFlagsmithBlockedFromPage(page);
}

async function visibleConsoleForceScore(win: HeadedWindow, page: Page, score = 0.95): Promise<void> {
  xdo(["windowactivate", "--sync", win.winId]);
  await sleep(250);
  xdo(["key", "Escape"]);
  await sleep(150);
  xdo(["mousemove", "--sync", String(win.x + 720), String(win.y + 260)]);
  await sleep(200);
  xdo(["click", "1"]);
  await sleep(300);
  xdo(["mousemove", "--sync", String(win.x + 940), String(win.y + 825)]);
  await sleep(200);
  xdo(["click", "1"]);
  await sleep(300);
  xdo(["key", "ctrl+shift+p"]);
  await sleep(500);
  await xType("Show Console", 35);
  await sleep(250);
  xdo(["key", "Return"]);
  await sleep(800);
  xdo(["mousemove", "--sync", String(win.x + 430), String(win.y + 168)]);
  await sleep(200);
  xdo(["click", "1"]);
  await sleep(300);
  await xType(`LiftL3.forceScore(${score})`, 35);
  await sleep(250);
  xdo(["key", "Return"]);
  await page.waitForFunction(
    (n) => {
      const hud = document.querySelector("#lift-l3-hud");
      return Boolean(
        hud &&
          (hud.textContent ?? "").includes("(forced)") &&
          Number(hud.getAttribute("data-score")) >= n - 0.02,
      );
    },
    score,
    { timeout: 12_000 },
  );
}

async function confirmFeatureSegmentsRoute(): Promise<void> {
  const state = loadState();
  const api = env("FLAGSMITH_API_URL", `${FLAGSMITH_ORIGIN}/api/v1/`).replace(/\/?$/, "/");
  const token = env("FLAGSMITH_ADMIN_API_TOKEN");
  const url = `${api}features/feature-segments/?environment=${encodeURIComponent(state.environmentId)}&feature=${state.flagId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Api-Key ${token}`,
      Accept: "application/json",
    },
  });
  process.stdout.write(`feature-segments GET ${res.status} ${url}\n`);
  if (res.status !== 200) {
    throw new Error(`expected /features/feature-segments/?environment= to return 200, got ${res.status}`);
  }
}

async function launchWindow(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { devtools?: boolean } = {},
): Promise<HeadedWindow> {
  const before = new Set(chromeWindowIds());
  const browser = await chromium.launch({
    headless: false,
    executablePath: chromePath(),
    args: [
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-position=${x},${y}`,
      `--window-size=${w},${h}`,
      "--disable-features=Translate",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      ...(opts.devtools ? ["--auto-open-devtools-for-tabs"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation", "--hide-scrollbars"],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  let winId = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    const ids = chromeWindowIds().filter((id) => !before.has(id));
    if (ids.length) {
      winId = ids[ids.length - 1] ?? "";
      break;
    }
    await sleep(150);
  }
  placeWin(winId, x, y, w, h);
  return { browser, page, winId, x, y, w, h };
}

function startGrab(outPath: string): ChildProcess {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const child = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-draw_mouse",
      "1",
      "-framerate",
      "25",
      "-video_size",
      "1920x1200",
      "-i",
      `${process.env.DISPLAY || ":1"}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outPath,
    ],
    { stdio: "ignore" },
  );
  return child;
}

async function stopGrab(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 8_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGINT");
  });
}

async function driftScore(page: Page, values: number[], holdMs: number): Promise<void> {
  for (const value of values) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), value);
    await sleep(holdMs);
  }
}

async function sweepScore(page: Page, from: number, to: number, stepMs = 320): Promise<void> {
  const delta = to >= from ? 0.02 : -0.02;
  const values: number[] = [];
  if (delta > 0) {
    for (let n = from; n <= to + 1e-9; n += delta) values.push(Number(n.toFixed(2)));
  } else {
    for (let n = from; n >= to - 1e-9; n += delta) values.push(Number(n.toFixed(2)));
  }
  if (values[values.length - 1] !== Number(to.toFixed(2))) values.push(Number(to.toFixed(2)));
  await driftScore(page, values, stepMs);
}

async function waitUntilCalm(page: Page): Promise<void> {
  const on = await page.locator("html").evaluate((el) => el.classList.contains("lift-sensory-safe"));
  if (!on) return;
  await page.evaluate(() => window.LiftL3.forceScore(0.12));
  await page.waitForSelector("html:not(.lift-sensory-safe)", { timeout: 25_000 });
  await page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 25_000 });
  await page.evaluate(() => window.LiftL3.forceScore(null));
  await sleep(400);
}

async function fullLoop(): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  const demo = await launchWindow(0, 0, TILE.w, TILE.h);
  const admin = await launchWindow(960, 0, TILE.w, TILE.h);
  const tmp = resolve(ROOT, "test-results/l3-recordings", "l3-full-loop-grab.mp4");
  let grab: ChildProcess | null = null;
  try {
    await loginFlagsmith(admin.page, state);
    retile(admin);
    await demo.page.goto(`${BASE}/?lift_identity=${RECORD_IDENTITY}`, {
      waitUntil: "domcontentloaded",
    });
    await demo.page.waitForSelector("#lift-l3-hud", { timeout: 20_000 });
    await waitUntilCalm(demo.page);
    await demo.page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });
    retile(demo);
    await openIdentity(admin.page, state, RECORD_IDENTITY);
    retile(admin);
    retile(demo);
    await sleep(800);
    grab = startGrab(tmp);
    await sleep(1_000);
    await visiblePointerStress(demo, demo.page, 4_400);
    pin(demo);
    pin(admin);
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
    await demo.page.waitForSelector("#lift-l3-hud[data-flag='true']", { timeout: 20_000 });
    pin(demo);
    pin(admin);
    await sleep(2_400);
    await refreshIdentity(admin, [demo]);
    xdo(["windowactivate", "--sync", admin.winId]);
    xdo(["mousemove", "--sync", String(admin.x + 480), String(admin.y + 520)]);
    for (let i = 0; i < 7; i += 1) {
      xdo(["click", "5"]);
      await sleep(140);
    }
    pin(admin);
    pin(demo);
    await sleep(2_400);
    await visibleDragSlider(demo.page, 1, 0.08);
    await demo.page.waitForFunction(
      () => {
        const hud = document.querySelector("#lift-l3-hud");
        if (!hud) return false;
        if ((hud.textContent ?? "").includes("(forced)")) return false;
        return Number(hud.getAttribute("data-score")) < 0.38;
      },
      null,
      { timeout: 20_000 },
    );
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 40_000 });
    await sleep(2_200);
    await refreshIdentity(admin, [demo]);
    await sleep(2_800);
  } finally {
    if (grab) await stopGrab(grab);
    await demo.browser.close().catch(() => {});
    await admin.browser.close().catch(() => {});
  }
  publishMp4(tmp, "l3-full-loop.mp4");
}

async function noFlap(): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  const demo = await launchWindow(0, 0, TILE.w, TILE.h);
  const admin = await launchWindow(960, 0, TILE.w, TILE.h);
  const tmp = resolve(ROOT, "test-results/l3-recordings", "l3-no-flap-grab.mp4");
  let grab: ChildProcess | null = null;
  try {
    await loginFlagsmith(admin.page, state);
    retile(admin);
    await demo.page.goto(`${BASE}/?lift_identity=${NOFLAP_IDENTITY}`, {
      waitUntil: "domcontentloaded",
    });
    await demo.page.waitForSelector("#lift-l3-hud", { timeout: 20_000 });
    await waitUntilCalm(demo.page);
    await demo.page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });
    retile(demo);
    await openIdentity(admin.page, state, NOFLAP_IDENTITY);
    retile(admin);
    retile(demo);
    grab = startGrab(tmp);
    await sleep(1_200);
    await sweepScore(demo.page, 0.48, 0.6, 320);
    await sweepScore(demo.page, 0.6, 0.5, 320);
    for (let i = 0; i < 5; i += 1) {
      await sweepScore(demo.page, 0.54, 0.64, 180);
      await sweepScore(demo.page, 0.64, 0.54, 180);
    }
    await sleep(1_000);
    await sweepScore(demo.page, 0.54, 0.9, 260);
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
    await sleep(2_000);
    await refreshIdentity(admin, [demo]);
    await sleep(2_800);
    await sweepScore(demo.page, 0.9, 0.45, 420);
    await sleep(1_600);
    await sweepScore(demo.page, 0.45, 0.4, 500);
    await sleep(2_400);
  } finally {
    if (grab) await stopGrab(grab);
    await demo.browser.close().catch(() => {});
    await admin.browser.close().catch(() => {});
  }
  publishMp4(tmp, "l3-no-flap.mp4");
}

async function segment(): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  const demo = await launchWindow(0, 0, TILE.w, TILE.h);
  const admin = await launchWindow(960, 0, TILE.w, TILE.h);
  const tmp = resolve(ROOT, "test-results/l3-recordings", "l3-flagsmith-segment-grab.mp4");
  let grab: ChildProcess | null = null;
  try {
    await loginFlagsmith(admin.page, state);
    retile(admin);
    await demo.page.goto(`${BASE}/?lift_identity=${SEGMENT_IDENTITY}`, {
      waitUntil: "domcontentloaded",
    });
    await demo.page.waitForSelector("#lift-l3-hud", { timeout: 20_000 });
    await waitUntilCalm(demo.page);
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 20_000 });
    retile(demo);
    await admin.page.goto(projectSegmentsUrl(state), { waitUntil: "domcontentloaded" });
    await hideFlagsmithSnippets(admin.page);
    await admin.page.waitForSelector("text=overstimulated", { timeout: 15_000 });
    retile(admin);
    retile(demo);
    grab = startGrab(tmp);
    await sleep(4_000);
    await openIdentity(admin.page, state, SEGMENT_IDENTITY);
    await sleep(2_800);
    await sweepScore(demo.page, 0.2, 0.95, 280);
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
    await sleep(1_800);
    await refreshIdentity(admin, [demo]);
    await sleep(3_000);
    await sweepScore(demo.page, 0.95, 0.1, 380);
    await demo.page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 25_000 });
    await sleep(1_600);
    await refreshIdentity(admin, [demo]);
    await sleep(3_200);
  } finally {
    if (grab) await stopGrab(grab);
    await demo.browser.close().catch(() => {});
    await admin.browser.close().catch(() => {});
  }
  publishMp4(tmp, "l3-flagsmith-segment.mp4");
}

async function failOpenClip(): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  const demo = await launchWindow(0, 0, TILE.w, TILE.h, { devtools: true });
  const admin = await launchWindow(960, 0, TILE.w, TILE.h);
  const tmp = resolve(ROOT, "test-results/l3-recordings", "l3-fail-open-grab.mp4");
  let grab: ChildProcess | null = null;
  try {
    await loginFlagsmith(admin.page, state);
    retile(admin);
    await demo.page.goto(`${BASE}/?lift_identity=${FAILOPEN_IDENTITY}`, {
      waitUntil: "domcontentloaded",
    });
    await demo.page.waitForSelector("#lift-l3-hud", { timeout: 20_000 });
    await waitUntilCalm(demo.page);
    await demo.page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });
    retile(demo);
    await openIdentity(admin.page, state, FAILOPEN_IDENTITY);
    retile(admin);
    retile(demo);
    grab = startGrab(tmp);
    await sleep(1_200);
    pin(demo);
    pin(admin);
    await blockFlagsmithInDevTools(demo, demo.page, true);
    pin(demo);
    pin(admin);
    await sleep(800);
    visibleReload(admin, "click");
    pin(demo);
    pin(admin);
    await admin.page.getByText("Traits", { exact: true }).first().waitFor({ timeout: 15_000 });
    await assertFlagsmithReachableFromPage(admin.page);
    await hideFlagsmithSnippets(admin.page);
    pin(demo);
    pin(admin);
    await sleep(1_400);
    xdo(["windowactivate", "--sync", demo.winId]);
    xdo(["key", "Escape"]);
    await sleep(200);
    const reloaded = demo.page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    visibleReload(demo, "f5");
    await reloaded;
    pin(demo);
    pin(admin);
    await demo.page.waitForSelector("#lift-l3-hud", { timeout: 20_000 });
    await demo.page.waitForSelector("#lift-l3-offline", { timeout: 25_000 });
    await demo.page.waitForFunction(
      () =>
        (document.querySelector("#lift-l3-hud")?.textContent ?? "").includes(
          "(default, Flagsmith unreachable)",
        ),
      null,
      { timeout: 15_000 },
    );
    pin(demo);
    pin(admin);
    await sleep(900);
    await visibleConsoleForceScore(demo, demo.page, 0.95);
    pin(demo);
    pin(admin);
    await sleep(2_800);
    await demo.page.waitForSelector("html:not(.lift-sensory-safe)");
    await demo.page.waitForSelector("[data-lift-promo]", { state: "visible" });
    await demo.page.waitForSelector("[data-lift-cookie]", { state: "visible" });
    await sleep(2_200);
  } finally {
    if (grab) await stopGrab(grab);
    await demo.browser.close().catch(() => {});
    await admin.browser.close().catch(() => {});
  }
  publishMp4(tmp, "l3-fail-open.mp4");
}

async function main() {
  let server: ChildProcess | null = null;
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg?.slice("--only=".length) ?? "all";
  if (process.argv.includes("--allow-stop-shared-flagsmith")) {
    throw new Error(
      "Stopping the shared Flagsmith container is disabled and excluded from --only=all. Block 127.0.0.1:8000 in the app window DevTools instead.",
    );
  }
  try {
    const up = await fetch(BASE)
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) {
      server = spawn("npx", ["tsx", "scripts/serve-l3.ts", "--port", String(PORT)], {
        cwd: ROOT,
        stdio: "pipe",
      });
      await waitForServer();
    }
    await confirmFeatureSegmentsRoute();
    const jobs: Record<string, () => Promise<void>> = {
      "l3-full-loop": fullLoop,
      "l3-no-flap": noFlap,
      "l3-flagsmith-segment": segment,
      "l3-fail-open": failOpenClip,
    };
    const selected =
      only === "all"
        ? ["l3-full-loop", "l3-no-flap", "l3-flagsmith-segment", "l3-fail-open"]
        : only === "full"
          ? ["l3-full-loop"]
          : only === "noflap"
            ? ["l3-no-flap"]
            : only === "segment"
              ? ["l3-flagsmith-segment"]
              : only === "failopen"
                ? ["l3-fail-open"]
                : [only];
    for (const name of selected) {
      const run = jobs[name];
      if (!run) throw new Error(`Unknown recording ${name}`);
      await run();
    }
    process.stdout.write(`${JSON.stringify({ out: OUT_DIRS, selected }, null, 2)}\n`);
  } finally {
    server?.kill("SIGTERM");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
