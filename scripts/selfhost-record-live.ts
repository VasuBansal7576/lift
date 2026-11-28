import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { readEnvFile, loadSelfhostEnv } from "../selfhost/src/env.ts";
import { ENV_FILE, PROOF_ENV_FILE, REPO_ROOT } from "../selfhost/src/paths.ts";
import {
  experimentOpenTarget,
  glideScreenPoints,
  reloadButtonScreenPoint,
} from "../selfhost/src/record-pointer.ts";
import {
  abortIfServerKeyInFiles,
  assertNoServerKeyVisible,
  liftScanFiles,
} from "../selfhost/src/redact.ts";
import { writeSiteConfigForSelfhost } from "../selfhost/src/site-config.ts";
import { findApprovePromptFile } from "../selfhost/src/approve.ts";

const PROOF_PROJECT = "lift-selfhost-proof";
const PROOF_ORIGIN = "http://127.0.0.1:8010";
const SHARED_ORIGIN = "http://127.0.0.1:8000";

const DISPLAY = process.env.DISPLAY || ":1";
const recordings = resolve(REPO_ROOT, "recordings/t3-t4");
const artifacts = "/opt/cursor/artifacts";
const store = "/cursor/stores/self/recordings/t3-t4";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(bin: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts?.cwd ?? REPO_ROOT,
      env: { ...process.env, DISPLAY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = opts?.timeoutMs ?? (bin === "xdotool" ? 8_000 : 0);
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* */
          }
          resolvePromise({ code: 1, stdout: Buffer.concat(stdout).toString(), stderr: `timeout ${timeoutMs}ms` });
        }, timeoutMs)
      : null;
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

async function killStrayFfmpeg(outFile: string): Promise<void> {
  const needle = outFile.split("/").pop() ?? outFile;
  const listed = await sh("ps", ["-eo", "pid,args"]);
  for (const line of listed.stdout.split("\n")) {
    if (!line.includes("ffmpeg") || !line.includes("x11grab") || !line.includes(needle)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function startFfmpeg(outFile: string): ChildProcess {
  mkdirSync(recordings, { recursive: true });
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      "1920x1200",
      "-framerate",
      "12",
      "-draw_mouse",
      "1",
      "-i",
      DISPLAY,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-movflags",
      "+frag_keyframe+empty_moov",
      outFile,
    ],
    { env: { ...process.env, DISPLAY }, stdio: ["pipe", "ignore", "pipe"] },
  );
}

async function stopFfmpeg(child: ChildProcess, outFile?: string): Promise<void> {
  if (!child.pid) return;
  try {
    child.stdin?.write("q");
    child.stdin?.end();
  } catch {
    /* already closed */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* */
  }
  await new Promise<void>((resolvePromise) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* */
        }
      }
      resolvePromise();
    }, 1_500);
    child.on("close", () => {
      clearTimeout(t);
      resolvePromise();
    });
  });
  if (!outFile || !existsSync(outFile)) return;
  const tmp = `${outFile}.remux.mp4`;
  const remux = await sh("ffmpeg", ["-y", "-i", outFile, "-c", "copy", "-movflags", "+faststart", tmp]);
  if (remux.code === 0 && existsSync(tmp)) {
    copyFileSync(tmp, outFile);
    rmSync(tmp, { force: true });
  }
}

function makeClipFinisher(ff: ChildProcess, out: string): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await stopFfmpeg(ff, out);
    publish(out);
  };
}

async function assertClipMotion(file: string): Promise<void> {
  const probe = await sh("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    file,
  ]);
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration < 8) {
    throw new Error(`${file} duration ${probe.stdout.trim()} is too short`);
  }
  const freeze = await sh("ffmpeg", ["-i", file, "-vf", "freezedetect=n=0.001:d=6", "-f", "null", "-"]);
  const hits = [...freeze.stderr.matchAll(/freeze_duration:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const longest = hits.length ? Math.max(...hits) : 0;
  if (longest >= 6) {
    throw new Error(`${file} freezedetect n=0.001 d=6 longest=${longest.toFixed(3)}s`);
  }
}

function publish(file: string): void {
  for (const dir of [artifacts, store]) {
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, join(dir, file.split("/").pop() ?? "clip"));
    } catch {
      /* optional destinations */
    }
  }
}

async function openTerminal(
  title: string,
  script: string,
  geometry = "108x36+16+48",
  maximize = false,
  interactive = false,
): Promise<{ child: ChildProcess; done: string; scriptPath: string }> {
  const stamp = `${title.replace(/\W+/g, "-")}-${Date.now()}`;
  const scriptPath = `/tmp/lift-term-${stamp}.sh`;
  const done = `/tmp/lift-term-${stamp}.done`;
  const body = interactive
    ? `exec bash --noprofile --norc`
    : `${script}
touch ${JSON.stringify(done)}
sleep 180
`;
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -uo pipefail
cd ${JSON.stringify(REPO_ROOT)}
export TERM=xterm-256color
export COLUMNS=220
export LINES=52
stty cols 220 rows 52 2>/dev/null || true
${body}
`,
    { mode: 0o700 },
  );
  const child = spawn(
    "xfce4-terminal",
    [
      `--display=${DISPLAY}`,
      "--disable-server",
      "--hide-menubar",
      "--hide-toolbar",
      `--title=${title}`,
      maximize ? "--maximize" : `--geometry=${geometry}`,
      "--font=Monospace 16",
      "-e",
      `bash ${scriptPath}`,
    ],
    { env: { ...process.env, DISPLAY }, stdio: "ignore", detached: true },
  );
  child.unref();
  await waitWindowNamed(title, 12_000);
  return { child, done, scriptPath };
}

async function waitWindowNamed(title: string, timeoutMs = 12_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await sh("xdotool", ["search", "--name", title]);
    const id = out.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .pop();
    if (id) return id;
    await sleep(200);
  }
  throw new Error(`window ${title} did not open`);
}

async function unmapWindowsNamed(title: string): Promise<void> {
  await sh("xdotool", ["search", "--name", title, "windowunmap", "%@"]);
  await sh("xdotool", ["search", "--class", title, "windowunmap", "%@"]);
}

async function mapWindowsNamed(title: string): Promise<void> {
  await sh("xdotool", ["search", "--name", title, "windowmap", "%@"]);
  await sh("xdotool", ["search", "--class", title, "windowmap", "%@"]);
}

function cleanupTermFiles(term: { scriptPath: string; done: string } | null): void {
  if (!term) return;
  for (const file of [term.scriptPath, term.done]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* */
    }
  }
}

async function waitDone(done: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(done)) return;
    await sleep(500);
  }
  throw new Error(`terminal ${done} did not finish`);
}

async function closeWindowsNamed(title: string): Promise<void> {
  await sh("xdotool", ["search", "--name", title, "windowkill"]).catch(() => ({
    code: 0,
    stdout: "",
    stderr: "",
  }));
}

function killProcessGroup(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
  });
}

async function startSelfhostSite(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn("npx", ["tsx", "scripts/serve-site.ts", "--selfhost", "--port", "0"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, DISPLAY },
  });
  try {
    const port = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("serve-site did not bind a port")), 15_000);
      const onData = (buf: Buffer) => {
        const match = buf.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolvePromise(Number(match[1]));
      };
      child.stdout?.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`serve-site exited ${code}`));
      });
    });
    return { child, port };
  } catch (err) {
    killProcessGroup(child);
    throw err;
  }
}

async function waitHttpOk(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not tried";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`${url} not ready (${last})`);
}

type ChromeLayout = "full" | "top" | "right";

const CHROME_BIN = "/opt/google/chrome/chrome";

function chromeArgv(layout: ChromeLayout, profile: string, cdp: number): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-session-crashed-bubble",
    "--no-sandbox",
    "--test-type",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--password-store=basic",
    "--disable-save-password-bubble",
    "--disable-features=Translate,PasswordManagerOnboarding,PasswordManager,PasswordCheck,AutofillServerCommunication",
    `--remote-debugging-port=${cdp}`,
    ...(layout === "full"
      ? ["--window-size=1920,1200", "--window-position=0,0"]
      : layout === "top"
        ? ["--window-size=1920,680", "--window-position=0,0"]
        : ["--window-size=1040,1100", "--window-position=880,24"]),
    "about:blank",
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function startChromeFromTerminal(
  title: string,
  layout: ChromeLayout,
): Promise<{ child: ChildProcess; cdp: number; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "lift-chrome-"));
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    }),
  );
  const cdp = await freePort();
  const line = [CHROME_BIN, ...chromeArgv(layout, profile, cdp)].map(shellQuote).join(" ");
  writeFileSync(
    "/tmp/lift-open-chrome.sh",
    `#!/usr/bin/env bash\nexec ${line} >/tmp/lift-chrome-launch.log 2>&1 &\n`,
    { mode: 0o700 },
  );
  await clickFocusTerminal(title);
  await xdotoolType("bash /tmp/lift-open-chrome.sh", 70);
  await sleep(200);
  await sh("xdotool", ["key", "--clearmodifiers", "Return"]);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdp}/json/version`);
      if (res.ok) {
        const listed = await sh("pgrep", ["-f", `${CHROME_BIN}.*remote-debugging-port=${cdp}`]);
        const pid = Number(
          listed.stdout
            .trim()
            .split("\n")
            .map((row) => row.trim())
            .find((row) => /^\d+$/.test(row)),
        );
        if (!(pid > 1)) throw new Error("typed chrome launch has no pid");
        const child = { pid } as ChildProcess;
        return { child, cdp, profile };
      }
    } catch {
      /* */
    }
    await sleep(300);
  }
  throw new Error("chrome CDP not ready after typed launch");
}

async function startChrome(
  layout: ChromeLayout = "right",
): Promise<{ child: ChildProcess; cdp: number; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "lift-chrome-"));
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    }),
  );
  const cdp = await freePort();
  const child = spawn(
    CHROME_BIN,
    chromeArgv(layout, profile, cdp),
    { env: { ...process.env, DISPLAY }, stdio: "ignore", detached: true },
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdp}/json/version`);
      if (res.ok) return { child, cdp, profile };
    } catch {
      /* */
    }
    await sleep(300);
  }
  killProcessGroup(child);
  throw new Error("chrome CDP not ready");
}

async function stopChrome(
  chrome: { child: ChildProcess; profile: string } | null,
  browser?: Browser,
): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* */
  }
  killProcessGroup(chrome?.child ?? null);
  await sleep(400);
  if (chrome?.profile) {
    try {
      rmSync(chrome.profile, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

async function connectChrome(cdp: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0];
  if (!page) throw new Error("chrome has no page");
  return { browser, page };
}

async function chromeWindowId(pid: number): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await sh("xdotool", ["search", "--onlyvisible", "--pid", String(pid)]);
    const all = await sh("xdotool", ["search", "--pid", String(pid)]);
    const ids = (visible.stdout.trim() || all.stdout.trim())
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) {
      let best = ids[ids.length - 1] ?? ids[0];
      let bestArea = -1;
      for (const id of ids) {
        const geo = await sh("xdotool", ["getwindowgeometry", id]);
        const m = geo.stdout.match(/(\d+)x(\d+)/);
        const area = m ? Number(m[1]) * Number(m[2]) : 0;
        if (area >= bestArea) {
          bestArea = area;
          best = id;
        }
      }
      return best;
    }
    await sleep(200);
  }
  throw new Error(`no window for chrome pid ${pid}`);
}

function parseWindowGeometry(stdout: string): { x: number; y: number; width: number; height: number } {
  const pos = stdout.match(/Position:\s*(-?\d+),(-?\d+)/);
  const geo = stdout.match(/Geometry:\s*(\d+)x(\d+)/);
  return {
    x: pos ? Number(pos[1]) : 0,
    y: pos ? Number(pos[2]) : 0,
    width: geo ? Number(geo[1]) : 0,
    height: geo ? Number(geo[2]) : 0,
  };
}

async function focusChromePid(pid: number): Promise<string> {
  const id = await chromeWindowId(pid);
  if (allowWindowRaise) {
    await sh("xdotool", ["windowraise", id, "windowactivate", id, "windowfocus", id]);
    await sleep(250);
  }
  return id;
}

async function windowBounds(page: Page): Promise<{ left: number; top: number; width: number; height: number }> {
  const session = await page.context().newCDPSession(page);
  try {
    const win = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
    const { bounds } = (await session.send("Browser.getWindowBounds", { windowId: win.windowId })) as {
      bounds: { left?: number; top?: number; width?: number; height?: number };
    };
    return {
      left: bounds.left ?? 0,
      top: bounds.top ?? 0,
      width: bounds.width ?? 0,
      height: bounds.height ?? 0,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function viewportToScreen(page: Page, vx: number, vy: number): Promise<{ x: number; y: number }> {
  const metrics = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    sx: window.screenX,
    sy: window.screenY,
    ow: window.outerWidth,
    oh: window.outerHeight,
  }));
  const chromeY = 96;
  return {
    x: Math.round(metrics.sx + vx - 20),
    y: Math.round(metrics.sy + chromeY + vy),
  };
}

let recordingChromePid: number | null = null;
let allowWindowRaise = true;
let lastPointer = { x: 960, y: 600 };

async function glidePointerTo(x: number, y: number): Promise<void> {
  const dest = { x: Math.round(x), y: Math.round(y) };
  const points = glideScreenPoints(lastPointer, dest);
  for (const point of points) {
    await sh("xdotool", ["mousemove", String(point.x), String(point.y)]);
    lastPointer = point;
    await sleep(84);
  }
  lastPointer = dest;
}

async function xdotoolClick1(x: number, y: number, focusChrome = true): Promise<void> {
  if (focusChrome && recordingChromePid) {
    await focusChromePid(recordingChromePid).catch(() => undefined);
  }
  await glidePointerTo(x, y);
  await sleep(550);
  await sh("xdotool", ["click", "1"]);
  await sleep(150);
}

async function xdotoolType(text: string, delay = 40): Promise<void> {
  await sh("xdotool", ["type", "--delay", String(delay), "--clearmodifiers", text]);
}

async function xdotoolTypeInto(title: string, text: string, delay = 40): Promise<void> {
  const id = await waitWindowNamed(title);
  await sh("xdotool", ["type", "--window", id, "--delay", String(delay), "--clearmodifiers", text]);
}

async function xdotoolKeyInto(title: string, key: string): Promise<void> {
  const id = await waitWindowNamed(title);
  await sh("xdotool", ["key", "--window", id, "--clearmodifiers", key]);
}

async function pointerWheel(page: Page, locator: Locator, clicks = 6, button = 5): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const vx = box ? box.x + Math.min(40, box.width / 2) : inner.w / 2;
  const vy = box ? Math.max(40, Math.min(box.y + 20, inner.h - 40)) : inner.h / 2;
  const point = await viewportToScreen(page, vx, vy);
  await glidePointerTo(point.x, point.y);
  await sleep(550);
  const wheelButton = button === 4 ? "4" : "5";
  for (let i = 0; i < clicks; i += 1) {
    await sh("xdotool", ["click", wheelButton]);
    await sleep(80);
  }
}

async function pointerClick(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  let box = await locator.boundingBox();
  if (!box || box.y < 8 || box.y > inner.h - 8) {
    await pointerWheel(page, locator, 6);
    box = await locator.boundingBox();
  }
  if (!box) throw new Error("locator has no box for pointer click");
  const vx = box.x + box.width / 2;
  const vy = box.y + box.height / 2;
  const point = await viewportToScreen(page, vx, vy);
  await xdotoolClick1(point.x, point.y);
}

async function clickFocusedInput(page: Page, locator: Locator, label: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await pointerClick(page, locator);
    if (await locator.evaluate((el) => document.activeElement === el).catch(() => false)) return;
    await sleep(180);
  }
  throw new Error(`${label} input is not document.activeElement`);
}

async function navigationTimeOrigin(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin);
}

async function waitForVerifiedReload(page: Page, beforeOrigin: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const origin = await navigationTimeOrigin(page);
      const state = await page.evaluate(() => document.readyState);
      if (origin !== beforeOrigin && (state === "complete" || state === "interactive")) {
        await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
        return;
      }
    } catch {
      /* document swapped mid-reload */
    }
    await sleep(150);
  }
  throw new Error(`verified reload failed (timeOrigin stayed ${beforeOrigin})`);
}

async function inertClickTarget(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator("#flag-status"),
    page.getByRole("heading", { name: /features/i }).first(),
    page.getByRole("heading", { level: 1 }).first(),
    page.locator("h1").first(),
    page.locator("h2").first(),
    page.locator("footer").first(),
    page.locator(".wordmark").first(),
  ];
  for (const loc of candidates) {
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    const text = ((await loc.innerText().catch(() => "")) ?? "").toLowerCase();
    if (text.includes("summary")) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 12 && box.height > 8 && box.y > 8) return loc;
  }
  return null;
}

async function clickInertContent(page: Page, pid: number): Promise<void> {
  recordingChromePid = pid;
  await focusChromePid(pid);
  const loc = await inertClickTarget(page);
  if (loc) await pointerClick(page, loc);
}

async function chromeWindowTitle(pid: number): Promise<string> {
  const id = await chromeWindowId(pid);
  return (await sh("xdotool", ["getwindowname", id])).stdout.trim();
}

async function visibleReload(
  page: Page,
  pid: number,
  opts: { verifyMs?: number; method?: "reload-button" } = {},
): Promise<void> {
  const verifyMs = opts.verifyMs ?? 3_000;
  recordingChromePid = pid;
  const before = await navigationTimeOrigin(page);
  await focusChromeWindow();
  const chromeId = await chromeWindowId(pid).catch(() => "");
  const geo = chromeId
    ? parseWindowGeometry((await sh("xdotool", ["getwindowgeometry", chromeId])).stdout)
    : { x: 0, y: 0, width: 0, height: 0 };
  const point = reloadButtonScreenPoint(geo.x, geo.y);
  await xdotoolClick1(point.x, point.y, false);
  await waitForVerifiedReload(page, before, verifyMs);
  await sanitizeFlagsmithUi(page);
  await abortIfServerKeyLeaked(page);
}

async function clickOmnibox(page: Page, pid: number): Promise<void> {
  recordingChromePid = pid;
  await focusChromeWindow();
  const id = await chromeWindowId(pid);
  const geo = parseWindowGeometry((await sh("xdotool", ["getwindowgeometry", id])).stdout);
  const x = Math.round(geo.x + 420);
  const y = Math.round(geo.y + 56);
  await xdotoolClick1(x, y, false);
  await sleep(200);
}

async function typeUrlInOmnibox(page: Page, pid: number, url: string): Promise<void> {
  recordingChromePid = pid;
  const before = await navigationTimeOrigin(page).catch(() => 0);
  await clickOmnibox(page, pid);
  const chromeId = await focusChromeWindow();
  if (chromeId) {
    await sh("xdotool", ["key", "--window", chromeId, "ctrl+a"]);
    await sleep(120);
    await sh("xdotool", ["type", "--window", chromeId, "--delay", "18", "--clearmodifiers", url], {
      timeoutMs: 15_000,
    });
    await sleep(200);
    await sh("xdotool", ["key", "--window", chromeId, "Return"]);
  } else {
    await sh("xdotool", ["key", "ctrl+a"]);
    await sleep(120);
    await xdotoolType(url, 18);
    await sleep(200);
    await sh("xdotool", ["key", "Return"]);
  }
  await waitForVerifiedReload(page, before);
}

async function clickChromeTab(page: Page, pid: number, titleNeedle: string): Promise<void> {
  recordingChromePid = pid;
  await focusChromePid(pid);
  const needle = titleNeedle.toLowerCase();
  const pages = page.context().pages();
  let idx = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const tabTitle = (await pages[i].title().catch(() => "")) ?? "";
    if (tabTitle.toLowerCase().includes(needle)) {
      idx = i;
      break;
    }
  }
  const bounds = await windowBounds(page);
  // Tab strip shares a row with the window controls; idx 0 center is ~175px, not the buttons.
  const tabX = Math.round(bounds.left + 175 + idx * 185);
  const tabY = Math.round(bounds.top + 20);
  await xdotoolClick1(tabX, tabY);
  await sleep(400);
  let title = await chromeWindowTitle(pid);
  if (!title.toLowerCase().includes(needle)) {
    await clickInertContent(page, pid);
    await sleep(200);
    await sh("xdotool", ["key", "ctrl+shift+a"]);
    await sleep(450);
    await xdotoolType(titleNeedle, 35);
    await sleep(200);
    await sh("xdotool", ["key", "Return"]);
    await sleep(500);
    title = await chromeWindowTitle(pid);
  }
  if (!title.toLowerCase().includes(needle)) {
    throw new Error(`chrome tab ${titleNeedle} not focused (title=${title})`);
  }
}

async function ensureChromeGeometry(pid: number, width: number, height: number, page?: Page): Promise<void> {
  const id = await chromeWindowId(pid);
  for (let i = 0; i < 4; i += 1) {
    await sh("xdotool", ["windowmap", id]);
    const state = await sh("xprop", ["-id", id, "_NET_WM_STATE"]);
    if (state.stdout.includes("SHADED")) {
      await sh("xdotool", ["key", "--window", id, "alt+F9"]);
      await sleep(180);
    }
    await sh("xdotool", ["windowmove", id, "0", "0"]);
    await sh("xdotool", ["windowsize", id, String(width), String(height)]);
    if (page) {
      const session = await page.context().newCDPSession(page);
      try {
        const win = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
        await session.send("Browser.setWindowBounds", {
          windowId: win.windowId,
          bounds: { left: 0, top: 0, width, height, windowState: "normal" },
        });
      } catch {
        /* window bounds are best-effort */
      } finally {
        await session.detach().catch(() => undefined);
      }
    }
    await sleep(180);
    const geo = parseWindowGeometry((await sh("xdotool", ["getwindowgeometry", id])).stdout);
    const stateAfter = await sh("xprop", ["-id", id, "_NET_WM_STATE"]);
    if (
      geo.height >= Math.min(400, height - 80) &&
      geo.height <= height + 80 &&
      geo.width >= 800 &&
      !stateAfter.stdout.includes("SHADED")
    ) {
      return;
    }
    await sh("xdotool", ["key", "--window", id, "alt+F9"]);
    await sleep(180);
  }
}

async function focusChromeWindow(): Promise<string> {
  if (!recordingChromePid) return "";
  const id = await chromeWindowId(recordingChromePid);
  await sh("xdotool", ["windowfocus", id]);
  return id;
}

async function clickChromeNewTab(page: Page, pid: number): Promise<Page> {
  recordingChromePid = pid;
  const id = await chromeWindowId(pid);
  const geo = parseWindowGeometry((await sh("xdotool", ["getwindowgeometry", id])).stdout);
  const plusX = Math.round(geo.x + 400);
  const plusY = Math.round(geo.y + 18);
  const created = page.context().waitForEvent("page", { timeout: 3_000 });
  await sh("xdotool", ["windowfocus", id]);
  await xdotoolClick1(plusX, plusY, false);
  try {
    return await created;
  } catch {
    const retry = page.context().waitForEvent("page", { timeout: 3_000 });
    for (const dx of [20, 40]) {
      await xdotoolClick1(plusX + dx, plusY, false);
    }
    return await retry;
  }
}

async function stirTerminal(_title: string): Promise<void> {
  await abortIfServerKeyLeaked();
}

async function clickFocusTerminal(title: string): Promise<void> {
  const id = await waitWindowNamed(title, 8_000);
  if (allowWindowRaise) {
    await sh("timeout", ["1", "xdotool", "windowraise", id, "windowactivate", "--sync", id, "windowfocus", id]);
  }
  const geo = parseWindowGeometry((await sh("xdotool", ["getwindowgeometry", id])).stdout);
  const x = geo.x + Math.max(40, Math.floor(geo.width * 0.35));
  const y = geo.y + Math.max(48, Math.floor(geo.height * 0.4));
  await xdotoolClick1(x, y, false);
}

async function downProofStack(): Promise<void> {
  await sh("docker", [
    "compose",
    "-f",
    "selfhost/docker-compose.yml",
    "-f",
    "selfhost/docker-compose.proof.yml",
    "--env-file",
    "selfhost/.env",
    "--project-name",
    PROOF_PROJECT,
    "down",
    "-v",
  ]);
}

async function hideDock(): Promise<void> {
  await unmapWindowsNamed("plank");
  await unmapWindowsNamed("Plank");
}

async function showDock(): Promise<void> {
  await mapWindowsNamed("plank");
  await mapWindowsNamed("Plank");
}

async function snapshotStaleFlagNames(
  lift: ReturnType<typeof createLiftSelfhost>,
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const row of await lift.listFlags()) {
    if (row.name.startsWith("lift_a11y_stale_")) existing.add(row.name);
  }
  return existing;
}

async function waitStaleFlagName(
  lift: ReturnType<typeof createLiftSelfhost>,
  existing: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStir = 0;
  while (Date.now() < deadline) {
    try {
      const flags = await lift.listFlags();
      const stale = flags.find((row) => row.name.startsWith("lift_a11y_stale_") && !existing.has(row.name));
      if (stale) return stale.name;
    } catch {
      /* retry */
    }
    if (Date.now() - lastStir > 2500) {
      lastStir = Date.now();
      await stirTerminal("t4-skill-run");
    }
    await sleep(400);
  }
  throw new Error("stale flag was not created");
}

async function waitStaleFlagGone(
  lift: ReturnType<typeof createLiftSelfhost>,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await lift.findFeature(name))) return;
    await sleep(400);
  }
  throw new Error(`stale flag ${name} still present after cleanup`);
}

async function sanitizeFlagsmithUi(page: Page): Promise<void> {
  let dump = { innerText: "", textContent: "" };
  try {
    dump = await page.evaluate(() => ({
      innerText: document.body?.innerText ?? "",
      textContent: document.documentElement?.textContent ?? "",
    }));
  } catch {
    return;
  }
  assertNoServerKeyVisible(dump.innerText);
  assertNoServerKeyVisible(dump.textContent);
  if (/FLAGSMITH_SERVER|FLAGSMITH_ADMIN_API_TOKEN|DJANGO_SECRET_KEY|WAREHOUSE_CREDENTIALS_SECRET/.test(
    `${dump.innerText}\n${dump.textContent}`,
  )) {
    throw new Error("secret label visible on Flagsmith UI");
  }
}

async function assertNoSecrets(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText ?? "");
  assertNoServerKeyVisible(text);
  if (/FLAGSMITH_ADMIN_API_TOKEN|DJANGO_SECRET_KEY|WAREHOUSE_CREDENTIALS_SECRET/.test(text)) {
    throw new Error("secret label visible on Flagsmith UI");
  }
}

async function abortIfServerKeyLeaked(page?: Page): Promise<void> {
  if (page) {
    let dump = { innerText: "", textContent: "", href: "" };
    try {
      dump = await page.evaluate(() => ({
        innerText: document.body?.innerText ?? "",
        textContent: document.documentElement?.textContent ?? "",
        href: document.URL,
      }));
    } catch {
      dump = { innerText: "", textContent: "", href: "" };
    }
    assertNoServerKeyVisible(dump.innerText);
    assertNoServerKeyVisible(dump.textContent);
    assertNoServerKeyVisible(dump.href);
    assertNoServerKeyVisible(page.url());
  }
  abortIfServerKeyInFiles(liftScanFiles());
}

async function loginFlagsmith(
  page: Page,
  pid: number,
  opts?: { origin?: string; envFile?: string },
): Promise<void> {
  const origin = opts?.origin ?? SHARED_ORIGIN;
  const file = readEnvFile(opts?.envFile ?? ENV_FILE);
  const email = file.FLAGSMITH_BOOTSTRAP_EMAIL || "admin@lift.local";
  const password = file.FLAGSMITH_BOOTSTRAP_PASSWORD;
  if (!password) throw new Error(`missing bootstrap password in ${opts?.envFile ?? ENV_FILE}`);
  recordingChromePid = pid;
  const host = new URL(origin).host;
  if (!page.url().includes(host)) {
    await typeUrlInOmnibox(page, pid, `${origin}/login`);
  }
  await sleep(600);
  if (!page.url().includes("/login") && (await page.getByText("Lift").count()) > 0) {
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    return;
  }
  const emailBox = page.locator('input[type="email"], input[name="email"], input[id*="email"]').first();
  const passBox = page.locator('input[type="password"]').first();
  await emailBox.waitFor({ timeout: 15_000 });
  await clickFocusedInput(page, emailBox, "email");
  await sh("xdotool", ["key", "ctrl+a"]);
  await xdotoolType(email, 45);
  await sh("xdotool", ["key", "Tab"]);
  await sleep(250);
  let passwordFocused = await passBox.evaluate((el) => document.activeElement === el).catch(() => false);
  if (!passwordFocused) {
    await clickFocusedInput(page, passBox, "password");
    passwordFocused = await passBox.evaluate((el) => document.activeElement === el).catch(() => false);
  }
  if (!passwordFocused) {
    throw new Error("password input is not document.activeElement before xdotool type");
  }
  await sh("xdotool", ["key", "ctrl+a"]);
  await xdotoolType(password, 35);
  await sleep(250);
  await sh("xdotool", ["key", "Return"]);
  const leftLogin = await page
    .waitForFunction(() => !location.pathname.includes("/login"), { timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (!leftLogin) {
    const submit = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login")').first();
    await pointerClick(page, submit);
    await page.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 10_000 }).catch(() => undefined);
  }
  if (page.url().includes("/login")) {
    throw new Error(`Flagsmith login did not leave /login (url=${page.url()})`);
  }
  const never = page.getByRole("button", { name: /never/i }).first();
  if (await never.count()) await pointerClick(page, never);
  await sanitizeFlagsmithUi(page);
  await assertNoSecrets(page);
}

async function openLiftFeatures(page: Page): Promise<void> {
  await sanitizeFlagsmithUi(page);
  if (await page.getByText("checkout_a11y").count()) {
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    return;
  }
  await page.getByText("Create Project").first().waitFor({ state: "visible", timeout: 15_000 });
  const createBox = await page.getByText("Create Project").first().boundingBox();
  if (!createBox) throw new Error("Create Project tile has no box");
  const lifts = page.getByText("Lift", { exact: true });
  const n = await lifts.count();
  let hit: { x: number; y: number; w: number; h: number } | null = null;
  for (let i = 0; i < n; i += 1) {
    const box = await lifts.nth(i).boundingBox().catch(() => null);
    if (!box) continue;
    if (box.y > 90 && box.x > createBox.x && Math.abs(box.y - createBox.y) < 100) {
      if (!hit || box.width * box.height < hit.w * hit.h) {
        hit = { x: box.x, y: box.y, w: box.width, h: box.height };
      }
    }
  }
  const vx = hit ? hit.x + hit.w / 2 : createBox.x + createBox.width + 110;
  const vy = hit ? hit.y + hit.h / 2 : createBox.y + createBox.height / 2;
  const point = await viewportToScreen(page, vx, vy);
  await xdotoolClick1(point.x, point.y);
  const opened = await page
    .getByText("checkout_a11y")
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    const features = page.getByRole("link", { name: /^Features$/i }).first();
    if (await features.isVisible().catch(() => false)) {
      await clickSidebarLink(page, "Features");
    } else {
      if (!recordingChromePid) throw new Error("chrome pid missing for features URL");
      const env = loadSelfhostEnv();
      await typeUrlInOmnibox(
        page,
        recordingChromePid,
        `${SHARED_ORIGIN}/project/${env.projectId}/environment/${env.environmentId}/features`,
      );
    }
  }
  await page.getByText("checkout_a11y").first().waitFor({ state: "visible", timeout: 20_000 });
  await sanitizeFlagsmithUi(page);
  await assertNoSecrets(page);
}

async function openCheckoutFlag(page: Page): Promise<void> {
  const row = await featureRowByName(page, "checkout_a11y");
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await pointerClick(page, row);
  await page.getByText("Environment Weight %").first().waitFor({ timeout: 10_000 });
  await sanitizeFlagsmithUi(page);
  await assertNoSecrets(page);
}

async function treatmentWeightInput(page: Page): Promise<Locator> {
  const label = page.getByText("Environment Weight %").first();
  await label.waitFor({ state: "visible", timeout: 10_000 });
  const lbox = await label.boundingBox();
  if (!lbox) throw new Error("Environment Weight % has no box");
  const inputs = page.locator('input[type="number"], input[inputmode="numeric"], input');
  const n = await inputs.count();
  let best: { loc: Locator; x: number } | null = null;
  for (let i = 0; i < n; i += 1) {
    const loc = inputs.nth(i);
    const box = await loc.boundingBox().catch(() => null);
    if (!box || box.width < 20 || box.height < 12) continue;
    if (Math.abs(box.y - lbox.y) > 28) continue;
    if (box.x <= lbox.x) continue;
    if (!best || box.x > best.x) best = { loc, x: box.x };
  }
  if (!best) throw new Error("treatment weight input not found on the weight row");
  return best.loc;
}

async function pointerClickInput(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("input has no box");
  const vx = box.x + Math.min(18, Math.max(8, box.width * 0.25));
  const vy = box.y + box.height / 2;
  const point = await viewportToScreen(page, vx, vy);
  await xdotoolClick1(point.x, point.y);
}

async function setTreatmentInUi(page: Page, percent: number): Promise<boolean> {
  const weight = await treatmentWeightInput(page);
  const already = await weight.inputValue();
  if (new RegExp(`^${percent}(\\.0+)?$`).test(already)) return true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await pointerClickInput(page, weight);
    await sleep(150);
    const focused = await weight.evaluate((el) => document.activeElement === el).catch(() => false);
    if (!focused) {
      if (attempt === 3) throw new Error("treatment weight input is not document.activeElement");
      await sleep(250);
      continue;
    }
    await sh("xdotool", ["key", "ctrl+a"]);
    await sleep(80);
    await xdotoolType(String(percent), 80);
    await sleep(200);
    const typed = await weight.inputValue();
    if (new RegExp(`^${percent}(\\.0+)?$`).test(typed)) break;
    if (attempt === 3) {
      throw new Error(`treatment weight input is ${JSON.stringify(typed)}, not ${percent}`);
    }
    await sleep(250);
  }
  await sh("xdotool", ["key", "Tab"]);
  await sleep(200);
  const update = page.getByRole("button", { name: "Update Feature Value" });
  await pointerClick(page, update);
  await sleep(600);
  return true;
}

async function closeFeaturePanel(page: Page): Promise<void> {
  const title = page.getByText(/^Edit Feature:/).first();
  await title.waitFor({ state: "visible", timeout: 8_000 });
  const toast = page.getByText(/Updated Feature/i).first();
  if (await toast.isVisible().catch(() => false)) {
    await toast.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => undefined);
  }
  await sleep(350);
  await page.locator(".modal-header").last().waitFor({ state: "visible", timeout: 8_000 });
  const info = await page.evaluate(() => {
    const header = [...document.querySelectorAll(".modal-header")].at(-1);
    if (!header) return { error: "no header" as const, nodes: [] as Array<Record<string, number | string>> };
    const hr = header.getBoundingClientRect();
    const nodes = [...header.querySelectorAll("svg,button,.cursor-pointer,[role=button],span,ion-icon,[aria-label]")].map((el) => {
      const r = el.getBoundingClientRect();
      const parent = el.parentElement;
      const pr = parent?.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: ((el as HTMLElement).className ?? "").toString().slice(0, 80),
        aria: el.getAttribute("aria-label") ?? "",
        test: el.getAttribute("data-test") ?? "",
        parentTag: parent?.tagName ?? "",
        parentCls: ((parent as HTMLElement | null)?.className ?? "").toString().slice(0, 80),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        px: pr?.x ?? 0,
        py: pr?.y ?? 0,
        pw: pr?.width ?? 0,
        ph: pr?.height ?? 0,
      };
    });
    const labeled = [...document.querySelectorAll("[aria-label*=lose i], [aria-label*=Close], [data-test*=close i], .close, .btn-close")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        aria: el.getAttribute("aria-label") ?? "",
        test: el.getAttribute("data-test") ?? "",
        cls: ((el as HTMLElement).className ?? "").toString().slice(0, 80),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      };
    });
    const svg = [...header.querySelectorAll("svg")].at(-1) as SVGElement | undefined;
    const pe = svg ? getComputedStyle(svg).pointerEvents : "";
    return {
      header: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
      nodes,
      labeled,
      pointerEvents: pe,
      headerHtml: header.outerHTML.slice(0, 4000),
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      ow: window.outerWidth,
      oh: window.outerHeight,
      sx: window.screenX,
      sy: window.screenY,
      dpr: window.devicePixelRatio,
      vv: window.visualViewport
        ? {
            w: window.visualViewport.width,
            h: window.visualViewport.height,
            scale: window.visualViewport.scale,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : null,
    };
  });
  const closeNode = [...(info.nodes ?? [])]
    .filter((n) => typeof n.w === "number" && n.w >= 8 && n.w <= 40 && Number(n.h) >= 8 && Number(n.h) <= 40 && Number(n.x) > 900)
    .sort((a, b) => Number(b.x) - Number(a.x))[0];
  writeFileSync("/tmp/lift-xclose.json", JSON.stringify({ info, closeNode }, null, 2));
  if (!closeNode) throw new Error("feature panel X node not found in modal header");
  const vx = Number(closeNode.x) + Number(closeNode.w) / 2;
  const vy = Number(closeNode.y) + Number(closeNode.h) / 2;
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { ok: false, tag: "none" };
      const close = el.closest(".modal-header .cursor-pointer, .modal-header svg, .modal-header button, .modal-header");
      return { ok: Boolean(close), tag: el.tagName };
    },
    { x: vx, y: vy },
  );
  if (!hit.ok) {
    throw new Error(`feature panel X is not under the pointer (elementFromPoint=${hit.tag})`);
  }
  const point = await viewportToScreen(page, vx, vy);
  if (recordingChromePid) {
    const id = await chromeWindowId(recordingChromePid).catch(() => "");
    if (id) await sh("xdotool", ["windowfocus", id]);
  }
  await xdotoolClick1(point.x, point.y);
  const holdUntil = Date.now() + 1800;
  while (Date.now() < holdUntil && (await title.isVisible())) {
    await sleep(80);
  }
  if (await title.isVisible()) throw new Error("feature panel X click did not close the panel");
}

function stripScriptLog(raw: string): string {
  return raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n");
}

function approveLineFromLog(raw: string): string | null {
  const log = stripScriptLog(raw);
  const exact = [...log.matchAll(/Type exactly:\s*(APPROVE\s+\d+)/g)].at(-1)?.[1];
  if (exact) return exact.replace(/\s+/g, " ").trim();
  if (log.includes("WAITING_FOR_HUMAN_APPROVAL")) {
    const created = [...log.matchAll(/experiment created id=(\d+)/g)].at(-1)?.[1];
    if (created) return `APPROVE ${created}`;
  }
  return null;
}

function newestApproveMarker(): string | null {
  const found = findApprovePromptFile();
  let best: { path: string; mtime: number } | null = found && existsSync(found)
    ? { path: found, mtime: 0 }
    : null;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("lift-approve-")) continue;
      const candidate = join(tmpdir(), name, "prompt.json");
      if (!existsSync(candidate)) continue;
      const mtime = Number(name.replace(/\D/g, "").slice(-8) || "0");
      if (!best || mtime >= best.mtime) best = { path: candidate, mtime };
    }
  } catch {
    /* */
  }
  return best?.path ?? null;
}

function readApproveMarkerLine(marker: string): string | null {
  try {
    const doc = JSON.parse(readFileSync(marker, "utf8")) as {
      experimentId: number;
      typed?: string;
    };
    return doc.typed || `APPROVE ${doc.experimentId}`;
  } catch {
    return null;
  }
}

function clearLeftoverApproveMarkers(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("lift-approve-")) continue;
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  } catch {
    /* */
  }
}

async function waitForApproveLine(
  title = "t4-skill-run",
  done?: string,
  stir = true,
): Promise<string> {
  const deadline = Date.now() + 480_000;
  let lastStir = 0;
  while (Date.now() < deadline) {
    try {
      const log = existsSync("/tmp/lift-t4-skill-run.log")
        ? readFileSync("/tmp/lift-t4-skill-run.log", "utf8")
        : "";
      if (/COMMAND_EXIT_CODE="[1-9]/.test(log) && !/WAITING_FOR_HUMAN_APPROVAL/.test(log)) {
        throw new Error("skill-run exited before the approval prompt");
      }
      if (!log.includes("APPROVE typed by recording harness in place of a human approver")) {
        await sleep(80);
        continue;
      }
      const fromLog = approveLineFromLog(log);
      if (fromLog) return fromLog;
      if (/COMMAND_EXIT_CODE="[1-9]/.test(log) && !/WAITING_FOR_HUMAN_APPROVAL/.test(log)) {
        throw new Error("skill-run exited before the approval prompt");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("exited before the approval prompt")) {
        throw err;
      }
    }
    const marker = newestApproveMarker();
    const fromMarker = marker ? readApproveMarkerLine(marker) : null;
    if (fromMarker) return fromMarker;
    if (done && existsSync(done)) {
      let log = "";
      try {
        log = readFileSync("/tmp/lift-t4-skill-run.log", "utf8").slice(-2500);
      } catch {
        /* */
      }
      throw new Error(`approval prompt marker missing; skill-run finished early\n${log}`);
    }
    if (stir && Date.now() - lastStir > 2500) {
      lastStir = Date.now();
      await stirTerminal(title);
    }
    await sleep(80);
  }
  throw new Error("approval prompt marker missing");
}

async function typeApproveLine(title: string, line: string): Promise<void> {
  await clickFocusTerminal(title);
  await sleep(150);
  await xdotoolType(line, 80);
  await sleep(120);
  await sh("xdotool", ["key", "--clearmodifiers", "Return"]);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const log = existsSync("/tmp/lift-t4-skill-run.log")
      ? stripScriptLog(readFileSync("/tmp/lift-t4-skill-run.log", "utf8"))
      : "";
    if (/\bapproved\b/i.test(log)) return;
    await sleep(120);
  }
  throw new Error("APPROVE was typed but the approved marker never appeared");
}

async function typeApproveAtTty(title = "t4-skill-run", done?: string): Promise<string> {
  const line = await waitForApproveLine(title, done);
  await stirTerminal(title);
  await typeApproveLine(title, line);
  return line;
}

async function awaitWhileNavigating<T>(_page: Page, _pid: number, pending: Promise<T>): Promise<T> {
  return pending;
}

async function revealCheckoutForm(page: Page, opts?: { fill?: boolean }): Promise<void> {
  const fill = opts?.fill !== false;
  const checkout = page.locator("#checkout");
  if (await checkout.isVisible().catch(() => false)) {
    await pointerWheel(page, checkout, 4);
    await page.locator("#email").waitFor({ state: "visible", timeout: 5_000 });
    if (fill) await showCheckoutFields(page);
    return;
  }
  const shop = page.locator("#shop-trigger");
  await shop.waitFor({ state: "visible", timeout: 8_000 });
  const shopBox = await shop.boundingBox();
  if (shopBox) {
    const hover = await viewportToScreen(page, shopBox.x + shopBox.width / 2, shopBox.y + shopBox.height / 2);
    await glidePointerTo(hover.x, hover.y);
    await sleep(550);
    const link = page.locator("#checkout-link");
    if (await link.isVisible().catch(() => false)) {
      await pointerClick(page, link);
      await sleep(300);
    }
  }
  if (!(await checkout.isVisible().catch(() => false))) {
    const rects = await page.evaluate(() => {
      const cart = document.getElementById("cart-icon")?.getBoundingClientRect();
      const header = document.querySelector("header.masthead")?.getBoundingClientRect();
      return {
        cart: cart ? { x: cart.x, y: cart.y, w: cart.width, h: cart.height } : null,
        header: header ? { x: header.x, y: header.y, w: header.width, h: header.height } : null,
      };
    });
    const target = rects.cart && rects.cart.w >= 4 && rects.cart.h >= 4
      ? { vx: rects.cart.x + rects.cart.w / 2, vy: rects.cart.y + rects.cart.h / 2 }
      : rects.header
        ? { vx: rects.header.x + rects.header.w - 22, vy: rects.header.y + rects.header.h / 2 }
        : null;
    if (!target) throw new Error("cart icon has no screen box");
    const bag = await viewportToScreen(page, target.vx, target.vy);
    if (recordingChromePid) await focusChromePid(recordingChromePid).catch(() => undefined);
    await glidePointerTo(bag.x, bag.y);
    await sleep(550);
    await sh("xdotool", ["mousedown", "1"]);
    await sleep(80);
    await sh("xdotool", ["mouseup", "1"]);
    await sleep(300);
    if (!(await checkout.isVisible().catch(() => false))) {
      await sh("xdotool", ["click", "1"]);
      await sleep(300);
    }
  }
  await checkout.waitFor({ state: "visible", timeout: 8_000 });
  await pointerWheel(page, checkout, 4);
  await page.locator("#email").waitFor({ state: "visible", timeout: 5_000 });
  if (fill) await showCheckoutFields(page);
}

async function showCheckoutFields(page: Page): Promise<void> {
  const values: Record<string, string> = {
    email: "demo@store.test",
    "card-name": "Demo Shopper",
    "card-number": "4242424242424242",
    "card-exp": "12/28",
    "card-cvc": "123",
  };
  for (const id of ["email", "card-name", "card-number", "card-exp", "card-cvc", "terms", "place-order"]) {
    const loc = page.locator(`#${id}`);
    if (!(await loc.isVisible().catch(() => false))) continue;
    await pointerClick(page, loc);
    const value = values[id];
    if (value) {
      const focused = await loc.evaluate((el) => document.activeElement === el).catch(() => false);
      if (!focused) throw new Error(`#${id} is not document.activeElement after click`);
      await sh("xdotool", ["key", "ctrl+a"]);
      await xdotoolType(value, 22);
    }
    await sleep(60);
  }
}

function clipIndex(): void {
  writeFileSync(
    resolve(recordings, "index.json"),
    `${JSON.stringify(
      {
        ok: true,
        clips: {
          "t3-selfhost-up": "recordings/t3-t4/t3-selfhost-up.mp4",
          "t3-site-reads-selfhosted-flag": "recordings/t3-t4/t3-site-reads-selfhosted-flag.mp4",
          "t3-dashboard": "recordings/t3-t4/t3-dashboard.mp4",
          "t4-skill-run": "recordings/t3-t4/t4-skill-run.mp4",
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function recordT3Up(): Promise<void> {
  await closeWindowsNamed("t3-selfhost-up");
  await closeWindowsNamed("t4-skill-run");
  for (const file of ["/tmp/lift-proof-up.done", "/tmp/lift-proof-up.started", "/tmp/lift-proof-up.log"]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* */
    }
  }
  const sharedStillUp = await fetch(`${SHARED_ORIGIN}/health/liveness/`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!sharedStillUp) {
    process.stderr.write("shared Flagsmith on :8000 is down; leaving it alone (not starting it)\n");
  }
  const out = resolve(recordings, "t3-selfhost-up.mp4");
  await killStrayFfmpeg(out);
  let chrome: { child: ChildProcess; cdp: number; profile: string } | null = null;
  let browser: Browser | undefined;
  let upTerm: { child: ChildProcess; done: string; scriptPath: string } | null = null;
  let finish = async () => {};
  try {
    await hideDock();
    await downProofStack();
    upTerm = await openTerminal("t3-selfhost-up", "", "110x62+0+0", false, true);
    const termId = await waitWindowNamed("t3-selfhost-up");
    await sh("xdotool", ["windowsize", termId, "900", "1160"]);
    await sh("xdotool", ["windowmove", termId, "0", "0"]);
    await clickFocusTerminal("t3-selfhost-up");
    const ff = startFfmpeg(out);
    finish = makeClipFinisher(ff, out);
    await xdotoolType("npm run selfhost:proof-up", 28);
    await sh("xdotool", ["key", "--clearmodifiers", "Return"]);
    const startedDeadline = Date.now() + 12_000;
    while (Date.now() < startedDeadline && !existsSync("/tmp/lift-proof-up.started")) {
      await abortIfServerKeyLeaked();
      await sleep(150);
    }
    if (!existsSync("/tmp/lift-proof-up.started")) {
      throw new Error("proof-up command was not received by the terminal");
    }
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      await abortIfServerKeyLeaked();
      if (existsSync("/tmp/lift-proof-up.done")) break;
      await sleep(350);
    }
    if (!existsSync("/tmp/lift-proof-up.done")) throw new Error("proof compose up did not finish");
    await abortIfServerKeyLeaked();
    await sleep(3000);
    chrome = await startChromeFromTerminal("t3-selfhost-up", "right");
    const chromePid = chrome.child.pid;
    if (!chromePid) throw new Error("chrome pid missing");
    recordingChromePid = chromePid;
    const connected = await connectChrome(chrome.cdp);
    browser = connected.browser;
    const page = connected.page;
    await loginFlagsmith(page, chromePid, { origin: PROOF_ORIGIN, envFile: PROOF_ENV_FILE });
    await openLiftFeatures(page);
    await abortIfServerKeyLeaked(page);
    const checkoutRow = await featureRowByName(page, "checkout_a11y");
    await checkoutRow.waitFor({ state: "visible", timeout: 8_000 });
    const box = await checkoutRow.boundingBox();
    if (!box) throw new Error("checkout_a11y row has no box");
    const point = await viewportToScreen(page, box.x + box.width / 2, box.y + box.height / 2);
    await glidePointerTo(point.x, point.y);
    await sleep(3200);
    await finish();
  } finally {
    recordingChromePid = null;
    allowWindowRaise = true;
    await finish();
    await showDock();
    await closeWindowsNamed("t3-selfhost-up");
    cleanupTermFiles(upTerm);
    await stopChrome(chrome, browser);
    await downProofStack();
  }
}

async function recordT3Site(): Promise<void> {
  await closeWindowsNamed("t3-selfhost-up");
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  writeSiteConfigForSelfhost(env, "checkout", "checkout_a11y", "checkout_completed");
  await lift.clearIdentityOverride("t3-control", "checkout_a11y");
  await lift.setTreatmentWeight("checkout_a11y", 0);
  const site = await startSelfhostSite();
  const origin = `http://127.0.0.1:${site.port}`;
  let chrome: { child: ChildProcess; cdp: number; profile: string } | null = null;
  let browser: Browser | undefined;
  const out = resolve(recordings, "t3-site-reads-selfhosted-flag.mp4");
  await killStrayFfmpeg(out);
  await hideDock();
  await waitHttpOk(`${origin}/checkout/`);
  const served = (await fetch(`${origin}/checkout/config.json`).then((r) => r.json())) as {
    flagsmithEnvironmentKey?: string;
  };
  if (served.flagsmithEnvironmentKey !== env.environmentKey) {
    killProcessGroup(site.child);
    throw new Error("serve-site is not mapping config.selfhost.json");
  }
  chrome = await startChrome("full");
  const chromePid = chrome.child.pid;
  if (!chromePid) {
    killProcessGroup(site.child);
    throw new Error("chrome pid missing");
  }
  recordingChromePid = chromePid;
  const connected = await connectChrome(chrome.cdp);
  browser = connected.browser;
  await ensureChromeGeometry(chromePid, 1920, 1200, connected.page);
  const ff = startFfmpeg(out);
  const finish = makeClipFinisher(ff, out);
  try {
    const sitePage = connected.page;
    const controlUrl = `${origin}/checkout/?lift_identity=t3-control&lift_bot=1&lift_no_poll=1`;
    await typeUrlInOmnibox(sitePage, chromePid, controlUrl);
    await sitePage.waitForFunction(
      () => (document.getElementById("flag-status")?.textContent ?? "").includes("Flagsmith checkout_a11y=control"),
      { timeout: 20_000 },
    );
    await revealCheckoutForm(sitePage, { fill: false });
    const flagsmithPage = await clickChromeNewTab(sitePage, chromePid);
    await typeUrlInOmnibox(flagsmithPage, chromePid, `${SHARED_ORIGIN}/login`);
    await loginFlagsmith(flagsmithPage, chromePid);
    await awaitWhileNavigating(flagsmithPage, chromePid, openLiftFeatures(flagsmithPage));
    await openCheckoutFlag(flagsmithPage);
    await setTreatmentInUi(flagsmithPage, 100);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await lift.readTreatmentWeight("checkout_a11y")) === 100) break;
      await setTreatmentInUi(flagsmithPage, 100);
    }
    if ((await lift.readTreatmentWeight("checkout_a11y")) !== 100) {
      throw new Error("Flagsmith UI did not persist checkout_a11y treatment=100");
    }
    await closeFeaturePanel(flagsmithPage);
    await clickChromeTab(flagsmithPage, chromePid, "Northline");
    const stillControl = await sitePage.evaluate(
      () => document.getElementById("flag-status")?.textContent ?? "",
    );
    if (!stillControl.includes("checkout_a11y=control")) {
      throw new Error(`site updated without a reload (status=${stillControl})`);
    }
    await visibleReload(sitePage, chromePid, { method: "reload-button", verifyMs: 3_000 });
    if (!(await sitePage.locator(".wordmark").isVisible().catch(() => false))) {
      throw new Error("visible reload did not keep the checkout page");
    }
    await sitePage.waitForFunction(
      () => (document.getElementById("flag-status")?.textContent ?? "").includes("Flagsmith checkout_a11y=treatment"),
      { timeout: 20_000 },
    );
    await revealCheckoutForm(sitePage);
    await abortIfServerKeyLeaked(sitePage);
    await sleep(3200);
    await finish();
  } finally {
    recordingChromePid = null;
    await finish();
    await showDock();
    await lift.setTreatmentWeight("checkout_a11y", 0).catch(() => undefined);
    await lift.clearIdentityOverride("t3-control", "checkout_a11y").catch(() => undefined);
    await stopChrome(chrome, browser);
    killProcessGroup(site.child);
  }
}

async function currentExperimentId(lift: ReturnType<typeof createLiftSelfhost>): Promise<number> {
  const lastPath = resolve(REPO_ROOT, "skills/flagsmith-a11y-experiment/last-run.json");
  if (existsSync(lastPath)) {
    const last = JSON.parse(readFileSync(lastPath, "utf8")) as { experimentId?: number };
    const fromFile = Number(last.experimentId ?? 0);
    if (fromFile) return fromFile;
  }
  const listed = await lift.listExperiments();
  const a11y = listed
    .filter((row) => String(row.name ?? "").startsWith("lift a11y "))
    .sort((a, b) => Number(b.id) - Number(a.id));
  const id = Number(a11y[0]?.id ?? 0);
  if (!id) throw new Error("no lift a11y experiment id to open");
  return id;
}

async function recordT3Dashboard(): Promise<void> {
  await closeWindowsNamed("t4-skill-run");
  await closeWindowsNamed("t3-selfhost-up");
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  await lift.ensureDemoSegment();
  const experimentId = await currentExperimentId(lift);
  const out = resolve(recordings, "t3-dashboard.mp4");
  let chrome: { child: ChildProcess; cdp: number; profile: string } | null = null;
  let browser: Browser | undefined;
  let finish = async () => {};
  try {
    await hideDock();
    chrome = await startChrome("full");
    const chromePid = chrome.child.pid;
    if (!chromePid) throw new Error("chrome pid missing");
    recordingChromePid = chromePid;
    const connected = await connectChrome(chrome.cdp);
    browser = connected.browser;
    const page = connected.page;
    await ensureChromeGeometry(chromePid, 1920, 1200, page);
    await killStrayFfmpeg(out);
    const ff = startFfmpeg(out);
    finish = makeClipFinisher(ff, out);
    await loginFlagsmith(page, chromePid);
    await openLiftFeatures(page);
    await searchFeatureList(page, "lift_a11y_r5");
    const skillRow = await featureRowByName(page, "lift_a11y_r5");
    await skillRow.waitFor({ state: "visible", timeout: 15_000 });
    await pointerClick(page, skillRow);
    await page.getByText(/^Edit Feature:\s*lift_a11y_r5/).waitFor({ timeout: 10_000 });
    await page.getByText("Environment Weight %").first().waitFor({ state: "attached", timeout: 8_000 });
    await clickPanelTabs(page, ["Segment Overrides", "Identity Overrides", "Value"]);
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    await closeFeaturePanel(page);
    await clickSidebarLink(page, "Segments");
    const segmentRow = page.getByText("lift-demo-site").first();
    await segmentRow.waitFor({ state: "visible", timeout: 20_000 });
    await pointerClick(page, segmentRow);
    await clickPanelTabs(page, ["Features", "Identities", "General"]);
    await sanitizeFlagsmithUi(page);
    await clickSidebarLink(page, "Environments");
    await page.getByText("checkout_a11y").first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
    await openExperimentsViaSidebar(page);
    await sleep(3200);
    const listed = await lift.listExperiments();
    const target = experimentOpenTarget(experimentId, listed);
    const byHref = page.locator(`a[href*="${target.href}"]`).first();
    if (await byHref.count()) {
      await pointerClick(page, byHref);
    } else {
      if (!target.name) throw new Error(`experiment ${experimentId} not listed`);
      const expRow = page.getByText(target.name, { exact: false }).first();
      await expRow.waitFor({ state: "visible", timeout: 15_000 });
      await pointerClick(page, expRow);
    }
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    await abortIfServerKeyLeaked(page);
    const results = page.getByText("Results", { exact: true }).first();
    await results.waitFor({ state: "visible", timeout: 10_000 });
    const pagePoint = await viewportToScreen(page, 640, 420);
    await glidePointerTo(pagePoint.x, pagePoint.y);
    await sleep(550);
    await pointerWheel(page, results, 3);
    await sleep(3200);
    await finish();
  } finally {
    recordingChromePid = null;
    await finish();
    await showDock();
    await stopChrome(chrome, browser);
  }
}

async function stopRunningForFlag(flagName: string): Promise<void> {
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  const feature = await lift.findFeature(flagName);
  if (!feature) return;
  for (const exp of await lift.listExperiments()) {
    const featureId =
      typeof exp.feature === "number" ? exp.feature : exp.feature && typeof exp.feature === "object" ? exp.feature.id : undefined;
    if (featureId !== feature.id) continue;
    if (!/running/i.test(exp.status ?? "")) continue;
    try {
      await lift.completeExperiment(exp.id, { rollout_decision: "control" });
    } catch {
      /* leftover experiment; gate will refuse if this fails */
    }
  }
  await lift.setTreatmentWeight(flagName, 0).catch(() => undefined);
}

async function sidebarNavLink(page: Page, name: string): Promise<Locator> {
  const key = name.toLowerCase();
  const hrefNeedle =
    key === "experiments"
      ? "/experiments"
      : key === "features"
        ? "/features"
        : key === "segments"
          ? "/segments"
          : key === "environments"
            ? "/environment"
            : null;
  const byHref = hrefNeedle ? page.locator(`a[href*="${hrefNeedle}"]`) : page.locator("a");
  const byName = page.getByRole("link", { name: new RegExp(`^${name}$`, "i") });
  const pool = hrefNeedle ? byHref : byName;
  const n = await pool.count();
  for (let i = 0; i < n; i += 1) {
    const loc = pool.nth(i);
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 40 && box.height > 12) {
      if ((key === "segments" || key === "environments") && box.y < 100) return loc;
      if (key !== "segments" && key !== "environments" && box.x < 280) return loc;
    }
  }
  return byName.first();
}

async function pointerClickTop(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("locator has no box for pointer click");
  const vx = box.x + box.width / 2;
  const vy = box.y + box.height / 2;
  const point = await viewportToScreen(page, vx, vy);
  await focusChromeWindow();
  await xdotoolClick1(point.x, point.y, false);
}

async function clickSidebarLink(page: Page, name: string): Promise<void> {
  const nav = await sidebarNavLink(page, name);
  await pointerClickTop(page, nav);
  await sleep(350);
  await sanitizeFlagsmithUi(page);
}

async function clickLeftNav(page: Page, name: string): Promise<void> {
  const loc = page.locator("a,button,div").filter({ hasText: new RegExp(`^${name}$`, "i") });
  const n = await loc.count();
  for (let i = 0; i < n; i += 1) {
    const el = loc.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (box && box.x < 220 && box.y > 70 && box.width > 24 && box.height > 10 && box.height < 40) {
      await pointerClickTop(page, el);
      await sleep(350);
      await sanitizeFlagsmithUi(page);
      return;
    }
  }
  await clickSidebarLink(page, name);
}

async function clickPanelTabs(page: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    const loc = page.getByText(label, { exact: true });
    const n = await loc.count();
    let best: { x: number; y: number; w: number; h: number } | null = null;
    for (let i = 0; i < n; i += 1) {
      const box = await loc.nth(i).boundingBox().catch(() => null);
      if (!box || box.height > 48 || box.y < 40) continue;
      if (!best || box.x > best.x) best = { x: box.x, y: box.y, w: box.width, h: box.height };
    }
    if (!best) continue;
    const point = await viewportToScreen(page, best.x + Math.min(20, best.w / 2), best.y + best.h / 2);
    await xdotoolClick1(point.x, point.y);
    await sleep(180);
  }
}

async function openExperimentsViaSidebar(page: Page): Promise<void> {
  if (allowWindowRaise && recordingChromePid) await clickInertContent(page, recordingChromePid);
  await clickLeftNav(page, "Experiments");
  const onExperiments = () => /\/experiments(\/|\?|$)/.test(new URL(page.url()).pathname);
  if (!onExperiments()) {
    await clickSidebarLink(page, "Experiments");
    await page
      .waitForFunction(() => /\/experiments(\/|\?|$)/.test(location.pathname), { timeout: 5_000 })
      .catch(() => undefined);
  }
  if (!onExperiments() && recordingChromePid) {
    const experimentsUrl = page.url().replace(/\/(features|metrics|segments|identities|experiments).*$/, "/experiments");
    await typeUrlInOmnibox(page, recordingChromePid, experimentsUrl);
  }
  if (!onExperiments()) {
    throw new Error(`sidebar Experiments click did not navigate (url=${page.url()})`);
  }
  await page.getByRole("heading", { name: /experiments/i }).waitFor({ timeout: 8_000 });
}

async function featuresSearchRect(page: Page): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(() => {
    const vis = [...document.querySelectorAll('input[placeholder="Search"]')]
      .map((el) => (el as HTMLElement).getBoundingClientRect())
      .filter((r) => r.width > 80 && r.height > 8 && r.height < 48 && r.y > 70 && r.y < 380);
    vis.sort((a, b) => a.y - b.y);
    const r = vis[0];
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  });
}

async function searchFeatureList(
  page: Page,
  name: string,
  opts?: { expectEmpty?: boolean },
): Promise<void> {
  if (await page.getByText(/^Edit Feature:/).first().isVisible().catch(() => false)) {
    await closeFeaturePanel(page);
  }
  const search = page.locator('input[placeholder="Search"]').first();
  await search.waitFor({ state: "visible", timeout: 8_000 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await page.getByText(/^Edit Feature:/).first().isVisible().catch(() => false)) {
      await closeFeaturePanel(page);
    }
    const rect = (await featuresSearchRect(page)) ?? (await search.boundingBox().catch(() => null));
    if (!rect) throw new Error("features search box has no box");
    const height = "h" in rect ? rect.h : rect.height;
    const width = "w" in rect ? rect.w : rect.width;
    const vx = rect.x + Math.max(24, (width || 80) * 0.4);
    const vy = rect.y + Math.max(6, (height || 20) * 0.5);
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const input = el instanceof HTMLElement ? el.closest("input") : null;
        return { ok: Boolean(input && (input as HTMLInputElement).placeholder === "Search"), tag: el?.tagName ?? "none" };
      },
      { x: vx, y: vy },
    );
    const point = await viewportToScreen(page, vx, vy);
    await focusChromeWindow();
    await xdotoolClick1(point.x, point.y, false);
    await focusChromeWindow();
    const focused = await search.evaluate((el) => document.activeElement === el).catch(() => false);
    if (!focused) {
      await sh("xdotool", ["click", "1"]);
      await sleep(80);
    }
    const still = await search.evaluate((el) => document.activeElement === el).catch(() => false);
    if (!still) continue;
    await sh("xdotool", ["key", "ctrl+a"]);
    await sleep(80);
    await sh("xdotool", ["key", "BackSpace"]);
    await sleep(80);
    if (name) await xdotoolType(name, 32);
    await sleep(800);
    const body = ((await page.evaluate(() => document.body.innerText ?? "")) ?? "").replace(/\s+/g, " ");
    const empty = /no results/i.test(body);
    if (opts?.expectEmpty) {
      if (empty) return;
      continue;
    }
    if (!name || body.includes(name) || empty) return;
  }
  const url = page.url();
  const dump = ((await page.evaluate(() => document.body.innerText ?? "")) ?? "").slice(0, 400);
  await page.screenshot({ path: "/tmp/lift-t4-search-fail.png" }).catch(() => undefined);
  throw new Error(`features search box did not receive the typed query (${url}) ${dump}`);
}

async function featureRowByName(page: Page, name: string): Promise<Locator> {
  const matches = page.getByText(name, { exact: true });
  const n = await matches.count();
  const searchBox = await page.getByPlaceholder("Search").first().boundingBox().catch(() => null);
  const searchBottom = searchBox ? searchBox.y + searchBox.height : 80;
  for (let i = 0; i < n; i += 1) {
    const loc = matches.nth(i);
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.y > searchBottom + 4 && box.height > 8 && box.width > 20) return loc;
  }
  return matches.last();
}

async function waitSkillRunLogContains(
  needle: string,
  timeoutMs: number,
  stir = true,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStir = 0;
  while (Date.now() < deadline) {
    if (existsSync("/tmp/lift-t4-skill-run.log")) {
      const log = stripScriptLog(readFileSync("/tmp/lift-t4-skill-run.log", "utf8"));
      if (log.includes("stale-flag NOT deleted")) {
        throw new Error("skill-run did not delete the stale flag");
      }
      if (log.includes(needle)) return log;
    }
    if (stir && Date.now() - lastStir > 2500) {
      lastStir = Date.now();
      await stirTerminal("t4-skill-run");
    }
    await sleep(120);
  }
  throw new Error(`skill-run log missing ${needle}`);
}

async function waitSkillRunLog(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStir = 0;
  while (Date.now() < deadline) {
    if (existsSync("/tmp/lift-t4-skill-run.log")) {
      const log = readFileSync("/tmp/lift-t4-skill-run.log", "utf8");
      if (log.includes("stale-flag NOT deleted")) {
        throw new Error("skill-run did not delete the stale flag");
      }
      if (log.includes("stale-flag deleted") && /COMMAND_EXIT_CODE="0"/.test(log)) return log;
      if (log.includes("stale-flag deleted") && /COMMAND_EXIT_CODE="[1-9]/.test(log)) {
        throw new Error("skill-run exited non-zero after stale-flag banner");
      }
    }
    if (Date.now() - lastStir > 2500) {
      lastStir = Date.now();
      await stirTerminal("t4-skill-run");
    }
    await sleep(400);
  }
  throw new Error("skill-run did not finish");
}

async function recordT4(): Promise<void> {
  await closeWindowsNamed("t3-selfhost-up");
  await closeWindowsNamed("t3-site-reads-selfhosted-flag");
  await stopRunningForFlag("lift_a11y_r5");
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  const out = resolve(recordings, "t4-skill-run.mp4");
  await killStrayFfmpeg(out);
  let chrome: { child: ChildProcess; cdp: number; profile: string } | null = null;
  let browser: Browser | undefined;
  let runTerm: { child: ChildProcess; done: string; scriptPath: string } | null = null;
  allowWindowRaise = true;
  await hideDock();
  chrome = await startChrome("top");
  const chromePid = chrome.child.pid;
  if (!chromePid) throw new Error("chrome pid missing");
  recordingChromePid = chromePid;
  const connected = await connectChrome(chrome.cdp);
  browser = connected.browser;
  await ensureChromeGeometry(chromePid, 1920, 680, connected.page);
  try {
    writeFileSync("/tmp/lift-t4-skill-run.log", "");
  } catch {
    /* */
  }
  runTerm = await openTerminal("t4-skill-run", "", "200x28+8+700", false, true);
  const ff = startFfmpeg(out);
  const finish = makeClipFinisher(ff, out);
  try {
    const page = connected.page;
    await loginFlagsmith(page, chromePid);
    await openLiftFeatures(page);
    await visibleReload(page, chromePid, { method: "reload-button", verifyMs: 3_000 });
    const existingStales = await snapshotStaleFlagNames(lift);
    clearLeftoverApproveMarkers();
    await clickFocusTerminal("t4-skill-run");
    const launch =
      'script -q -f -e -c "stdbuf -o0 -e0 env LIFT_RECORD_HARNESS=1 npx tsx scripts/skill-run.ts --apply --start --traffic-n 200 --flag lift_a11y_r5 --reuse-flag" /tmp/lift-t4-skill-run.log; echo exit=$?';
    await xdotoolType(launch, 18);
    await sleep(120);
    await sh("xdotool", ["key", "--clearmodifiers", "Return"]);
    const typedDeadline = Date.now() + 20_000;
    let typedLog = "";
    while (Date.now() < typedDeadline) {
      typedLog = existsSync("/tmp/lift-t4-skill-run.log")
        ? readFileSync("/tmp/lift-t4-skill-run.log", "utf8")
        : "";
      if (typedLog.includes("skill-run") || typedLog.includes("guard") || typedLog.includes("npx")) break;
      await sleep(200);
    }
    if (!typedLog.includes("skill-run") && !typedLog.includes("guard") && !typedLog.includes("npx")) {
      throw new Error("skill-run command was not received by the terminal");
    }
    allowWindowRaise = false;
    const approveLineP = waitForApproveLine("t4-skill-run", undefined, false);
    const staleName = await waitStaleFlagName(lift, existingStales, 120_000);
    if (await page.getByText(/^Edit Feature:/).first().isVisible().catch(() => false)) {
      await closeFeaturePanel(page);
    }
    await clickLeftNav(page, "Features");
    await searchFeatureList(page, staleName);
    const staleRow = await featureRowByName(page, staleName);
    await staleRow.waitFor({ state: "visible", timeout: 15_000 });
    await pointerClick(page, staleRow);
    await page.getByText(new RegExp(`^Edit Feature:\\s*${staleName}`)).waitFor({ timeout: 8_000 });
    await sleep(500);
    await closeFeaturePanel(page);
    const approveLine = await awaitWhileNavigating(page, chromePid, approveLineP);
    await typeApproveLine("t4-skill-run", approveLine);
    const deletedLog = await awaitWhileNavigating(
      page,
      chromePid,
      waitSkillRunLogContains(`stale-flag deleted ${staleName}`, 180_000, false),
    );
    if (!deletedLog.includes(`stale-flag deleted ${staleName}`)) {
      throw new Error("stale-flag deleted banner missing from skill-run log");
    }
    const pageHasNoResults = async () =>
      page.evaluate(() => /no results/i.test(document.body.innerText ?? ""));
    if (await page.getByText(/^Edit Feature:/).first().isVisible().catch(() => false)) {
      await closeFeaturePanel(page);
    }
    await focusChromeWindow();
    const featuresUrl = page.url().split("?")[0];
    await typeUrlInOmnibox(page, chromePid, featuresUrl);
    await clickLeftNav(page, "Features");
    await page.getByText("checkout_a11y").first().waitFor({ state: "visible", timeout: 15_000 });
    await searchFeatureList(page, staleName, { expectEmpty: true });
    if (!(await pageHasNoResults())) {
      await visibleReload(page, chromePid, { method: "reload-button", verifyMs: 3_000 });
      await clickLeftNav(page, "Features");
      await searchFeatureList(page, staleName, { expectEmpty: true });
    }
    if (!(await pageHasNoResults())) {
      throw new Error("No results not visible after stale-flag delete");
    }
    const noResults = page.getByText(/no results/i).first();
    await noResults.waitFor({ state: "visible", timeout: 5_000 });
    await sleep(3_200);
    await searchFeatureList(page, "lift_a11y_r5");
    const skillRow = await featureRowByName(page, "lift_a11y_r5");
    await skillRow.waitFor({ state: "visible", timeout: 10_000 });
    const weightLabel = page.getByText("Environment Weight %").first();
    await pointerClick(page, skillRow);
    await weightLabel.waitFor({ state: "visible", timeout: 8_000 });
    await pointerWheel(page, weightLabel, 4);
    const treatmentWeight = page.locator('input[type="number"]').last();
    await treatmentWeight.waitFor({ state: "visible", timeout: 8_000 });
    await pointerClick(page, treatmentWeight);
    const weightVal = await treatmentWeight.inputValue();
    if (!/^100(\.0+)?$/.test(weightVal)) {
      throw new Error(`treatment Environment Weight % is not 100 (got ${JSON.stringify(weightVal)})`);
    }
    await pointerWheel(page, weightLabel, 2, 4);
    await sleep(400);
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    await closeFeaturePanel(page);
    const last = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "skills/flagsmith-a11y-experiment/last-run.json"), "utf8"),
    ) as { experimentId?: number };
    const experimentId = Number(last.experimentId ?? 0);
    if (!experimentId) throw new Error("last-run.json missing experimentId");
    const listed = await lift.listExperiments();
    const experimentName = listed.find((row) => row.id === experimentId)?.name ?? "";
    if (!experimentName) throw new Error(`experiment ${experimentId} not listed`);
    await openExperimentsViaSidebar(page);
    await sleep(3200);
    const target = experimentOpenTarget(experimentId, listed);
    const byHref = page.locator(`a[href*="${target.href}"]`).first();
    if (await byHref.count()) {
      await pointerClick(page, byHref);
    } else {
      const expRow = page.getByText(target.name || experimentName, { exact: false }).first();
      await expRow.waitFor({ state: "visible", timeout: 10_000 });
      await pointerClick(page, expRow);
    }
    await sanitizeFlagsmithUi(page);
    await assertNoSecrets(page);
    const results = page.getByText("Results", { exact: true }).first();
    await results.waitFor({ state: "visible", timeout: 10_000 });
    const resultsTable = page.getByText(/conversions|probability|p\(best\)/i).first();
    if (!(await resultsTable.isVisible())) {
      const pagePoint = await viewportToScreen(page, 640, 360);
      await glidePointerTo(pagePoint.x, pagePoint.y);
      await sleep(550);
      await pointerWheel(page, results, 2);
    }
    await resultsTable.waitFor({ state: "visible", timeout: 10_000 });
    await abortIfServerKeyLeaked(page);
    await sleep(4_500);
    await finish();
  } finally {
    recordingChromePid = null;
    allowWindowRaise = true;
    await finish();
    await showDock();
    await closeWindowsNamed("t4-skill-run");
    cleanupTermFiles(runTerm);
    await stopChrome(chrome, browser);
  }
}

const which = process.argv[2] ?? "all";
const clips: Record<string, () => Promise<void>> = {
  "t3-selfhost-up": recordT3Up,
  "t3-site-reads-selfhosted-flag": recordT3Site,
  "t3-dashboard": recordT3Dashboard,
  "t4-skill-run": recordT4,
};

if (which === "all") {
  for (const [name, fn] of Object.entries(clips)) {
    process.stderr.write(`recording ${name}\n`);
    await fn();
    await assertClipMotion(resolve(recordings, `${name}.mp4`));
  }
} else if (clips[which]) {
  await clips[which]();
  await assertClipMotion(resolve(recordings, `${which}.mp4`));
} else {
  throw new Error(`unknown clip ${which}`);
}
clipIndex();
process.stdout.write("live recordings written\n");
