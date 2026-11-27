import { stripSecretsFromText } from "../secrets.ts";

export class FlagsmithHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(stripSecretsFromText(message));
  }
}

export interface HttpRequest {
  method: string;
  url: string;
  body?: unknown;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export class FlagsmithHttp {
  constructor(
    private readonly opts: {
      baseUrl: string;
      token: string;
      fetch?: FetchLike;
    },
  ) {}

  private url(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const fetchImpl = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    const res = await fetchImpl(this.url(path), {
      method,
      headers: {
        Authorization: `Api-Key ${this.opts.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
    if (res.status < 200 || res.status >= 300) {
      throw new FlagsmithHttpError(
        `${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`,
        res.status,
        stripSecretsFromText(text),
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

  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

export function listResults<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "results" in payload) {
    const results = (payload as { results: unknown }).results;
    if (Array.isArray(results)) return results as T[];
  }
  return [];
}

export function cliOrigin(apiUrl: string): string {
  return apiUrl.replace(/\/api\/v1\/?$/i, "").replace(/\/+$/, "");
}
