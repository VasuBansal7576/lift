import { describe, expect, it } from "vitest";
import { MANUAL_ESTIMATE_MINUTES, TIME_SAVED_LABEL, measureTimeSaved } from "../../orchestrator/src/time-saved.ts";

describe("time saved", () => {
  it("subtracts wall-clock from the documented 115 minute manual estimate", () => {
    expect(MANUAL_ESTIMATE_MINUTES).toBe(115);
    expect(TIME_SAVED_LABEL).toBe("vs est. manual 115 min (itemised estimate)");
    const saved = measureTimeSaved(5 * 60_000);
    expect(saved.savedMs).toBe((115 - 5) * 60_000);
  });
});
