import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Flagsmith } from "@flagsmith/nodejs";
import { ROOT, loadConfig } from "./config.ts";
import {
  FlagsmithAdmin,
  FlagsmithAdminError,
  listResults,
  type ExperimentRecord,
} from "./flagsmith-admin.ts";
import { ensureFeature, ensureMetric, ensureTreatmentKey } from "./bootstrap.ts";
import { completeBody, experimentCreatePayload } from "./payloads.ts";

const PROBE_FLAG = "lift_pull_probe";

async function evaluate(flagName: string, identity: string) {
  const cfg = loadConfig();
  const key = cfg.serverKey || cfg.environmentKey;
  if (!key) throw new Error("server or environment key required");
  const flagsmith = new Flagsmith({
    environmentKey: key,
    apiUrl: cfg.adminApiUrl || cfg.apiUrl,
    enableLocalEvaluation: Boolean(cfg.serverKey),
  });
  try {
    const flags = await flagsmith.getIdentityFlags(identity, {
      simulated: true,
      purpose: "pull_to_control_verify",
    });
    const flag = flags.getFlag(flagName);
    const variant =
      "variant" in flag && typeof flag.variant === "string" ? flag.variant : undefined;
    const experiment =
      "experiment" in flag && flag.experiment && typeof flag.experiment === "object"
        ? flag.experiment
        : null;
    return {
      identity,
      flagName,
      variant,
      value: flag.value,
      enabled: flag.enabled,
      experiment,
    };
  } finally {
    await flagsmith.close(2000);
  }
}

async function cleanup(
  admin: FlagsmithAdmin,
  cfg: ReturnType<typeof loadConfig>,
  featureId: number,
  experimentId: number | null,
) {
  if (!cfg.environmentKey || !cfg.projectId) return;
  if (experimentId !== null) {
    try {
      const { data } = await admin.get<ExperimentRecord>(
        `/environments/${cfg.environmentKey}/experiments/${experimentId}/`,
      );
      if (data.status === "running") {
        await admin.post(
          `/environments/${cfg.environmentKey}/experiments/${experimentId}/complete/`,
          completeBody("pull_to_control", 0),
        );
      }
    } catch (err) {
      process.stderr.write(
        `cleanup complete: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  try {
    await admin.delete(`/projects/${cfg.projectId}/features/${featureId}/`);
  } catch (err) {
    process.stderr.write(
      `cleanup delete feature ${featureId}: ${err instanceof Error ? err.message : err}\n`,
    );
    try {
      await admin.patch(`/features/featurestates/?feature=${featureId}`, { enabled: false });
    } catch {
      /* last-ditch; the probe flag stays off the checkout experiment */
    }
  }
}

export async function verifyPullToControl() {
  const cfg = loadConfig();
  if (!cfg.adminToken || !cfg.environmentKey || !cfg.projectId) {
    throw new Error("Admin credentials required for pull_to_control probe");
  }
  const admin = new FlagsmithAdmin(cfg);
  const flag = await ensureFeature(
    admin,
    cfg.projectId,
    PROBE_FLAG,
    "Throwaway probe for pull_to_control SDK behaviour. Not the checkout experiment.",
    50,
  );
  const treatment = await ensureTreatmentKey(admin, cfg.projectId, flag);
  const metric = await ensureMetric(admin, cfg.environmentKey, cfg.metricEvent);

  const { data: existing } = await admin.get<unknown>(
    `/environments/${cfg.environmentKey}/experiments/?q=${encodeURIComponent(PROBE_FLAG)}`,
  );
  let experiment =
    listResults<ExperimentRecord>(existing).find((exp) => {
      const featureId = typeof exp.feature === "number" ? exp.feature : exp.feature?.id;
      return featureId === flag.id && exp.status !== "completed";
    }) ?? null;

  if (!experiment) {
    const payload = experimentCreatePayload({
      featureId: flag.id,
      treatmentId: treatment.id,
      metricId: metric.id,
      name: `Lift pull_to_control probe ${Date.now()}`,
      hypothesis: "Throwaway probe. Completing to control to observe SDK evaluation.",
    });
    try {
      experiment = (await admin.post<ExperimentRecord>(
        `/environments/${cfg.environmentKey}/experiments/`,
        payload,
      )).data;
    } catch (err) {
      if (
        err instanceof FlagsmithAdminError &&
        (err.body.includes("unicode") || err.body.includes("string"))
      ) {
        payload.experiment_rollout.feature_state_value.type = "unicode";
        experiment = (await admin.post<ExperimentRecord>(
          `/environments/${cfg.environmentKey}/experiments/`,
          payload,
        )).data;
      } else {
        throw err;
      }
    }
  }

  if (experiment.status !== "running") {
    const started = await admin.post<ExperimentRecord>(
      `/environments/${cfg.environmentKey}/experiments/${experiment.id}/start/`,
    );
    experiment = started.data;
  }

  await admin.post(
    `/environments/${cfg.environmentKey}/experiments/${experiment.id}/complete/`,
    completeBody("pull_to_control", treatment.id),
  );
  const { data: completed } = await admin.get<ExperimentRecord>(
    `/environments/${cfg.environmentKey}/experiments/${experiment.id}/`,
  );

  const identity = `lift-pull-probe-${Date.now()}`;
  const evalResult = await evaluate(PROBE_FLAG, identity);
  const payload = {
    capturedAt: new Date().toISOString(),
    experimentId: completed.id,
    experimentStatus: completed.status,
    rolloutDecision: completed.rollout_decision ?? null,
    rolloutVariant: completed.rollout_variant ?? null,
    flag: PROBE_FLAG,
    evaluation: evalResult,
  };
  const out = resolve(ROOT, "tests/fixtures/pull-to-control-eval.json");
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`Wrote ${out}\n`);
  process.stdout.write(
    `pull_to_control eval: variant=${String(evalResult.variant)} value=${String(evalResult.value)} enabled=${String(evalResult.enabled)}\n`,
  );

  await cleanup(admin, cfg, flag.id, completed.id);
  return payload;
}

async function main() {
  await verifyPullToControl();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
