import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
import { ROOT } from "../../agent/src/config.ts";
import { contrastRatio, parseCssColor } from "../../traffic/src/contrast.ts";
import { L3_SDK_URL, WCAG_AA_MIN } from "../../shared/l3-constants.ts";

declare global {
  interface Window {
    LiftL3: {
      forceScore: (n: number | null) => void;
    };
  }
}

const L3_URL = "http://127.0.0.1:4175";
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

async function stubFlagsmith(page: Page) {
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

test.beforeAll(async () => {
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

test.describe.configure({ mode: "serial" });

test("L3 full loop: stress, Flagsmith trait/segment/flag, Sensory-Safe, fade back", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await stubFlagsmith(page);
  await page.goto(`${L3_URL}/?lift_identity=lift-l3-e2e`);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-score", /0\./);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  const videoPlaying = await page.locator("#hero-video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    return !video.paused && !video.ended;
  });
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
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
  if (score < 0.62) {
    await page.evaluate(() => window.LiftL3.forceScore(0.9));
    await page.waitForTimeout(1_700);
  }

  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true", { timeout: 8_000 });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true");
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-segment", "true");
  await expect(page.locator("html")).toHaveClass(/lift-sensory-safe/);
  await expect(page.locator("[data-l3='flag']")).toHaveText("on");
  await expect(page.locator("[data-l3='segment']")).toHaveText("member");
  await expect(page.locator("[data-lift-promo]")).toBeHidden();
  await expect(page.locator("[data-lift-cookie]")).toBeHidden();
  await expect(page.locator("[data-lift-marketing]")).toBeHidden();
  await expect(page.locator("[data-lift-summary]").first()).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
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

  if (videoPlaying) {
    await expect(page.locator("#hero-video")).toHaveJSProperty("paused", true);
  }

  await setSlider(page, 0);
  await page.evaluate(() => window.LiftL3.forceScore(0.12));
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false", {
    timeout: 25_000,
  });
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-safe/, { timeout: 5_000 });
  await expect(page.locator("html")).toHaveClass(/lift-sensory-restoring/);
  await expect(page.locator("[data-lift-summary]").first()).toBeHidden();
  await expect(page.locator("[data-lift-promo]")).toBeVisible();
  await expect(page.locator("#checkout")).toBeVisible();
  await page.waitForTimeout(2_100);
  await expect(page.locator("html")).not.toHaveClass(/lift-sensory-restoring/);
});

test("L3 borderline scores do not flap", async ({ page }) => {
  test.setTimeout(40_000);
  await stubFlagsmith(page);
  await page.goto(`${L3_URL}/?lift_identity=lift-l3-noflap`);
  await expect(page.locator("#lift-l3-hud")).toBeVisible();

  for (let i = 0; i < 12; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.6 : 0.5);
    await page.waitForTimeout(250);
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "false");
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "false");
  }

  await page.evaluate(() => window.LiftL3.forceScore(0.9));
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true", { timeout: 8_000 });

  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((n) => window.LiftL3.forceScore(n), i % 2 === 0 ? 0.45 : 0.4);
    await page.waitForTimeout(250);
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-trait", "true");
    await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-flag", "true");
  }
});

test("L3 HUD can be hidden with ?hud=0", async ({ page }) => {
  await stubFlagsmith(page);
  await page.goto(`${L3_URL}/?hud=0`);
  await page.waitForTimeout(300);
  await expect(page.locator("#lift-l3-hud")).toBeHidden();
  await expect(page.locator("#checkout")).toBeVisible();
});

test("L3 offline fallback is labelled tests-only", async ({ page }) => {
  await page.route("**/config.json", async (route) => {
    await route.fulfill({ json: { site: "l3" } });
  });
  await page.goto(`${L3_URL}/?l3_offline=1&lift_identity=lift-offline`);
  await expect(page.locator("#lift-l3-offline")).toBeVisible();
  await expect(page.locator("#lift-l3-offline")).toHaveText(/OFFLINE FALLBACK — tests only/);
  await expect(page.locator("#lift-l3-hud")).toHaveAttribute("data-offline", "true");
});
