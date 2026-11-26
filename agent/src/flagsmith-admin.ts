import type { LiftConfig } from "./config.ts";

export class FlagsmithAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class FlagsmithAdmin {
  constructor(private readonly cfg: LiftConfig) {}

  private headers(extra?: HeadersInit): Headers {
    if (!this.cfg.adminToken) {
      throw new Error("FLAGSMITH_ADMIN_API_TOKEN is required");
    }
    return new Headers({
      Authorization: `Api-Key ${this.cfg.adminToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    });
  }

  private url(path: string): string {
    const base = (this.cfg.adminApiUrl || this.cfg.apiUrl).replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: T = null as T;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as T;
      }
    }
    if (!res.ok) {
      throw new FlagsmithAdminError(
        `${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`,
        res.status,
        text,
      );
    }
    return { status: res.status, data };
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }

  async envKey(): Promise<string> {
    if (!this.cfg.environmentKey) {
      throw new Error("FLAGSMITH_ENVIRONMENT_KEY is required");
    }
    return this.cfg.environmentKey;
  }
}

export interface FeatureOption {
  id: number;
  string_value?: string | null;
  default_percentage_allocation?: number;
  key?: string | null;
  type?: string | null;
  feature?: number;
}

export interface FeatureRecord {
  id: number;
  name: string;
  type?: string;
  initial_value?: string | null;
  multivariate_options?: FeatureOption[];
}

export interface EnvironmentRecord {
  id: number;
  name: string;
  api_key: string;
  project?: number;
}

export interface ExperimentRecord {
  id: number;
  name: string;
  status: string;
  feature: number | { id: number; name: string; multivariate_options?: FeatureOption[] };
  hypothesis?: string;
  rollout_decision?: string | null;
  rollout_variant?: number | null;
}

export interface MetricRecord {
  id: number;
  name: string;
  aggregation: string;
  direction: string;
  definition: { version: number; event: string };
}

export interface WarehouseRecord {
  id: number;
  warehouse_type: string;
  status: string;
  name?: string;
}

export function listResults<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "results" in payload) {
    const results = (payload as { results: unknown }).results;
    if (Array.isArray(results)) return results as T[];
  }
  return [];
}
