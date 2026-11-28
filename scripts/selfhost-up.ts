import { writeFileSync } from "node:fs";
import { parseArgs, flagBool } from "../selfhost/src/args.ts";
import { bootstrapSelfhost } from "../selfhost/src/bootstrap.ts";
import { composePs, composeUp, requireDocker, waitHttpOk } from "../selfhost/src/docker.ts";
import { COMPOSE_ORIGIN, composeLocalEnv, ensureComposeSecrets } from "../selfhost/src/env.ts";
import { PROOF_LOG } from "../selfhost/src/paths.ts";
import { printJson, redactSecrets } from "../selfhost/src/redact.ts";

const { flags } = parseArgs(process.argv.slice(2));

function fail(payload: Record<string, unknown>): never {
  printJson({ ok: false, ...payload });
  process.exit(1);
}

try {
  ensureComposeSecrets();
  const docker = await requireDocker();
  if (docker.ok === false) fail({ step: "docker", reason: docker.reason });

  const up = await composeUp();
  if (up.code !== 0) {
    fail({ step: "compose", stderr: up.stderr, stdout: up.stdout });
  }

  await waitHttpOk(`${COMPOSE_ORIGIN}/health/liveness/`);
  const ps = await composePs();
  const boot = await bootstrapSelfhost(composeLocalEnv(), {
    writeRootEnv: flagBool(flags, "write-root-env"),
  });
  if (boot.ok === false) fail({ step: "bootstrap", ...boot });
  writeFileSync(PROOF_LOG, `${redactSecrets(JSON.stringify(boot, null, 2))}\n`);
  printJson({
    ok: true,
    origin: COMPOSE_ORIGIN,
    compose: { code: up.code },
    ps,
    bootstrap: boot,
  });
} catch (err) {
  fail({
    step: "selfhost-up",
    reason: err instanceof Error ? err.message : String(err),
  });
}
