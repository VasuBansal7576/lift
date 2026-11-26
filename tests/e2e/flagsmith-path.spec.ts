import { expect, test } from "@playwright/test";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

const STUB_SDK = `
const flagsmith = {
  async init() {},
  getExperimentFlag() {
    return { variant: "treatment", value: "treatment", enabled: true };
  },
  getValue(name) {
    return name === "checkout_a11y" ? "treatment" : "control";
  },
  trackEvent() {},
  async setTrait() {},
  async flushEvents() {},
};
export default flagsmith;
`;

test("CDN serves @flagsmith/flagsmith@12.4.0", async ({ request }) => {
  const res = await request.get(SDK_URL);
  expect(res.status(), "jsdelivr must serve @flagsmith/flagsmith@12.4.0 (not flagsmith@12.4.0)").toBe(200);
  const body = await res.text();
  expect(body).toMatch(/getExperimentFlag/);
});

test("real Flagsmith path loads without ?lift_variant", async ({ page }) => {
  await page.route(SDK_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: STUB_SDK,
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

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "treatment");
  await expect(page.locator("#flag-status")).toHaveText(/Flagsmith checkout_a11y=treatment/);
  await expect(page.locator("#flag-status")).not.toHaveText(/URL override/);
});
