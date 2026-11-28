import { describe, expect, it } from "vitest";
import { parsePatchSpec } from "../../shared/patch-spec.ts";
import {
  badContrastSpec,
  championFocusCeilingNote,
  championHasFocusVisibleOp,
  contrastSpec,
  focusOutlineChallenger,
  fullTreatmentSpec,
  labelsSpec,
  templatesFromViolations,
} from "../../orchestrator/src/agents/mutator.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { maybeLlmCandidates } from "../../orchestrator/src/agents/mutator.ts";
import type { AxeSummary } from "../../orchestrator/src/types.ts";

const axe: AxeSummary = {
  url: "http://127.0.0.1:4174/checkout",
  violationCount: 3,
  nodeCount: 6,
  ruleIds: ["label", "button-name", "color-contrast"],
  violations: [
    { id: "label", impact: "critical", nodes: 5, targets: [], help: "label" },
    { id: "button-name", impact: "critical", nodes: 2, targets: [], help: "button-name" },
    { id: "color-contrast", impact: "serious", nodes: 1, targets: [], help: "color-contrast" },
  ],
};

describe("mutator templates", () => {
  it("emits deterministic specs plus a hostile canary", () => {
    const candidates = templatesFromViolations(axe);
    const ids = candidates.map((item) => item.spec.id);
    expect(ids).toContain("labels-v1");
    expect(ids).not.toContain("controls-v1");
    expect(ids).toContain("contrast-v1");
    expect(ids).toContain("full-v1");
    expect(ids).toContain("bad-contrast-v1");
    expect(candidates.some((item) => item.kind === "canary-reject")).toBe(true);
  });

  it("produces parseable PatchSpecs for the good templates", () => {
    for (const spec of [labelsSpec(), contrastSpec(), fullTreatmentSpec()]) {
      const parsed = parsePatchSpec(spec);
      expect(parsed.ok, spec.id).toBe(true);
    }
  });

  it("hostile contrast spec is allowlisted (axe, not parse, must reject it)", () => {
    const parsed = parsePatchSpec(badContrastSpec());
    expect(parsed.ok).toBe(true);
  });

  it("generation 2 uses the champion as control and emits gated challengers", () => {
    const champion = fullTreatmentSpec("full-v1");
    const candidates = templatesFromViolations(axe, 2, champion);
    expect(candidates.every((item) => item.spec.id !== "full-v1")).toBe(true);
    expect(candidates.some((item) => item.spec.id.startsWith("g2-"))).toBe(true);
    const focus = focusOutlineChallenger(champion, "g2-focus");
    expect(parsePatchSpec(focus).ok).toBe(true);
    const outline = JSON.stringify(focus);
    expect(outline).toContain("#ffffff");
  });

  it("skips LLM when no key is present", async () => {
    const previousKey = process.env.LIFT_LLM_API_KEY;
    const previousUrl = process.env.LIFT_LLM_API_URL;
    const previousGroq = process.env.GROQ_API_KEY;
    const previousGemini = process.env.GEMINI_API_KEY;
    delete process.env.LIFT_LLM_API_KEY;
    delete process.env.LIFT_LLM_API_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const log = new EventLog(false);
    try {
      const extra = await maybeLlmCandidates(axe, log);
      expect(extra).toEqual([]);
      expect(log.events.some((event) => /deterministic template mutator; LLM path available with a key/.test(event.message))).toBe(
        true,
      );
    } finally {
      if (previousKey === undefined) delete process.env.LIFT_LLM_API_KEY;
      else process.env.LIFT_LLM_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.LIFT_LLM_API_URL;
      else process.env.LIFT_LLM_API_URL = previousUrl;
      if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = previousGroq;
      if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGemini;
    }
  });

  it("requires LIFT_LLM_API_URL with LIFT_LLM_API_KEY", async () => {
    const previousKey = process.env.LIFT_LLM_API_KEY;
    const previousUrl = process.env.LIFT_LLM_API_URL;
    process.env.LIFT_LLM_API_KEY = "sk-test";
    delete process.env.LIFT_LLM_API_URL;
    const log = new EventLog(false);
    try {
      const extra = await maybeLlmCandidates(axe, log);
      expect(extra).toEqual([]);
      expect(log.events.some((event) => /LIFT_LLM_API_URL/.test(event.message))).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.LIFT_LLM_API_KEY;
      else process.env.LIFT_LLM_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.LIFT_LLM_API_URL;
      else process.env.LIFT_LLM_API_URL = previousUrl;
    }
  });

  it("derives the gen-2 ceiling note from whether the champion already has a focus-visible op", () => {
    const champion = fullTreatmentSpec("full-v1");
    expect(championHasFocusVisibleOp(champion)).toBe(false);
    expect(championFocusCeilingNote(champion)).toMatch(/UA :focus-visible on Place order/);
    const outlined = focusOutlineChallenger(champion, "g2-focus");
    expect(championHasFocusVisibleOp(outlined)).toBe(true);
    expect(championFocusCeilingNote(outlined)).toMatch(/includes a focus-visible outline/);
  });
});
