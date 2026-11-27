/**
 * Headed Chrome recordings for Lift L3. Writes WebM to artifacts dirs.
 * Does not print or display any API token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Page } from "@playwright/test";
import { ROOT } from "../agent/src/config.ts";
import { L3_SDK_URL } from "../shared/l3-constants.ts";

declare global {
  interface Window {
    LiftL3: { forceScore: (n: number | null) => void };
  }
}

const PORT = 4175;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIRS = [
  resolve("/opt/cursor/artifacts"),
  resolve("/cursor/stores/self/artifacts"),
  resolve(ROOT, "test-results/l3-recordings"),
];

const FLAG_CONFIG = {
  pauseMedia: true,
  pauseMotion: true,
  softenContrast: true,
  showSummaries: true,
  hideMarketing: true,
  fadeMs: 2000,
  ink: "#2c3038",
  paper: "#f4f0e8",
};

function stubSdk() {
  return `
const traits = { simulated: false, site: "l3", overstimulated: false };
const flagsmith = {
  async init(opts) { Object.assign(traits, opts.traits || {}); },
  async setTrait(k, v) { traits[k] = v; return { ...traits }; },
  getTrait(k) { return traits[k]; },
  getAllTraits() { return { ...traits }; },
  hasFeature(name) {
    return name === "l3_sensory_safe" && (traits.overstimulated === true || traits.overstimulated === "true");
  },
  getValue(name) {
    if (name === "l3_sensory_safe" && this.hasFeature(name)) {
      return ${JSON.stringify(JSON.stringify(FLAG_CONFIG))};
    }
    return null;
  },
  async getFlags() { return this; },
};
export default flagsmith;
`;
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

async function stub(page: Page) {
  await page.route(L3_SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: stubSdk(),
    });
  });
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      json: {
        site: "l3",
        flagsmithApiUrl: "http://127.0.0.1:8000/api/v1/",
        flagsmithEnvironmentKey: "test-env",
        flagName: "l3_sensory_safe",
      },
    });
  });
}

async function caption(page: Page, text: string) {
  await page.evaluate((label) => {
    let el = document.getElementById("l3-record-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "l3-record-caption";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;left:1rem;top:5.5rem;z-index:30;background:#111827;color:#fde68a;padding:0.55rem 0.8rem;font:700 18px/1.3 ui-sans-serif,system-ui;border:1px solid #f59e0b;max-width:28rem";
      document.body.appendChild(el);
    }
    el.textContent = label;
  }, text);
}

function saveVideo(tmp: string, name: string) {
  for (const dir of OUT_DIRS) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(tmp, resolve(dir, name));
  }
}

async function fullLoop(page: Page) {
  await stub(page);
  await page.goto(`${BASE}/?lift_identity=lift-l3-record`, { waitUntil: "domcontentloaded" });
  await caption(page, "1. Calm — HUD score low, carousel and promo live");
  await page.waitForSelector("#lift-l3-hud");
  await sleep(2_000);

  await caption(page, "2. Stress spike — erratic cursor, rage clicks, scroll, slider");
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
  await page.evaluate(() => window.LiftL3.forceScore(0.88));
  await caption(page, "3. Waiting 1.5s hold → setTrait(overstimulated, true)");
  await page.waitForSelector("#lift-l3-hud[data-flag='true']", { timeout: 8_000 });
  await caption(
    page,
    "4. Flagsmith: trait true, sensory_safe member, l3_sensory_safe ON — UI softening",
  );
  await sleep(3_000);

  await caption(page, "5. Calming down — slider down, score below EXIT for 8s");
  await page.locator("#lift-biometric").evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.1));
  await page.waitForSelector("#lift-l3-hud[data-flag='false']", { timeout: 25_000 });
  await caption(page, "6. Fade back (~2s) — trait false, promo returns, motion resumes");
  await sleep(2_400);
}

async function noFlap(page: Page) {
  await stub(page);
  await page.goto(`${BASE}/?lift_identity=lift-l3-noflap`, { waitUntil: "domcontentloaded" });
  await caption(page, "Borderline scores 0.50–0.60 stay CALM (below ENTER 0.62)");
  await page.waitForSelector("#lift-l3-hud");
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.6 : 0.5);
    await sleep(280);
  }
  await caption(page, "Score 0.90 for 1.5s → enter Sensory-Safe");
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await page.waitForSelector("#lift-l3-hud[data-trait='true']", { timeout: 8_000 });
  await caption(page, "Borderline 0.40–0.45 stays ON (above EXIT 0.38) — no flap");
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.45 : 0.4);
    await sleep(280);
  }
  await sleep(800);
}

async function segment(page: Page) {
  await page.goto(`${BASE}/segment.html`, { waitUntil: "domcontentloaded" });
  await sleep(4_000);
}

async function recordOne(
  name: string,
  run: (page: Page) => Promise<void>,
): Promise<string> {
  const videoDir = resolve(ROOT, "test-results/l3-recordings", name);
  mkdirSync(videoDir, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    executablePath: existsSync("/usr/local/bin/google-chrome")
      ? "/usr/local/bin/google-chrome"
      : undefined,
    args: [
      "--no-sandbox",
      "--window-position=40,40",
      "--window-size=1280,860",
      "--disable-features=Translate",
    ],
    slowMo: 35,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  await run(page);
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
    const jobs: Record<string, (page: Page) => Promise<void>> = {
      "l3-full-loop": fullLoop,
      "l3-no-flap": noFlap,
      "l3-flagsmith-segment": segment,
    };
    const selected =
      only === "all" ? Object.keys(jobs) : only === "full" ? ["l3-full-loop"] : only === "noflap" ? ["l3-no-flap"] : only === "segment" ? ["l3-flagsmith-segment"] : [only];
    const paths: Record<string, string> = {};
    for (const name of selected) {
      const run = jobs[name];
      if (!run) throw new Error(`Unknown recording ${name}`);
      paths[name] = await recordOne(name, run);
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
