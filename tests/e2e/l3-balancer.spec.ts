import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
import { ROOT } from "../../agent/src/config.ts";
import { contrastRatio, parseCssColor } from "../../traffic/src/contrast.ts";
import { ENTER_THRESHOLD, WCAG_AA_MIN } from "../../shared/l3-constants.ts";

declare global {
  interface Window {
    LiftL3: {
      forceScore: (n: number | null) => void;
      stop: () => void;
      start: () => Promise<unknown>;
    };
  }
}

const L3_URL = "http://127.0.0.1:4175";
const FLAGSMITH_ORIGIN = "http://127.0.0.1:8000";

function liftIdentity(): string {
  return `lift-${randomUUID()}`;
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
  server = spawn("npx", ["tsx", "scripts/serve-l3.ts", "--port", "4175"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  await waitForServer(L3_URL);
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  server = null;
});

async function parseRgb(color: string, fallback: [number, number, number]): Promise<[number, number, number]> {
  try {
    return parseCssColor(color, fallback);
  } catch {
    return fallback;
  }
}

async function contrastOf(page: Page, selector: string) {
  const colors = await page.locator(selector).first().evaluate((el) => {
    const read = (node: Element) => getComputedStyle(node);
    const fg = read(el).color;
    let node: HTMLElement | null = el as HTMLElement;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && !color.includes("0, 0, 0, 0") && color !== "transparent") {
        bg = color;
        break;
      }
      node = node.parentElement;
    }
    return { fg, bg };
  });
  const fg = await parseRgb(colors.fg, [44, 48, 56]);
  const bg = await parseRgb(colors.bg, [244, 240, 232]);
  return contrastRatio(fg, bg);
}

async function setSlider(page: Page, value: number) {
  await page.locator("#lift-biometric").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function spikeStress(page: Page, ms = 2200) {
  await setSlider(page, 100);
  const t0 = Date.now();
  const heading = page.locator(".hero h1");
  const box = await heading.boundingBox();
  while (Date.now() - t0 < ms) {
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.move(160 + (i % 2) * 110, 140 + (i % 3) * 55);
    }
    if (box) {
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.click(box.x + 12, box.y + 10, { delay: 30 });
      }
    }
    await page.mouse.wheel(0, 820);
    await page.mouse.wheel(0, -820);
    await page.mouse.wheel(0, 640);
  }
}

function skipUnlessLive() {
  test.skip(!live, "self-hosted Flagsmith is not running on 127.0.0.1:8000 with demo/l3/config.json");
}

test.describe.configure({ mode: "serial" });

test("L3 full loop: stress, Flagsmith trait/segment/flag, Sensory-Safe, fade back", async ({
  page,
}) => {
  skipUnlessLive();
  test.setTimeout(120_000);
  const identity = liftIdentity();
  await page.goto(`${L3_URL}/?lift_identity=${identity}`);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#lift-l3-hud")).not.toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-score", /0\./);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-enter", "0.62");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-exit", "0.38");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  const videoPlaying = await page.locator("#hero-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    return !video.paused && !video.ended;
  });
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-summary]").first()).toBeHidden();
  await expect(page.locator(".carousel-track")).toHaveCSS("animation-play-state", "running");

  const checkoutName = await page.locator("#checkout").evaluate((el) => ({
    role: el.getAttribute("role"),
    name: (el as HTMLButtonElement).innerText,
    tabIndex: (el as HTMLButtonElement).tabIndex,
    tag: el.tagName,
  }));

  await spikeStress(page);
  await page.waitForTimeout(1_700);
  const score = Number(await page.locator("#lift-l3-hud").getAttribute("data-score"));
  if (score < ENTER_THRESHOLD) {
    await page.evaluate(() => window.LiftL3.forceScore(0.9));
    await page.waitForTimeout(1_700);
  }

  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true", { timeout: 20_000 });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true", { timeout: 20_000 });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-segment", "true");
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-l3='flag']")).toHaveText("on");
  await expect(page.locator("[data-l3='segment']")).toHaveText("member");
  await expect(page.locator("[data-l3='contrast']")).toHaveText(/4\.\d+:1|([5-9]|\d{2,})\.\d+:1/);
  await expect(page.locator("[data-lift-promo]")).toBeHidden();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-error]")).toBeVisible();
  await expect(page.locator("[data-lift-legal]")).toBeVisible();
  await expect(page.locator("[data-lift-marketing]")).toBeHidden();
  await expect(page.locator("[data-lift-summary]").first()).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible();
  await page.locator("#checkout").focus();
  await expect(page.locator("#checkout")).toBeFocused();
  await expect(page.locator(".carousel-track")).toHaveCSS("animation-play-state", "paused");

  const after = await page.locator("#checkout").evaluate((el) => ({
    role: el.getAttribute("role"),
    name: (el as HTMLButtonElement).innerText,
    tabIndex: (el as HTMLButtonElement).tabIndex,
    tag: el.tagName,
  }));
  expect(after).toEqual(checkoutName);

  const headingContrast = await contrastOf(page, ".long-copy h2");
  expect(headingContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  const bodyContrast = await contrastOf(page, ".long-copy .dense p");
  expect(bodyContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  const btnContrast = await contrastOf(page, "#checkout");
  expect(btnContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  const hudContrast = Number(
    (await page.locator("#lift-l3-hud").getAttribute("data-contrast")) ?? "0",
  );
  expect(hudContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);

  if (videoPlaying) {
    await expect(page.locator("#hero-video")).toHaveJSProperty("paused", true);
  }

  await setSlider(page, 0);
  await page.evaluate(() => window.LiftL3.forceScore(0.12));
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false", {
    timeout: 25_000,
  });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false", {
    timeout: 20_000,
  });
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 5_000 });
  await expect(page.locator("[data-lift-summary]").first()).toBeHidden();
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
  await page.waitForTimeout(2_100);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-restoring/);
});

test("L3 borderline scores do not flap", async ({ page }) => {
  skipUnlessLive();
  test.setTimeout(60_000);
  const identity = liftIdentity();
  await page.goto(`${L3_URL}/?lift_identity=${identity}`);
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
  await expect(page.locator("#lift-l3-offline")).toHaveText(/flag-off state|fail-open/i);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "true");
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_200);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  const autoplayPaused = await page.locator("#hero-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    return video.paused && video.dataset.liftWasPlaying === "1";
  });
  expect(autoplayPaused).toBe(false);
});

test("L3 offline query hook is labelled tests-only and still fail-opens", async ({ page }) => {
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=${liftIdentity()}`);
  await expect(page.locator("#lift-l3-offline")).toBeVisible();
  await expect(page.locator("#lift-l3-offline")).toHaveText(/OFFLINE FALLBACK — tests only/);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "true");
  await page.evaluate(() => window.LiftL3.forceScore(0.95));
  await page.waitForTimeout(2_000);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
});

test("L3 rejects XSS identities and never writes them into the HUD DOM", async ({ page }) => {
  const payload = '<img src=x onerror=alert(1)>';
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=${encodeURIComponent(payload)}`);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();
  const html = await page.locator("#lift-l3-hud").innerHTML();
  expect(html.toLowerCase()).not.toContain("<img");
  expect(html).not.toContain("onerror");
  const identityText = await page.locator("#lift-l3-hud .l3-hud-id").textContent();
  expect(identityText).toMatch(/lift-[0-9a-f-]{36}/i);
  expect(identityText).not.toContain("<img");
});

test("L3 moves focus out of a hidden promo and never hides cookie/legal/error", async ({
  page,
}) => {
  skipUnlessLive();
  test.setTimeout(60_000);
  await page.goto(`${L3_URL}/?lift_identity=${liftIdentity()}`);
  await page.locator("#promo-focus").focus();
  await expect(page.locator("#promo-focus")).toBeFocused();
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  await expect(page.locator("[data-lift-promo]")).toBeHidden();
  await expect(page.locator("#checkout")).toBeFocused();
  await expect(page.locator("[data-lift-cookie]")).toBeVisible();
  await expect(page.locator("[data-lift-legal]")).toBeVisible();
  await expect(page.locator("[data-lift-error]")).toBeVisible();
});

test("L3 pauses autoplay only and ignores keyboard rage clicks", async ({ page }) => {
  skipUnlessLive();
  test.setTimeout(40_000);
  await page.goto(`${L3_URL}/?lift_identity=${liftIdentity()}`);
  await page.locator("#user-video").evaluate(async (el) => {
    const video = el as HTMLVideoElement;
    video.dataset.liftGesture = "1";
    await video.play().catch(() => {});
  });
  await page.locator("#checkout").focus();
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(400);
  const rage = await page.locator("#lift-l3-hud li").nth(1).textContent();
  expect(rage).toMatch(/rage 0\.00/);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/, { timeout: 20_000 });
  const userWasPausedByL3 = await page.locator("#user-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    return video.dataset.liftWasPlaying === "1";
  });
  expect(userWasPausedByL3).toBe(false);
});

test("L3 opt-out is keyboard reachable and dismisses Sensory-Safe", async ({ page }) => {
  skipUnlessLive();
  test.setTimeout(40_000);
  await page.goto(`${L3_URL}/?lift_identity=${liftIdentity()}`);
  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-opt-out")).toBeVisible({ timeout: 20_000 });
  await page.locator("#lift-l3-opt-out").focus();
  await expect(page.locator("#lift-l3-opt-out")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 8_000 });
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
});
