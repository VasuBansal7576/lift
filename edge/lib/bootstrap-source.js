import { BOOTSTRAP_PATH, CONFIG_SCRIPT_ID, FLAGSMITH_SDK_URL_DEFAULT, RUNTIME_PATH_PREFIX } from "./constants.js";

const RUNTIME_URL = `${RUNTIME_PATH_PREFIX}runtime.js`;

/**
 * Browser module served at /__lift/bootstrap.js. Fail-open on every path.
 * Server-side eval is authoritative when `evaluated` is true; the JS SDK is
 * only used when the Worker did not evaluate.
 */
export const BOOTSTRAP_JS = `/* lift edge bootstrap — fail open */
const CONFIG_ID = ${JSON.stringify(CONFIG_SCRIPT_ID)};
const SDK_FALLBACK = ${JSON.stringify(FLAGSMITH_SDK_URL_DEFAULT)};
const RUNTIME_URL = ${JSON.stringify(RUNTIME_URL)};

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

function adoptLiftCss(styleNonce) {
  const take = (el) => {
    if (!el || el.tagName !== "STYLE") return;
    if (el.getAttribute("data-lift-css") !== "1") return;
    if (el.dataset.liftCssAdopted === "1") return;
    el.dataset.liftCssAdopted = "1";
    try {
      if (typeof CSSStyleSheet === "function") {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(el.textContent || "");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        el.remove();
        return;
      }
    } catch {
      /* fall through to nonce */
    }
    if (styleNonce) el.setAttribute("nonce", styleNonce);
  };
  try {
    document.querySelectorAll("style[data-lift-css]").forEach(take);
    const obs = new MutationObserver((recs) => {
      for (const rec of recs) {
        for (const node of rec.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName === "STYLE") take(node);
          if (node.querySelectorAll) node.querySelectorAll("style[data-lift-css]").forEach(take);
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* fail-open */
  }
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
    if (cfg.styleNonce) document.documentElement.dataset.liftStyleNonce = cfg.styleNonce;
    adoptLiftCss(cfg.styleNonce || null);
    const identity = cfg.identity || cookieVid();
    let spec = cfg.spec || null;
    let specId = usableSpecId(cfg.specId);
    const serverEvaluated = cfg.evaluated === true;
    if (!serverEvaluated && !spec && !specId && cfg.environmentKey && cfg.apiUrl && cfg.flagName) {
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
    const runtime = await import(RUNTIME_URL);
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

export { BOOTSTRAP_PATH, RUNTIME_URL };
