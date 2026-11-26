import { expect, test, type Page } from "@playwright/test";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

function stubSdk(variant: "control" | "treatment") {
  return `
const flagsmith = {
  async init() {},
  getExperimentFlag() {
    return { variant: "${variant}", value: "${variant}", enabled: true };
  },
  getValue(name) {
    return name === "checkout_a11y" ? "${variant}" : "control";
  },
  trackEvent() {},
  async setTrait() {},
  async flushEvents() {},
};
export default flagsmith;
`;
}

async function stubFlagsmith(page: Page, variant: "control" | "treatment") {
  await page.route(SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: stubSdk(variant),
    });
  });
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      json: {
        allowMock: false,
        flagsmithEnvironmentKey: "test-env",
        flagsmithApiUrl: "https://edge.api.flagsmith.com/api/v1/",
        flagsmithEventsUrl: "https://events.api.flagsmith.com/",
        flagName: "checkout_a11y",
        metricEvent: "checkout_completed",
      },
    });
  });
}

test("real Flagsmith path loads without ?lift_variant", async ({ page }) => {
  await stubFlagsmith(page, "treatment");
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "treatment");
  await expect(page.locator("#flag-status")).toHaveText(/Flagsmith checkout_a11y=treatment/);
  await expect(page.locator("#flag-status")).not.toHaveText(/URL override/);
});

test("allowMock:false ignores ?lift_variant=treatment when Flagsmith returns control", async ({
  page,
}) => {
  await stubFlagsmith(page, "control");
  await page.goto("/?lift_variant=treatment");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await expect(page.locator("#flag-status")).toHaveText(/Flagsmith checkout_a11y=control/);
  await expect(page.locator("#flag-status")).not.toHaveText(/URL override/);
});
