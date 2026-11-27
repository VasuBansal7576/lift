import { applyFixes, setStatus } from "./fixes.js";
import { browserIdentityEnv, resolveVisitorId } from "./identity.js";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

function params() {
  return new URLSearchParams(location.search);
}

async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function allFixes(map, on) {
  const fixes = {};
  for (const id of Object.keys(map || {})) fixes[id] = on;
  return fixes;
}

function flagIsTreatment(flagsmith, name) {
  try {
    return flagsmith.getValue(name) === "treatment";
  } catch {
    return false;
  }
}

function fixesFromFlagsmith(flagsmith, map, bundledVariant) {
  const bundled = bundledVariant === "treatment";
  const fixes = {};
  for (const [id, flag] of Object.entries(map || {})) {
    fixes[id] = bundled || flagIsTreatment(flagsmith, flag);
  }
  return fixes;
}

async function initFromFlagsmith(config, identity) {
  if (!config?.flagsmithEnvironmentKey) {
    throw new Error("Missing FLAGSMITH_ENVIRONMENT_KEY");
  }
  const { default: flagsmith } = await import(SDK_URL);
  await flagsmith.init({
    environmentID: config.flagsmithEnvironmentKey,
    api: config.flagsmithApiUrl,
    identity,
    traits: {
      simulated: false,
      site: config.site || document.body.dataset.site || "",
    },
    enableEvents: true,
    eventProcessorConfig: config.flagsmithEventsUrl
      ? { eventsApiUrl: config.flagsmithEventsUrl }
      : undefined,
  });
  const flagName = config.flagName;
  const flag = flagsmith.getExperimentFlag(flagName);
  const variant =
    flag?.variant === "treatment" || flag?.value === "treatment"
      ? "treatment"
      : "control";
  const map = config.barrierFlagMap || {};
  applyFixes(
    fixesFromFlagsmith(flagsmith, map, variant),
    `Flagsmith ${flagName}=${variant}`,
  );
  window.addEventListener("lift:converted", async () => {
    flagsmith.trackEvent(config.metricEvent, {
      traits: {
        converted: true,
        simulated: false,
        site: config.site || document.body.dataset.site || "",
      },
    });
    await flagsmith.setTrait("converted", true);
    await flagsmith.flushEvents();
  });
  window.addEventListener("pagehide", () => {
    void flagsmith.flushEvents();
  });
}

async function main() {
  const mock = params().get("lift_variant");
  const config = await loadConfig();
  const identity = resolveVisitorId(
    browserIdentityEnv({ allowBotOverride: config?.allowBotOverride === true }),
  );
  const allowMock = Boolean(config?.allowMock);
  const map = config?.barrierFlagMap || {};
  if (allowMock && (mock === "control" || mock === "treatment")) {
    applyFixes(allFixes(map, mock === "treatment"), "URL override (no Flagsmith)");
    return;
  }
  try {
    await initFromFlagsmith(config ?? {}, identity);
  } catch (err) {
    setStatus(
      `Flagsmith is required for variant assignment (${err instanceof Error ? err.message : err}).`,
      true,
    );
  }
}

void main();
