#!/usr/bin/env node
/**
 * Headed Chrome evidence recorder for Phase A clips 01–06.
 * Every click is a real X11 pointer move via xdotool. Neutral demo-target
 * nodes and evidence are created by typing in the visible DevTools Console,
 * or by using the app's own UI.
 *
 * Prerequisites: Chrome on DISPLAY=:1 with CDP 9222, checkout served
 * without --allow-mock, Flagsmith identity tab available.
 *
 * Required env: FLAGSMITH_ENVIRONMENT_KEY, FLAGSMITH_IDENTITY_URL,
 * FLAGSMITH_FEATURE_ID, FLAGSMITH_ADMIN_API_TOKEN (for clip 01 override),
 * LIFT_DISABLE_AUTOFILL=true on the demo server.
 *
 *   node scripts/record-phase-a.mjs
 *   node scripts/record-phase-a.mjs 01 02
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const DISPLAY = process.env.DISPLAY || ":1";
const PORT = process.env.LIFT_PORT || "4190";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.EVIDENCE_MP4_DIR || resolve(here, "../artifacts/fir-9-a/recorder");
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const FM_IDENTITY = requireEnv("FLAGSMITH_IDENTITY_URL");
const ENV_KEY = requireEnv("FLAGSMITH_ENVIRONMENT_KEY");
requireEnv("FLAGSMITH_FEATURE_ID");
const VID =
  process.env.LIFT_VID ||
  (FM_IDENTITY.match(/\/identities\/([^/?#]+)/) || [])[1] ||
  "";
if (!VID) {
  console.error("LIFT_VID is required, or FLAGSMITH_IDENTITY_URL must include /identities/<id>/");
  process.exit(1);
}
const XDOTOOL_ENV = { ...process.env, DISPLAY };
const AXE_LOAD =
  "s=document.createElement('script');s.src='/vendor/axe.min.js';await new Promise((res,rej)=>{s.onload=res;s.onerror=()=>rej(new Error('axe load'));document.head.append(s)});window.__axeIds=(await axe.run()).violations.map(v=>v.id).sort();window.__axeIds";
const CONTROL_AXE = ["button-name", "color-contrast", "label", "region"];
const TREATMENT_AXE = ["region"];

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

function mouseLocation() {
  const out = xdo(["getmouselocation"]);
  return {
    x: Number((out.match(/x:(-?\d+)/) || [])[1] || 0),
    y: Number((out.match(/y:(-?\d+)/) || [])[1] || 0),
  };
}

async function xMoveTo(x, y) {
  const destX = Math.round(x);
  const destY = Math.round(y);
  const cur = mouseLocation();
  const dx = destX - cur.x;
  const dy = destY - cur.y;
  const dist = Math.hypot(dx, dy);
  const steps = dist < 12 ? 1 : Math.max(6, Math.min(28, Math.ceil(dist / 45)));
  for (let i = 1; i <= steps; i += 1) {
    xdo([
      "mousemove",
      "--sync",
      String(Math.round(cur.x + (dx * i) / steps)),
      String(Math.round(cur.y + (dy * i) / steps)),
    ]);
    if (steps > 1) await sleep(14);
  }
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
  await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  const box = await locator.boundingBox({ timeout: 2000 });
  if (!box) throw new Error("locator has no box");
  const inner = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
  }));
  return {
    x: inner.screenX + LEFT_CHROME + box.x + box.width / 2,
    y: inner.screenY + TOP_CHROME + box.y + box.height / 2,
    box,
  };
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
    "ffmpeg",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return Number((probe.stdout || r.stdout || "").trim()) || 0;
}

async function recordClip(name, run) {
  const file = `${OUT}/${name}.mp4`;
  const proc = startFfmpeg(file);
  await sleep(400);
  try {
    await run();
    await sleep(700);
  } catch (err) {
    await stopFfmpeg(proc);
    try {
      unlinkSync(file);
    } catch {
      /* keep going */
    }
    throw err;
  }
  await stopFfmpeg(proc);
  const dur = ffprobeDuration(file);
  console.log(`saved ${file} duration=${dur.toFixed(1)}s`);
  if (dur < 8) throw new Error(`${name} too short (${dur.toFixed(1)}s)`);
  return { file, duration: dur };
}

function chromeTitle() {
  return xdo(["getwindowname", WIN.id]);
}

function isCheckoutTitle(title) {
  return /Northline/i.test(title) && !/Flagsmith/i.test(title);
}

function isFlagsmithTitle(title) {
  return /Flagsmith/i.test(title);
}

const TAB_DX = { checkout: null, flagsmith: null };

async function clickTabUntil(pred, label, key) {
  if (pred(chromeTitle())) return;
  xdo(["windowactivate", "--sync", WIN.id]);
  const offsets = [];
  if (TAB_DX[key] != null) offsets.push(TAB_DX[key]);
  for (let dx = 140; dx <= 560; dx += 36) {
    if (!offsets.includes(dx)) offsets.push(dx);
  }
  for (const dx of offsets) {
    await xMoveClick(WIN.x + dx, WIN.y + 16);
    await sleep(160);
    if (pred(chromeTitle())) {
      TAB_DX[key] = dx;
      return;
    }
  }
  throw new Error(`${label} tab click did not select (title=${chromeTitle()})`);
}

async function clickCheckoutTab() {
  await clickTabUntil(isCheckoutTitle, "checkout", "checkout");
}

async function clickFlagsmithTab() {
  await clickTabUntil(isFlagsmithTitle, "Flagsmith", "flagsmith");
}

function clickReload() {
  return xMoveClick(WIN.x + 96, WIN.y + 58);
}

async function reloadVisible(page, tab) {
  xdo(["windowactivate", "--sync", WIN.id]);
  if (tab === "flagsmith") await clickFlagsmithTab();
  else await clickCheckoutTab();
  await sleep(180);
  const beforeUrl = page.url();
  const origin = await page.evaluate(() => performance.timeOrigin);
  await clickReload();
  const moved = await page
    .waitForFunction((o) => performance.timeOrigin !== o, origin, { timeout: 1500 })
    .then(
      () => true,
      () => false,
    );
  if (!moved) {
    throw new Error("reload button click did not start navigation within 1.5s");
  }
  await page.waitForLoadState("domcontentloaded");
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl) {
    throw new Error(`reload changed url ${beforeUrl} -> ${afterUrl}`);
  }
  const navType = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry && "type" in entry ? entry.type : "";
  });
  if (navType !== "reload") {
    throw new Error(`navigation type was ${navType || "missing"}, want reload`);
  }
  await sleep(250);
}

async function liveDevtools(page, hint) {
  const context = page.context();
  const origin = await page.evaluate(() => ({ sx: window.screenX, sy: window.screenY }));
  const dts = [];
  if (hint && !hint.isClosed() && hint.url().startsWith("devtools://")) dts.push(hint);
  for (const p of context.pages()) {
    if (p.url().startsWith("devtools://") && !dts.includes(p)) dts.push(p);
  }
  const scored = [];
  for (const dt of dts) {
    const ok = await dt
      .locator("#tab-console")
      .waitFor({ state: "visible", timeout: 2500 })
      .then(
        () => true,
        () => false,
      );
    if (!ok) continue;
    const pos = await dt.evaluate(() => ({ sx: window.screenX, sy: window.screenY }));
    const dist = Math.abs(pos.sx - origin.sx) + Math.abs(pos.sy - origin.sy);
    scored.push({ dt, dist });
  }
  scored.sort((a, b) => a.dist - b.dist);
  if (scored[0]) return scored[0].dt;
  throw new Error("no live DevTools Console tab");
}

async function clickDevToolsTab(dt, name) {
  const id = { Console: "#tab-console", Network: "#tab-network", Application: "#tab-resources" }[name];
  if (!id) throw new Error(`unknown DevTools tab ${name}`);
  const tab = dt.locator(id);
  await tab.waitFor({ state: "visible", timeout: 4000 });
  const selected = await tab.getAttribute("aria-selected");
  if (selected === "true") return;
  await xClickLocator(dt, tab);
}

async function focusConsole(dt) {
  await clickDevToolsTab(dt, "Console");
  await sleep(120);
  await xClickLocator(dt, dt.locator("#console-prompt"));
  await sleep(120);
}

async function typeConsole(dt, code, opts = {}) {
  const t0 = Date.now();
  if (opts.refocus !== false) await focusConsole(dt);
  await dt.keyboard.type(code, { delay: 16 });
  await dt.keyboard.press("Enter");
  await sleep(280);
  console.log(`typed ${code.slice(0, 48)}… ${(Date.now() - t0) / 1000}s`);
}

async function clickClearConsole(dt) {
  await clickDevToolsTab(dt, "Console");
  await sleep(120);
  const btn = dt.getByRole("button", { name: "Clear console" });
  await btn.waitFor({ state: "visible", timeout: 4000 });
  await xClickLocator(dt, btn);
  await sleep(180);
}

async function ensureCheckoutDevtools(page, dtHint) {
  if (!isCheckoutTitle(chromeTitle())) await clickCheckoutTab();
  return liveDevtools(page, dtHint);
}

async function waitFlagsmith(page, timeout = 8000) {
  await page.waitForFunction(
    () => {
      const v = document.body.getAttribute("data-variant");
      return v === "control" || v === "treatment";
    },
    null,
    { timeout },
  );
}

async function seedVisitorCookie(page) {
  await page.context().addCookies([
    {
      name: "lift_vid",
      value: VID,
      url: `${BASE}/checkout/`,
      sameSite: "Lax",
    },
  ]);
}

async function waitEdgeValue(wanted, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(
        `https://edge.api.flagsmith.com/api/v1/identities/?identifier=${encodeURIComponent(VID)}`,
        { headers: { "X-Environment-Key": ENV_KEY }, signal: AbortSignal.timeout(1500) },
      );
      const data = await res.json();
      const flag = (data.flags || []).find((f) => f.feature?.name === "checkout_a11y");
      const value = flag?.variant || flag?.feature_state_value;
      console.log(`edge checkout_a11y=${value} want=${wanted}`);
      if (value === wanted) return;
    } catch {
      console.warn("edge poll failed");
    }
    await sleep(400);
  }
  throw new Error(`edge never reached ${wanted}`);
}

async function waitVariantShort(page, wanted) {
  const ok = await page
    .waitForFunction((v) => document.body.getAttribute("data-variant") === v, wanted, {
      timeout: 5000,
    })
    .then(
      () => true,
      () => false,
    );
  if (!ok) {
    const actual = await page.evaluate(() => document.body.getAttribute("data-variant"));
    throw new Error(`never reached ${wanted} (now ${actual})`);
  }
}

async function showCheckout() {
  await clickCheckoutTab();
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
  if (!isFlagsmithTitle(chromeTitle())) {
    throw new Error(`Flagsmith tab is not selected (title=${chromeTitle()})`);
  }
  return fm;
}

async function openCheckoutViaLink(page) {
  await clickCheckoutTab();
  const shop = page.locator("#shop-trigger");
  await shop.waitFor({ state: "visible", timeout: 4000 });
  const shopPos = await screenBox(page, shop);
  await xMoveTo(shopPos.x, shopPos.y);
  await sleep(320);
  const link = page.locator("#checkout-link");
  let shown = await link.isVisible().catch(() => false);
  if (!shown) {
    xdo(["click", "1"]);
    await sleep(280);
    shown = await link.isVisible().catch(() => false);
  }
  if (!shown) throw new Error("#checkout-link did not appear after hovering Shop");
  const linkBox = await link.boundingBox({ timeout: 2000 });
  if (!linkBox) throw new Error("#checkout-link has no box");
  const inner = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
  }));
  const linkY = inner.screenY + TOP_CHROME + linkBox.y + linkBox.height / 2;
  const downX = shopPos.x;
  const downY = Math.max(shopPos.y + 28, linkY);
  console.log(`checkout-link click down ${downX.toFixed(0)},${downY.toFixed(0)} shop=${shopPos.x.toFixed(0)},${shopPos.y.toFixed(0)}`);
  await xMoveTo(downX, downY);
  await sleep(200);
  if (!(await link.isVisible().catch(() => false))) {
    throw new Error("#checkout-link hid before click (hover lost)");
  }
  xdo(["click", "1"]);
  await sleep(220);
  await page.locator("#checkout").waitFor({ state: "visible", timeout: 4000 });
}

async function assertFocusedId(page, id) {
  const active = await page.evaluate(() => document.activeElement?.id || "");
  if (active !== id) {
    throw new Error(`activeElement.id=${active || "(none)"} want=${id}`);
  }
}

function runOverride(cmd) {
  const helper = resolve(here, "flagsmith-override.py");
  if (!existsSync(helper)) throw new Error("scripts/flagsmith-override.py missing");
  const r = spawnSync("python3", [helper, cmd, VID], { encoding: "utf8", env: process.env });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`override ${cmd} exit ${r.status}`);
}

async function resetFlagsmithIdentity(page) {
  const fm = await showFlagsmith(page);
  const search = fm.getByPlaceholder("Search").first();
  await search.waitFor({ state: "visible", timeout: 6000 });
  await xClickLocator(fm, search);
  xdo(["key", "ctrl+a"]);
  await fm.keyboard.type("checkout_a11y", { delay: 35 });
  await sleep(500);
  const reset = fm.getByRole("button", { name: /^Reset$/ }).first();
  await reset.waitFor({ state: "visible", timeout: 6000 });
  await xClickLocator(fm, reset);
  const confirmField = fm.getByPlaceholder("feature_name").or(fm.getByPlaceholder("checkout_a11y"));
  const opened = await confirmField.waitFor({ state: "visible", timeout: 4000 }).then(
    () => true,
    () => false,
  );
  if (!opened) throw new Error("Flagsmith Reset did not open the confirm dialog");
  await sleep(400);
  await xClickLocator(fm, confirmField);
  const focused = await confirmField.evaluate((el) => document.activeElement === el);
  if (!focused) throw new Error("confirm field did not take focus");
  xdo(["key", "ctrl+a"]);
  await fm.keyboard.type("checkout_a11y", { delay: 50 });
  await sleep(400);
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
  await confirm.waitFor({ state: "hidden", timeout: 8000 });
  await fm.getByText(/environment defaults/i).first().waitFor({ timeout: 8000 });
}

async function holdFlagsmithView(ms) {
  await sleep(ms);
}

async function runAxeAndAssert(page, dt, expected) {
  await typeConsole(dt, AXE_LOAD);
  const ids = await page
    .waitForFunction(() => Array.isArray(window.__axeIds) && window.__axeIds.length >= 0, null, {
      timeout: 8000,
    })
    .then(
      () => page.evaluate(() => window.__axeIds),
      () => null,
    );
  const want = [...expected].sort();
  const got = Array.isArray(ids) ? [...ids].sort() : null;
  if (!got || got.join() !== want.join()) {
    throw new Error(`axe ids ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  await sleep(3200);
}

async function xClickDtBox(dt, box) {
  const inner = await dt.evaluate(() => ({ sx: window.screenX, sy: window.screenY }));
  await xMoveClick(inner.sx + box.x + box.w / 2, inner.sy + TOP_CHROME + box.y + box.h / 2);
}

async function cookieTableFilterBox(dt) {
  return dt.evaluate(() => {
    let hit = null;
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.getAttribute?.("aria-label") !== "Filter") continue;
        const r = el.getBoundingClientRect();
        if (r.y > 680 && r.x > 180 && r.width > 40 && r.height > 8 && r.height < 40) {
          hit = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
    };
    walk(document);
    return hit;
  });
}

async function findLiftVidCell(dt) {
  const cell = await dt.evaluate(() => {
    const hits = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if ((el.textContent || "").trim() !== "lift_vid") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8 || r.height > 36 || r.y < 760) continue;
        hits.push({
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          tag: el.tagName,
        });
      }
    };
    walk(document);
    return hits.find((h) => h.tag === "TD") || hits[0] || null;
  });
  return cell;
}

async function showLiftVidCookie(dt) {
  await clickDevToolsTab(dt, "Application");
  await sleep(400);
  const cookies = dt.getByRole("treeitem", { name: "Cookies" });
  await cookies.waitFor({ state: "visible", timeout: 8000 });
  await cookies.scrollIntoViewIfNeeded();
  await xClickLocator(dt, cookies);
  await sleep(200);
  await dt.keyboard.press("ArrowRight");
  await sleep(350);
  const origin = dt.getByRole("treeitem", { name: BASE });
  const originVisible = await origin.waitFor({ state: "visible", timeout: 4000 }).then(
    () => true,
    () => false,
  );
  if (!originVisible) throw new Error("cookie origin row not found");
  await origin.scrollIntoViewIfNeeded();
  await xClickLocator(dt, origin);
  await sleep(400);
  const filterBox = await cookieTableFilterBox(dt);
  if (!filterBox) throw new Error("cookie table Filter box not found");
  await xClickDtBox(dt, filterBox);
  await sleep(120);
  xdo(["key", "ctrl+a"]);
  await dt.keyboard.type("lift_vid", { delay: 40 });
  await sleep(500);
  let vid = await findLiftVidCell(dt);
  if (!vid) {
    await xClickLocator(dt, origin);
    await sleep(300);
    await xClickDtBox(dt, filterBox);
    xdo(["key", "ctrl+a"]);
    await dt.keyboard.type("lift_vid", { delay: 40 });
    await sleep(600);
    vid = await findLiftVidCell(dt);
  }
  if (!vid) throw new Error("lift_vid cookie row not found");
  await xClickDtBox(dt, vid);
  await sleep(700);
}

async function assertNotAllowMock(page) {
  await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
  await waitFlagsmith(page);
  const live = await page.evaluate(() => document.body.getAttribute("data-variant"));
  const probe = live === "treatment" ? "control" : "treatment";
  await page.goto(`${BASE}/checkout/?lift_variant=${probe}`, { waitUntil: "domcontentloaded" });
  await waitFlagsmith(page);
  const after = await page.evaluate(() => ({
    variant: document.body.getAttribute("data-variant"),
    status: document.getElementById("flag-status")?.textContent || "",
  }));
  if (/URL override/i.test(after.status) || (after.variant === probe && after.variant !== live)) {
    throw new Error(`server appears to be in --allow-mock (status=${after.status} variant=${after.variant})`);
  }
  const cfg = await page.evaluate(async () => {
    const res = await fetch("./config.json", { cache: "no-store" });
    return res.json();
  });
  if (cfg.disableAutofill !== true) {
    throw new Error("config.disableAutofill is not true; start serve-site with LIFT_DISABLE_AUTOFILL=true");
  }
  await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
  await waitFlagsmith(page);
}

const clips = {
  "01-control-treatment-axe": {
    async setup(page, dt) {
      runOverride("set-control");
      await waitEdgeValue("control");
      const fm = flagsmithPage(page);
      if (!fm) throw new Error("Flagsmith tab missing");
      await fm.goto(FM_IDENTITY, { waitUntil: "domcontentloaded" });
      await fm.getByText("Identifier:", { exact: false }).first().waitFor({ timeout: 20000 });
      await seedVisitorCookie(page);
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
      await page.waitForFunction(
        () => document.body.getAttribute("data-variant") === "control",
        null,
        { timeout: 15000 },
      );
      dt = await ensureCheckoutDevtools(page, dt);
      await clickDevToolsTab(dt, "Console");
      await clickFlagsmithTab();
      return dt;
    },
    async run(page, dt) {
      await showFlagsmith(page);
      await holdFlagsmithView(2000);
      await showCheckout();
      dt = await ensureCheckoutDevtools(page, dt);
      await openCheckoutViaLink(page);
      dt = await liveDevtools(page, dt);
      await sleep(400);
      await runAxeAndAssert(page, dt, CONTROL_AXE);
      await resetFlagsmithIdentity(page);
      await holdFlagsmithView(2000);
      await showCheckout();
      await reloadVisible(page, "checkout");
      await waitVariantShort(page, "treatment");
      dt = await liveDevtools(page, dt);
      await openCheckoutViaLink(page);
      dt = await liveDevtools(page, dt);
      await sleep(400);
      await runAxeAndAssert(page, dt, TREATMENT_AXE);
    },
  },

  "02-keyboard-submit-once": {
    async setup(page) {
      runOverride("clear");
      await waitEdgeValue("treatment");
      await seedVisitorCookie(page);
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
      await page.waitForFunction(
        () => document.body.getAttribute("data-variant") === "treatment",
        null,
        { timeout: 15000 },
      );
    },
    async run(page, dt) {
      await showCheckout();
      dt = await ensureCheckoutDevtools(page, dt);
      await openCheckoutViaLink(page);
      dt = await liveDevtools(page, dt);
      await typeConsole(
        dt,
        "window.clicks = 0; document.getElementById('place-order')?.addEventListener('click', () => { window.clicks += 1 })",
      );
      await xClickLocator(page, page.locator("#email"));
      await assertFocusedId(page, "email");
      await page.keyboard.type("ada@northline.test", { delay: 40 });
      xdo(["key", "Tab"]);
      await sleep(160);
      await assertFocusedId(page, "card-name");
      await page.keyboard.type("Ada Lovelace", { delay: 32 });
      xdo(["key", "Tab"]);
      await sleep(120);
      await assertFocusedId(page, "card-number");
      await page.keyboard.type("0000", { delay: 40 });
      xdo(["key", "Tab"]);
      await sleep(120);
      await assertFocusedId(page, "card-exp");
      await page.keyboard.type("12/28", { delay: 36 });
      xdo(["key", "Tab"]);
      await sleep(120);
      await assertFocusedId(page, "card-cvc");
      await page.keyboard.type("123", { delay: 36 });
      xdo(["key", "Tab"]);
      await sleep(160);
      await assertFocusedId(page, "terms");
      xdo(["key", "space"]);
      await sleep(160);
      xdo(["key", "Tab"]);
      await sleep(250);
      xdo(["key", "Return"]);
      await page.locator("#confirmation").waitFor({ state: "visible", timeout: 8000 });
      await typeConsole(dt, "clicks");
      await sleep(1000);
    },
  },

  "03-per-node-attribution": {
    async setup(page) {
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
    },
    async run(page, dt) {
      await showCheckout();
      dt = await ensureCheckoutDevtools(page, dt);
      await clickClearConsole(dt);
      await typeConsole(dt, "s=document.createElement('style'); s.textContent='.dark{background-color:#111;color:#fff}'; document.head.append(s)");
      await typeConsole(
        dt,
        "a=document.createElement('div'); a.id='node-a'; a.className='demo-target'; a.textContent='A'; a.style.cssText='padding:10px;background:#fff;color:#111;font:700 18px/1.3 system-ui'",
      );
      await typeConsole(
        dt,
        "dark=document.createElement('div'); dark.className='dark'; dark.style.cssText='padding:10px;margin-top:12px'; b=document.createElement('div'); b.id='node-b'; b.className='demo-target'; b.textContent='B'; b.style.cssText='background:#fff;color:#111;font:700 18px/1.3 system-ui'; document.body.append(a, dark, b)",
      );
      await typeConsole(
        dt,
        "(await import('/runtime/runtime.js')).applyPatchSpec({id:'per-node',version:0,ops:[{op:'injectCSS',rules:[{selector:{classes:['demo-target']},declarations:[{property:'color',value:'#111'}]}]}]})",
      );
      await sleep(350);
      await typeConsole(dt, "a.style.color='#eee'");
      await typeConsole(dt, "b.style.backgroundColor=''; b.style.color=''; dark.append(b)");
      await sleep(800);
      await typeConsole(
        dt,
        "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,attributions:s.attributions,lastAttributions:s.lastAttributions},null,2)",
      );
      await sleep(1400);
    },
  },

  "04-cssom-edit-detected": {
    async setup(page) {
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
    },
    async run(page, dt) {
      await showCheckout();
      await reloadVisible(page, "checkout");
      dt = await liveDevtools(page, dt);
      await clickClearConsole(dt);
      await typeConsole(
        dt,
        "p=document.createElement('div'); p.className='demo-target'; p.textContent='Sample'; p.style.cssText='padding:12px;background:#fff;font:700 20px/1.3 system-ui'; document.body.append(p)",
      );
      await typeConsole(
        dt,
        "(await import('/runtime/runtime.js')).applyPatchSpec({id:'cssom-edit',version:0,ops:[{op:'injectCSS',rules:[{selector:{classes:['demo-target']},declarations:[{property:'color',value:'#111'}]}]}]})",
      );
      await typeConsole(dt, "sheet=document.querySelector('[data-lift-css]'); sheet.disabled");
      await sleep(300);
      await typeConsole(dt, "sheet.sheet.cssRules[0].style.color='#eee'");
      await sleep(4000);
      await typeConsole(dt, "sheet.disabled");
      await typeConsole(
        dt,
        "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,attributions:s.attributions,ticksRan:s.ticksRan})",
      );
      await sleep(1000);
    },
  },

  "05-page-contrast-no-loop": {
    async setup(page) {
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
    },
    async run(page, dt) {
      await showCheckout();
      await reloadVisible(page, "checkout");
      dt = await liveDevtools(page, dt);
      await clickClearConsole(dt);
      await typeConsole(
        dt,
        "h=document.createElement('a'); h.id='hit'; h.className='demo-target'; h.href='#x'; h.textContent='Go'; h.style.cssText='display:inline-block;padding:12px 18px;color:#111;background:#fff;font:700 22px/1.3 system-ui'; document.body.append(h)",
      );
      await typeConsole(
        dt,
        "(await import('/runtime/runtime.js')).applyPatchSpec({id:'minw',version:0,ops:[{op:'injectCSS',rules:[{selector:{id:'hit'},declarations:[{property:'min-width',value:'44px'}]}]}]})",
      );
      await typeConsole(dt, "h.style.color='#eee'");
      await sleep(200);
      await typeConsole(dt, "h.style.color='#111'");
      await sleep(200);
      await typeConsole(dt, "h.style.color='#eee'");
      await sleep(200);
      await typeConsole(dt, "h.style.color='#111'");
      await sleep(250);
      const statsLine =
        "s=LiftRuntime.getRuntimeStats(); JSON.stringify({undos:s.undos,ticksRan:s.ticksRan,attributions:s.attributions})";
      await typeConsole(dt, statsLine);
      await sleep(4800);
      await typeConsole(dt, statsLine, { refocus: false });
      await sleep(4800);
      await typeConsole(dt, statsLine, { refocus: false });
      await sleep(900);
    },
  },

  "06-sticky-identity": {
    async setup(page) {
      runOverride("clear");
      await waitEdgeValue("treatment");
      await page.goto(`${BASE}/checkout/`, { waitUntil: "domcontentloaded" });
      await waitFlagsmith(page);
    },
    async run(page, dt) {
      await showCheckout();
      await sleep(500);
      dt = await ensureCheckoutDevtools(page, dt);
      await showLiftVidCookie(dt);
      await sleep(800);
      await reloadVisible(page, "checkout");
      await waitFlagsmith(page, 8000);
      await sleep(500);
      dt = await ensureCheckoutDevtools(page, dt);
      await showLiftVidCookie(dt);
      await sleep(1000);
    },
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
context.setDefaultTimeout(4000);
let page = context.pages().find((p) => p.url().includes("/checkout/") && !p.url().startsWith("devtools://"));
if (!page) page = context.pages().find((p) => !p.url().startsWith("devtools://") && p.url().startsWith("http"));
if (!page) page = await context.newPage();
let dt = context.pages().find((p) => p.url().startsWith("devtools://"));
{
  const id = chromeWinId();
  xdo(["windowactivate", "--sync", id]);
  xdo(["windowmove", id, "80", "40"]);
  xdo(["windowsize", id, "1760", "1120"]);
  await sleep(250);
  WIN = winGeom(id);
}
console.log("chrome window", WIN.x, WIN.y, WIN.w, WIN.h);
await clickCheckoutTab();
await seedVisitorCookie(page);
console.log("checking server is not --allow-mock");
await assertNotAllowMock(page);

const results = [];
for (const name of names) {
  console.log("setup", name);
  WIN = winGeom(chromeWinId());
  const clip = clips[name];
  dt = (await clip.setup(page, dt)) || dt;
  dt = context.pages().find((p) => p.url().startsWith("devtools://")) || dt;
  console.log("recording", name);
  results.push(await recordClip(name, () => clip.run(page, dt)));
  dt = context.pages().find((p) => p.url().startsWith("devtools://")) || dt;
}
console.log(results);
process.exit(0);
