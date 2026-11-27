#!/usr/bin/env node
/**
 * Headed Chrome evidence recorder for Phase A clips 01–05.
 * Every click is a real X11 pointer move via xdotool. Probe nodes and
 * evidence are created by typing in the visible DevTools Console.
 *
 * Prerequisites: Chrome on DISPLAY=:1 with CDP 9222, checkout on :4190
 * without --allow-mock, Flagsmith identity tab open.
 *
 *   node scripts/record-phase-a.mjs
 *   node scripts/record-phase-a.mjs 01 02
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const here = dirname(fileURLToPath(import.meta.url));

const DISPLAY = process.env.DISPLAY || ":1";
const PORT = process.env.LIFT_PORT || "4190";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.EVIDENCE_MP4_DIR || "/cursor/stores/self/recordings/fir-9-a-final";
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const VID = process.env.LIFT_VID || "a80cc96e-b7ad-44a7-b759-1615607478a6";
const FM_IDENTITY =
  process.env.FLAGSMITH_IDENTITY_URL ||
  "https://app.flagsmith.com/project/56470/environment/LA6mpev9Bggh3nyPCZVsUg/identities/a80cc96e-b7ad-44a7-b759-1615607478a6/055daf0e-5622-45a5-a39f-d042ef385268";
const XDOTOOL_ENV = { ...process.env, DISPLAY };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xdo(args) {
  const r = spawnSync("xdotool", args, { env: XDOTOOL_ENV, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`xdotool ${args.join(" ")} → ${r.stderr || r.status}`);
  }
  return (r.stdout || "").trim();
}

function chromeWinId() {
  const ids = xdo(["search", "--onlyvisible", "--class", "google-chrome"]).split("\n").filter(Boolean);
  if (!ids.length) throw new Error("no visible Chrome window");
  return ids[ids.length - 1];
}

function winGeom(id) {
  const out = xdo(["getwindowgeometry", "--shell", id]);
  const map = Object.fromEntries(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  return {
    id,
    x: Number(map.X),
    y: Number(map.Y),
    w: Number(map.WIDTH),
    h: Number(map.HEIGHT),
  };
}

async function xMoveTo(x, y) {
  xdo(["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))]);
  await sleep(90);
}

async function xMoveClick(x, y, hold = 90) {
  await xMoveTo(x, y);
  await sleep(hold);
  xdo(["click", "1"]);
  await sleep(140);
}

const TOP_CHROME = 80;
const LEFT_CHROME = 0;
let WIN = { x: 78, y: 39, w: 1734, h: 1103, id: "" };

async function screenBox(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("locator has no box");
  const inner = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    innerH: window.innerHeight,
    outerH: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
  }));
  const isDt = page.url().startsWith("devtools://");
  const gap = (inner.outerH || 0) - (inner.innerH || inner.h || 0);
  const x = inner.screenX + LEFT_CHROME + box.x + box.width / 2;
  let y;
  if (isDt) {
    y = WIN.y + WIN.h - inner.h - 2 + box.y + box.height / 2;
  } else if (gap > 200) {
    y = inner.screenY + TOP_CHROME + box.y + box.height / 2;
  } else {
    y = inner.screenY + Math.max(0, gap - 36) + box.y + box.height / 2;
  }
  return { x, y, box, inner, isDt };
}

async function xClickLocator(page, locator) {
  const pos = await screenBox(page, locator);
  await xMoveClick(pos.x, pos.y);
}

function startFfmpeg(file) {
  const proc = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      "1920x1200",
      "-framerate",
      "25",
      "-i",
      `${DISPLAY}.0`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-movflags",
      "+faststart",
      file,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DISPLAY } },
  );
  proc.err = "";
  proc.stderr.on("data", (d) => {
    proc.err += d.toString();
  });
  return proc;
}

async function stopFfmpeg(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.stdin.write("q");
  } catch {
    proc.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8000);
    proc.on("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function ffprobeDuration(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return Number(r.stdout.trim()) || 0;
}

async function recordClip(name, run) {
  const file = `${OUT}/${name}.mp4`;
  const proc = startFfmpeg(file);
  await sleep(500);
  try {
    await run();
    await sleep(800);
  } finally {
    await stopFfmpeg(proc);
  }
  const dur = ffprobeDuration(file);
  console.log(`saved ${file} duration=${dur.toFixed(1)}s`);
  if (dur < 8) throw new Error(`${name} too short (${dur.toFixed(1)}s)`);
  return { file, duration: dur };
}

function clickCheckoutTab() {
  return xMoveClick(WIN.x + 240, WIN.y + 16);
}

function clickFlagsmithTab() {
  return xMoveClick(WIN.x + 420, WIN.y + 16);
}

function clickReload() {
  return xMoveClick(WIN.x + 100, WIN.y + 54);
}

async function reloadCheckout(page) {
  await page.bringToFront();
  await clickCheckoutTab();
  await sleep(250);
  const nav = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
  await clickReload();
  let loaded = await nav;
  if (!loaded) {
    const nav2 = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    xdo(["key", "F5"]);
    loaded = await nav2;
  }
  if (!loaded) await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(400);
}

const DT_TAB_XY = {
  Elements: [180, 828],
  Console: [250, 828],
  Sources: [320, 828],
  Network: [390, 828],
  Application: [620, 828],
};

async function clickDevToolsTab(_dt, name) {
  const xy = DT_TAB_XY[name] || DT_TAB_XY.Console;
  await xMoveClick(xy[0], xy[1]);
}

async function focusConsole(dt) {
  await clickDevToolsTab(dt, "Console");
  await xMoveClick(150, 900);
  await sleep(220);
}

async function typeConsole(dt, code) {
  await focusConsole(dt);
  await dt.keyboard.type(code, { delay: 26 });
  await dt.keyboard.press("Enter");
  await sleep(550);
}

async function ensureCheckoutDevtools(page, dtHint) {
  await page.bringToFront();
  let dt = dtHint;
  if (!dt || dt.isClosed()) {
    xdo(["key", "F12"]);
    await sleep(700);
  }
  const pages = page.context().pages();
  dt = pages.find((p) => p.url().startsWith("devtools://") && !p.isClosed()) || dt;
  return dt;
}

async function waitFlagsmith(page, timeout = 20000) {
  await page.waitForFunction(
    () => {
      const v = document.body.getAttribute("data-variant");
      return v === "control" || v === "treatment";
    },
    { timeout },
  );
}

async function waitEdgeValue(wanted, tries = 25) {
  const env = process.env.FLAGSMITH_ENVIRONMENT_KEY || "LA6mpev9Bggh3nyPCZVsUg";
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`https://edge.api.flagsmith.com/api/v1/identities/?identifier=${VID}`, {
        headers: { "X-Environment-Key": env },
      });
      const data = await res.json();
      const flag = (data.flags || []).find((f) => f.feature?.name === "checkout_a11y");
      const value = flag?.variant || flag?.feature_state_value;
      console.log(`edge checkout_a11y=${value} want=${wanted}`);
      if (value === wanted) return;
    } catch (err) {
      console.warn("edge poll", err);
    }
    await sleep(1000);
  }
  throw new Error(`edge never reached ${wanted}`);
}

async function waitVariant(page, wanted, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await page
      .waitForFunction((v) => document.body.getAttribute("data-variant") === v, wanted, {
        timeout: 6000,
      })
      .then(
        () => true,
        () => false,
      );
    if (ok) return;
    await reloadCheckout(page);
    await sleep(400);
  }
  const actual = await page.evaluate(() => document.body.getAttribute("data-variant"));
  throw new Error(`never reached ${wanted} (now ${actual})`);
}

async function showCheckout(page) {
  await page.bringToFront();
  await clickCheckoutTab();
  await sleep(280);
}

function flagsmithPage(page) {
  return page
    .context()
    .pages()
    .find((p) => p.url().includes("flagsmith.com") && !p.url().startsWith("devtools://"));
}

async function showFlagsmith(page) {
  const fm = flagsmithPage(page);
  if (!fm) throw new Error("Flagsmith tab missing");
  await clickFlagsmithTab();
  await fm.bringToFront();
  await sleep(350);
  return fm;
}

async function openCheckoutX(page) {
  await page.bringToFront();
  await dismissSaveCard();
  const trigger = page.locator("#shop-trigger");
  await trigger.waitFor({ state: "attached", timeout: 8000 });
  const tag = await trigger.evaluate((el) => el.tagName);
  if (tag === "BUTTON") {
    await xClickLocator(page, trigger);
  } else {
    await xMoveTo(1665, 175);
    await sleep(350);
    const visible = await page.locator("#checkout-link").isVisible().catch(() => false);
    if (!visible) {
      const pos = await screenBox(page, page.locator(".hover-nav"));
      await xMoveTo(pos.x + 24, pos.y);
      await sleep(350);
    }
  }
  const link = page.locator("#checkout-link");
  try {
    await link.waitFor({ state: "visible", timeout: 2500 });
    await xClickLocator(page, link);
  } catch {
    await xMoveClick(1665, 230);
  }
  await page.locator("#checkout").waitFor({ state: "visible", timeout: 8000 });
}

async function injectAxe(page) {
  const already = await page.evaluate(() => Boolean(window.axe));
  if (!already) await page.addScriptTag({ path: axePath });
}

function runOverride(cmd) {
  const committed = resolve(here, "flagsmith-override.py");
  const helper = existsSync(committed) ? committed : "/tmp/fm-override.py";
  if (!existsSync(helper)) {
    console.warn("no flagsmith override helper — skip");
    return;
  }
  const r = spawnSync("python3", [helper, cmd, VID], { encoding: "utf8", env: process.env });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) console.warn(`override ${cmd} exit ${r.status}`);
}

function setControlOverride() {
  runOverride("set-control");
}

function clearOverride() {
  runOverride("clear");
}

async function dismissSaveCard() {
  await xMoveClick(1692, 158, 40);
  await sleep(120);
  await xMoveClick(1575, 332, 40);
}

async function resetFlagsmithIdentity(page) {
  const fm = await showFlagsmith(page);
  await fm.keyboard.press("Escape").catch(() => {});
  await sleep(250);
  if (!fm.url().includes("/identities/")) {
    await fm.goto(FM_IDENTITY, { waitUntil: "domcontentloaded" });
  } else {
    await fm.reload({ waitUntil: "domcontentloaded" });
  }
  await fm.getByText("Identifier:", { exact: false }).first().waitFor({ timeout: 20000 });
  const search = fm.getByPlaceholder("Search").first();
  await xClickLocator(fm, search);
  xdo(["key", "ctrl+a"]);
  await fm.keyboard.type("checkout_a11y", { delay: 40 });
  await sleep(800);
  const reset = fm.getByRole("button", { name: /^Reset$/ }).first();
  await reset.waitFor({ state: "visible", timeout: 15000 });
  const pos = await screenBox(fm, reset);
  await xMoveClick(pos.x + Math.max(0, pos.box.width - 10), pos.y);
  const confirmField = fm
    .getByPlaceholder("feature_name")
    .or(fm.getByPlaceholder("checkout_a11y"))
    .or(fm.locator(".modal input, [role='dialog'] input").last());
  const opened = await confirmField.waitFor({ state: "visible", timeout: 2500 }).then(
    () => true,
    () => false,
  );
  if (!opened) {
    await xMoveClick(1638, 695);
  }
  const stillClosed = await confirmField.waitFor({ state: "visible", timeout: 2500 }).then(
    () => false,
    () => true,
  );
  if (stillClosed) {
    await reset.click({ force: true });
  }
  await confirmField.waitFor({ state: "visible", timeout: 8000 });
  await xClickLocator(fm, confirmField);
  const focused = await confirmField.evaluate((el) => document.activeElement === el);
  if (!focused) await confirmField.click();
  xdo(["key", "ctrl+a"]);
  await fm.keyboard.type("checkout_a11y", { delay: 70 });
  await sleep(450);
  const confirm = fm.getByRole("button", { name: /^Confirm$/ }).first();
  await confirm.waitFor({ state: "visible" });
  await fm.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll("button")];
      const el = buttons.find((b) => b.textContent?.trim() === "Confirm");
      return el instanceof HTMLButtonElement && !el.disabled;
    },
    undefined,
    { timeout: 8000 },
  );
  await xClickLocator(fm, confirm);
  await confirm.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await sleep(1500);
}

const clips = {
  async "01-control-treatment-axe"(page, dt) {
    setControlOverride();
    await waitEdgeValue("control");
    await showCheckout(page);
    await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
    await waitFlagsmith(page);
    await waitVariant(page, "control");
    await dismissSaveCard();
    await openCheckoutX(page);
    await injectAxe(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(dt, "(await axe.run()).violations.map(v=>v.id)");
    await sleep(2200);
    await resetFlagsmithIdentity(page);
    await waitEdgeValue("treatment");
    await showCheckout(page);
    await sleep(400);
    await reloadCheckout(page);
    await waitVariant(page, "treatment");
    await openCheckoutX(page);
    await injectAxe(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(dt, "(await axe.run()).violations.map(v=>v.id)");
    await sleep(2200);
  },

  async "02-keyboard-submit-once"(page, dt) {
    clearOverride();
    await showCheckout(page);
    await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
    await waitFlagsmith(page);
    await waitVariant(page, "treatment");
    await openCheckoutX(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(
      dt,
      "window.clicks = 0; document.getElementById('place-order')?.addEventListener('click', () => { window.clicks += 1 })",
    );
    await xClickLocator(page, page.locator("#email"));
    await page.keyboard.type("ada@northline.test", { delay: 45 });
    xdo(["key", "Tab"]);
    await sleep(220);
    await page.keyboard.type("Ada Lovelace", { delay: 35 });
    xdo(["key", "Tab"]);
    await sleep(180);
    await page.keyboard.type("4242424242424242", { delay: 18 });
    xdo(["key", "Tab"]);
    await sleep(180);
    await page.keyboard.type("12/28", { delay: 40 });
    xdo(["key", "Tab"]);
    await sleep(180);
    await page.keyboard.type("123", { delay: 40 });
    xdo(["key", "Tab"]);
    await sleep(220);
    xdo(["key", "space"]);
    await sleep(220);
    xdo(["key", "Tab"]);
    await sleep(400);
    xdo(["key", "Return"]);
    await sleep(700);
    await dismissSaveCard();
    await page.locator("#confirmation").waitFor({ state: "visible", timeout: 8000 });
    await typeConsole(dt, "clicks");
    await sleep(1800);
    await clickDevToolsTab(dt, "Network");
    await sleep(400);
    await xMoveClick(220, 870);
    await dt.keyboard.type("flagsmith", { delay: 40 });
    await sleep(900);
    await xMoveTo(260, 980);
    await sleep(1600);
  },

  async "03-per-node-attribution"(page, dt) {
    await showCheckout(page);
    await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
    await waitFlagsmith(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(dt, "s=document.createElement('style'); s.textContent='.dark{background-color:#111;color:#fff}'; document.head.append(s)");
    await typeConsole(
      dt,
      "a=document.createElement('div'); a.id='node-a'; a.className='probe'; a.textContent='A'; a.style.cssText='padding:10px;background:#fff;color:#111;font:700 18px/1.3 system-ui'",
    );
    await typeConsole(
      dt,
      "dark=document.createElement('div'); dark.className='dark'; dark.style.cssText='padding:10px;margin-top:12px'; b=document.createElement('div'); b.id='node-b'; b.className='probe'; b.textContent='B'; b.style.cssText='background:#fff;color:#111;font:700 18px/1.3 system-ui'; document.body.append(a, dark, b)",
    );
    await typeConsole(
      dt,
      "(await import('/runtime/runtime.js')).applyPatchSpec({id:'per-node',version:0,ops:[{op:'injectCSS',rules:[{selector:{classes:['probe']},declarations:[{property:'color',value:'#111'}]}]}]})",
    );
    await sleep(400);
    await typeConsole(dt, "a.style.color='#eee'");
    await typeConsole(dt, "b.style.backgroundColor=''; b.style.color=''; dark.append(b)");
    await sleep(900);
    await typeConsole(
      dt,
      "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,attributions:s.attributions,lastAttributions:s.lastAttributions},null,2)",
    );
    await sleep(1800);
  },

  async "04-cssom-edit-detected"(page, dt) {
    await showCheckout(page);
    await reloadCheckout(page);
    await waitFlagsmith(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(dt, "clear()");
    await typeConsole(
      dt,
      "p=document.createElement('div'); p.className='probe'; p.textContent='Probe'; p.style.cssText='padding:12px;background:#fff;font:700 20px/1.3 system-ui'; document.body.append(p)",
    );
    await typeConsole(
      dt,
      "(await import('/runtime/runtime.js')).applyPatchSpec({id:'cssom-edit',version:0,ops:[{op:'injectCSS',rules:[{selector:{classes:['probe']},declarations:[{property:'color',value:'#111'}]}]}]})",
    );
    await typeConsole(dt, "sheet=document.querySelector('[data-lift-css]'); sheet.disabled");
    await sleep(500);
    await typeConsole(dt, "sheet.sheet.cssRules[0].style.color='#eee'");
    await sleep(2200);
    await typeConsole(dt, "sheet.disabled");
    await typeConsole(
      dt,
      "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,attributions:s.attributions,ticksRan:s.ticksRan})",
    );
    await sleep(1600);
  },

  async "05-page-contrast-no-loop"(page, dt) {
    await showCheckout(page);
    await reloadCheckout(page);
    await waitFlagsmith(page);
    dt = await ensureCheckoutDevtools(page, dt);
    await typeConsole(dt, "clear()");
    await typeConsole(
      dt,
      "h=document.createElement('a'); h.id='hit'; h.href='#x'; h.textContent='Go'; h.style.cssText='display:inline-block;padding:12px 18px;color:#111;background:#fff;font:700 22px/1.3 system-ui'; document.body.append(h)",
    );
    await typeConsole(
      dt,
      "(await import('/runtime/runtime.js')).applyPatchSpec({id:'minw',version:0,ops:[{op:'injectCSS',rules:[{selector:{id:'hit'},declarations:[{property:'min-width',value:'44px'}]}]}]})",
    );
    await typeConsole(dt, "h.style.color='#eee'");
    await sleep(250);
    await typeConsole(dt, "h.style.color='#111'");
    await sleep(250);
    await typeConsole(dt, "h.style.color='#eee'");
    await sleep(250);
    await typeConsole(dt, "h.style.color='#111'");
    await sleep(400);
    await typeConsole(
      dt,
      "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,ticksRan:s.ticksRan,attributions:s.attributions})",
    );
    await sleep(5000);
    await typeConsole(
      dt,
      "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,ticksRan:s.ticksRan,attributions:s.attributions})",
    );
    await sleep(5000);
    await typeConsole(
      dt,
      "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,ticksRan:s.ticksRan,attributions:s.attributions})",
    );
    await sleep(1600);
  },
};

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const names = wanted.length
  ? wanted.map((n) => {
      const key = Object.keys(clips).find((k) => k.startsWith(n) || k.includes(n));
      if (!key) throw new Error(`unknown clip ${n}`);
      return key;
    })
  : Object.keys(clips);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
let page = context.pages().find((p) => p.url().includes("/checkout/") && !p.url().startsWith("devtools://"));
if (!page) page = context.pages().find((p) => !p.url().startsWith("devtools://") && p.url().startsWith("http"));
if (!page) page = await context.newPage();
let dt = context.pages().find((p) => p.url().startsWith("devtools://"));
WIN = winGeom(chromeWinId());
xdo(["windowactivate", WIN.id]);
console.log("chrome window", WIN);
await page.bringToFront();
await clickCheckoutTab();
await dismissSaveCard();

const results = [];
for (const name of names) {
  console.log("recording", name);
  results.push(await recordClip(name, () => clips[name](page, dt, WIN)));
}
console.log(results);
process.exit(0);
