import type { Page } from "@playwright/test";

export const CONTRAST_FLOOR = 4.5;

/** Contrast-threshold persona: 200% zoom that affects layout, then WCAG 4.5:1 on computed colours. */
export async function applyLowVisionZoom(page: Page) {
  const session = await page.context().newCDPSession(page);
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
}
