import type { FlagsmithResultsEnvelope } from "./decide.ts";

export function chiSquareSrmFromDoc(
  doc: {
    decision?: {
      control?: { visitors?: number };
      treatment?: { visitors?: number };
    };
    flagsmithResults?: FlagsmithResultsEnvelope | null;
  },
  srmFn: (nControl: number, nTreatment: number) => number,
): { value: number | null; source: "flagsmith" | "lift" | null } {
  const variants = doc.flagsmithResults?.results?.payload?.metrics?.[0]?.variants;
  const controlN = variants?.control?.n ?? doc.decision?.control?.visitors ?? 0;
  const treatment =
    variants?.treatment ??
    (variants
      ? Object.entries(variants).find(([key]) => key !== "control")?.[1]
      : undefined);
  const treatmentN = treatment?.n ?? doc.decision?.treatment?.visitors ?? 0;
  if (controlN + treatmentN <= 0) return { value: null, source: null };
  return { value: srmFn(controlN, treatmentN), source: "lift" };
}
