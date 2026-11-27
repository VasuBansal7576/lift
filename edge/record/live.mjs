#!/usr/bin/env node
/**
 * Drive the Layer 1 demo against REAL self-hosted Flagsmith 2.295.2
 * (not the e2e mock). Headed Chromium so the address bar is on screen.
 *
 * Env (never log values):
 *   FLAGSMITH_UI           default http://127.0.0.1:8000
 *   FLAGSMITH_API_URL      default http://127.0.0.1:8000/api/v1/
 *   FLAGSMITH_BOOTSTRAP_EMAIL / FLAGSMITH_BOOTSTRAP_PASSWORD  (flag-flip UI)
 *   LIFT_RECORD_OUT        default recordings/edge
 *
 * Requires: Flagsmith already running; edge/.dev.vars already written by
 * bootstrap-flag.ts; KV seeded (`npm run edge:put-spec -- runtime/checkout-treatment.json`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = process.env.LIFT_RECORD_OUT || resolve(root, "recordings/edge");
const FLAGSMITH_UI = (process.env.FLAGSMITH_UI || "http://127.0.0.1:8000").replace(/\/$/, "");
const ORIGIN_PORT = Number(process.env.LIFT_RECORD_ORIGIN_PORT || "4174");
const EDGE_PORT = Number(process.env.LIFT_RECORD_EDGE_PORT || "8787");
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
const WORKER = `http://127.0.0.1:${EDGE_PORT}`;

export const SCENES = [
  "edge-zero-code-fix",
  "edge-flag-flip",
  "edge-fail-open",
  "edge-sticky",
];

function loadDotEnvVars(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function waitFor(url, timeoutMs = 60_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || (res.status >= 200 && res.status < 500)) return;
      last = String(res.status);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

function spawnLogged(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    ...opts,
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function confirmRealFlagsmith() {
  const res = await fetch(`${FLAGSMITH_UI}/api/v1/`);
  if (!res.ok && res.status !== 401 && res.status !== 403) {
    throw new Error(`Flagsmith UI not reachable at ${FLAGSMITH_UI} (${res.status})`);
  }
  const versionRes = await fetch(`${FLAGSMITH_UI}/api/v1/version/`).catch(() => null);
  let body = "";
  try {
    body = versionRes ? await versionRes.text() : "";
  } catch {
    body = "";
  }
  if (body && !body.includes("2.295") && !body.includes("version")) {
    /* version endpoint varies; continue if the UI answered */
  }
}

export async function startDemoStack() {
  await confirmRealFlagsmith();
  const origin = spawnLogged("npx", [
    "tsx",
    "scripts/serve-site.ts",
    "--port",
    String(ORIGIN_PORT),
    "--edge-origin",
  ]);
  const wrangler = spawnLogged("npx", [
    "wrangler",
    "dev",
    "--config",
    "edge/wrangler.toml",
    "--persist-to",
    "edge/.wrangler/state",
    "--ip",
    "127.0.0.1",
    "--port",
    String(EDGE_PORT),
  ]);
  await waitFor(`${ORIGIN}/checkout/`);
  await waitFor(`${WORKER}/__lift/bootstrap.js`);
  return {
    origin,
    wrangler,
    async stop() {
      killGroup(wrangler);
      killGroup(origin);
      await sleep(400);
    },
  };
}

async function axeSnippet(page) {
  return page.evaluate(async () => {
    const src = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
    await new Promise((resolve, reject) => {
      if (window.axe) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
    });
    const results = await window.axe.run(document, { resultTypes: ["violations"] });
    console.log("[lift-axe]", results.violations.length, results.violations.map((v) => v.id).join(","));
    return results.violations.length;
  });
}

async function keyboardCheckout(page) {
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.locator("#shop-menu").waitFor({ state: "visible", timeout: 8_000 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.locator("#checkout").waitFor({ state: "visible" });
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
  await page.locator("#terms").check();
  await page.locator("#place-order").focus();
  await page.keyboard.press("Enter");
  await page.locator("#confirmation").waitFor({ state: "visible" });
}

export async function runScenes(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${ORIGIN}/checkout/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await axeSnippet(page);

  await page.goto(`${WORKER}/checkout/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.documentElement.dataset.liftEdge === "injected", null, {
    timeout: 20_000,
  });
  await axeSnippet(page);
  await page.waitForFunction(() => document.documentElement.dataset.liftApplied === "1", null, {
    timeout: 20_000,
  });
  await keyboardCheckout(page);

  await page.goto(`${FLAGSMITH_UI}/login`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(500);

  await page.goto(`${WORKER}/checkout/`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.cookie);

  await context.close();
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run edge:record\nSee edge/record/README.md\n");
    return;
  }
  loadDotEnvVars(resolve(root, "edge/.dev.vars"));
  mkdirSync(OUT, { recursive: true });
  const stack = await startDemoStack();
  const headed = process.env.LIFT_RECORD_HEADED !== "0";
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--window-size=1400,900", "--window-position=40,40"],
  });
  try {
    await runScenes(browser);
  } finally {
    await browser.close();
    await stack.stop();
  }
}

const launchedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
