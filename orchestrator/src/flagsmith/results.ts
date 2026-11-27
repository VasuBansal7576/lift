import type { FlagsmithResultsLike } from "../agents/analyst.ts";
import type { OrchOptions } from "../types.ts";
import { FlagsmithHttp, FlagsmithHttpError } from "./http.ts";

export async function fetchExperimentResults(
  opts: OrchOptions,
  experimentId: number,
  refresh = true,
  http?: FlagsmithHttp,
): Promise<FlagsmithResultsLike | null> {
  if (!opts.adminToken || !opts.environmentKey) return null;
  const client =
    http ??
    new FlagsmithHttp({
      baseUrl: opts.adminApiUrl || opts.apiUrl,
      token: opts.adminToken,
    });
  if (refresh) {
    try {
      await client.post(`/environments/${opts.environmentKey}/experiments/${experimentId}/results/refresh/`);
    } catch (err) {
      if (!(err instanceof FlagsmithHttpError)) throw err;
    }
  }
  const { data } = await client.get<FlagsmithResultsLike>(
    `/environments/${opts.environmentKey}/experiments/${experimentId}/results/`,
  );
  return data;
}

export function resultsIdentityCount(envelope: FlagsmithResultsLike | null): number {
  const variants = envelope?.results?.payload?.metrics?.[0]?.variants ?? {};
  return Object.values(variants).reduce((sum, row) => sum + (row?.n ?? 0), 0);
}

export function resultsAreReady(envelope: FlagsmithResultsLike | null, minIdentities = 0): boolean {
  const inference = envelope?.results?.payload?.metrics?.[0]?.inference;
  const hasChance = Boolean(
    inference &&
      Object.values(inference).some((arm) => arm && typeof arm.chance_to_win === "number"),
  );
  if (!hasChance) return false;
  return resultsIdentityCount(envelope) >= minIdentities;
}

export async function waitForResults(
  opts: OrchOptions,
  experimentId: number,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIdentities = 0,
): Promise<FlagsmithResultsLike | null> {
  const deadline = Date.now() + waitMs;
  let latest: FlagsmithResultsLike | null = null;
  let delay = 8_000;
  let lastRefresh = 0;
  // Let the SDK flush and the warehouse land rows before the first refresh.
  if (waitMs > 0) await sleep(Math.min(15_000, waitMs));
  while (Date.now() < deadline) {
    const now = Date.now();
    const refresh = lastRefresh === 0 || now - lastRefresh >= 5 * 60 * 1000;
    latest = await fetchExperimentResults(opts, experimentId, refresh);
    if (refresh) lastRefresh = now;
    if (resultsAreReady(latest, minIdentities)) return latest;
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(Math.floor(delay * 1.4), 30_000);
  }
  return latest;
}
