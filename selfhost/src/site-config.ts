import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SelfhostEnv } from "./env.ts";
import { REPO_ROOT } from "./paths.ts";
import { simulatedConversionsLabel } from "./skill-traffic.ts";

export interface SiteConfigFile {
  site: string;
  flagsmithApiUrl: string;
  flagsmithEventsUrl: string;
  flagsmithEnvironmentKey: string;
  flagName: string;
  metricEvent: string;
  allowMock: boolean;
  simulatedTrafficLabel: string;
  barrierFlags: string[];
  barrierFlagMap: Record<string, string>;
}

const CHECKOUT_BARRIERS: Record<string, string> = {
  hover_menu: "a11y_hover_menu",
  unlabeled_icon: "a11y_unlabeled_icon",
  div_button: "a11y_div_button",
  missing_labels: "a11y_missing_labels",
  unlabeled_terms: "a11y_unlabeled_terms",
  low_contrast: "a11y_low_contrast",
};

export function selfhostSiteConfigPath(site = "checkout"): string {
  return resolve(REPO_ROOT, "sites", site, "config.selfhost.json");
}

/** Point the existing checkout demo at FLAGSMITH_API_URL (self-hosted). */
export function siteConfigFromEnv(
  cfg: SelfhostEnv,
  site = "checkout",
  flagName = "checkout_a11y",
  metricEvent = `${site}_completed`,
): SiteConfigFile {
  return {
    site,
    flagsmithApiUrl: cfg.apiUrl,
    flagsmithEventsUrl: cfg.eventsUrl,
    flagsmithEnvironmentKey: cfg.environmentKey,
    flagName,
    metricEvent,
    allowMock: false,
    simulatedTrafficLabel: simulatedConversionsLabel(120),
    barrierFlags: Object.values(CHECKOUT_BARRIERS),
    barrierFlagMap: CHECKOUT_BARRIERS,
  };
}

export function writeSiteConfigForSelfhost(
  cfg: SelfhostEnv,
  site = "checkout",
  flagName = "checkout_a11y",
  metricEvent = `${site}_completed`,
): string {
  const path = selfhostSiteConfigPath(site);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(siteConfigFromEnv(cfg, site, flagName, metricEvent), null, 2)}\n`,
  );
  return path;
}
