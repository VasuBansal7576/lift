import { expect, test } from "@playwright/test";

test("lift_vid cookie persists across reload and assignment is sticky", async ({ page, context }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const first = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(first?.value).toBeTruthy();
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const again = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(again?.value).toBe(first?.value);
});

test("?lift_identity= overwrites the cookie by design and stays after a query-less load", async ({
  page,
  context,
}) => {
  await page.goto("/checkout/?lift_variant=control&lift_identity=lift-sim-sticky-1");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const written = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(written?.value).toBe("lift-sim-sticky-1");
  await page.goto("/checkout/?lift_variant=control");
  const sticky = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(sticky?.value).toBe("lift-sim-sticky-1");
});
