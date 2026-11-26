import { expect, test } from "@playwright/test";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

test("CDN serves @flagsmith/flagsmith@12.4.0", async ({ request }) => {
  test.skip(process.env.LIFT_CDN_SMOKE !== "1", "optional network smoke (LIFT_CDN_SMOKE=1)");
  const res = await request.get(SDK_URL);
  expect(
    res.status(),
    "jsdelivr must serve @flagsmith/flagsmith@12.4.0 (not flagsmith@12.4.0)",
  ).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/getExperimentFlag/);
});
