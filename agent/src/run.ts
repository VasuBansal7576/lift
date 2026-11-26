import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { isInsideRoot } from "../../shared/fs-path.ts";
import { ROOT, loadConfig } from "./config.ts";
import { loadRunningState } from "./bootstrap.ts";
import {
  applyDecision,
  decideExperiment,
  parseFlagsmithWin,
  summariseVisits,
  waitForFlagsmithResults,
  loadVisits,
} from "./decide.ts";
import { buildResultsDocument, flagsmithArmCounts, writeDashboard } from "./dashboard.ts";
import { scanCheckoutSite } from "./scan.ts";
import { runTraffic } from "../../traffic/src/runner.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveCheckout(
  port: number,
): Promise<{ close: () => Promise<void>; reused: boolean }> {
  const root = resolve(ROOT, "sites/checkout");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const filePath = resolve(
      root,
      url.pathname === "/" ? "index.html" : url.pathname.slice(1),
    );
    if (!isInsideRoot(root, filePath)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (url.pathname === "/config.json" || url.pathname.endsWith("/config.json")) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse((await readFile(filePath)).toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        parsed = {};
      }
      const body = JSON.stringify({ ...parsed, allowMock: true });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolveServer({
        reused: false,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `Port ${port} already in use; reusing the existing checkout server. It must overlay allowMock on /config.json (scripts/serve-site.mjs --allow-mock).\n`,
        );
        resolveServer({ reused: true, close: async () => undefined });
        return;
      }
      reject(err);
    });
  });
}

export async function runExperiment() {
  const cfg = loadConfig();
  const scan = scanCheckoutSite();
  process.stdout.write(
    `Fixture scan: ${scan.findings.length} data-barrier markers (${scan.findings.map((f) => f.barrier.id).join(", ")}). Not a production crawler.\n`,
  );

  const state = await loadRunningState(cfg);
  process.stdout.write(
    `Flagsmith experiment ${state.experimentId} on flag ${state.flagName}\n`,
  );

  const sitePort = Number(new URL(cfg.siteUrl).port || 4174);
  const server = await serveCheckout(sitePort);
  try {
    if (cfg.continueUntilDecision) {
      process.stderr.write(
        "LIFT_CONTINUE_UNTIL=true is optional stopping: extra batches are sent until P(win) crosses the threshold. Prefer a pre-registered fixed horizon (LIFT_TARGET_ARM_N).\n",
      );
    }
    let batch = 0;
    for (;;) {
      const runId = `${cfg.trafficRunId}-b${batch}`;
      const n = cfg.continueUntilDecision
        ? cfg.trafficN
        : Math.max(cfg.trafficN, cfg.targetArmN * 2);
      await runTraffic({
        trafficRunId: runId,
        trafficN: n,
        trafficBatch: batch,
        appendVisits: cfg.appendVisits || (cfg.continueUntilDecision && batch > 0),
      });
      batch += 1;

      const visits = loadVisits();
      const trafficEndedAt = visits.at(-1)?.at ?? new Date().toISOString();
      const waitMs = Math.max(cfg.resultsWaitMs, cfg.continueUntilDecision ? 5 * 60 * 1000 : 0);
      const flagsmith = await waitForFlagsmithResults({
        experimentId: state.experimentId,
        visits,
        waitMs,
        trafficEndedAt,
      });
      const local = summariseVisits(visits);
      const parsed = parseFlagsmithWin(flagsmith, {
        localN: visits.length,
        localArms: {
          control: local.control.visitors,
          treatment: local.treatment.visitors,
        },
        trafficEndedAt,
      });
      const decision = decideExperiment({
        flag: cfg.flagName,
        visits,
        flagsmith,
        threshold: cfg.winThreshold,
        allowLocalDecision: cfg.allowLocalDecision,
        statsSeed: cfg.trafficSeed,
        trafficEndedAt,
      });

      const arms = flagsmithArmCounts(flagsmith);
      const maxArm = Math.max(
        arms?.control.visitors ?? 0,
        arms?.treatment.visitors ?? 0,
        local.control.visitors,
        local.treatment.visitors,
      );
      const flagsmithReady = parsed?.usable === true;
      const conclusive = flagsmithReady && decision.decision !== "keep_running";
      const atCap = maxArm >= cfg.maxArmN;
      const sendMore =
        cfg.continueUntilDecision &&
        !conclusive &&
        !atCap &&
        parsed?.rejectReason !== "srm" &&
        parsed?.rejectReason !== "ingestion";
      process.stdout.write(
        `batch=${batch} waitMs=${waitMs} visits=${visits.length} parsed=${parsed?.rejectReason ?? (flagsmithReady ? "usable" : "none")} source=${decision.source} decision=${decision.decision} maxArm=${maxArm} cap=${cfg.maxArmN} sendMore=${sendMore}\n`,
      );

      if (sendMore) {
        process.stdout.write(
          `Optional stopping: not conclusive at maxArm=${maxArm} (cap ${cfg.maxArmN}); sending another batch.\n`,
        );
        continue;
      }

      await applyDecision(decision);
      const doc = buildResultsDocument({
        decision,
        visits,
        flagsmith,
        experimentId: state.experimentId,
        dashboardUrl: `${cfg.dashboardUrl}/project/${state.projectId}/environment/${state.environmentId}/experiments/${state.experimentId}`,
        personaMix: cfg.personaMix,
      });
      const path = writeDashboard(doc);
      process.stdout.write(
        `${decision.decision} (${decision.source}, P(treatment>control)=${decision.winProbabilityTreatment.toFixed(3)})\n`,
      );
      process.stdout.write(`Wrote ${path}\n`);
      return doc;
    }
    throw new Error("experiment loop exited without a decision");
  } finally {
    if (!server.reused) await server.close();
  }
}

async function main() {
  await runExperiment();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
