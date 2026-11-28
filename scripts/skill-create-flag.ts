import { parseArgs, flagBool, flagString } from "../selfhost/src/args.ts";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson } from "../selfhost/src/redact.ts";
import { createFlagViaCliOrApi, guardApply, mutationContext } from "../selfhost/src/skill-ops.ts";

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
const out = await createFlagViaCliOrApi(
  lift,
  ctx,
  flagString(flags, "name", "lift_a11y_skill"),
  flagString(flags, "description", "A11y experiment treatment"),
  { reuseFlag: flagBool(flags, "reuse-flag") },
);
printJson(out);
if (out.ok === false) process.exit(1);
