# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/` and the Agent Store.

| File | What it shows |
| --- | --- |
| `t2-orchestrator-run` | Full conductor: scanner, mutator, gatekeeper REJECT of hostile/backstop-failing variants, flag/metric/experiment, 220 simulated visits, Flagsmith `chance_to_win` 0.915, pause at `WAITING_FOR_HUMAN_APPROVAL`. `--approve` is skipped because 0.915 < 0.95. |
| `t1-experiment` | Flagsmith experiment page for `checkout_orch_010771`: variants, Checkout completed metric, 92% chance to be best for full-v1 (matches terminal 0.915). URL bar rewritten to numeric ids so the environment key is never shown. |
| `l2-generation-2` | Gen-1 champion becomes control; g2-focus/type/cursor pass the axe gate; hostile contrast is rejected; a new experiment runs. |

No keys or token fragments appear on screen.

Recorded 27 Nov 2026 against self-hosted Flagsmith 2.295.2. SHA of the orchestrator commit is in the agent report. Media is gitignored; copies live in `artifacts/t1-t2/` and the Agent Store.
