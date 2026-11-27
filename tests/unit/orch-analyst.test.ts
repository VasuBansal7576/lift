import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIN_THRESHOLD,
  parseArmChances,
  recommendWinner,
} from "../../orchestrator/src/agents/analyst.ts";
import { resultsAreReady, resultsIdentityCount } from "../../orchestrator/src/flagsmith/results.ts";

const envelope = {
  results: {
    payload: {
      metrics: [
        {
          variants: {
            control: { n: 80, sum: 40 },
            "full-v1": { n: 80, sum: 62 },
          },
          inference: {
            control: { chance_to_win: 0.02, lift: 0 },
            "full-v1": { chance_to_win: 0.98, lift: 0.55 },
          },
        },
      ],
    },
  },
};

describe("analyst threshold", () => {
  it("documents the 0.95 chance_to_win threshold", () => {
    expect(DEFAULT_WIN_THRESHOLD).toBe(0.95);
  });

  it("recommends a winner only at or above 0.95", () => {
    const arms = parseArmChances(envelope);
    const rec = recommendWinner(arms, 0.95);
    expect(rec.kind).toBe("winner");
    if (rec.kind === "winner") {
      expect(rec.arm).toBe("full-v1");
      expect(rec.chanceToWin).toBe(0.98);
    }
  });

  it("says keep collecting below the threshold", () => {
    const rec = recommendWinner(
      [
        { key: "full-v1", chanceToWin: 0.81, n: 40, sum: 22, lift: 0.2 },
        { key: "control", chanceToWin: 0.19, n: 40, sum: 18, lift: 0 },
      ],
      0.95,
    );
    expect(rec.kind).toBe("keep_collecting");
    if (rec.kind === "keep_collecting") {
      expect(rec.reason).toMatch(/keep collecting/i);
      expect(rec.leading).toBe("full-v1");
    }
  });

  it("keeps collecting when Flagsmith has no inference yet", () => {
    const rec = recommendWinner([], 0.95);
    expect(rec.kind).toBe("keep_collecting");
  });

  it("does not treat stale /results as ready when identity counts have not grown", () => {
    expect(resultsIdentityCount(envelope)).toBe(160);
    expect(resultsAreReady(envelope, 160)).toBe(true);
    expect(resultsAreReady(envelope, 161)).toBe(false);
    expect(resultsAreReady({ results: { payload: { metrics: [{ variants: {}, inference: {} }] } } }, 0)).toBe(false);
  });
});
