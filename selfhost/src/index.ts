/**
 * Lift self-hosted Flagsmith module.
 *
 * ```ts
 * import {
 *   loadSelfhostEnv,
 *   createLiftSelfhost,
 *   compareAxeGate,
 *   assertSafeToMutate,
 * } from "./index.ts";
 *
 * const env = loadSelfhostEnv();
 * const lift = createLiftSelfhost(env);
 * const flags = await lift.listManagedFlags();
 * await lift.setTreatmentWeight("checkout_a11y", 100);
 * ```
 */
export {
  loadSelfhostEnv,
  composeLocalEnv,
  publicEnvSummary,
  splitApiUrl,
  COMPOSE_ORIGIN,
  ensureComposeSecrets,
  type SelfhostEnv,
} from "./env.ts";
export {
  createLiftSelfhost,
  LiftSelfhost,
  isTreatmentKey,
  isTreatmentOption,
  optionKeyOf,
  type SelfhostOptions,
  type HealthStatus,
  type FeatureRecord,
  type ExperimentRecord,
} from "./client.ts";
export {
  parseSdkFlags,
  flagStatus,
  isManagedFlagName,
  type LiftFlag,
  type LiftFlagVariant,
  type LiftFlagStatus,
} from "./flags.ts";
export { compareAxeGate, type AxeViolationSummary, type GateResult } from "./axe-gate.ts";
export {
  assertSafeToMutate,
  isProductionEnvironmentName,
  isLoopbackUrl,
  wantApply,
  wantConfirmProd,
  wantAllowRemote,
  type SafetyDecision,
} from "./safety.ts";
export { redactSecrets, maskKey, printJson } from "./redact.ts";
export {
  writeSiteConfigForSelfhost,
  siteConfigFromEnv,
  selfhostSiteConfigPath,
  type SiteConfigFile,
} from "./site-config.ts";
export { bootstrapSelfhost, type BootstrapResult } from "./bootstrap.ts";
export { serveDir, type ExtraRoutes } from "./static-server.ts";
export { parseArgs, flagString, flagBool, type FlagMap } from "./args.ts";
export {
  planOrRefuse,
  guardApply,
  createFlagViaCliOrApi,
  createExperimentViaApi,
  startExperimentViaApi,
  rolloutWinner,
  cleanupStaleFlags,
  recordedFlagsFromLastRun,
  gateFromSummaries,
  mutationContext,
  assertServedVariants,
  assertApprovalCommand,
  assertApprovalTarget,
  canReuseExistingFlag,
  runningExperimentForFeature,
  shouldDeleteRecorded,
  type RecordedFlag,
} from "./skill-ops.ts";
export {
  expectedApprovalLine,
  parseApprovalLine,
  promptApproveLine,
  readTtyLine,
} from "./approve.ts";
export {
  pickRolloutFromResults,
  chanceByArm,
  asResultsEnvelope,
  resultsPresent,
  CHANCE_TO_WIN_THRESHOLD,
} from "./results.ts";
