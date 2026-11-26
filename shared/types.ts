export const PERSONAS = [
  "mouse",
  "keyboard",
  "screen-reader",
  "low-vision",
] as const;

export type Persona = (typeof PERSONAS)[number];

export const VARIANTS = ["control", "treatment"] as const;
export type Variant = (typeof VARIANTS)[number];

export const DECISIONS = [
  "rollout_treatment",
  "pull_to_control",
  "keep_running",
] as const;
export type Decision = (typeof DECISIONS)[number];

export type BarrierId =
  | "hover_menu"
  | "unlabeled_icon"
  | "div_button"
  | "missing_labels"
  | "unlabeled_terms"
  | "low_contrast";

export interface Barrier {
  id: BarrierId;
  flag: string;
  wcag: string;
  title: string;
  control: string;
  treatment: string;
  blocks: Persona[];
}

export interface VisitRecord {
  identity: string;
  persona: Persona;
  variant: Variant;
  converted: boolean;
  blockedBy: BarrierId[];
  reason: string;
  simulated: true;
  at?: string;
}

export interface ArmStats {
  visitors: number;
  conversions: number;
  rate: number;
}

export interface ExperimentDecision {
  flag: string;
  decision: Decision;
  source: "flagsmith" | "local_bayesian";
  winProbabilityTreatment: number;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  control: ArmStats;
  treatment: ArmStats;
  threshold: number;
  notes: string[];
}

export type PersonaMix = Record<Persona, number>;

export const DEFAULT_PERSONA_MIX: PersonaMix = {
  mouse: 0.7,
  keyboard: 0.1,
  "screen-reader": 0.1,
  "low-vision": 0.1,
};

export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${String(value)}`);
}
