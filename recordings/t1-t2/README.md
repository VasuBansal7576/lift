# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/` and the Agent Store.

| File | What it shows |
| --- | --- |
| `t2-orchestrator-run` | Full conductor: scanner, mutator, gatekeeper REJECT of a hostile variant, flag/metric/experiment in Flagsmith, traffic, chance_to_win, WAITING_FOR_HUMAN_APPROVAL, `--approve`, winner at 100%. |
| `t1-experiment` | Flagsmith experiment page: variants, metric, win probability matching the terminal, then rollout. |
| `l2-generation-2` | Gen-1 champion as control, new challengers axe-gated, new experiment. |

No keys or token fragments appear on screen.
