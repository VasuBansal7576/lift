# Edge Worker recordings

Produced by `npm run edge:record` (Playwright video) plus a terminal capture of Flagsmith / wrangler setup. Copied to `artifacts/edge/` and the agent store.

| File | What it shows |
| --- | --- |
| `edge-zero-code-fix.webm` | Origin checkout (barriers + axe count), then the same URL through the Worker as a treatment identity. Fixes apply; axe drops. Origin tree unchanged (`git status`). |
| `edge-flag-flip.webm` | Self-hosted Flagsmith UI: treatment weight 0% → Worker shows a Shop span; weight 100% → reload applies the spec (Shop is a button). |
| `edge-fail-open.webm` | Flagsmith stopped; reload serves the original page, no injection errors. |
| `edge-sticky.webm` | Same visitor across reloads keeps `lift_vid` and the same variant (cookie visible). |
| `edge-setup.typescript` | Terminal recording of compose / put-spec / wrangler (no key fragments). |

Worker CPU (`Server-Timing: liftcpu`) on HTML through `wrangler dev`: **0–3 ms**, under the 10 ms free-tier budget.
