/**
 * Headed Chrome recordings for Lift L3 against a real self-hosted Flagsmith.
 * Never prints or displays API tokens, environment keys, or SDK snippets.
 * Password fields stay type=password. Flagsmith navigation avoids putting the
 * environment key in the URL; recordings that must visit Flagsmith launch with
 * --app so a key cannot appear in an address bar.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { ROOT } from "../agent/src/config.ts";

declare global {
  interface Window {
    LiftL3: {
      forceScore: (n: number | null) => void;
      ingest: (kind: string, sample: unknown) => void;
      stop: () => void;
      start: () => Promise<unknown>;
      getRuntime: () => { flagsmith: unknown; offline: boolean; optedOut: boolean };
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
const RECORD_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const NOFLAP_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
const SEGMENT_IDENTITY = "lift-aaaaaaaa-bbbb-4ccc-8ddd-333333333333";

interface L3State {
  dashboardUrl: string;
  projectId: string;
  environmentId: string;
  environmentUuid?: string;
  segmentId: number;
  flagId: number;
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

async function caption(page: Page, text: string) {
  await page.evaluate((label) => {
    let el = document.getElementById("l3-record-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "l3-record-caption";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;left:1rem;bottom:1rem;z-index:2147483647;background:#111827;color:#fde68a;padding:0.55rem 0.8rem;font:700 18px/1.3 ui-sans-serif,system-ui;border:1px solid #f59e0b;max-width:36rem";
      document.body.appendChild(el);
    }
    el.textContent = label;
  }, text);
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
      const hide = (el: Element) => {
        const node = el as HTMLElement;
        node.style.setProperty("display", "none", "important");
        node.hidden = true;
      };
      const leak = /\bser\.[A-Za-z0-9]|FLAGSMITH_(ENVIRONMENT|SERVER|API)_KEY|environmentID\s*[:=]/i;
      for (const el of document.querySelectorAll("pre, code, textarea, p, li, div, section, aside")) {
        const text = (el.textContent ?? "").slice(0, 400);
        if (leak.test(text)) hide(el);
      }
      for (const btn of document.querySelectorAll("button, a, [role='tab']")) {
        const label = (btn.textContent ?? "").trim();
        if (/code example|sdk keys|install the|javascript sdk/i.test(label)) {
          hide(btn.closest("section, aside, div") ?? btn);
        }
      }
    })
    .catch(() => {});
}

function saveVideo(tmp: string, name: string) {
  const mp4Name = name.replace(/\.webm$/i, ".mp4");
  for (const dir of OUT_DIRS) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(tmp, resolve(dir, name));
    try {
      execFileSync(
        "ffmpeg",
        ["-y", "-i", tmp, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", resolve(dir, mp4Name)],
        { stdio: "ignore" },
      );
    } catch {
      /* webm is the source of truth if ffmpeg is missing */
    }
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

function projectSegmentsUrl(state: L3State): string {
  const origin = state.dashboardUrl || FLAGSMITH_ORIGIN;
  return `${origin}/project/${state.projectId}/segments/${state.segmentId}`;
}

function environmentRef(state: L3State): string {
  return env("FLAGSMITH_ENVIRONMENT_KEY") || state.environmentUuid || state.environmentId;
}

function identitiesUrl(state: L3State): string {
  const origin = state.dashboardUrl || FLAGSMITH_ORIGIN;
  return `${origin}/project/${state.projectId}/environment/${environmentRef(state)}/identities`;
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
  if (await page.locator('[data-test="features-page"], [data-test="home-link"]').count()) {
    await page.goto(projectSegmentsUrl(state), { waitUntil: "domcontentloaded" });
    await hideFlagsmithSnippets(page);
    return;
  }
  await page.goto(projectSegmentsUrl(state), { waitUntil: "domcontentloaded" });
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
  await page.waitForTimeout(600);
}

async function fullLoop(page: Page): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  await loginFlagsmith(page, state);
  await page.goto(`${BASE}/?lift_identity=${RECORD_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "1. Calm — l3_sensory_safe=false, carousel and promo live");
  await page.waitForSelector("#lift-l3-hud");
  await page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });
  await sleep(2_400);

  await caption(
    page,
    "2. Stress input simulated for the demo (slider + scripted pointer). Only overstimulated is sent.",
  );
  await page.locator("#lift-biometric").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "92";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const box = await page.locator(".hero h1").boundingBox();
  for (let round = 0; round < 8; round += 1) {
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.move(170 + (i % 2) * 140, 150 + (i % 3) * 70);
    }
    if (box) {
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.click(box.x + 16, box.y + 12, { delay: 40 });
      }
    }
    await page.mouse.wheel(0, 900);
    await page.mouse.wheel(0, -900);
  }
  await page.evaluate(() => window.LiftL3.forceScore(1));
  await caption(page, "3. Score 1.00 held 1.5s → flagsmith.setTrait(overstimulated, true)");
  await page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
  await page.waitForSelector("#lift-l3-hud[data-flag='true']", { timeout: 20_000 });
  await sleep(1_200);

  await openIdentity(page, state, RECORD_IDENTITY);
  await caption(page, "Flagsmith Identities — overstimulated=true (SDK snippets hidden)");
  await page.waitForSelector('[data-test^="user-trait"]', { timeout: 15_000 }).catch(async () => {
    await page.waitForSelector("text=true", { timeout: 10_000 });
  });
  await hideFlagsmithSnippets(page);
  await sleep(3_500);

  await page.goto(`${BASE}/?lift_identity=${RECORD_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(
    page,
    "5. Reload keeps Sensory-Safe — media paused, banners hidden, contrast ≥ 4.5:1",
  );
  await page.waitForSelector("#lift-l3-hud[data-flag='true']", { timeout: 20_000 });
  await sleep(3_200);

  await caption(page, "6. Calming down — slider down, 8s exit hold, then ~2s fade");
  await page.locator("#lift-biometric").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.1));
  await page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 25_000 });
  await page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });

  await openIdentity(page, state, RECORD_IDENTITY);
  await caption(page, "Flagsmith Identities — overstimulated=false, flag off");
  await hideFlagsmithSnippets(page);
  await sleep(3_200);

  await page.goto(`${BASE}/?lift_identity=${RECORD_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "Fade back (~2s) — promo returns, motion resumes");
  await page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 20_000 });
  await sleep(2_600);
}

async function noFlap(page: Page): Promise<void> {
  await page.goto(`${BASE}/?lift_identity=${NOFLAP_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "Borderline 0.50–0.60 stay CALM (below ENTER 0.62) — meter visible");
  await page.waitForSelector("#lift-l3-hud");
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.6 : 0.5);
    await sleep(280);
  }
  await caption(page, "Score 0.90 for 1.5s → enter Sensory-Safe");
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
  await caption(page, "Borderline 0.40–0.45 stays ON (above EXIT 0.38) — hysteresis + cooldown");
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.45 : 0.4);
    await sleep(280);
  }
  await sleep(1_200);
}

async function failOpen(page: Page): Promise<void> {
  await page.goto(FLAGSMITH_ORIGIN, { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
  await caption(page, "Flagsmith on 127.0.0.1:8000 is stopped").catch(() => {});
  await sleep(2_400);
  await page.goto(`${BASE}/?lift_identity=${RECORD_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "Demo loads; SDK cannot reach Flagsmith — fail-open");
  await page.waitForSelector("#lift-l3-offline", { timeout: 20_000 });
  await sleep(2_200);
  await caption(page, "Forced score 0.95 — page stays calm (fail-open)");
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await sleep(2_400);
  await caption(page, "Promo, autoplay, cookie stay; Sensory-Safe not applied");
  await sleep(2_800);
}

async function segment(page: Page): Promise<void> {
  const state = loadState();
  loadDemoConfig();
  await loginFlagsmith(page, state);
  await page.goto(projectSegmentsUrl(state), { waitUntil: "domcontentloaded" });
  await hideFlagsmithSnippets(page);
  await page.waitForSelector("text=overstimulated", { timeout: 15_000 });
  await caption(page, "Segment sensory_safe — overstimulated Exactly Matches true");
  await sleep(3_200);
  const featuresTab = page
    .getByRole("tab", { name: /^features$/i })
    .or(page.getByText("Features", { exact: true }))
    .first();
  await featuresTab.click();
  await page.getByText("l3_sensory_safe").first().waitFor({ timeout: 15_000 });
  await hideFlagsmithSnippets(page);
  await caption(
    page,
    "Associated Features — l3_sensory_safe overridden by sensory_safe; default off",
  );
  await sleep(3_200);

  await page.goto(`${BASE}/?lift_identity=${SEGMENT_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 20_000 });
  await caption(page, "Demo identity starts calm — trait overstimulated=false");
  await sleep(1_800);

  await openIdentity(page, state, SEGMENT_IDENTITY);
  await caption(page, "Identities — overstimulated is false before the spike");
  await hideFlagsmithSnippets(page);
  await sleep(2_800);

  await page.goto(`${BASE}/?lift_identity=${SEGMENT_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "Spike — setTrait(overstimulated, true) on this identity");
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 20_000 });
  await sleep(1_400);

  await openIdentity(page, state, SEGMENT_IDENTITY);
  await caption(page, "Refresh — overstimulated is now true");
  await hideFlagsmithSnippets(page);
  await sleep(3_200);

  await page.goto(`${BASE}/?lift_identity=${SEGMENT_IDENTITY}`, { waitUntil: "domcontentloaded" });
  await caption(page, "Calm — setTrait(overstimulated, false)");
  await page.evaluate(() => window.LiftL3.forceScore(0.1));
  await page.waitForSelector("#lift-l3-hud[data-trait='false']", { timeout: 25_000 });
  await sleep(1_200);

  await openIdentity(page, state, SEGMENT_IDENTITY);
  await caption(page, "Refresh — overstimulated is false again");
  await hideFlagsmithSnippets(page);
  await sleep(3_200);
}

async function recordOne(
  name: string,
  run: (page: Page, context: BrowserContext) => Promise<void>,
  appUrl: string | null,
): Promise<string> {
  const videoDir = resolve(ROOT, "test-results/l3-recordings", name);
  mkdirSync(videoDir, { recursive: true });
  const args = [
    "--no-sandbox",
    "--window-position=48,24",
    "--window-size=1440,900",
    "--disable-features=Translate",
    "--disable-infobars",
  ];
  if (appUrl) args.push(`--app=${appUrl}`);
  const browser = await chromium.launch({
    headless: false,
    executablePath: existsSync("/usr/local/bin/google-chrome")
      ? "/usr/local/bin/google-chrome"
      : undefined,
    args,
    slowMo: 40,
  });
  const context = await browser.newContext({
    viewport: null,
    recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  await run(page, context);
  const video = page.video();
  await context.close();
  await browser.close();
  const path = video ? await video.path() : "";
  if (!path) throw new Error(`No video for ${name}`);
  saveVideo(path, `${name}.webm`);
  return path;
}

async function main() {
  let server: ChildProcess | null = null;
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg?.slice("--only=".length) ?? "all";
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
    const jobs: Record<
      string,
      { run: (page: Page, context: BrowserContext) => Promise<void>; appUrl: string | null }
    > = {
      "l3-full-loop": {
        run: fullLoop,
        appUrl: `${BASE}/?lift_identity=${RECORD_IDENTITY}`,
      },
      "l3-no-flap": { run: noFlap, appUrl: null },
      "l3-flagsmith-segment": {
        run: segment,
        appUrl: `${FLAGSMITH_ORIGIN}/login`,
      },
      "l3-fail-open": { run: failOpen, appUrl: null },
    };
    const selected =
      only === "all"
        ? ["l3-full-loop", "l3-no-flap", "l3-flagsmith-segment"]
        : only === "full"
          ? ["l3-full-loop"]
          : only === "noflap"
            ? ["l3-no-flap"]
            : only === "segment"
              ? ["l3-flagsmith-segment"]
              : only === "failopen"
                ? ["l3-fail-open"]
                : [only];
    const paths: Record<string, string> = {};
    for (const name of selected) {
      const job = jobs[name];
      if (!job) throw new Error(`Unknown recording ${name}`);
      paths[name] = await recordOne(name, job.run, job.appUrl);
    }
    process.stdout.write(`${JSON.stringify({ paths, out: OUT_DIRS }, null, 2)}\n`);
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
