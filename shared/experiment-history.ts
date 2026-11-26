export type HistoricKind = "abandoned" | "superseded";

export interface HistoricExperiment {
  id: number;
  kind: HistoricKind;
  flag: string | null;
  site: string | null;
  name: string | null;
  status: string;
  exposures: {
    control: number | null;
    treatment: number | null;
    total: number | null;
  } | null;
  rolloutDecision: string | null;
  reason: string;
}

/** Gaps in Development experiment ids. Looked up 2026-11-26; all 404. */
export const ABANDONED_EXPERIMENTS: HistoricExperiment[] = [
  {
    id: 615,
    kind: "abandoned",
    flag: null,
    site: "pricing",
    name: null,
    status: "not_found",
    exposures: null,
    rolloutDecision: null,
    reason:
      "Looked up on Development: GET /experiments/615/ returned 404 (No Experiment matches). ID gap between signup 614 and pricing 616. Likely a deleted or never-persisted bootstrap attempt. Exposures unknown because the object is gone.",
  },
  {
    id: 617,
    kind: "abandoned",
    flag: null,
    site: "newsletter",
    name: null,
    status: "not_found",
    exposures: null,
    rolloutDecision: null,
    reason:
      "Looked up on Development: GET /experiments/617/ returned 404. ID gap between pricing 616 and newsletter 618. Likely a deleted or never-persisted bootstrap attempt. Exposures unknown because the object is gone.",
  },
  {
    id: 620,
    kind: "abandoned",
    flag: null,
    site: "booking",
    name: null,
    status: "not_found",
    exposures: null,
    rolloutDecision: null,
    reason:
      "Looked up on Development: GET /experiments/620/ returned 404. ID gap between donate 619 and booking 621. Likely a deleted or never-persisted bootstrap attempt. Exposures unknown because the object is gone.",
  },
  {
    id: 622,
    kind: "abandoned",
    flag: null,
    site: "login",
    name: null,
    status: "not_found",
    exposures: null,
    rolloutDecision: null,
    reason:
      "Looked up on Development: GET /experiments/622/ returned 404. ID gap between booking 621 and login 624. Likely a deleted or never-persisted bootstrap attempt. Exposures unknown because the object is gone.",
  },
  {
    id: 623,
    kind: "abandoned",
    flag: null,
    site: "login",
    name: null,
    status: "not_found",
    exposures: null,
    rolloutDecision: null,
    reason:
      "Looked up on Development: GET /experiments/623/ returned 404. ID gap between booking 621 and login 624 (with 622). Likely a deleted or never-persisted bootstrap attempt. Exposures unknown because the object is gone.",
  },
];

/** Site-1 checkout runs, still present on Development, superseded by the fleet. */
export const SITE1_EXPERIMENTS: HistoricExperiment[] = [
  {
    id: 586,
    kind: "superseded",
    flag: "checkout_a11y",
    site: "checkout",
    name: "Checkout accessibility lift",
    status: "completed",
    exposures: { control: 59, treatment: 61, total: 120 },
    rolloutDecision: "variant",
    reason:
      "Site-1 first live Development run (120 identities). Rolled out treatment. Superseded by later checkout experiments and the fleet.",
  },
  {
    id: 593,
    kind: "superseded",
    flag: "checkout_a11y",
    site: "checkout",
    name: "Checkout accessibility lift (rev2)",
    status: "completed",
    exposures: { control: 152, treatment: 143, total: 295 },
    rolloutDecision: "variant",
    reason:
      "Site-1 sequential (optional-stopping) Development run. Rolled out treatment. Superseded by the fixed-horizon site-1 run and the fleet.",
  },
  {
    id: 605,
    kind: "superseded",
    flag: "checkout_a11y",
    site: "checkout",
    name: "Checkout accessibility lift (20261126100841)",
    status: "completed",
    exposures: { control: 271, treatment: 310, total: 581 },
    rolloutDecision: "variant",
    reason:
      "Site-1 fixed-horizon Development run. Rolled out treatment. Superseded by the fleet checkout experiment.",
  },
];

/** First fleet live run (200/arm). Superseded once LIFT_FLEET_FORCE re-runs. */
export const FLEET_F1_EXPERIMENTS: HistoricExperiment[] = [
  {
    id: 613,
    kind: "superseded",
    flag: "checkout_a11y",
    site: "checkout",
    name: "Northline Market checkout accessibility lift (20261126103649)",
    status: "completed",
    exposures: { control: 207, treatment: 193, total: 400 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 614,
    kind: "superseded",
    flag: "signup_a11y",
    site: "signup",
    name: "Harbor Notes signup accessibility lift (20261126104916)",
    status: "completed",
    exposures: { control: 186, treatment: 215, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 616,
    kind: "superseded",
    flag: "pricing_a11y",
    site: "pricing",
    name: "Lumen Cloud pricing accessibility lift (20261126110011)",
    status: "completed",
    exposures: { control: 205, treatment: 196, total: 401 },
    rolloutDecision: "control",
    reason: "First fleet live run (pulled to control). Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 618,
    kind: "superseded",
    flag: "newsletter_a11y",
    site: "newsletter",
    name: "Field Post newsletter accessibility lift (20261126110850)",
    status: "completed",
    exposures: { control: 184, treatment: 217, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 619,
    kind: "superseded",
    flag: "donate_a11y",
    site: "donate",
    name: "River Keep donation accessibility lift (20261126111554)",
    status: "completed",
    exposures: { control: 205, treatment: 196, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 621,
    kind: "superseded",
    flag: "booking_a11y",
    site: "booking",
    name: "North Clinic booking accessibility lift (20261126112334)",
    status: "completed",
    exposures: { control: 191, treatment: 210, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 624,
    kind: "superseded",
    flag: "login_a11y",
    site: "login",
    name: "Atlas Board login accessibility lift (20261126113224)",
    status: "completed",
    exposures: { control: 197, treatment: 204, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
  {
    id: 625,
    kind: "superseded",
    flag: "search_a11y",
    site: "search",
    name: "Northline search and cart accessibility lift (20261126113925)",
    status: "completed",
    exposures: { control: 218, treatment: 183, total: 401 },
    rolloutDecision: "variant",
    reason: "First fleet live run. Superseded by the F1-fix re-run (LIFT_FLEET_FORCE=true).",
  },
];

export function historicLists(currentExperimentIds: number[] = []): {
  abandonedExperiments: HistoricExperiment[];
  supersededExperiments: HistoricExperiment[];
} {
  const current = new Set(currentExperimentIds);
  const superseded = [...SITE1_EXPERIMENTS, ...FLEET_F1_EXPERIMENTS].filter(
    (row) => !current.has(row.id),
  );
  return {
    abandonedExperiments: ABANDONED_EXPERIMENTS,
    supersededExperiments: superseded,
  };
}
