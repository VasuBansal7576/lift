import { parseArgs, flagString } from "../selfhost/src/args.ts";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson } from "../selfhost/src/redact.ts";

const { flags, rest } = parseArgs(process.argv.slice(2));
const name = flagString(flags, "flag", "checkout_a11y");
const percent = Number(flagString(flags, "percent", rest[0] ?? "100"));
const lift = createLiftSelfhost(loadSelfhostEnv());
const result = await lift.setTreatmentWeight(name, percent);
const flag = await lift.getFlag(name);
printJson({ ...result, flag });
