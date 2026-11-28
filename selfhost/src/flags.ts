export interface LiftFlagVariant {
  key: string;
  value: string;
  weight: number;
}

export type LiftFlagStatus = "off" | "control" | "experimenting" | "rolled_out";

export interface LiftFlag {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  value: string | null;
  variants: LiftFlagVariant[];
  status: LiftFlagStatus;
  managed: boolean;
}

const MANAGED = /^(lift_|checkout_|a11y_|signup_|pricing_|newsletter_|donate_|booking_|login_|search_)/;

export function isManagedFlagName(name: string): boolean {
  return MANAGED.test(name);
}

function variantKey(row: Record<string, unknown>): { key: string; value: string; weight: number } {
  const option = row.multivariate_feature_option;
  let key = "";
  let value = "";
  if (option && typeof option === "object") {
    const o = option as Record<string, unknown>;
    key = String(o.key ?? o.string_value ?? "");
    value = String(o.string_value ?? o.value ?? "");
  } else if (typeof row.value === "string") {
    value = row.value;
    key = String(row.key ?? row.value);
  }
  const weight = Number(row.percentage_allocation ?? row.weight ?? 0);
  return { key: key || value || "variant", value: value || key, weight: Number.isFinite(weight) ? weight : 0 };
}

export function flagStatus(enabled: boolean, variants: LiftFlagVariant[]): LiftFlagStatus {
  if (!enabled) return "off";
  const treatment = variants.find((v) => v.key === "treatment" || v.value === "treatment");
  if (!treatment) return variants.length ? "experimenting" : "control";
  if (treatment.weight >= 100) return "rolled_out";
  if (treatment.weight <= 0) return "control";
  return "experimenting";
}

export function parseSdkFlags(payload: unknown): LiftFlag[] {
  const rows = Array.isArray(payload) ? payload : [];
  const flags: LiftFlag[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const feature = (row.feature && typeof row.feature === "object" ? row.feature : {}) as Record<
      string,
      unknown
    >;
    const name = String(feature.name ?? row.name ?? "");
    if (!name) continue;
    const mv = Array.isArray(row.multivariate_feature_state_values)
      ? row.multivariate_feature_state_values
      : [];
    const variants = mv
      .filter((item) => item && typeof item === "object")
      .map((item) => variantKey(item as Record<string, unknown>));
    const enabled = Boolean(row.enabled);
    flags.push({
      id: Number(feature.id ?? row.id ?? 0),
      name,
      type: String(feature.type ?? row.type ?? "STANDARD"),
      enabled,
      value: row.feature_state_value == null ? null : String(row.feature_state_value),
      variants,
      status: flagStatus(enabled, variants),
      managed: isManagedFlagName(name),
    });
  }
  return flags;
}
