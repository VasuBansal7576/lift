import type { OrchOptions } from "../../orchestrator/src/types.ts";

export function testOrchOptions(overrides: Partial<OrchOptions> = {}): OrchOptions {
  return {
    apply: false,
    approve: false,
    approveExperimentId: null,
    resultsExperimentId: null,
    cleanup: false,
    allowRemote: false,
    generations: 1,
    fromGeneration: 1,
    siteUrl: "http://127.0.0.1:4174/checkout",
    uiPort: 4177,
    trafficN: 8,
    threshold: 0.95,
    flagName: "lift_orch_checkout",
    metricEvent: "checkout_completed",
    keepUi: false,
    noUi: true,
    resultsWaitMs: 1000,
    apiUrl: "http://127.0.0.1:8000/api/v1/",
    adminApiUrl: "http://127.0.0.1:8000/api/v1/",
    eventsUrl: "http://127.0.0.1:8000/api/",
    dashboardUrl: "http://127.0.0.1:8000",
    environmentKey: "envkey",
    serverKey: "serverkey",
    adminToken: "admin-token",
    projectId: "1",
    organisationId: "1",
    environmentId: "1",
    ...overrides,
  };
}
