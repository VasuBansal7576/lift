import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { ROOT, loadConfig, readJson, statePath } from "./config.ts";
import { bootstrap, type BootstrapState } from "./bootstrap.ts";
import {
  applyDecision,
  decideExperiment,
  fetchFlagsmithResults,
  loadVisits,
} from "./decide.ts";
import { buildResultsDocument, writeDashboard } from "./dashboard.ts";
import { scanCheckoutSite } from "./scan.ts";
import { runTraffic } from "../../traffic/src/runner.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveCheckout(port: number): Promise<{ close: () => Promise<void> }> {
  const root = resolve(ROOT, "sites/checkout");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const filePath = resolve(
      root,
      url.pathname === "/" ? "index.html" : url.pathname.slice(1),
    );
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
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
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
    server.on("error", reject);
  });
}

export async function runExperiment() {
  const cfg = loadConfig();
  const scan = scanCheckoutSite();
  process.stdout.write(
    `Scan: ${scan.findings.length} barriers on checkout (${scan.findings.map((f) => f.barrier.id).join(", ")})\n`,
  );

  const state: BootstrapState = readJson<BootstrapState>(statePath()) ?? (await bootstrap(cfg));
  process.stdout.write(
    `Flagsmith experiment ${state.experimentId} on flag ${state.flagName}\n`,
  );

  const sitePort = Number(new URL(cfg.siteUrl).port || 4174);
  const server = await serveCheckout(sitePort);
  try {
    await runTraffic();
  } finally {
    await server.close();
  }

  const visits = loadVisits();
  const flagsmith = await fetchFlagsmithResults(state.experimentId);
  const decision = decideExperiment({
    flag: cfg.flagName,
    visits,
    flagsmith,
    threshold: cfg.winThreshold,
  });

  if (decision.decision !== "keep_running") {
    await applyDecision(decision);
  }

  const doc = buildResultsDocument({
    decision,
    visits,
    flagsmith,
    experimentId: state.experimentId,
    dashboardUrl: `${cfg.dashboardUrl}/project/${state.projectId}/environment/${state.environmentKey}/experiments/${state.experimentId}`,
  });
  const path = writeDashboard(doc);
  process.stdout.write(
    `${decision.decision} (${decision.source}, P(treatment>control)=${decision.winProbabilityTreatment.toFixed(3)})\n`,
  );
  process.stdout.write(`Wrote ${path}\n`);
  return doc;
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
