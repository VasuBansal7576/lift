# Lift orchestrator (Track 2)

The Lift bot is the conductor. It coordinates typed agents with a terminal event log and a local timeline at `http://127.0.0.1:4177/`.

Dry-run is the default. `--apply` mutates self-hosted Flagsmith. Rollout happens only on a second invocation with `--approve`.

## Agents

1. **Scanner** — Playwright + axe-core on the demo checkout page.
2. **Mutator** — Deterministic PatchSpec templates from those violations (labels, controls, contrast, full treatment). Always includes a hostile white-on-white canary. Optional Groq/Gemini only if a key is present in env; the run is complete without one.
3. **Gatekeeper** — Applies each candidate with `runtime/runtime.js` in a real browser and re-runs axe. Rejects any variant that fails a runtime backstop or **adds** axe violations. This gate runs **before** any variant gets traffic.
4. **Flag** — Flagsmith CLI v2 `feature create` / `variant add` when available, Admin API otherwise. Creates the conversion metric and experiment (`flagsmith api` / HTTP — the CLI has no experiment command), then starts it. Variant payloads are the gated spec ids.
5. **Traffic** — Mouse, keyboard, screen-reader, and low-vision personas (Playwright) under a sticky identity. Real `trackEvent` conversions into Flagsmith. Labelled SIMULATED.
6. **Analyst** — `GET .../experiments/{id}/results/`. Recommends a winner only if `chance_to_win >= 0.95`; otherwise **keep collecting**. Flagsmith itself withholds inference until each arm has **50 identities and 5 conversions** (`RESULTS_MIN_*` in 2.295.2). Default `--traffic-n 220` is sized for control + three gated variants.
7. **Human approval** — Phase `WAITING_FOR_HUMAN_APPROVAL`. No rollout yet.
8. **Rollout** — `--approve` completes the experiment, sets the winner to 100%, and deletes losing multivariate options.

## Commands

```bash
npm run orch                 # dry-run: scan, mutate, gate, pause
npm run orch -- --apply      # also create flag/metric/experiment and send traffic
npm run orch -- --approve    # second invocation: roll out
npm run orch -- --generations 2 --apply   # L2: champion becomes control, new challengers re-gated
npm run orch:selfhost        # official compose in a scratch dir, image 2.295.2
```

`--allow-remote` is required for any non-loopback `FLAGSMITH_API_URL` or site URL. Keys and tokens are never printed.

## Time saved

Manual estimate for one checkout run: **115 minutes** (scan 10, write specs 40, re-axe 20, Flagsmith UI 15, personas 20, read/rollout 10). The conductor reports wall-clock versus that estimate at the end of a run.

L2 (`--generations 2`): generation 1’s champion (Flagsmith winner, or the gated spec with the fewest remaining axe hits) becomes **control**. New challengers are re-gated by axe before any traffic, then a new experiment starts.

## Self-hosted Flagsmith

Compose runs **outside** the repo (`~/.lift-flagsmith-2.295.2` or `$LIFT_FLAGSMITH_SCRATCH`). Pin `2.295.2`. `EXPERIMENTATION_ENABLED` is on in the official file. Warehouse: Flagsmith database (`warehouse_type=postgres`, `config.source=flagsmith_database`).

If `migrate-db` fails on a VM, `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` on **your** VM is acceptable. It is not in repo scripts.

Config from env: `FLAGSMITH_API_URL`, `FLAGSMITH_ADMIN_API_TOKEN`, `FLAGSMITH_ENVIRONMENT_KEY`, `FLAGSMITH_SERVER_KEY`, `FLAGSMITH_PROJECT_ID`.
