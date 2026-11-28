import { AdminHttp, listResults, type FetchFn } from "./http.ts";
import { parseSdkFlags, type LiftFlag } from "./flags.ts";
import type { SelfhostEnv } from "./env.ts";
import { flagsmithApi, runFlagsmith, type CliResult } from "./cli.ts";

export interface SelfhostOptions {
  apiUrl: string;
  adminApiUrl?: string;
  eventsUrl?: string;
  dashboardUrl?: string;
  cliApiUrl?: string;
  environmentKey: string;
  adminToken?: string;
  serverKey?: string;
  projectId?: string;
  environmentId?: string;
  environmentName?: string;
  fetchImpl?: FetchFn;
}

export interface HealthStatus {
  ok: boolean;
  url: string;
  status: number;
}

export interface MvOptionRecord {
  id: number;
  type?: string;
  string_value?: string | null;
  default_percentage_allocation?: number;
  key?: string | null;
  feature?: number;
}

export interface FeatureRecord {
  id: number;
  name: string;
  type?: string;
  multivariate_options?: Array<{
    id: number;
    key?: string | null;
    string_value?: string | null;
    default_percentage_allocation?: number;
  }>;
}

export function isTreatmentKey(key: string | null | undefined): boolean {
  return String(key ?? "").trim() === "treatment";
}

export function isTreatmentOption(option: {
  key?: string | null;
  string_value?: string | null;
}): boolean {
  if (isTreatmentKey(option.key)) return true;
  return String(option.string_value ?? "").trim() === "treatment";
}

export function optionKeyOf(
  option: number | { id: number; string_value?: string; key?: string },
  keysById: Map<number, string>,
): string {
  if (typeof option === "number") return (keysById.get(option) ?? "").trim();
  const fromObj = String(option.key ?? "").trim();
  if (fromObj) return fromObj;
  return (keysById.get(option.id) ?? "").trim();
}

export interface ExperimentRecord {
  id: number;
  name: string;
  status: string;
  feature?: number | { id: number };
}

/**
 * Reusable Lift ↔ self-hosted Flagsmith client.
 *
 * ```ts
 * import { createLiftSelfhost, loadSelfhostEnv } from "./index.ts";
 * const lift = createLiftSelfhost(loadSelfhostEnv());
 * const flags = await lift.listFlags();
 * await lift.setTreatmentWeight("checkout_a11y", 100); // 100% treatment
 * ```
 */
export class LiftSelfhost {
  readonly apiUrl: string;
  readonly adminApiUrl: string;
  readonly cliApiUrl: string;
  readonly eventsUrl: string;
  readonly environmentKey: string;
  readonly environmentName: string;
  readonly projectId: string;
  readonly adminToken: string;
  private readonly admin?: AdminHttp;
  private readonly fetchImpl: FetchFn;

  constructor(opts: SelfhostOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/?$/, "/");
    this.adminApiUrl = (opts.adminApiUrl || opts.apiUrl).replace(/\/?$/, "/");
    this.cliApiUrl = (opts.cliApiUrl || this.adminApiUrl.replace(/\/api\/v1\/$/i, "")).replace(/\/+$/, "");
    this.eventsUrl = (opts.eventsUrl || `${this.cliApiUrl}/api/`).replace(/\/?$/, "/");
    this.environmentKey = opts.environmentKey;
    this.environmentName = opts.environmentName ?? "Development";
    this.projectId = opts.projectId ?? "";
    this.adminToken = opts.adminToken ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (this.adminToken) {
      this.admin = new AdminHttp(this.adminApiUrl, this.adminToken, this.fetchImpl);
    }
  }

  private requireAdmin(): AdminHttp {
    if (!this.admin) throw new Error("FLAGSMITH_ADMIN_API_TOKEN is required");
    return this.admin;
  }

  async health(): Promise<HealthStatus> {
    const origin = this.cliApiUrl || this.apiUrl.replace(/\/api\/v1\/$/i, "");
    const url = `${origin.replace(/\/+$/, "")}/health/liveness/`;
    try {
      const res = await this.fetchImpl(url);
      return { ok: res.ok, url, status: res.status };
    } catch {
      return { ok: false, url, status: 0 };
    }
  }

  async listFlags(): Promise<LiftFlag[]> {
    const url = new URL("flags/", this.apiUrl);
    const res = await this.fetchImpl(url, {
      headers: {
        "X-Environment-Key": this.environmentKey,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET flags -> ${res.status}: ${text.slice(0, 400)}`);
    const sdk = parseSdkFlags(JSON.parse(text) as unknown);
    if (!this.admin || !this.projectId) return sdk;
    try {
      const states = listResults<Record<string, unknown>>(
        await this.admin.get(`/environments/${this.environmentKey}/featurestates/`),
      );
      const byName = new Map(sdk.map((f) => [f.name, f]));
      const extra = parseSdkFlags(
        states.map((row) => {
          const feature = row.feature;
          const name =
            feature && typeof feature === "object"
              ? String((feature as { name?: string }).name ?? "")
              : "";
          const sdkRow = byName.get(name);
          return {
            ...row,
            feature:
              feature && typeof feature === "object"
                ? { ...(feature as object), type: sdkRow?.type ?? (feature as { type?: string }).type }
                : { name, type: sdkRow?.type ?? "MULTIVARIATE" },
          };
        }),
      );
      const merged = new Map(sdk.map((f) => [f.name, f]));
      for (const flag of extra) merged.set(flag.name, { ...merged.get(flag.name), ...flag, type: merged.get(flag.name)?.type ?? flag.type });
      return [...merged.values()];
    } catch {
      return sdk;
    }
  }

  async listManagedFlags(): Promise<LiftFlag[]> {
    return (await this.listFlags()).filter((f) => f.managed);
  }

  async getFlag(name: string): Promise<LiftFlag | null> {
    return (await this.listFlags()).find((f) => f.name === name) ?? null;
  }

  async findFeature(name: string): Promise<FeatureRecord | null> {
    const admin = this.requireAdmin();
    const data = await admin.get<unknown>(
      `/projects/${this.projectId}/features/?search=${encodeURIComponent(name)}`,
    );
    return listResults<FeatureRecord>(data).find((f) => f.name === name) ?? null;
  }

  async createMultivariateFlag(name: string, description: string): Promise<FeatureRecord> {
    const existing = await this.findFeature(name);
    if (existing) {
      await this.ensureTreatmentKey(existing);
      return existing;
    }
    const created = await this.requireAdmin().post<FeatureRecord>(`/projects/${this.projectId}/features/`, {
      name,
      default_enabled: true,
      initial_value: "control",
      description,
      type: "MULTIVARIATE",
      multivariate_options: [
        {
          type: "unicode",
          string_value: "treatment",
          default_percentage_allocation: 0,
          key: "treatment",
        },
      ],
    });
    await this.ensureTreatmentKey(created);
    return created;
  }

  async listMvOptions(featureId: number): Promise<MvOptionRecord[]> {
    const data = await this.requireAdmin().get<unknown>(
      `/projects/${this.projectId}/features/${featureId}/mv-options/`,
    );
    return listResults<MvOptionRecord>(data);
  }

  async ensureTreatmentKey(feature: FeatureRecord): Promise<void> {
    const admin = this.requireAdmin();
    const options = await this.listMvOptions(feature.id);
    const treatment = options.find((o) => isTreatmentOption(o));
    if (!treatment) {
      const added = await runFlagsmith(
        [
          "feature",
          "variant",
          "add",
          feature.name,
          "--key",
          "treatment",
          "--value",
          "treatment",
          "--weight",
          "0",
          "--json",
          "--no-input",
          "--yes",
        ],
        {
          apiUrl: this.cliApiUrl,
          apiKey: this.adminToken,
          project: this.projectId,
        },
      );
      if (!added.ok) {
        throw new Error(`variant add failed: ${added.stderr || added.stdout}`);
      }
      const created = (await this.listMvOptions(feature.id)).find((o) => isTreatmentOption(o));
      if (!created || created.key !== "treatment") {
        throw new Error("variant add did not set key=treatment");
      }
      return;
    }
    if (treatment.key === "treatment") return;
    await admin.put(`/projects/${this.projectId}/features/${feature.id}/mv-options/${treatment.id}/`, {
      id: treatment.id,
      type: treatment.type ?? "unicode",
      string_value: treatment.string_value ?? "treatment",
      default_percentage_allocation: treatment.default_percentage_allocation ?? 0,
      key: "treatment",
      feature: feature.id,
    });
    const keyed = (await this.listMvOptions(feature.id)).find((o) => o.id === treatment.id);
    if (keyed?.key !== "treatment") {
      throw new Error("variant update did not set key=treatment");
    }
  }

  async setTreatmentWeight(flagName: string, percent: number): Promise<{ via: "cli" | "admin_api"; flag: string; percent: number }> {
    const weight = Math.max(0, Math.min(100, percent));
    const feature = await this.findFeature(flagName);
    if (feature) await this.ensureTreatmentKey(feature);
    const cli = await runFlagsmith(
      ["flag", "update", flagName, "--weight", `treatment=${weight}`, "--json", "--no-input", "--yes"],
      {
        apiUrl: this.cliApiUrl,
        apiKey: this.adminToken,
        project: this.projectId,
        environment: this.environmentKey,
      },
    );
    const via: "cli" | "admin_api" = cli.ok ? "cli" : "admin_api";
    if (via !== "cli") await this.setTreatmentWeightAdmin(flagName, weight);
    await this.assertTreatmentWeight(flagName, weight);
    return { via, flag: flagName, percent: weight };
  }

  async readTreatmentWeight(flagName: string): Promise<number | null> {
    const feature = await this.findFeature(flagName);
    if (!feature) return null;
    const admin = this.requireAdmin();
    const data = await admin.get<unknown>(
      `/environments/${this.environmentKey}/featurestates/?feature=${feature.id}`,
    );
    const states = listResults<{
      multivariate_feature_state_values?: Array<{
        percentage_allocation?: number;
        multivariate_feature_option: number | { id: number; string_value?: string; key?: string };
      }>;
    }>(data);
    const keysById = new Map(
      (await this.listMvOptions(feature.id)).map((opt) => [opt.id, String(opt.key ?? "").trim()]),
    );
    for (const row of states[0]?.multivariate_feature_state_values ?? []) {
      const key = optionKeyOf(row.multivariate_feature_option, keysById);
      if (isTreatmentKey(key)) return Number(row.percentage_allocation ?? 0);
    }
    return null;
  }

  async assertTreatmentWeight(flagName: string, expected: number): Promise<void> {
    const actual = await this.readTreatmentWeight(flagName);
    if (actual === null || Math.abs(actual - expected) > 0.51) {
      throw new Error(
        `treatment weight mismatch on ${flagName}: expected ${expected} got ${actual}`,
      );
    }
  }

  private async setTreatmentWeightAdmin(flagName: string, percent: number): Promise<void> {
    const feature = await this.findFeature(flagName);
    if (!feature) throw new Error(`Feature ${flagName} not found`);
    const admin = this.requireAdmin();
    const envKey = this.environmentKey;
    const data = await admin.get<unknown>(
      `/environments/${envKey}/featurestates/?feature=${feature.id}`,
    );
    const states = listResults<{
      id: number;
      multivariate_feature_state_values?: Array<{
        id: number;
        multivariate_feature_option: number | { id: number; string_value?: string; key?: string };
      }>;
    }>(data);
    const state = states[0];
    if (!state) throw new Error(`No feature state for ${flagName}`);
    const keysById = new Map(
      (await this.listMvOptions(feature.id)).map((opt) => [opt.id, String(opt.key ?? "").trim()]),
    );
    const mv = (state.multivariate_feature_state_values ?? []).map((row) => {
      const option = row.multivariate_feature_option;
      const optionId = typeof option === "number" ? option : option.id;
      const key = optionKeyOf(option, keysById);
      return {
        id: row.id,
        multivariate_feature_option: optionId,
        percentage_allocation: isTreatmentKey(key) ? percent : 0,
      };
    });
    if (!mv.some((row) => isTreatmentKey(optionKeyOf(row.multivariate_feature_option, keysById)))) {
      throw new Error(`No keyed treatment variant on ${flagName}; refusing empty-key fallback`);
    }
    const value = percent >= 100 ? "treatment" : "control";
    const bodies = [
      {
        enabled: true,
        feature_state_value: { type: "unicode", value },
        multivariate_feature_state_values: mv,
      },
      {
        enabled: true,
        feature_state_value: { type: "string", value },
        multivariate_feature_state_values: mv,
      },
    ];
    let lastErr: unknown;
    for (const body of bodies) {
      try {
        await admin.patch(`/features/featurestates/${state.id}/`, body);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
  }

  async listMetrics(): Promise<
    Array<{ id: number; name: string; definition?: { event?: string; version?: number } }>
  > {
    const data = await this.requireAdmin().get<unknown>(
      `/environments/${this.environmentKey}/experiment-metrics/`,
    );
    return listResults<{
      id: number;
      name: string;
      definition?: { event?: string; version?: number };
    }>(data);
  }

  async createMetric(event: string, name: string) {
    const existing = (await this.listMetrics()).find((row) => row.name === name);
    if (existing) {
      let existingEvent = existing.definition?.event;
      if (!existingEvent) {
        const full = await this.requireAdmin().get<{ definition?: { event?: string } }>(
          `/environments/${this.environmentKey}/experiment-metrics/${existing.id}/`,
        );
        existingEvent = full.definition?.event;
      }
      if (existingEvent && existingEvent !== event) {
        throw new Error(
          `metric ${name} event is ${existingEvent}, expected ${event}; refusing to reuse`,
        );
      }
      return existing;
    }
    return this.requireAdmin().post(`/environments/${this.environmentKey}/experiment-metrics/`, {
      name,
      aggregation: "occurrence",
      direction: "up",
      definition: { version: 1, event },
    });
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    const data = await this.requireAdmin().get<unknown>(
      `/environments/${this.environmentKey}/experiments/`,
    );
    return listResults<ExperimentRecord>(data);
  }

  async createExperiment(body: Record<string, unknown>) {
    return this.requireAdmin().post<ExperimentRecord>(
      `/environments/${this.environmentKey}/experiments/`,
      body,
    );
  }

  async startExperiment(id: number) {
    return this.requireAdmin().post<ExperimentRecord>(
      `/environments/${this.environmentKey}/experiments/${id}/start/`,
    );
  }

  async getExperiment(id: number) {
    return this.requireAdmin().get<ExperimentRecord>(
      `/environments/${this.environmentKey}/experiments/${id}/`,
    );
  }

  async getExperimentResults(id: number): Promise<unknown> {
    return this.requireAdmin().get(
      `/environments/${this.environmentKey}/experiments/${id}/results/`,
    );
  }

  async refreshExperimentResults(id: number): Promise<unknown> {
    return this.requireAdmin().post(
      `/environments/${this.environmentKey}/experiments/${id}/results/refresh/`,
    );
  }

  async completeExperiment(id: number, body: Record<string, unknown>) {
    return this.requireAdmin().post<ExperimentRecord>(
      `/environments/${this.environmentKey}/experiments/${id}/complete/`,
      body,
    );
  }

  async deleteExperiment(id: number): Promise<void> {
    await this.requireAdmin().delete(`/environments/${this.environmentKey}/experiments/${id}/`);
  }

  async listSegments(): Promise<Array<{ id: number; name: string }>> {
    const data = await this.requireAdmin().get<unknown>(`/projects/${this.projectId}/segments/`);
    return listResults<{ id: number; name: string }>(data);
  }

  async ensureDemoSegment(name = "lift-demo-site"): Promise<{ id: number; name: string }> {
    const listed = await this.listSegments();
    const matches = listed.filter((row) => row.name === name);
    for (const extra of matches.slice(1)) {
      try {
        await this.requireAdmin().delete(`/projects/${this.projectId}/segments/${extra.id}/`);
      } catch {
        /* leftover duplicate */
      }
    }
    if (matches[0]) return matches[0];
    return this.requireAdmin().post<{ id: number; name: string }>(
      `/projects/${this.projectId}/segments/`,
      {
        name,
        description: "Identities with site=checkout",
        project: Number(this.projectId),
        rules: [
          {
            type: "ALL",
            rules: [
              {
                type: "ANY",
                rules: [],
                conditions: [{ operator: "EQUAL", property: "site", value: "checkout" }],
              },
            ],
            conditions: [],
          },
        ],
      },
    );
  }

  async treatmentOptionId(flagName: string): Promise<number | undefined> {
    const feature = await this.findFeature(flagName);
    if (!feature) return undefined;
    const options = await this.listMvOptions(feature.id);
    return options.find((o) => isTreatmentOption(o))?.id;
  }

  async deleteFeatureById(id: number): Promise<{ via: "admin_api"; id: number }> {
    await this.requireAdmin().delete(`/projects/${this.projectId}/features/${id}/`);
    return { via: "admin_api", id };
  }

  async deleteFeature(name: string): Promise<{ via: "admin_api"; name: string; id?: number }> {
    const feature = await this.findFeature(name);
    if (!feature) return { via: "admin_api", name };
    await this.deleteFeatureById(feature.id);
    return { via: "admin_api", name, id: feature.id };
  }

  async ensureIdentity(identifier: string): Promise<{ id: number; identifier: string }> {
    const admin = this.requireAdmin();
    const quoted = `"${identifier}"`;
    const listed = listResults<{ id: number; identifier: string }>(
      await admin.get(
        `/environments/${this.environmentKey}/identities/?q=${encodeURIComponent(quoted)}`,
      ),
    );
    const exact = listed.find((row) => row.identifier === identifier);
    if (exact) return exact;
    return admin.post(`/environments/${this.environmentKey}/identities/`, { identifier });
  }

  async setIdentityOverride(
    identifier: string,
    flagName: string,
    variant: "control" | "treatment",
  ): Promise<{ identityId: number; featureStateId: number; variant: "control" | "treatment" }> {
    const feature = await this.findFeature(flagName);
    if (!feature) throw new Error(`Feature ${flagName} not found`);
    const treatmentId = await this.treatmentOptionId(flagName);
    if (!treatmentId) throw new Error(`No treatment option on ${flagName}`);
    const identity = await this.ensureIdentity(identifier);
    const admin = this.requireAdmin();
    const percent = variant === "treatment" ? 100 : 0;
    const listed = listResults<{
      id: number;
      feature: number | { id: number };
    }>(
      await admin.get(
        `/environments/${this.environmentKey}/identities/${identity.id}/featurestates/`,
      ),
    );
    const match = listed.find((row) => {
      const featureId = typeof row.feature === "number" ? row.feature : row.feature.id;
      return featureId === feature.id;
    });
    const body = {
      enabled: true,
      feature: feature.id,
      feature_state_value: { type: "unicode", string_value: variant },
      multivariate_feature_state_values: [
        { multivariate_feature_option: treatmentId, percentage_allocation: percent },
      ],
    };
    const saved = match
      ? await admin.put<{ id: number }>(
          `/environments/${this.environmentKey}/identities/${identity.id}/featurestates/${match.id}/`,
          { ...body, id: match.id },
        )
      : await admin.post<{ id: number }>(
          `/environments/${this.environmentKey}/identities/${identity.id}/featurestates/`,
          body,
        );
    return { identityId: identity.id, featureStateId: saved.id, variant };
  }

  async clearIdentityOverride(identifier: string, flagName: string): Promise<void> {
    const feature = await this.findFeature(flagName);
    if (!feature) return;
    const admin = this.requireAdmin();
    const quoted = `"${identifier}"`;
    const listed = listResults<{ id: number; identifier: string }>(
      await admin.get(
        `/environments/${this.environmentKey}/identities/?q=${encodeURIComponent(quoted)}`,
      ),
    );
    const identity = listed.find((row) => row.identifier === identifier);
    if (!identity) return;
    const states = listResults<{ id: number; feature: number | { id: number } }>(
      await admin.get(
        `/environments/${this.environmentKey}/identities/${identity.id}/featurestates/`,
      ),
    );
    for (const row of states) {
      const featureId = typeof row.feature === "number" ? row.feature : row.feature.id;
      if (featureId !== feature.id) continue;
      await admin.delete(
        `/environments/${this.environmentKey}/identities/${identity.id}/featurestates/${row.id}/`,
      );
    }
  }

  async cliApi(path: string, method: string, body?: unknown): Promise<CliResult> {
    return flagsmithApi(path, {
      apiUrl: this.cliApiUrl,
      apiKey: this.adminToken,
      project: this.projectId,
      environment: this.environmentKey,
      method,
      body,
    });
  }
}

export function createLiftSelfhost(env: SelfhostEnv, fetchImpl?: FetchFn): LiftSelfhost {
  return new LiftSelfhost({
    apiUrl: env.apiUrl,
    adminApiUrl: env.adminApiUrl,
    eventsUrl: env.eventsUrl,
    dashboardUrl: env.dashboardUrl,
    cliApiUrl: env.cliApiUrl,
    environmentKey: env.environmentKey,
    adminToken: env.adminToken,
    serverKey: env.serverKey,
    projectId: env.projectId,
    environmentId: env.environmentId,
    environmentName: env.environmentName,
    fetchImpl,
  });
}
