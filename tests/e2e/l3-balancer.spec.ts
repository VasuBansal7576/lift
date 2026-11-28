import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
import { ROOT } from "../../agent/src/config.ts";
import { contrastRatio, parseCssColor } from "../../traffic/src/contrast.ts";
import { ENTER_THRESHOLD, L3_SDK_URL, WCAG_AA_MIN } from "../../shared/l3-constants.ts";

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
    __setTraitCalls?: number;
  }
}

const L3_URL = "http://127.0.0.1:4176";
const FLAGSMITH_ORIGIN = "http://127.0.0.1:8000";

const STUB_SDK = `
let trait = false;
let flagOn = false;
try {
  trait = sessionStorage.getItem("lift-stub-trait") === "1";
  flagOn = trait;
} catch { /* ignore */ }
const flagsmith = {
  async init() {},
  async setTrait(_name, value) {
    trait = value === true || value === "true";
    flagOn = trait;
    try { sessionStorage.setItem("lift-stub-trait", trait ? "1" : "0"); } catch { /* ignore */ }
  },
  async getFlags() {},
  getTrait() { return trait; },
  hasFeature() { return flagOn; },
  getValue() {
    return JSON.stringify({
      pauseMedia: true,
      pauseMotion: true,
      softenContrast: true,
      showSummaries: true,
      hideMarketing: true,
      fadeMs: 2000,
      ink: "#2c3038",
      paper: "#f4f0e8",
    });
  },
};
export default flagsmith;
`;

function liftIdentity(): string {
  return `lift-${randomUUID()}`;
}

function isStubLane(): boolean {
  return test.info().project.name === "l3-stub" || process.env.L3_STUB_SDK === "1";
}

function liveConfig(): { flagsmithApiUrl: string; flagsmithEnvironmentKey: string } | null {
  const path = resolve(ROOT, "demo/l3/config.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      flagsmithApiUrl?: string;
      flagsmithEnvironmentKey?: string;
    };
    if (!parsed.flagsmithApiUrl || !parsed.flagsmithEnvironmentKey) return null;
    return {
      flagsmithApiUrl: parsed.flagsmithApiUrl,
      flagsmithEnvironmentKey: parsed.flagsmithEnvironmentKey,
    };
  } catch {
    return null;
  }
}

async function flagsmithIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${FLAGSMITH_ORIGIN}/version/`);
    if (!res.ok) return false;
    const body = (await res.json()) as { image_tag?: string };
    return Boolean(body.image_tag);
  } catch {
    return false;
  }
}

async function waitForServer(url: string, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* still booting */
    }
    await sleep(150);
  }
  throw new Error(`L3 demo server did not start at ${url}`);
}

async function installStubSdk(page: Page) {
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      json: {
        site: "l3",
        flagsmithApiUrl: `${FLAGSMITH_ORIGIN}/api/v1/`,
        flagsmithEnvironmentKey: "stub-environment-key",
      },
    });
  });
  await page.route(L3_SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: STUB_SDK,
    });
  });
}

let server: ChildProcess | null = null;
let live = false;

test.beforeAll(async () => {
  live = (await flagsmithIsUp()) && liveConfig() !== null;
  try {
    const res = await fetch(L3_URL);
    if (res.ok) return;
  } catch {
    /* start one */
  }
  server = spawn("npx", ["tsx", "scripts/serve-l3.ts", "--port", "4176"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  await waitForServer(L3_URL);
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  server = null;
});

function skipUnlessFlagsmith() {
  if (isStubLane()) return;
  test.skip(!live, "self-hosted Flagsmith is not running on 127.0.0.1:8000 with demo/l3/config.json");
}

function compositeRgb(
  fg: [number, number, number],
  bg: [number, number, number],
  opacity: number,
): [number, number, number] {
  const t = Math.min(1, Math.max(0, opacity));
  return [
    Math.round(fg[0] * t + bg[0] * (1 - t)),
    Math.round(fg[1] * t + bg[1] * (1 - t)),
    Math.round(fg[2] * t + bg[2] * (1 - t)),
  ];
}

async function contrastOf(page: Page, selector: string) {
  const colors = await page.locator(selector).first().evaluate((el) => {
    const fgStyle = getComputedStyle(el);
    let opacity = 1;
    let node: HTMLElement | null = el as HTMLElement;
    const backgrounds: string[] = [];
    while (node) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      backgrounds.push(style.backgroundColor);
      node = node.parentElement;
    }
    return { fg: fgStyle.color, opacity, backgrounds };
  });
  let bg: [number, number, number] | null = null;
  for (let i = colors.backgrounds.length - 1; i >= 0; i -= 1) {
    const raw = colors.backgrounds[i];
    if (!raw || raw === "transparent") continue;
    try {
      bg = bg ? parseCssColor(raw, bg) : parseCssColor(raw);
    } catch {
      continue;
    }
  }
  if (!bg) throw new Error("No opaque background");
  const fg = parseCssColor(colors.fg, bg);
  return contrastRatio(compositeRgb(fg, bg, colors.opacity), bg);
}

async function setSlider(page: Page, value: number) {
  await page.locator("#lift-biometric").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function spikeStress(page: Page, ms = 2800) {
  await setSlider(page, 100);
  await page.evaluate(() => {
    const now = Date.now();
    for (let i = 0; i < 40; i += 1) {
      window.LiftL3.ingest("mouse", {
        t: now - 640 + i * 16,
        x: 100 + (i % 2 === 0 ? -48 : 48) + i,
        y: 120 + (i % 3 === 0 ? -56 : 56),
      });
    }
    window.LiftL3.ingest("click", { t: now - 240, x: 52, y: 52, detail: 1, pointerType: "mouse" });
    window.LiftL3.ingest("click", { t: now - 160, x: 54, y: 50, detail: 1, pointerType: "mouse" });
    window.LiftL3.ingest("click", { t: now - 80, x: 50, y: 55, detail: 1, pointerType: "mouse" });
    window.LiftL3.ingest("scroll", { t: now - 320, y: 0, dy: 900 });
    window.LiftL3.ingest("scroll", { t: now - 240, y: 900, dy: -900 });
    window.LiftL3.ingest("scroll", { t: now - 160, y: 0, dy: 900 });
    window.LiftL3.ingest("scroll", { t: now - 80, y: 900, dy: -900 });
    window.LiftL3.ingest("biometric", 100);
    for (let i = 0; i < 80; i += 1) {
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: 140 + (i % 2) * 110,
          clientY: 150 + (i % 3) * 70,
          bubbles: true,
        }),
      );
    }
    for (let i = 0; i < 4; i += 1) {
      window.dispatchEvent(
        new MouseEvent("click", {
          clientX: 200,
          clientY: 180,
          bubbles: true,
          cancelable: true,
          detail: 1,
          view: window,
        }),
      );
    }
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 920, bubbles: true }));
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -920, bubbles: true }));
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 720, bubbles: true }));
  });
  const t0 = Date.now();
  const heading = page.locator(".hero h1");
  const box = await heading.boundingBox();
  while (Date.now() - t0 < ms) {
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.move(160 + (i % 2) * 110, 140 + (i % 3) * 55);
    }
    if (box) {
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.click(box.x + 12, box.y + 10, { delay: 25 });
      }
    }
    await page.mouse.wheel(0, 820);
    await page.mouse.wheel(0, -820);
    await page.mouse.wheel(0, 640);
  }
}

async function gotoDemo(page: Page, extra = "") {
  if (isStubLane()) await installStubSdk(page);
  const identity = liftIdentity();
  await page.goto(`${L3_URL}/?lift_identity=${identity}${extra}`);
  return identity;
}

test.describe.configure({ mode: "serial" });

test("L3 full loop: stress, Flagsmith trait/segment/flag, Sensory-Safe, fade back", async ({
  page,
}) => {
  skipUnlessFlagsmith();
  test.setTimeout(120_000);
  await gotoDemo(page);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#lift-l3-hud")).not.toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-enter", "0.62");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-exit", "0.38");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  const hudTextStart = (await page.locator("#lift-l3-hud").textContent()) ?? "";
  const cfg = liveConfig();
  if (cfg?.flagsmithEnvironmentKey) {
    expect(hudTextStart).not.toContain(cfg.flagsmithEnvironmentKey);
  }
  expect(hudTextStart).not.toMatch(/\bser\./);
  expect(hudTextStart).toMatch(/trait overstimulated/);
  expect(hudTextStart).not.toContain("is_sensory_safe");
  await page.locator("#hero-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    video.muted = true;
    return video.play();
  });
  await expect(page.locator("#hero-video")).toHaveJSProperty("paused", false);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-summary]").first()).toBeHidden();

  const checkoutName = await page.locator("#checkout").evaluate((el) => ({
    role: el.getAttribute("role"),
    name: (el as HTMLButtonElement).innerText,
    tabIndex: (el as HTMLButtonElement).tabIndex,
    tag: el.tagName,
  }));

  await spikeStress(page);
  await page.waitForTimeout(1_700);
  const hudText = (await page.locator("#lift-l3-hud").textContent()) ?? "";
  expect(hudText, "full-loop spike must not use forceScore").not.toContain("(forced)");
  const score = Number(await page.locator("#lift-l3-hud").getAttribute("data-score"));
  expect(score, "detectors reach threshold without forceScore").toBeGreaterThanOrEqual(
    ENTER_THRESHOLD,
  );

  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true", { timeout: 20_000 });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true", { timeout: 20_000 });
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeHidden();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-error]")).toBeVisible();
  await expect(page.locator("[data-lift-legal]")).toBeVisible();
  await expect(page.locator("[data-lift-marketing]")).toBeHidden();
  await expect(page.locator("[data-lift-summary]").first()).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible();
  await expect(page.locator(".carousel-track")).toHaveCSS("animation-play-state", "paused");

  const after = await page.locator("#checkout").evaluate((el) => ({
    role: el.getAttribute("role"),
    name: (el as HTMLButtonElement).innerText,
    tabIndex: (el as HTMLButtonElement).tabIndex,
    tag: el.tagName,
  }));
  expect(after).toEqual(checkoutName);

  expect(await contrastOf(page, ".long-copy h2")).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  expect(await contrastOf(page, ".long-copy .dense p")).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  expect(await contrastOf(page, "#checkout")).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  expect(await contrastOf(page, ".flash-bar")).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  expect(await contrastOf(page, "[data-lift-cookie] button")).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  const hudContrast = Number((await page.locator("#lift-l3-hud").getAttribute("data-contrast")) ?? "0");
  expect(hudContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);

  await expect(page.locator("#hero-video")).toHaveJSProperty("paused", true);

  await setSlider(page, 0);
  await page.evaluate(() => window.LiftL3.forceScore(0.12));
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false", {
    timeout: 25_000,
  });
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 5_000 });
  await expect(page.locator("#checkout")).not.toBeFocused();
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await page.waitForTimeout(2_100);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-restoring/);
});

test("L3 borderline scores do not flap", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(60_000);
  await gotoDemo(page);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();

  for (let i = 0; i < 12; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.6 : 0.5);
    await page.waitForTimeout(250);
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false");
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  }

  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true", { timeout: 20_000 });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true", { timeout: 20_000 });

  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.45 : 0.4);
    await page.waitForTimeout(250);
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true");
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true");
  }
});

test("L3 reload during Sensory-Safe restores hysteresis and keeps the calm view", async ({
  page,
}) => {
  skipUnlessFlagsmith();
  test.setTimeout(60_000);
  await gotoDemo(page);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
});

test("L3 HUD can be hidden with ?hud=0", async ({ page }) => {
  await page.goto(`${L3_URL}/?hud=0&l3_offline=1`);
  await page.waitForTimeout(300);
  await expect(page.locator("#lift-l3-hud")).toBeHidden();
  await expect(page.locator("#checkout")).toBeVisible();
});

test("L3 fail-open: missing Flagsmith keeps the page calm", async ({ page }) => {
  test.setTimeout(40_000);
  await page.route("**/config.json", async (route) => {
    await route.fulfill({ json: { site: "l3" } });
  });
  await page.route("**/@flagsmith/flagsmith@**", async (route) => {
    await route.abort();
  });
  await page.route("**/api/v1/**", async (route) => {
    await route.abort();
  });
  await page.goto(`${L3_URL}/?lift_identity=${liftIdentity()}`);
  await expect(page.locator("#lift-l3-offline")).toBeVisible();
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_200);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  const hudOffline = (await page.locator("#lift-l3-hud").textContent()) ?? "";
  expect(hudOffline).toContain("(default, Flagsmith unreachable)");
  expect(hudOffline).not.toMatch(/\(Flagsmith\)/);
});

test("L3 opt-in does not apply Sensory-Safe while Flagsmith is down", async ({ page }) => {
  test.setTimeout(40_000);
  const identity = liftIdentity();
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=${identity}`);
  await expect(page.locator("#checkout")).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem("lift-l3-opt-out", "1");
  });
  await page.reload();
  await expect(page.locator("#lift-l3-opt-in")).toBeVisible({ timeout: 10_000 });
  await page.locator("#lift-l3-opt-in").click();
  await page.waitForTimeout(1_000);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
});

test("L3 fail-open: env key present but API blocked stays calm", async ({ page }) => {
  test.setTimeout(40_000);
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      json: {
        site: "l3",
        flagsmithApiUrl: `${FLAGSMITH_ORIGIN}/api/v1/`,
        flagsmithEnvironmentKey: "blocked-key",
      },
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    await route.abort();
  });
  await page.goto(`${L3_URL}/?lift_identity=${liftIdentity()}`);
  await expect(page.locator("#lift-l3-offline")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_200);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  const hudBlocked = (await page.locator("#lift-l3-hud").textContent()) ?? "";
  expect(hudBlocked).toContain("(default, Flagsmith unreachable)");
  expect(hudBlocked).not.toMatch(/\(Flagsmith\)/);
});

test("L3 fail-open: Flagsmith dying mid-session keeps the normal page usable", async ({
  page,
}) => {
  skipUnlessFlagsmith();
  test.setTimeout(50_000);
  await gotoDemo(page);
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await page.route("**/api/v1/**", async (route) => {
    await route.abort();
  });
  await page.evaluate(() => {
    const flagsmith = window.LiftL3.getRuntime().flagsmith as {
      setTrait?: () => Promise<void>;
      getFlags?: () => Promise<void>;
    };
    if (!flagsmith) return;
    flagsmith.getFlags = () => Promise.reject(new Error("Flagsmith died mid-session"));
    flagsmith.setTrait = () => Promise.reject(new Error("Flagsmith died mid-session"));
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.12));
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
  await expect(page.locator("#checkout")).toBeEnabled();
});

test("L3 fail-open: Flagsmith dying mid-setTrait keeps UI off without staying offline", async ({
  page,
}) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "false");
  await page.route("**/api/v1/**", async (route) => {
    await route.abort();
  });
  await page.evaluate(() => {
    const flagsmith = window.LiftL3.getRuntime().flagsmith as {
      setTrait?: () => Promise<void>;
    };
    if (flagsmith) {
      flagsmith.setTrait = () =>
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error("timeout")), 10);
        });
    }
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_200);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "false");
});

test("L3 offline query hook is labelled tests-only and still fail-opens", async ({ page }) => {
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=${liftIdentity()}`);
  await expect(page.locator("#lift-l3-offline")).toBeVisible();
  await expect(page.locator("#lift-l3-offline")).toHaveText(/OFFLINE FALLBACK — tests only/);
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_000);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
});

test("L3 rejects XSS identities and never writes them into the HUD DOM", async ({ page }) => {
  const payload = "<img src=x onerror=alert(1)>";
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=${encodeURIComponent(payload)}`);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();
  const html = await page.locator("#lift-l3-hud").innerHTML();
  expect(html.toLowerCase()).not.toContain("<img");
  expect(html).not.toContain("onerror");
  const identityText = await page.locator("#lift-l3-hud .l3-hud-id").textContent();
  expect(identityText).toMatch(/lift-[0-9a-f-]{36}/i);
});

test("L3 moves focus to main when hiding promo and never hides cookie/legal/error", async ({
  page,
}) => {
  skipUnlessFlagsmith();
  test.setTimeout(60_000);
  await gotoDemo(page);
  await page.locator("#promo-focus").focus();
  await expect(page.locator("#promo-focus")).toBeFocused();
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await expect(page.locator("[data-lift-promo]")).toBeHidden();
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-legal]")).toBeVisible();
  await expect(page.locator("[data-lift-error]")).toBeVisible();
});

test("L3 pauses autoplay only and ignores keyboard rage clicks", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await expect(page.locator("#hero-video")).toHaveAttribute("autoplay");
  await page.locator("#hero-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    video.muted = true;
    return video.play();
  });
  await expect(page.locator("#hero-video")).toHaveJSProperty("paused", false);
  await page.locator("#play-user-video").click();
  await page.locator("#checkout").focus();
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(400);
  const rage = await page.locator("#lift-l3-hud li").nth(1).textContent();
  expect(rage).toMatch(/rage 0\.00/);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await expect(page.locator("#hero-video")).toHaveJSProperty("paused", true);
  const userWasPausedByL3 = await page.locator("#user-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    return video.dataset.liftWasPlaying === "1";
  });
  expect(userWasPausedByL3).toBe(false);
});

test("L3 opt-out is keyboard reachable and Escape in a dialog does not exit", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "lift-test-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.textContent = "modal";
    document.body.appendChild(dialog);
    dialog.showModal();
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/);
  await page.evaluate(() => document.getElementById("lift-test-dialog")?.remove());
  await page.locator("#lift-l3-opt-out").focus();
  await expect(page.locator("#lift-l3-opt-out")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 8_000 });
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator("#lift-l3-opt-in")).toBeVisible();
  await expect(page.locator("#lift-l3-opt-in")).toHaveText("Allow calmer view again");
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
});

test("L3 opt-in is clickable with a real pointer through the HUD", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible({ timeout: 20_000 });
  await page.locator("#lift-l3-opt-out").click();
  await expect(page.locator("#lift-l3-opt-in")).toBeVisible();
  await page.locator("#lift-l3-opt-in").click();
  await expect(page.locator("#lift-l3-opt-in")).toBeHidden();
  expect(await page.evaluate(() => window.LiftL3.getRuntime().optedOut)).toBe(false);
});

test("L3 opt-out and opt-in stay clickable at 800x600 over the popup", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await page.setViewportSize({ width: 800, height: 600 });
  await gotoDemo(page);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible({ timeout: 20_000 });
  await page.locator("#lift-l3-opt-out").click();
  await expect(page.locator("#lift-l3-opt-in")).toBeVisible();
  await page.locator("#lift-l3-opt-in").click();
  await expect(page.locator("#lift-l3-opt-in")).toBeHidden();
  expect(await page.evaluate(() => window.LiftL3.getRuntime().optedOut)).toBe(false);
});

test("L3 setTrait does not loop when opt-out races a slow push", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "false", {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    const flagsmith = window.LiftL3.getRuntime().flagsmith as {
      setTrait: (name: string, value: unknown) => Promise<unknown>;
    } | null;
    if (!flagsmith?.setTrait) throw new Error("Flagsmith SDK was not ready");
    const orig = flagsmith.setTrait.bind(flagsmith);
    window.__setTraitCalls = 0;
    flagsmith.setTrait = (name, value) => {
      window.__setTraitCalls = (window.__setTraitCalls ?? 0) + 1;
      return new Promise((resolve, reject) => {
        window.setTimeout(() => {
          orig(name, value).then(resolve, reject);
        }, 300);
      });
    };
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForFunction(() => (window.__setTraitCalls ?? 0) >= 1, null, { timeout: 10_000 });
  await page.locator("#lift-l3-opt-out").evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(3_000);
  const mid = await page.evaluate(() => window.__setTraitCalls ?? 0);
  await page.waitForTimeout(1_200);
  const late = await page.evaluate(() => window.__setTraitCalls ?? 0);
  expect(late).toBe(mid);
  expect(late).toBeLessThan(8);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
});

test("L3 stop clears bindings, drops Sensory-Safe, and resyncs on start", async ({ page }) => {
  skipUnlessFlagsmith();
  test.setTimeout(40_000);
  await gotoDemo(page);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "false", {
    timeout: 20_000,
  });
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await page.evaluate(() => window.LiftL3.stop());
  const leftover = await page.evaluate(() => ({
    bound: document.querySelectorAll("[data-lift-bound]").length,
    media: document.querySelectorAll("[data-lift-media-bound]").length,
    retry: window.LiftL3.getRuntime().traitRetryTimer,
    seq: window.LiftL3.getRuntime().traitSeq,
  }));
  expect(leftover.bound).toBe(0);
  expect(leftover.media).toBe(0);
  expect(leftover.retry).toBe(0);
  expect(leftover.seq).toBeGreaterThan(0);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("#lift-l3-opt-out")).toBeHidden();
  await page.evaluate(() => window.LiftL3.start());
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
});
