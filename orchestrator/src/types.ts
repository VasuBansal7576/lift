import type { PatchSpec } from "../../shared/patch-spec.ts";
import type { Persona } from "../../shared/types.ts";

export const AGENTS = [
  "conductor",
  "scanner",
  "mutator",
  "gatekeeper",
  "flag",
  "traffic",
  "analyst",
  "approval",
  "rollout",
] as const;
export type AgentName = (typeof AGENTS)[number];

export const EVENT_KINDS = [
  "start",
  "info",
  "warn",
  "pass",
  "reject",
  "wait",
  "done",
  "error",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const PHASES = [
  "idle",
  "scanning",
  "mutating",
  "gating",
  "flagging",
  "traffic",
  "analysing",
  "KEEP_COLLECTING",
  "WAITING_FOR_HUMAN_APPROVAL",
  "rolling_out",
  "complete",
  "aborted",
] as const;
export type Phase = (typeof PHASES)[number];

export interface OrchEvent {
  ts: string;
  seq: number;
  agent: AgentName;
  kind: EventKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface AxeNodeHit {
  target: string[];
  html?: string;
}

export interface AxeViolationSummary {
  id: string;
  impact: string | null;
  nodes: number;
  targets: string[][];
  help: string;
}

export interface AxeSummary {
  url: string;
  violationCount: number;
  nodeCount: number;
  ruleIds: string[];
  violations: AxeViolationSummary[];
}

export interface ScanResult {
  url: string;
  axe: AxeSummary;
}

export type CandidateKind = "template" | "llm" | "canary-reject" | "generation-2";

export interface CandidateSpec {
  spec: PatchSpec;
  kind: CandidateKind;
  title: string;
  fromRules: string[];
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

export interface GateResult {
  specId: string;
  title: string;
  kind: CandidateKind;
  spec: PatchSpec;
  apply: ApplyResult;
  baseline: AxeSummary;
  after: AxeSummary;
  passed: boolean;
  reason: string;
}

export interface FlagVariantRecord {
  key: string;
  specId: string;
  optionId: number;
  title: string;
}

export interface FlagSetup {
  dryRun: boolean;
  flagName: string;
  flagId: number;
  metricId: number;
  metricEvent: string;
  experimentId: number;
  experimentName: string;
  variants: FlagVariantRecord[];
  controlKey: string;
  dashboardUrl: string;
  usedCli: boolean;
}

export interface TrafficVisit {
  identity: string;
  persona: Persona;
  variant: string;
  converted: boolean;
  reason: string;
  simulated: true;
  at: string;
}

export interface ArmChance {
  key: string;
  chanceToWin: number;
  n: number | null;
  sum: number | null;
  lift: number | null;
}

export type AnalystRecommendation =
  | {
      kind: "winner";
      arm: string;
      chanceToWin: number;
      threshold: number;
      arms: ArmChance[];
      source: "flagsmith" | "none";
    }
  | {
      kind: "keep_collecting";
      leading?: string;
      chanceToWin?: number;
      threshold: number;
      arms: ArmChance[];
      source: "flagsmith" | "none";
      reason: string;
    };

export interface GenerationRecord {
  generation: number;
  scan: ScanResult;
  candidates: CandidateSpec[];
  gated: GateResult[];
  passed: GateResult[];
  rejected: GateResult[];
  controlSpec: PatchSpec | null;
  flag?: FlagSetup;
  visits?: TrafficVisit[];
  recommendation?: AnalystRecommendation;
}

export interface TimeSaved {
  wallClockMs: number;
  manualEstimateMs: number;
  savedMs: number;
  manualEstimateMinutes: number;
}

export interface PersistedState {
  phase: Phase;
  siteUrl: string;
  flagName: string;
  metricEvent: string;
  threshold: number;
  generations: GenerationRecord[];
  events: OrchEvent[];
  recommendation?: AnalystRecommendation;
  flag?: FlagSetup;
  timeSaved?: TimeSaved;
  dashboardExperimentUrl?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface OrchOptions {
  apply: boolean;
  approve: boolean;
  approveExperimentId: number | null;
  resultsExperimentId: number | null;
  cleanup: boolean;
  allowRemote: boolean;
  generations: number;
  fromGeneration: number;
  siteUrl: string;
  uiPort: number;
  trafficN: number;
  threshold: number;
  flagName: string;
  metricEvent: string;
  keepUi: boolean;
  noUi: boolean;
  resultsWaitMs: number;
  apiUrl: string;
  adminApiUrl: string;
  eventsUrl: string;
  dashboardUrl: string;
  environmentKey: string;
  serverKey: string;
  adminToken: string;
  projectId: string;
  organisationId: string;
  environmentId: string;
}

export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${String(value)}`);
}
