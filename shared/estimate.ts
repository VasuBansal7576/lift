import { SITES } from "./catalog.ts";

export const FLEET_ARM_N = 200;

export interface FleetCallEstimate {
  armN: number;
  sites: number;
  visitors: number;
  admin: number;
  events: number;
  results: number;
  completeVerify: number;
  environmentDocs: number;
  total: number;
  notes: string[];
}

/** Local eval + batched events. Admin bootstrap is the bulk of Flagsmith HTTP. */
export function estimateFleetCalls(
  siteCount = SITES.length,
  armN = FLEET_ARM_N,
): FleetCallEstimate {
  const visitors = siteCount * armN * 2;
  const adminPerSite = 20;
  const eventsPerSite = 2;
  const resultsPerSite = 6;
  const completeVerify = 3;
  const environmentDocs = 2;
  const admin = siteCount * adminPerSite;
  const events = siteCount * eventsPerSite;
  const results = siteCount * resultsPerSite;
  const complete = siteCount * completeVerify;
  const envDocs = siteCount * environmentDocs;
  return {
    armN,
    sites: siteCount,
    visitors,
    admin,
    events,
    results,
    completeVerify: complete,
    environmentDocs: envDocs,
    total: admin + events + results + complete + envDocs,
    notes: [
      `Fixed horizon of ${armN * 2} identities per site (~${armN}/arm, random 50/50). Cap is Playwright runtime for eight sequential sites, not the 50k/month Flagsmith API budget (local eval + batched events keep HTTP to a few hundred calls).`,
      "Node SDK local evaluation: environment document ~1–2 times per site, not per visitor.",
      "Playwright bots do not call the JS SDK. Events flush in batches (~1–2 POSTs/site).",
      "Admin: ensure feature/metric/experiment/start (~20) + results poll/refresh (~6) + complete/GET (~2) per site.",
      "20-identity rollout check uses local evaluation (no extra Flags API).",
    ],
  };
}
