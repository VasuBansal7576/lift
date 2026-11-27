import { expect, test } from "@playwright/test";
import { runScanMutateGate } from "../../orchestrator/src/conductor.ts";

test.describe.configure({ timeout: 180_000 });

test("gatekeeper rejects a hostile variant before any traffic", async () => {
  const result = await runScanMutateGate("http://127.0.0.1:4174/checkout");
  expect(result.gated.length).toBeGreaterThan(1);

  const hostile = result.rejected.find((item) => item.specId.includes("bad-contrast"));
  expect(hostile, "hostile contrast candidate must be rejected").toBeTruthy();
  expect(hostile?.passed).toBe(false);
  expect(hostile?.reason).toMatch(/runtime backstop|added axe|nodes increased/i);

  const full = result.passed.find((item) => item.specId === "full-v1");
  expect(full, "full treatment spec should pass the axe gate").toBeTruthy();
  expect(full?.after.violationCount).toBeLessThanOrEqual(full?.baseline.violationCount ?? 99);
});
