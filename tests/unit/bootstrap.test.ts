import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeBody,
  experimentCreatePayload,
  featureCreatePayload,
  metricCreatePayload,
  warehouseCloudBody,
  warehouseSelfHostBody,
} from "../../agent/src/payloads.ts";
import { ensureMetric, ensureTreatmentKey } from "../../agent/src/bootstrap.ts";
import { FlagsmithAdmin } from "../../agent/src/flagsmith-admin.ts";
import type { LiftConfig } from "../../agent/src/config.ts";

function cfg(): LiftConfig {
  return {
    apiUrl: "https://edge.api.flagsmith.com/api/v1/",
    adminApiUrl: "https://api.flagsmith.com/api/v1/",
    eventsUrl: "https://events.api.flagsmith.com/",
    dashboardUrl: "https://app.flagsmith.com",
    environmentKey: "env-key",
    serverKey: "ser-key",
    adminToken: "token",
    organisationId: "42178",
    projectId: "56470",
    environmentId: "1",
    environmentName: "Development",
    bootstrapEmail: "",
    bootstrapPassword: "",
    flagName: "checkout_a11y",
    metricEvent: "checkout_completed",
    siteUrl: "http://127.0.0.1:4174",
    trafficN: 120,
    trafficSeed: 1,
    winThreshold: 0.95,
    allowMock: false,
    allowLocalDecision: false,
    resultsWaitMs: 0,
    personaMix: {
      mouse: 0.7,
      keyboard: 0.1,
      "screen-reader": 0.1,
      "low-vision": 0.1,
    },
  };
}

describe("bootstrap payloads", () => {
  it("creates a multivariate flag with treatment key", () => {
    expect(featureCreatePayload("checkout_a11y", "desc", 50)).toEqual({
      name: "checkout_a11y",
      default_enabled: true,
      initial_value: "control",
      description: "desc",
      type: "MULTIVARIATE",
      multivariate_options: [
        {
          type: "unicode",
          string_value: "treatment",
          default_percentage_allocation: 50,
          key: "treatment",
        },
      ],
    });
  });

  it("creates the experiment at 100% enrolled 50% treatment", () => {
    const body = experimentCreatePayload({
      featureId: 10,
      treatmentId: 99,
      metricId: 5,
      hypothesis: "h",
    });
    expect(body.feature).toBe(10);
    expect(body.metrics).toEqual([{ metric: 5, expected_direction: "increase" }]);
    expect(body.experiment_rollout.rollout_percentage).toBe(100);
    expect(body.experiment_rollout.feature_state_value).toEqual({
      type: "string",
      value: "control",
    });
    expect(body.experiment_rollout.multivariate_feature_state_values).toEqual([
      { multivariate_feature_option: 99, percentage_allocation: 50 },
    ]);
  });

  it("matches metrics on definition.event", () => {
    expect(metricCreatePayload("checkout_completed").definition.event).toBe(
      "checkout_completed",
    );
  });

  it("uses flagsmith warehouse on cloud and postgres flagsmith_database self-host", () => {
    expect(warehouseCloudBody().warehouse_type).toBe("flagsmith");
    expect(warehouseSelfHostBody()).toEqual({
      warehouse_type: "postgres",
      name: "Lift Flagsmith database",
      config: { source: "flagsmith_database" },
    });
  });

  it("builds complete body for variant vs control", () => {
    expect(completeBody("rollout_treatment", 99)).toEqual({
      rollout_decision: "variant",
      rollout_variant: 99,
    });
    expect(completeBody("pull_to_control", 99)).toEqual({
      rollout_decision: "control",
    });
  });
});

describe("ensureTreatmentKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws if the variant key is still not treatment after PUT", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/mv-options/") && method === "GET") {
        return new Response(
          JSON.stringify([{ id: 1, string_value: "treatment", key: "control" }]),
          { status: 200 },
        );
      }
      if (url.includes("/mv-options/") && method === "PUT") {
        const body = JSON.parse(String(init?.body));
        expect(body.key).toBe("treatment");
        expect(body.string_value).toBe("treatment");
        return new Response(JSON.stringify({ id: 1, key: "control" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const admin = new FlagsmithAdmin(cfg());
    await expect(
      ensureTreatmentKey(admin, "56470", { id: 10, name: "checkout_a11y" }),
    ).rejects.toThrow(/not "treatment"/);
  });
});

describe("ensureMetric", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches only on definition.event, not name", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 1,
                name: "Checkout completed",
                definition: { version: 1, event: "other_event" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body));
      expect(body.definition.event).toBe("checkout_completed");
      return new Response(
        JSON.stringify({
          id: 2,
          name: "Checkout completed",
          definition: { version: 1, event: "checkout_completed" },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const admin = new FlagsmithAdmin(cfg());
    const metric = await ensureMetric(admin, "env-key", "checkout_completed");
    expect(metric.id).toBe(2);
  });
});
