---
name: flagsmith-a11y-experiment
description: Run a Flagsmith accessibility experiment end to end — axe scan, reject variants that add violations, create a multivariate flag (Admin HTTP, CLI fallback), create metric/experiment (Admin HTTP), TTY-approved rollout, recorded-flag cleanup. Use when shipping WCAG fixes behind Flagsmith flags or when asked for a Flagsmith agent skill.
---

# Flagsmith a11y experiment

These scripts live in the **Lift repo** (`scripts/skill-*.ts`). They are not a standalone npm package.

Scripts do the work. Print compact JSON. Never print keys/tokens/passwords.

## Safety (always)

- Dry-run unless `--apply`. Every `--apply` run calls `planOrRefuse` first; `ok:false` is fatal. Weights never change before that guard passes.
- Default-deny any Admin, SDK, CLI, or events URL that is not loopback (`127.0.0.1`, `localhost`, `::1`). Pass `--allow-remote` for a remote instance.
- If the environment name matches `/prod/` → also refuse unless `--confirm-prod`.
- Multivariate flags are created at **0% treatment**. The served axe gate scans treatment through a **gate-only identity override**, never an environment-wide 100%. Traffic is allocated only by `experiment_rollout` after the gate passes. `--apply` without `--start` leaves 0%.
- Refuse to reuse an existing flag that is not in this run's `last-run.json` unless `--reuse-flag`. Refuse the gate while a running experiment exists for that feature.
- `--start` exists only on `scripts/skill-run.ts` and requires a passing axe gate of the **served** control and treatment from the same run (`variant==='control'|'treatment'` and flag-status names the flag). Fixtures are a demo / unit check only.
- After results, `skill-run --apply --start` prints `chance_to_win` per arm and reads one line from `/dev/tty`. Type exactly `APPROVE <experimentId>`. Empty input, a wrong id, other text, or no TTY is refused. Results are re-fetched after the line; a changed winner is refused. There is no `--approve-rollout` flag or env bypass.
- Do not call Flagsmith MCP to start/complete experiments (it cannot start them).

## Run

From the Lift repo, after `npm run selfhost:up` (or any Flagsmith with `FLAGSMITH_API_URL` in `selfhost/.env`):

```
npx tsx scripts/skill-run.ts                       # dry-run
npx tsx scripts/skill-run.ts --apply --start       # mutate; prompts APPROVE <id> on the TTY after results
```

SIMULATED conversions: 120 real Flagsmith identities. Equal base rates for both variants; conversion follows the measured persona / a11y outcome on the served page (keyboard and screen-reader personas fail when measured axe or keyboard barriers are present).

## Steps (do not skip the gate)

1. **Scan** `scripts/skill-scan.ts --url <page>`
2. **Gate** `scripts/skill-axe-gate.ts --control <url> --variant <url>`
   Exit 2 = REJECT. **Never create/serve a rejected variant.** Exit 0 = PASS.
   Before `--start`, `skill-run` gates the demo site rendered under control (environment default 0%) and under treatment (gate-only identity override).
3. **Flag** `scripts/skill-create-flag.ts --name <flag>` — Admin HTTP `POST /projects/{id}/features/` with treatment allocation **0%** (CLI `feature create` / `variant add --key treatment --weight 0` only if that path is used as fallback).
4. **Metric + experiment** `scripts/skill-create-experiment.ts` — Admin HTTP (`POST .../experiment-metrics/` looked up by name **and event**, `POST .../experiments/` looked up by feature; resumes a running experiment for that feature). **Does not start.** Start only via `scripts/skill-run.ts --start` after the served gate.
5. **Rollout** `scripts/skill-rollout.ts` — without `--apply` prints `WAITING_FOR_HUMAN_APPROVAL` and exits 3. With `--apply` and `--experiment-id`: GET `.../experiments/{id}/results/` (Admin HTTP), print `chance_to_win` per arm, read `APPROVE <id>` from `/dev/tty`, re-fetch, pick the arm with the highest `chance_to_win` (≥ 0.95). Control winning keeps control (`setTreatmentWeight(flag, 0)`). If `complete/` fails, do not pin.
6. **Cleanup** `scripts/skill-cleanup.ts` — deletes only flags recorded in `last-run.json` at creation, matched by **name and id**, deleted **by id**. No prefix-only deletion.

Need CLI details? Read [references/cli-vs-api.md](references/cli-vs-api.md) only if a command fails.

## Output

Every script prints one JSON object (`ok`, `dryRun`, `via`, `rejected`, `chance_to_win`, …). Prefer that over reading source.
