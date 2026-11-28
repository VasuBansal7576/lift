import { chromium } from "@playwright/test";
import { createLiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson } from "../selfhost/src/redact.ts";

const lift = createLiftSelfhost(loadSelfhostEnv());
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await lift.setTreatmentWeight("checkout_a11y", 0);
await page.goto("http://127.0.0.1:4174/checkout/?lift_identity=proof-control&lift_bot=1", {
  waitUntil: "networkidle",
});
const control = {
  status: await page.locator("#flag-status").textContent(),
  variant: await page.locator("body").getAttribute("data-variant"),
};

await lift.setTreatmentWeight("checkout_a11y", 100);
await page.goto("http://127.0.0.1:4174/checkout/?lift_identity=proof-treat&lift_bot=1", {
  waitUntil: "networkidle",
});
const treatment = {
  status: await page.locator("#flag-status").textContent(),
  variant: await page.locator("body").getAttribute("data-variant"),
};

await browser.close();
printJson({
  ok: control.variant === "control" && treatment.variant === "treatment",
  apiUrl: loadSelfhostEnv().apiUrl,
  control,
  treatment,
});
if (control.variant !== "control" || treatment.variant !== "treatment") process.exit(1);
