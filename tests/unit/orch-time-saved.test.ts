import { describe, expect, it } from "vitest";
import { MANUAL_ESTIMATE_MINUTES, measureTimeSaved } from "../../orchestrator/src/time-saved.ts";

describe("time saved", () => {
  it("subtracts wall-clock from the documented 115 minute manual estimate", () => {
    expect(MANUAL_ESTIMATE_MINUTES).toBe(115);
    const saved = measureTimeSaved(5 * 60_000);
    expect(saved.savedMs).toBe((115 - 5) * 60_000);
  });
});
