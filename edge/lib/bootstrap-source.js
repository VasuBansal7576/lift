import { BOOTSTRAP_PATH, CONFIG_SCRIPT_ID, FLAGSMITH_SDK_URL_DEFAULT } from "./constants.js";

/**
 * Browser module served at /__lift/bootstrap.js. Fail-open on every path.
 * Uses the inlined spec id when the Worker evaluated Flagsmith; otherwise
 * the Flagsmith JS SDK with the sticky lift_vid identity.
 */
export const BOOTSTRAP_JS = `/* lift edge bootstrap — fail open */
const CONFIG_ID = ${JSON.stringify(CONFIG_SCRIPT_ID)};
const SDK_FALLBACK = ${JSON.stringify(FLAGSMITH_SDK_URL_DEFAULT)};

function readConfig() {
  const el = document.getElementById(CONFIG_ID);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "");
  } catch {
    return null;
  }
}

function cookieVid() {
  const match = document.cookie.match(/(?:^|; )lift_vid=([^;]*)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function usableSpecId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "control" || text === "false" || text === "0") return null;
  return text;
}

async function specIdFromSdk(cfg, identity) {
  const sdkUrl = cfg.sdkUrl || SDK_FALLBACK;
  const { default: flagsmith } = await import(sdkUrl);
  await flagsmith.init({
    environmentID: cfg.environmentKey,
    api: cfg.apiUrl,
    identity,
    enableAnalytics: false,
  });
  if (typeof flagsmith.getValue === "function") {
    const fromValue = usableSpecId(flagsmith.getValue(cfg.flagName));
    if (fromValue) return fromValue;
  }
  if (typeof flagsmith.getExperimentFlag === "function") {
    const flag = flagsmith.getExperimentFlag(cfg.flagName);
    return usableSpecId(flag && (flag.value || flag.variant));
  }
  return null;
}

async function main() {
  try {
    const cfg = readConfig();
    if (!cfg) return;
    document.documentElement.dataset.liftEdge = "injected";
    const identity = cfg.identity || cookieVid();
    let spec = cfg.spec || null;
    let specId = usableSpecId(cfg.specId);
    if (!spec && !specId && cfg.environmentKey && cfg.apiUrl && cfg.flagName) {
      specId = await specIdFromSdk(cfg, identity);
    }
    if (!spec && specId) {
      document.documentElement.dataset.liftSpec = specId;
      const res = await fetch("/__lift/spec/" + encodeURIComponent(specId), { cache: "no-store" });
      if (!res.ok) return;
      spec = await res.json();
    }
    if (!spec) return;
    if (spec.id) document.documentElement.dataset.liftSpec = spec.id;
    const runtime = await import("/runtime/runtime.js");
    const result = runtime.applyPatchSpec(spec);
    document.documentElement.dataset.liftApplied = result && result.ok ? "1" : "0";
  } catch {
    /* fail-open: leave the origin page as it was */
  }
}

main();
`;

export function bootstrapResponse() {
  return new Response(BOOTSTRAP_JS, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export { BOOTSTRAP_PATH };
