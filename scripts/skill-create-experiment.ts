import { parseArgs, flagString } from "../selfhost/src/args.ts";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson } from "../selfhost/src/redact.ts";
import {
  createExperimentViaApi,
  guardApply,
  mutationContext,
} from "../selfhost/src/skill-ops.ts";

const { flags } = parseArgs(process.argv.slice(2));
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
const created = await createExperimentViaApi(lift, ctx, {
  flagName: flagString(flags, "flag", "lift_a11y_skill"),
  event: flagString(flags, "event", "lift_a11y_completed"),
  hypothesis: flagString(flags, "hypothesis", "Fixing axe violations raises conversions."),
  experimentName: flagString(flags, "name", "lift a11y skill"),
});
printJson(created);
if (created.ok === false) process.exit(1);
