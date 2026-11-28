export interface AxeViolationSummary {
  id: string;
  nodes: number;
  impact?: string | null;
}

export interface GateResult {
  ok: boolean;
  rejected: boolean;
  reason: string;
  addedIds: string[];
  increased: Array<{ id: string; from: number; to: number }>;
}

/**
 * NON-NEGOTIABLE: never serve a variant that adds axe violations.
 * Rejects when the variant introduces a new rule id or increases node count.
 */
export function compareAxeGate(
  control: AxeViolationSummary[],
  variant: AxeViolationSummary[],
): GateResult {
  const prior = new Map(control.map((row) => [row.id, row.nodes]));
  const addedIds: string[] = [];
  const increased: Array<{ id: string; from: number; to: number }> = [];
  for (const row of variant) {
    const from = prior.get(row.id) ?? 0;
    if (from === 0) addedIds.push(row.id);
    else if (row.nodes > from) increased.push({ id: row.id, from, to: row.nodes });
  }
  const rejected = addedIds.length > 0 || increased.length > 0;
  const reason = rejected
    ? `REJECT: variant adds axe violations (new=${addedIds.join(",") || "none"} increased=${increased.map((i) => i.id).join(",") || "none"})`
    : "PASS: variant does not add axe violations";
  return { ok: !rejected, rejected, reason, addedIds, increased };
}
