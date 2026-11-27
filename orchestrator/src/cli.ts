import { parseArgv } from "./config.ts";
import { runOrchestrator } from "./conductor.ts";
import { formatDuration, TIME_SAVED_LABEL } from "./time-saved.ts";

function help(): string {
  return `Lift orchestrator — Track 2 multi-agent conductor.

Usage:
  npx tsx orchestrator/src/cli.ts [options]
  npm run orch -- [options]

Options:
  --apply                 Create the Flagsmith flag, metric, and experiment (default: dry-run)
  --approve <id>          Roll out after a TTY prompt typing APPROVE <id>
  --cleanup               Delete lift_orch_ flags marked as orchestrator-owned
  --allow-remote          Allow non-loopback FLAGSMITH_API_URL / site URL
  --generations N         1 (default) or 2 for the L2 evolutionary step
  --traffic-n N           Simulated identities per generation (default 220; Flagsmith floors are 50/arm)
  --threshold 0.95        chance_to_win required to recommend a winner
  --site-url URL          Demo page (default http://127.0.0.1:4174/checkout)
  --ui-port N             Timeline UI (default 4177)
  --keep-ui               Leave the timeline server running
  --no-ui                 Skip the local web page
  --flag-name NAME        Multivariate flag name (default lift_orch_checkout)

Env: FLAGSMITH_API_URL, FLAGSMITH_ADMIN_API_TOKEN, FLAGSMITH_ENVIRONMENT_KEY,
FLAGSMITH_SERVER_KEY, FLAGSMITH_PROJECT_ID. Keys are never printed.
No default Flagsmith credentials — set them in the environment.

The Flag agent drives Flagsmith (CLI v2 + Admin API). Mutator is template-only;
LLM is optional when a key is set.

Human approval: the run stops at WAITING_FOR_HUMAN_APPROVAL. Rollout only
happens on a second invocation with --approve <experimentId> AND typing
APPROVE <id> on a TTY. There is no non-interactive bypass.
`;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(help());
    return;
  }
  const opts = parseArgv();
  const state = await runOrchestrator(opts);
  const saved = state.timeSaved
    ? ` wall=${formatDuration(state.timeSaved.wallClockMs)} ${TIME_SAVED_LABEL} saved=${formatDuration(state.timeSaved.savedMs)}`
    : "";
  process.stdout.write(`phase=${state.phase} generations=${state.generations.length}${saved}\n`);
  if (state.phase === "WAITING_FOR_HUMAN_APPROVAL") {
    const id = state.flag?.experimentId;
    process.stdout.write(
      id
        ? `Re-run with --approve ${id} and type APPROVE ${id} on a TTY to roll out the winner.\n`
        : "Re-run with --approve <experimentId> and type APPROVE <id> on a TTY to roll out the winner.\n",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
