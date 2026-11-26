export function featureCreatePayload(
  name: string,
  description: string,
  treatmentAllocation: number,
) {
  return {
    name,
    default_enabled: true,
    initial_value: "control",
    description,
    type: "MULTIVARIATE",
    multivariate_options: [
      {
        type: "unicode",
        string_value: "treatment",
        default_percentage_allocation: treatmentAllocation,
        key: "treatment",
      },
    ],
  };
}

export function experimentCreatePayload(input: {
  featureId: number;
  treatmentId: number;
  metricId: number;
  hypothesis: string;
  name?: string;
}) {
  return {
    feature: input.featureId,
    name: input.name ?? "Checkout accessibility lift",
    hypothesis: input.hypothesis,
    metrics: [{ metric: input.metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: "string" as "string" | "unicode", value: "control" },
      multivariate_feature_state_values: [
        {
          multivariate_feature_option: input.treatmentId,
          percentage_allocation: 50,
        },
      ],
    },
  };
}

export function completeBody(
  decision: "rollout_treatment" | "pull_to_control",
  treatmentOptionId: number,
): { rollout_decision: "variant" | "control"; rollout_variant?: number } {
  if (decision === "rollout_treatment") {
    return {
      rollout_decision: "variant",
      rollout_variant: treatmentOptionId,
    };
  }
  return { rollout_decision: "control" };
}

export function warehouseCloudBody() {
  return { warehouse_type: "flagsmith", name: "Lift Flagsmith warehouse" };
}

export function warehouseSelfHostBody() {
  return {
    warehouse_type: "postgres",
    name: "Lift Flagsmith database",
    config: { source: "flagsmith_database" },
  };
}

export function metricCreatePayload(event: string) {
  return {
    name: "Checkout completed",
    description:
      "Visitor submitted a completed checkout. Simulated traffic is labelled in identity traits.",
    aggregation: "occurrence",
    direction: "up",
    definition: { version: 1, event },
  };
}
