import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIN_THRESHOLD,
  describeResultsStatus,
  formatDecisionLine,
  formatGen2Inconclusive,
  formatWithheldArms,
  parseArmChances,
  recommendWinner,
  withheldSmallArms,
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

  it("prints a readable decision line, not only JSON", () => {
    const rec = recommendWinner(
      [
        { key: "full-v1", chanceToWin: 0.91, n: 250, sum: 200, lift: 0.3 },
        { key: "control", chanceToWin: 0.09, n: 250, sum: 140, lift: 0 },
      ],
      0.95,
    );
    expect(formatDecisionLine(rec)).toBe(
      "Flagsmith: 91% | Agent threshold: 95% | Decision: KEEP COLLECTING",
    );
  });

  it("wording for gen-2 below threshold does not claim a loss", () => {
    const rec = recommendWinner(
      [{ key: "g2-focus", chanceToWin: 0.62, n: 100, sum: 80, lift: 0.01 }],
      0.95,
    );
    expect(formatGen2Inconclusive(rec, 400)).toBe(
      "Gen-2 inconclusive (chance_to_win 0.620 < 0.95 after 400 visits); champion stays",
    );
    const rec90 = recommendWinner(
      [{ key: "g2-focus", chanceToWin: 0.62, n: 100, sum: 80, lift: 0.01 }],
      0.9,
    );
    expect(formatGen2Inconclusive(rec90, 80)).toBe(
      "Gen-2 inconclusive (chance_to_win 0.620 < 0.90 after 80 visits); champion stays",
    );
  });

  it("keeps collecting when Flagsmith has no inference yet", () => {
    const rec = recommendWinner([], 0.95);
    expect(rec.kind).toBe("keep_collecting");
  });

  it("names arms Flagsmith withheld because they are under 50 identities", () => {
    const small = {
      results: {
        payload: {
          metrics: [
            {
              variants: {
                control: { n: 57, sum: 50 },
                "g2-focus": { n: 65, sum: 61 },
                "g2-type": { n: 39, sum: 34 },
              },
              inference: {
                "g2-focus": { chance_to_win: 0.864, lift: 0.07 },
              },
            },
          ],
        },
      },
    };
    expect(withheldSmallArms(small)).toEqual(["g2-type"]);
    expect(formatWithheldArms(["g2-type"])).toBe("results withheld (<50/arm): g2-type");
  });

  it("reports a completed experiment as rolled out instead of waiting for approval", () => {
    const rec = recommendWinner(
      [{ key: "full-v1", chanceToWin: 0.99, n: 200, sum: 180, lift: 0.3 }],
      0.95,
    );
    expect(describeResultsStatus("completed", rec)).toEqual({
      phase: "complete",
      line: "completed; rolled out full-v1",
    });
    expect(describeResultsStatus("running", rec).phase).toBe("WAITING_FOR_HUMAN_APPROVAL");
  });

  it("does not treat stale /results as ready when identity counts have not grown", () => {
    expect(resultsIdentityCount(envelope)).toBe(160);
    expect(resultsAreReady(envelope, 160)).toBe(true);
    expect(resultsAreReady(envelope, 161)).toBe(false);
    expect(resultsAreReady({ results: { payload: { metrics: [{ variants: {}, inference: {} }] } } }, 0)).toBe(false);
  });
});
