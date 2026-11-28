import { writeFileSync } from "node:fs";
import { bootstrapSelfhost } from "../selfhost/src/bootstrap.ts";
import { generateBootstrapPassword, readEnvFile, type SelfhostEnv } from "../selfhost/src/env.ts";
import { PROOF_ENV_FILE } from "../selfhost/src/paths.ts";
import { printJson, redactSecrets } from "../selfhost/src/redact.ts";

const origin = process.env.FLAGSMITH_PROOF_ORIGIN ?? "http://127.0.0.1:8010";
process.stderr.write(`bootstrap start ${origin}\n`);
const proof = readEnvFile(PROOF_ENV_FILE);
const cfg: SelfhostEnv = {
  apiUrl: `${origin}/api/v1/`,
  adminApiUrl: `${origin}/api/v1/`,
  eventsUrl: `${origin}/api/`,
  dashboardUrl: origin,
  cliApiUrl: origin,
  environmentKey: "",
  serverKey: "",
  adminToken: "",
  organisationId: "",
  projectId: "",
  environmentId: "",
  environmentName: proof.FLAGSMITH_ENVIRONMENT_NAME || "Development",
  bootstrapEmail: proof.FLAGSMITH_BOOTSTRAP_EMAIL || "admin@lift.local",
  bootstrapPassword: proof.FLAGSMITH_BOOTSTRAP_PASSWORD || generateBootstrapPassword(),
  bootstrapFirstName: "Lift",
  bootstrapLastName: "Admin",
  orgName: proof.FLAGSMITH_ORG_NAME || "Lift",
  projectName: proof.FLAGSMITH_PROJECT_NAME || "Lift",
};

const boot = await bootstrapSelfhost(cfg, {
  origin,
  envFile: PROOF_ENV_FILE,
  persistSharedState: false,
  writeRootEnv: false,
  freshInstance: true,
});
writeFileSync("/tmp/lift-proof-bootstrap.json", `${redactSecrets(JSON.stringify(boot, null, 2))}\n`);
printJson({
  ok: boot.ok,
  origin: boot.origin,
  health: boot.health,
  version: boot.version,
  wroteEnv: boot.wroteEnv,
  reason: boot.reason,
});
if (!boot.ok) process.exit(1);
