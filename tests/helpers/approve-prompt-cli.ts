import { writeFileSync } from "node:fs";
import { parseArgs, flagString } from "../../selfhost/src/args.ts";
import { promptApproveLine } from "../../selfhost/src/approve.ts";

const { flags } = parseArgs(process.argv.slice(2));
const experimentId = Number(flagString(flags, "experiment-id", "0"));
const outPath = flagString(flags, "out");
const out = await promptApproveLine(experimentId, { treatment: 0.99, control: 0.01 });
if (outPath) writeFileSync(outPath, `${JSON.stringify(out)}\n`);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(out.ok ? 0 : 1);
