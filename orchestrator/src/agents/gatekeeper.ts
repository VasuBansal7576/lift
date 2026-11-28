import type { Browser } from "@playwright/test";
import { applySpecOnPage, gotoControl, launchBrowser, openCheckout, runAxe } from "../browser.ts";
import type { EventLog } from "../log.ts";
import type { PatchSpec } from "../../../shared/patch-spec.ts";
import type { ApplyResult, AxeSummary, CandidateSpec, GateResult } from "../types.ts";

export function evaluateGate(input: {
  apply: ApplyResult;
  baseline: AxeSummary;
  after: AxeSummary;
}): { passed: boolean; reason: string } {
  if (!input.apply.ok) {
    return {
      passed: false,
      reason: `runtime backstop: ${input.apply.error ?? "apply failed"}`,
    };
  }
  const addedRules = input.after.ruleIds.filter((id) => !input.baseline.ruleIds.includes(id));
  if (addedRules.length > 0) {
    return {
      passed: false,
      reason: `added axe rules: ${addedRules.join(", ")} (${input.baseline.violationCount} → ${input.after.violationCount})`,
    };
  }
  if (input.after.nodeCount > input.baseline.nodeCount) {
    return {
      passed: false,
      reason: `axe nodes increased ${input.baseline.nodeCount} → ${input.after.nodeCount}`,
    };
  }
  return {
    passed: true,
    reason: `axe ${input.baseline.violationCount} rules / ${input.baseline.nodeCount} nodes → ${input.after.violationCount} / ${input.after.nodeCount}`,
  };
}

export async function measureChampionBaseline(
  siteUrl: string,
  champion: PatchSpec,
  browser: Browser,
): Promise<AxeSummary> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await gotoControl(page, siteUrl);
    const apply = await applySpecOnPage(page, champion);
    if (!apply.ok) {
      throw new Error(`Champion failed to apply for gen-2 baseline: ${apply.error ?? "apply failed"}`);
    }
    await openCheckout(page);
    return await runAxe(page);
  } finally {
    await context.close();
  }
}

export async function gateCandidate(
  siteUrl: string,
  candidate: CandidateSpec,
  baseline: AxeSummary,
  browser: Browser,
): Promise<GateResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await gotoControl(page, siteUrl);
    const apply = await applySpecOnPage(page, candidate.spec);
    let after = baseline;
    if (apply.ok) {
      await openCheckout(page);
      after = await runAxe(page);
    }
    const decision = evaluateGate({ apply, baseline, after });
    return {
      specId: candidate.spec.id,
      title: candidate.title,
      kind: candidate.kind,
      spec: candidate.spec,
      apply,
      baseline,
      after,
      passed: decision.passed,
      reason: decision.reason,
    };
  } finally {
    await context.close();
  }
}

export async function runGatekeeper(
  siteUrl: string,
  candidates: CandidateSpec[],
  baseline: AxeSummary,
  log: EventLog,
  browser?: Browser,
  champion?: PatchSpec | null,
): Promise<GateResult[]> {
  log.emit("gatekeeper", "start", `Axe gate on ${candidates.length} candidates (before any traffic)`);
  const owned = browser ?? (await launchBrowser());
  const results: GateResult[] = [];
  try {
    const gateBaseline = champion ? await measureChampionBaseline(siteUrl, champion, owned) : baseline;
    if (champion) {
      log.emit(
        "gatekeeper",
        "info",
        `Gen-2 baseline is champion ${champion.id}: ${gateBaseline.violationCount} rules / ${gateBaseline.nodeCount} nodes`,
      );
    }
    for (const candidate of candidates) {
      const gated = await gateCandidate(siteUrl, candidate, gateBaseline, owned);
      results.push(gated);
      log.emit(
        "gatekeeper",
        gated.passed ? "pass" : "reject",
        `${gated.specId}: ${gated.reason}`,
        {
          specId: gated.specId,
          passed: gated.passed,
          baselineViolations: gated.baseline.violationCount,
          afterViolations: gated.after.violationCount,
          applyOk: gated.apply.ok,
        },
      );
    }
  } finally {
    if (!browser) await owned.close();
  }
  const passed = results.filter((item) => item.passed).length;
  log.emit("gatekeeper", "done", `${passed} passed / ${results.length - passed} rejected`);
  return results;
}
