import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { parseArgs, flagBool, flagString } from "../selfhost/src/args.ts";
import { compareAxeGate, type AxeViolationSummary, type GateResult } from "../selfhost/src/axe-gate.ts";
import { createLiftSelfhost, type ExperimentRecord, type LiftSelfhost } from "../selfhost/src/client.ts";
import { loadSelfhostEnv } from "../selfhost/src/env.ts";
import { printJson, redactSecrets } from "../selfhost/src/redact.ts";
import { writeSiteConfigForSelfhost } from "../selfhost/src/site-config.ts";
import {
  assertApprovalCommand,
  assertServedVariants,
  cleanupStaleFlags,
  createExperimentViaApi,
  createFlagViaCliOrApi,
  guardApply,
  mutationContext,
  rolloutWinner,
  runningExperimentForFeature,
  startExperimentViaApi,
  experimentIsRunning,
  type RecordedFlag,
} from "../selfhost/src/skill-ops.ts";
import {
  a11yOutcomeFromMeasurements,
  sendSimulatedConversions,
  simulatedConversionsLabel,
  type A11yOutcome,
  type PageA11yMeasurement,
} from "../selfhost/src/skill-traffic.ts";
import { pickRolloutFromResults } from "../selfhost/src/results.ts";
import { serveDir } from "../selfhost/src/static-server.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = resolve(root, "skills/flagsmith-a11y-experiment/fixtures");
const lastRunPath = resolve(root, "skills/flagsmith-a11y-experiment/last-run.json");
const GATE_CONTROL = "lift-gate-control";
const GATE_TREATMENT = "lift-gate-treatment";
const GATE_PROBE = "lift-gate-probe";
const METRIC_EVENT = "lift_a11y_completed";

async function scan(url: string): Promise<AxeViolationSummary[]> {
  process.stderr.write(`axe scan ${url}\n`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    const results = await withProgress(`axe analyze ${url}`, () =>
      new AxeBuilder({ page }).include("body").analyze(),
    );
    const violations = results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.length,
      impact: v.impact ?? null,
    }));
    process.stderr.write(`axe scan done ${url} violations=${violations.length}\n`);
    return violations;
  } finally {
    await context.close();
    await browser.close();
  }
}

function banner(line: string): void {
  process.stderr.write(`\n======== ${line} ========\n`);
}

async function withProgress<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stderr.write(`${label} ...\n`);
  const timer = setInterval(() => process.stderr.write(`${label} still running\n`), 2000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stderr.write(`${label} done\n`);
  }
}

function killProcessGroup(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function measureServedPage(page: {
  evaluate: (fn: () => PageA11yMeasurement) => Promise<PageA11yMeasurement>;
}): Promise<PageA11yMeasurement> {
  return page.evaluate(() => {
    const shop = document.getElementById("shop-trigger");
    const email = document.getElementById("email");
    const pay = document.getElementById("place-order");
    const terms = document.querySelector(".terms");
    const cart = document.getElementById("cart-icon");
    return {
      shopIsButton: shop?.tagName === "BUTTON",
      fieldsLabeled: Boolean(email && document.querySelector('label[for="email"]')),
      placeOrderIsButton: pay?.tagName === "BUTTON",
      contrastFixed: !terms?.classList.contains("contrast-fail"),
      cartLabeled: Boolean(cart?.getAttribute("aria-label")),
      axeIds: [],
    };
  });
}

async function scanServedVariant(
  siteUrl: string,
  identity: string,
  extraQuery = "",
): Promise<{
  violations: AxeViolationSummary[];
  status: string;
  variant: string;
  url: string;
  outcome: A11yOutcome;
}> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const query = extraQuery ? `&${extraQuery}` : "";
    const url = `${siteUrl}/checkout/?lift_identity=${encodeURIComponent(identity)}&lift_bot=1${query}`;
    process.stderr.write(`axe served scan ${identity} ${url}\n`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      () => {
        const text = document.getElementById("flag-status")?.textContent ?? "";
        return text.includes("=") && !text.includes("Waiting");
      },
      { timeout: 30_000 },
    );
    const status = (await page.locator("#flag-status").textContent()) ?? "";
    const variant = (await page.evaluate(() => document.body.dataset.variant)) ?? "";
    const results = await withProgress(`axe served analyze ${identity}`, () =>
      new AxeBuilder({ page }).include("body").analyze(),
    );
    const violations = results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.length,
      impact: v.impact ?? null,
    }));
    const measured = await measureServedPage(page);
    measured.axeIds = violations.map((v) => v.id);
    return {
      violations,
      status,
      variant,
      url,
      outcome: a11yOutcomeFromMeasurements(measured),
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function readLastRun(): {
  experimentId?: number;
  flagName?: string;
  createdFlags?: RecordedFlag[];
} {
  if (!existsSync(lastRunPath)) return {};
  try {
    return JSON.parse(readFileSync(lastRunPath, "utf8")) as {
      experimentId?: number;
      flagName?: string;
      createdFlags?: RecordedFlag[];
    };
  } catch {
    return {};
  }
}

async function pollResults(lift: LiftSelfhost, experimentId: number, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      await lift.refreshExperimentResults(experimentId);
    } catch {
      /* 429 / not ready */
    }
    try {
      last = await lift.getExperimentResults(experimentId);
      const pick = pickRolloutFromResults(last);
      process.stderr.write(
        `results poll chance_to_win=${JSON.stringify(pick.chances)} collecting=${Boolean(pick.collecting)}\n`,
      );
      if (pick.ok) {
        return { results: last, pick };
      }
      if (!pick.collecting && Object.keys(pick.chances).length > 0) {
        return { results: last, pick };
      }
    } catch {
      /* still ingesting */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { results: last, pick: pickRolloutFromResults(last) };
}

async function startGateSite(port: number): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    "npx",
    ["tsx", "scripts/serve-site.ts", "--selfhost", "--port", String(port)],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  try {
    const actualPort = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("gate site did not bind a port")), 15_000);
      const onData = (buf: Buffer) => {
        const match = buf.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolvePromise(Number(match[1]));
      };
      child.stdout?.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`gate site exited ${code}`));
      });
    });
    return { child, port: actualPort };
  } catch (err) {
    killProcessGroup(child);
    throw err;
  }
}

async function gateServedVariants(opts: {
  lift: LiftSelfhost;
  env: ReturnType<typeof loadSelfhostEnv>;
  flagName: string;
  sitePort: number;
  apply: boolean;
}): Promise<
  | { ok: true; gate: GateResult; outcomes: { control: A11yOutcome; treatment: A11yOutcome } }
  | { ok: false; reason: string; gate?: GateResult }
> {
  if (!opts.apply) {
    return {
      ok: false,
      reason: "--start requires a passing axe gate on the served control/treatment from this run",
    };
  }
  const running = await runningExperimentForFeature(opts.lift, opts.flagName);
  if (running) {
    return {
      ok: false,
      reason: `refuse the gate while experiment ${running.id} is running for ${opts.flagName}`,
    };
  }
  writeSiteConfigForSelfhost(opts.env, "checkout", opts.flagName, METRIC_EVENT);
  let site: ChildProcess | null = null;
  try {
    await opts.lift.setTreatmentWeight(opts.flagName, 0);
    await opts.lift.setIdentityOverride(GATE_TREATMENT, opts.flagName, "treatment");
    const started = await startGateSite(opts.sitePort);
    site = started.child;
    const origin = `http://127.0.0.1:${started.port}`;
    await new Promise((r) => setTimeout(r, 1500));

    const servedControl = await scanServedVariant(origin, GATE_CONTROL);
    const servedProbe = await scanServedVariant(origin, GATE_PROBE, "lift_gate_probe=bad");
    const probeGate = compareAxeGate(servedControl.violations, servedProbe.violations);
    banner(`axe-gate injected probe on served page: ${probeGate.reason}`);
    printJson({
      step: "axe-gate-served-probe",
      label: "injected probe on served page",
      ...probeGate,
      url: servedProbe.url,
      variant: servedProbe.variant,
      status: servedProbe.status,
    });
    if (!probeGate.rejected) {
      return { ok: false, reason: "expected the injected probe on served page to be REJECTED", gate: probeGate };
    }

    const servedTreatment = await scanServedVariant(origin, GATE_TREATMENT);
    const identities = assertServedVariants({
      flagName: opts.flagName,
      control: servedControl,
      treatment: servedTreatment,
    });
    if (identities.ok === false) return identities;

    const gate = compareAxeGate(servedControl.violations, servedTreatment.violations);
    banner(`axe-gate SERVED ${servedControl.variant} vs ${servedTreatment.variant}: ${gate.reason}`);
    printJson({
      step: "axe-gate-served",
      ...gate,
      url: servedTreatment.url,
      control: servedControl,
      treatment: servedTreatment,
    });
    if (gate.rejected || !gate.ok) {
      return {
        ok: false,
        reason: "served treatment failed the axe gate; not starting the experiment",
        gate,
      };
    }
    return {
      ok: true,
      gate,
      outcomes: { control: servedControl.outcome, treatment: servedTreatment.outcome },
    };
  } finally {
    try {
      await opts.lift.setTreatmentWeight(opts.flagName, 0);
    } catch {
      /* reset best-effort */
    }
    try {
      await opts.lift.clearIdentityOverride(GATE_TREATMENT, opts.flagName);
    } catch {
      /* override cleanup best-effort */
    }
    killProcessGroup(site);
  }
}

async function main(): Promise<number> {
  const { flags } = parseArgs(process.argv.slice(2));
  const env = loadSelfhostEnv();
  const lift = createLiftSelfhost(env);
  const ctx = mutationContext(flags, lift);
  const wantStart = flagBool(flags, "start");
  const reuseFlag = flagBool(flags, "reuse-flag");
  const flagName = flagString(flags, "flag", "lift_a11y_skill");
  const sitePort = Number(flagString(flags, "site-port", "0"));
  const fixturePort = Number(flagString(flags, "port", "0"));
  const previous = readLastRun();
  const createdFlags: RecordedFlag[] = [];
  const steps: Record<string, unknown>[] = [];
  function emit(step: Record<string, unknown>): void {
    steps.push(step);
    printJson(step);
  }

  const mixed = assertApprovalCommand(flags);
  if (mixed.ok === false) {
    printJson({ step: "guard", ...mixed });
    return 1;
  }

  const health = await lift.health();
  if (!health.ok) {
    printJson({ step: "health", ...health });
    return 1;
  }

  if (ctx.apply) {
    const plan = guardApply(ctx);
    banner(`guard ${plan.ok === false ? "REFUSED" : "ok"}`);
    emit({ step: "guard", ...plan });
    if (plan.ok === false) {
      printJson({ step: "guard", ...plan });
      return 1;
    }
  }

  const fixtureServer = await serveDir(fixtures, fixturePort);
  try {
    const controlUrl = `${fixtureServer.url}/control.html`;
    const badUrl = `${fixtureServer.url}/bad.html`;
    const goodUrl = `${fixtureServer.url}/good.html`;

    const control = await scan(controlUrl);
    emit({ step: "scan-fixtures", url: controlUrl, violations: control, demo: true });

    const bad = await scan(badUrl);
    const reject = compareAxeGate(control, bad);
    banner(`axe-gate fixtures bad: ${reject.reason}`);
    emit({ step: "axe-gate-fixtures-bad", demo: true, ...reject, control, variant: bad });
    if (!reject.rejected) {
      printJson({ ok: false, reason: "expected fixture bad variant to be REJECTED", steps });
      return 1;
    }

    const good = await scan(goodUrl);
    const pass = compareAxeGate(control, good);
    banner(`axe-gate fixtures good: ${pass.reason}`);
    emit({ step: "axe-gate-fixtures-good", demo: true, ...pass, control, variant: good });
    if (pass.rejected) {
      printJson({ ok: false, reason: "fixture good variant must PASS the axe gate", steps });
      return 1;
    }

    const staleName = `lift_a11y_stale_${Date.now()}`;
    let stale;
    try {
      stale = await createFlagViaCliOrApi(lift, ctx, staleName, "stale flag for cleanup demo");
    } catch (err) {
      printJson({
        ok: false,
        step: "stale-flag",
        reason: err instanceof Error ? err.message : String(err),
        steps,
      });
      return 1;
    }
    const staleAction = stale.reused ? "reused" : "created";
    banner(`stale-flag ${staleAction} ${staleName}`);
    emit({ step: "stale-flag", action: staleAction, ...stale });
    if (stale.ok === false) {
      printJson({ ok: false, reason: "stale-flag failed", steps });
      return 1;
    }
    if (typeof stale.id === "number" && stale.reused !== true) {
      createdFlags.push({ name: staleName, id: stale.id });
    }

    let createdFlag;
    try {
      createdFlag = await createFlagViaCliOrApi(
        lift,
        ctx,
        flagName,
        "A11y experiment (skill run)",
        { reuseFlag, recorded: previous.createdFlags ?? [] },
      );
    } catch (err) {
      printJson({
        ok: false,
        step: "create-flag",
        reason: err instanceof Error ? err.message : String(err),
        steps,
      });
      return 1;
    }
    banner(
      `multivariate flag ${flagName} ${createdFlag.reused ? "reused" : "created"} at 0% treatment`,
    );
    emit({ step: "create-flag", action: createdFlag.reused ? "reused" : "created", ...createdFlag });
    if (createdFlag.ok === false) {
      printJson({ ok: false, reason: "create-flag failed", steps });
      return 1;
    }
    if (typeof createdFlag.id === "number") createdFlags.push({ name: flagName, id: createdFlag.id });

    let servedGate: GateResult | null = null;
    let servedOutcomes: { control: A11yOutcome; treatment: A11yOutcome } | null = null;
    if (wantStart) {
      const gated = await gateServedVariants({
        lift,
        env,
        flagName,
        sitePort,
        apply: ctx.apply,
      });
      if (gated.ok === false) {
        printJson({ step: "axe-gate-served", ...gated, steps });
        return 1;
      }
      servedGate = gated.gate;
      servedOutcomes = gated.outcomes;
    }

    if (ctx.apply && typeof createdFlag.id === "number") {
      const featureId = createdFlag.id;
      let leftover: ExperimentRecord[] = [];
      try {
        leftover = await lift.listExperiments();
      } catch (err) {
        process.stderr.write(
          `listExperiments failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      for (const exp of leftover) {
        const feature =
          typeof exp.feature === "number"
            ? exp.feature
            : exp.feature && typeof exp.feature === "object"
              ? exp.feature.id
              : undefined;
        if (feature !== featureId) continue;
        if (experimentIsRunning(exp.status ?? "")) continue;
        if (!String(exp.name ?? "").startsWith("lift a11y ")) continue;
        try {
          await lift.deleteExperiment(exp.id);
        } catch {
          /* leftover completed experiment */
        }
      }
    }
    const experimentName = `lift a11y ${Date.now()}`;
    const experiment = await createExperimentViaApi(lift, ctx, {
      flagName,
      event: METRIC_EVENT,
      hypothesis: "Fixing axe violations raises conversions.",
      experimentName,
    });
    emit({ step: "create-experiment", ...experiment });
    if (experiment.ok === false) {
      printJson({ ok: false, reason: "create-experiment failed", steps });
      return 1;
    }
    const expId = (experiment.experiment as { id?: number } | undefined)?.id;
    banner(`experiment created id=${String(expId ?? "?")}`);

    if (wantStart) {
      if (!expId && ctx.apply) {
        printJson({ ok: false, reason: "experiment id missing; not starting", steps });
        return 1;
      }
      const started = await startExperimentViaApi(lift, { ...ctx, gate: servedGate }, expId ?? 0);
      banner(started.ok === false ? "start REFUSED" : "experiment STARTED after served axe gate PASS");
      emit({ step: "start-experiment", ...started });
      if (started.ok === false) {
        printJson({ ok: false, reason: "start refused", steps });
        return 1;
      }
    }

    if (ctx.apply && wantStart && expId) {
      const n = Number(flagString(flags, "traffic-n", "120"));
      const label = simulatedConversionsLabel(n);
      banner(label);
      if (!servedOutcomes) {
        printJson({ ok: false, reason: "served a11y outcomes missing; not sending conversions", steps });
        return 1;
      }
      let traffic;
      try {
        traffic = await sendSimulatedConversions({
          apiUrl: env.adminApiUrl || env.apiUrl,
          eventsUrl: env.eventsUrl,
          environmentKey: env.environmentKey,
          serverKey: env.serverKey,
          flagName,
          event: METRIC_EVENT,
          n,
          outcomes: servedOutcomes,
        });
      } catch (err) {
        printJson({
          ok: false,
          step: "simulated-traffic",
          label,
          reason: err instanceof Error ? err.message : String(err),
          steps,
        });
        return 1;
      }
      emit({ step: "simulated-traffic", label, ...traffic });
      banner(
        `variant default allocation stays 0%; experiment_rollout sets its own split (this run control=${traffic.control.n} treatment=${traffic.treatment.n})`,
      );
      const polled = await pollResults(lift, expId);
      banner(`chance_to_win ${JSON.stringify(polled.pick.chances)}`);
      emit({
        step: "results",
        pick: polled.pick,
        chances: polled.pick.chances,
        chance_to_win: polled.pick.chances,
      });
      if (!polled.pick.ok) {
        printJson({ ok: false, reason: "results not ready for approval", steps });
        return 1;
      }

      banner("WAITING_FOR_HUMAN_APPROVAL — type APPROVE <experimentId> at this TTY");
      const rolled = await rolloutWinner(lift, ctx, { flagName, experimentId: expId });
      banner(
        `rollout ${rolled.ok === false ? "FAILED" : "ok"} winner=${JSON.stringify((rolled as { pick?: unknown }).pick)}`,
      );
      emit({ step: "rollout", ...rolled });
      if (rolled.ok === false) {
        printJson({ ok: false, steps });
        return 1;
      }
      await new Promise((r) => setTimeout(r, 2500));
      const cleaned = (await cleanupStaleFlags(
        lift,
        ctx,
        createdFlags.filter((row) => row.name === staleName),
      )) as { ok: boolean; deleted?: string[]; reason?: string; dryRun?: boolean };
      emit({ step: "cleanup", ...cleaned });
      if (cleaned.ok === false) {
        printJson({ ok: false, steps });
        return 1;
      }
      const out = { ok: true, apply: ctx.apply, steps, experimentId: expId, flagName, createdFlags };
      writeFileSync(lastRunPath, `${redactSecrets(JSON.stringify(out, null, 2))}\n`);
      const deleted = cleaned.deleted ?? [];
      if (cleaned.ok && deleted.includes(staleName)) {
        banner(`stale-flag deleted ${staleName}`);
        printJson(out);
        printJson({ step: "stale-flag-deleted", name: staleName, deleted });
        process.stderr.write("\n");
        return 0;
      }
      const reason = deleted.length
        ? "stale name was not in the deleted list"
        : String(cleaned.reason ?? "stale flag was not deleted");
      banner(`stale-flag NOT deleted ${staleName}`);
      printJson(out);
      printJson({ step: "stale-flag-not-deleted", name: staleName, reason, deleted });
      process.stderr.write("\n");
      return 1;
    }

    const snapshot = {
      ok: true,
      paused: true,
      code: "WAITING_FOR_HUMAN_APPROVAL",
      experimentId: expId,
      flagName,
      createdFlags,
      steps,
    };
    writeFileSync(lastRunPath, `${redactSecrets(JSON.stringify(snapshot, null, 2))}\n`);
    banner("WAITING_FOR_HUMAN_APPROVAL — rerun with --apply --start to prompt APPROVE <id> after results");
    printJson({
      ...snapshot,
      hint: "With --apply --start, type APPROVE <experimentId> at the TTY after chance_to_win is printed",
    });
    return 3;
  } finally {
    await fixtureServer.close();
  }
}

const code = await main();
process.exit(code);
