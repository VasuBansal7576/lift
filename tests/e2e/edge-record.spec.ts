import { test } from "@playwright/test";

/**
 * Proof recordings are live headed-Chrome + terminal captures against
 * real self-hosted Flagsmith 2.295.2. They are not Playwright video.
 *
 *   npm run edge:record
 *
 * See edge/record/README.md.
 */
test.describe.skip("edge live recordings — see edge/record/README.md", () => {
  test("npm run edge:record against real Flagsmith 2.295.2", () => {});
});
