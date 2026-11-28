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

test("lift_identity without lift_bot=1 does not overwrite the visitor cookie", async ({
  page,
  context,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const first = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(first?.value).toBeTruthy();
  await page.goto(`/checkout/?lift_variant=control&lift_identity=evil-id`);
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const after = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(after?.value).toBe(first?.value);
});

test("lift_bot=1 identity is used for the load but is not written into the cookie", async ({
  page,
  context,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const first = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(first?.value).toBeTruthy();
  await page.goto(
    "/checkout/?lift_variant=control&lift_bot=1&lift_identity=lift-sim-bot-override",
  );
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const after = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(after?.value).toBe(first?.value);
  expect(after?.value).not.toBe("lift-sim-bot-override");
});
