import { parseArgs, flagString } from "../selfhost/src/args.ts";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson } from "../selfhost/src/redact.ts";
import {
  assertApprovalCommand,
  guardApply,
  mutationContext,
  rolloutWinner,
} from "../selfhost/src/skill-ops.ts";

const { flags } = parseArgs(process.argv.slice(2));
const mixed = assertApprovalCommand(flags);
if (mixed.ok === false) {
  printJson({ step: "guard", ...mixed });
  process.exit(1);
}
const env = loadSelfhostEnv();
const lift = createLiftSelfhost(env);
const ctx = mutationContext(flags, lift);
if (ctx.apply) {
  const plan = guardApply(ctx);
  if (plan.ok === false) {
    printJson({ step: "guard", ...plan });
    process.exit(1);
  }
}
const experimentIdRaw = flagString(flags, "experiment-id");
const out = await rolloutWinner(lift, ctx, {
  flagName: flagString(flags, "flag", "lift_a11y_skill"),
  experimentId: experimentIdRaw ? Number(experimentIdRaw) : undefined,
  treatmentOptionId: flagString(flags, "treatment-id")
    ? Number(flagString(flags, "treatment-id"))
    : undefined,
});
printJson(out);
if (out.waiting) process.exit(3);
if (out.ok === false) process.exit(1);
