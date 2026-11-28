export class AdminHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

export class AdminHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly headerName = "Api-Key",
  ) {}

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.token) {
      headers.Authorization = `${this.headerName} ${this.token}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers,
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
      throw new AdminHttpError(
        `${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`,
        res.status,
        text,
      );
    }
    return data;
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
