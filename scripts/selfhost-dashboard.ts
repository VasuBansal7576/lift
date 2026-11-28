import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv, publicEnvSummary } from "../selfhost/src/env.ts";
import { DASHBOARD_DIR } from "../selfhost/src/paths.ts";
import { serveDir } from "../selfhost/src/static-server.ts";

const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : 4175);

async function flagsJson(): Promise<string> {
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  const flags = await lift.listFlags();
  return JSON.stringify({
    ...publicEnvSummary(env),
    flags,
  });
}

const server = await serveDir(DASHBOARD_DIR, port, {
  "/flags.json": flagsJson,
});
process.stdout.write(`Self-host dashboard ${server.url}\n`);
