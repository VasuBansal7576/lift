import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Flagsmith } from "@flagsmith/nodejs";
import { barrierFlagMap, getSite, type SiteDef } from "../../shared/catalog.ts";
import {
  type LiftConfig,
  ROOT,
  loadConfig,
  readJson,
  statePath,
} from "./config.ts";
import {
  FlagsmithAdmin,
  FlagsmithAdminError,
  type EnvironmentRecord,
  type ExperimentRecord,
  type FeatureOption,
  type FeatureRecord,
  type MetricRecord,
  type WarehouseRecord,
  listResults,
} from "./flagsmith-admin.ts";
import {
  experimentCreatePayload,
  featureCreatePayload,
  metricCreatePayload,
  warehouseCloudBody,
  warehouseSelfHostBody,
} from "./payloads.ts";

export interface BootstrapState {
  organisationId: number | string;
  projectId: number | string;
  environmentId: number | string;
  environmentKey: string;
  flagName: string;
  flagId: number;
  treatmentOptionId: number;
  metricId: number;
  experimentId: number;
  warehouseId?: number;
  warehouseStatus?: string;
  barrierFlags: { name: string; id: number }[];
  siteId: string;
  createdAt: string;
}

export const WAREHOUSE_FIRST_EVENT_HINT =
  "Cloud: app.flagsmith.com → project Lift → environment Development → Environment Settings → Warehouse → click “Send your first event”. Self-host: Environment Settings → Warehouse → Flagsmith database → Send your first event.";

async function findFeature(
  admin: FlagsmithAdmin,
  projectId: string,
  name: string,
): Promise<FeatureRecord | null> {
  const { data } = await admin.get<unknown>(
    `/projects/${projectId}/features/?search=${encodeURIComponent(name)}`,
  );
  return listResults<FeatureRecord>(data).find((f) => f.name === name) ?? null;
}

export async function ensureFeature(
  admin: FlagsmithAdmin,
  projectId: string,
  name: string,
  description: string,
  treatmentAllocation: number,
): Promise<FeatureRecord> {
  const existing = await findFeature(admin, projectId, name);
  if (existing) return existing;

  const { data } = await admin.post<FeatureRecord>(
    `/projects/${projectId}/features/`,
    featureCreatePayload(name, description, treatmentAllocation),
  );
  return data;
}

export async function ensureTreatmentKey(
  admin: FlagsmithAdmin,
  projectId: string,
  feature: FeatureRecord,
): Promise<FeatureOption> {
  const { data } = await admin.get<unknown>(
    `/projects/${projectId}/features/${feature.id}/mv-options/`,
  );
  const options = listResults<FeatureOption>(data);
  const treatment =
    options.find((o) => o.string_value === "treatment") ?? options[0];
  if (!treatment) {
    throw new Error(`Feature ${feature.name} has no multivariate option`);
  }
  if (treatment.key !== "treatment") {
    await admin.put(
      `/projects/${projectId}/features/${feature.id}/mv-options/${treatment.id}/`,
      {
        id: treatment.id,
        type: treatment.type ?? "unicode",
        string_value: treatment.string_value ?? "treatment",
        default_percentage_allocation: treatment.default_percentage_allocation ?? 50,
        key: "treatment",
        feature: feature.id,
      },
    );
    const { data: refreshed } = await admin.get<unknown>(
      `/projects/${projectId}/features/${feature.id}/mv-options/`,
    );
    const verified = listResults<FeatureOption>(refreshed).find(
      (o) => o.id === treatment.id,
    );
    if (verified?.key !== "treatment") {
      throw new Error(
        `Variant key for ${feature.name} is "${verified?.key ?? treatment.key}", not "treatment". Exposures will not record. PUT the full mv-option with key:"treatment" and retry.`,
      );
    }
    treatment.key = "treatment";
  }
  return treatment;
}

async function tryCreateWarehouse(
  admin: FlagsmithAdmin,
  envKey: string,
  body: Record<string, unknown>,
): Promise<WarehouseRecord | null> {
  try {
    const created = await admin.post<WarehouseRecord>(
      `/environments/${envKey}/warehouse-connections/`,
      body,
    );
    return created.data;
  } catch (err) {
    if (err instanceof FlagsmithAdminError) {
      process.stderr.write(
        `Warehouse ${JSON.stringify(body.warehouse_type)} not created (${err.status}): ${err.body.slice(0, 240)}\n`,
      );
      return null;
    }
    throw err;
  }
}

export function warehouseWarning(status: string | undefined): string {
  return `Warehouse status is "${status ?? "unknown"}" (need connected). ${WAREHOUSE_FIRST_EVENT_HINT}`;
}

async function pingWarehouse(
  admin: FlagsmithAdmin,
  envKey: string,
  warehouse: WarehouseRecord,
  cfg: LiftConfig,
): Promise<void> {
  const pingPaths = [
    `/environments/${envKey}/warehouse-connections/${warehouse.id}/test-warehouse-connection/`,
    `/environments/${envKey}/warehouse-connections/test-warehouse-connection/`,
  ];
  for (const path of pingPaths) {
    try {
      await admin.post(path);
      process.stderr.write("Posted a Flagsmith warehouse test event (Send your first event equivalent).\n");
      break;
    } catch (err) {
      if (err instanceof FlagsmithAdminError) {
        process.stderr.write(
          `test-warehouse-connection ${err.status}: ${err.body.slice(0, 200)}\n`,
        );
        continue;
      }
      throw err;
    }
  }
  const key = cfg.serverKey || cfg.environmentKey;
  if (!key) return;
  const flagsmith = new Flagsmith({
    environmentKey: key,
    apiUrl: cfg.adminApiUrl || cfg.apiUrl,
    enableEvents: true,
    eventProcessorConfig: { eventsApiUrl: cfg.eventsUrl },
  });
  flagsmith.trackEvent("lift_warehouse_ping", {
    identifier: "lift-warehouse-ping",
    traits: { simulated: true, purpose: "warehouse_connect" },
  });
  await flagsmith.flushEvents();
  await flagsmith.close(5000);
}

export async function ensureWarehouse(
  admin: FlagsmithAdmin,
  envKey: string,
  apiUrl: string,
  cfg: LiftConfig,
): Promise<WarehouseRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/warehouse-connections/`,
  );
  const existing = Array.isArray(data)
    ? (data as WarehouseRecord[])
    : listResults<WarehouseRecord>(data);
  let warehouse = existing[0];

  if (!warehouse) {
    const cloud = /flagsmith\.com/i.test(apiUrl);
    const attempts = cloud
      ? [warehouseCloudBody(), warehouseSelfHostBody()]
      : [warehouseSelfHostBody(), warehouseCloudBody()];
    for (const body of attempts) {
      const created = await tryCreateWarehouse(admin, envKey, body);
      if (created) {
        warehouse = created;
        break;
      }
    }
  }

  if (!warehouse) {
    throw new Error(
      `No warehouse connection. Experiments cannot be created without one. ${WAREHOUSE_FIRST_EVENT_HINT} See https://docs.flagsmith.com/experimentation/connect-a-warehouse`,
    );
  }

  if (warehouse.status === "errored") {
    throw new Error(
      `Warehouse is Errored (${warehouse.status}). Fix the connection in Environment Settings → Warehouse. ${WAREHOUSE_FIRST_EVENT_HINT}`,
    );
  }

  if (warehouse.status !== "connected") {
    process.stderr.write(`${warehouseWarning(warehouse.status)}\n`);
    await pingWarehouse(admin, envKey, warehouse, cfg);
  }

  return warehouse;
}

export async function ensureMetric(
  admin: FlagsmithAdmin,
  envKey: string,
  event: string,
): Promise<MetricRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/experiment-metrics/`,
  );
  const existing = listResults<MetricRecord>(data).find(
    (m) => m.definition?.event === event,
  );
  if (existing) return existing;
  const created = await admin.post<MetricRecord>(
    `/environments/${envKey}/experiment-metrics/`,
    metricCreatePayload(event),
  );
  return created.data;
}

async function ensureExperiment(
  admin: FlagsmithAdmin,
  envKey: string,
  flag: FeatureRecord,
  treatmentId: number,
  metricId: number,
  name: string,
  hypothesis: string,
): Promise<ExperimentRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/experiments/?q=${encodeURIComponent(flag.name)}`,
  );
  const existing = listResults<ExperimentRecord>(data).find((exp) => {
    const featureId = typeof exp.feature === "number" ? exp.feature : exp.feature?.id;
    return featureId === flag.id && exp.status !== "completed";
  });
  if (existing) return existing;

  const payload = experimentCreatePayload({
    featureId: flag.id,
    treatmentId,
    metricId,
    name,
    hypothesis,
  });

  try {
    const created = await admin.post<ExperimentRecord>(
      `/environments/${envKey}/experiments/`,
      payload,
    );
    return created.data;
  } catch (err) {
    if (
      err instanceof FlagsmithAdminError &&
      (err.body.includes("unicode") || err.body.includes("string"))
    ) {
      payload.experiment_rollout.feature_state_value.type = "unicode";
      const created = await admin.post<ExperimentRecord>(
        `/environments/${envKey}/experiments/`,
        payload,
      );
      return created.data;
    }
    throw err;
  }
}

async function startExperiment(
  admin: FlagsmithAdmin,
  envKey: string,
  experiment: ExperimentRecord,
): Promise<ExperimentRecord> {
  if (experiment.status === "running") return experiment;
  const started = await admin.post<ExperimentRecord>(
    `/environments/${envKey}/experiments/${experiment.id}/start/`,
  );
  return started.data;
}

export function writeSiteConfig(cfg: LiftConfig, site: SiteDef = getSite(cfg.siteId)) {
  const config = {
    site: site.id,
    flagsmithApiUrl: cfg.apiUrl,
    flagsmithEventsUrl: cfg.eventsUrl,
    flagsmithEnvironmentKey: cfg.environmentKey,
    flagName: cfg.flagName,
    metricEvent: cfg.metricEvent,
    allowMock: cfg.allowMock,
    simulatedTrafficLabel: "SIMULATED TRAFFIC",
    barrierFlags: site.barriers.map((b) => b.flag),
    barrierFlagMap: barrierFlagMap(site),
  };
  writeFileSync(
    resolve(ROOT, site.dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

export function writeCheckoutConfig(cfg: LiftConfig) {
  writeSiteConfig(cfg, getSite("checkout"));
}

export async function bootstrap(cfg = loadConfig()): Promise<BootstrapState> {
  if (!cfg.adminToken) {
    throw new Error(
      "FLAGSMITH_ADMIN_API_TOKEN is required. Create one in Organisation Settings > API Access.",
    );
  }
  if (!cfg.projectId || !cfg.environmentKey) {
    throw new Error(
      "FLAGSMITH_PROJECT_ID and FLAGSMITH_ENVIRONMENT_KEY are required (cloud Lift project is 56470).",
    );
  }

  const admin = new FlagsmithAdmin(cfg);
  const envKey = cfg.environmentKey;

  let environmentId = cfg.environmentId;
  if (!environmentId) {
    const { data } = await admin.get<unknown>(
      `/projects/${cfg.projectId}/environments/`,
    );
    const envs = listResults<EnvironmentRecord>(data);
    const match =
      envs.find((e) => e.api_key === envKey) ??
      envs.find((e) => e.name === cfg.environmentName) ??
      envs[0];
    if (!match) throw new Error("No Flagsmith environment found");
    environmentId = String(match.id);
  }

  const warehouse = await ensureWarehouse(admin, envKey, cfg.apiUrl, cfg);

  const site = getSite(cfg.siteId);
  const combined = await ensureFeature(
    admin,
    cfg.projectId,
    cfg.flagName,
    `Combined accessibility treatment for ${site.name}. control = baked-in WCAG barriers, treatment = Kane-style fixes.`,
    50,
  );
  const treatment = await ensureTreatmentKey(admin, cfg.projectId, combined);

  const barrierFlags: { name: string; id: number }[] = [];
  for (const barrier of site.barriers) {
    const feature = await ensureFeature(
      admin,
      cfg.projectId,
      barrier.flag,
      `${barrier.title}. ${barrier.control} / ${barrier.treatment}`,
      0,
    );
    await ensureTreatmentKey(admin, cfg.projectId, feature);
    barrierFlags.push({ name: feature.name, id: feature.id });
  }

  const metric = await ensureMetric(admin, envKey, cfg.metricEvent);
  const experiment = await ensureExperiment(
    admin,
    envKey,
    combined,
    treatment.id,
    metric.id,
    `${site.name} accessibility lift (${cfg.trafficRunId})`,
    site.hypothesis,
  );
  const running = await startExperiment(admin, envKey, experiment);
  if (running.status !== "running") {
    throw new Error(`Experiment ${running.id} status is ${running.status}, expected running`);
  }

  const state: BootstrapState = {
    organisationId: cfg.organisationId || "",
    projectId: cfg.projectId,
    environmentId,
    environmentKey: envKey,
    flagName: combined.name,
    flagId: combined.id,
    treatmentOptionId: treatment.id,
    metricId: metric.id,
    experimentId: running.id,
    warehouseId: warehouse.id,
    warehouseStatus: warehouse.status,
    barrierFlags,
    siteId: site.id,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(statePath(site.id), `${JSON.stringify(state, null, 2)}\n`);
  writeSiteConfig(cfg, site);
  return state;
}

/** Reuse a running experiment from disk; bootstrap a new one if it is missing or completed. */
export async function loadRunningState(cfg = loadConfig()): Promise<BootstrapState> {
  const existing = readJson<BootstrapState>(statePath(cfg.siteId));
  if (!existing) return bootstrap(cfg);
  if (!cfg.adminToken || !cfg.environmentKey) {
    throw new Error(
      "FLAGSMITH_ADMIN_API_TOKEN and FLAGSMITH_ENVIRONMENT_KEY are required to load experiment state.",
    );
  }
  const admin = new FlagsmithAdmin(cfg);
  try {
    const { data } = await admin.get<ExperimentRecord>(
      `/environments/${cfg.environmentKey}/experiments/${existing.experimentId}/`,
    );
    if (data.status === "running") return existing;
    process.stderr.write(
      `Stored experiment ${existing.experimentId} is ${data.status}; creating a new experiment.\n`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Stored experiment ${existing.experimentId} is not readable (${detail.slice(0, 160)}); bootstrapping.\n`,
    );
  }
  return bootstrap(cfg);
}

async function main() {
  const state = await bootstrap();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
