# Lift orchestrator (Track 2)

The Lift bot is the conductor. It coordinates typed agents with a terminal event log and a local timeline at `http://127.0.0.1:4177/`.

The **Flag agent** is the only role that creates Flagsmith resources (multivariate flag, conversion metric, experiment) and later completes/pauses them. The mutator is a **deterministic template mutator; LLM path available with a key**.

Dry-run is the default. `--apply` mutates self-hosted Flagsmith. Rollout happens only on a second invocation with `--approve <experimentId>` **and** a TTY prompt where someone types `APPROVE <id>`. There is no non-interactive production bypass. At approve time the conductor re-fetches Flagsmith `/results` and re-checks `chance_to_win`; it does not trust `run-state.json`. Proof recordings type that phrase with the recording harness standing in for the human approver (disclosed on screen and in `recordings/t1-t2/README.md`).

Flag names must use the `lift_orch_` prefix. Features carry the description marker `Lift orchestrator gated accessibility variants`. Foreign flags are refused. `--cleanup` deletes only prefix+marker flags.

## Agents

1. **Scanner** — Playwright + axe-core on the demo checkout page.
2. **Mutator** — Deterministic template mutator; LLM path available with a key. PatchSpec templates from axe violations (labels, contrast, full treatment) plus a hostile canary: allowlisted `#767676` on white `.lede` plus `role=checkbox` without `aria-checked`. Parse and runtime accept it; axe rejects with `added axe rules: aria-required-attr`. Generation 2 labels control `Control = gen-1 champion <id>` in the Flagsmith experiment name/hypothesis. The champion is already at the measured ceiling (UA `:focus-visible` on Place order); gen-2 outline/type/cursor challengers do not change persona outcomes.
3. **Gatekeeper** — Applies each candidate with `runtime/runtime.js` in a real browser and re-runs axe **before** any traffic. Generation ≥ 2 gates against an axe baseline with the **champion applied**.
4. **Flag** — Drives Flagsmith (CLI v2 `feature create` / `variant add` when available, Admin API otherwise). Creates the conversion metric and experiment, then starts it. Variant payloads are gated spec ids (`^[a-z0-9-]{1,40}$`). Dashboard links use the real environment key in the URL.
5. **Traffic** — Mouse (70%), keyboard (10%), screen-reader (10%), and low-vision (10%) personas (Playwright) under a sticky `lift_vid` identity. Conversion is what that persona actually does on the served variant: keyboard must Tab/Enter to submit and the focused submit must show a visible outline or box-shadow vs unfocused (WCAG 2.4.7, same check on every arm), screen-reader uses the accessibility tree (unlabeled controls fail), low-vision fails if essential copy contrast is below 4.5:1 (computed styles). Every arm then shares the same seeded random keep rate (`SHARED_KEEP_RATE`, not a per-variant table). The RNG seed (`LIFT_TRAFFIC_SEED`, default `20261127`) and `runId` (`LIFT_RUN_ID`) are logged. Persona timeouts are logged per arm and abort above about 2%. The site’s own Flagsmith path serves the variant; a `data-lift-applied-variant` runtime marker must match or the visit is dropped (no `trackEvent`) and the run aborts. Generation ≥ 2 requires `/orch-specs/control.json` (`orchControlSpecRequired`); a missing spec leaves an empty marker so traffic aborts. Labelled SIMULATED. `?lift_variant=` mock override is on only during scan/gate, not during traffic.
6. **Analyst** — `GET .../experiments/{id}/results/`. Recommends a winner only if `chance_to_win >= 0.95`; otherwise **keep collecting**. Prints a readable decision line (`Flagsmith: N% | Agent threshold: 95% | Decision: KEEP COLLECTING` or `APPROVE`). Flagsmith withholds inference until each arm has **50 identities and 5 conversions**. Default `--traffic-n 220` plus extra rounds until a real result. Proof recordings use `--traffic-n 1000` (T2) / `400` (L2) and `LIFT_ORCH_MAX_EXTRA_ROUNDS=0` so the look is a single pre-registered sample. No fewest-axe-hits fallback.
7. **Human approval** — A winner pauses at `WAITING_FOR_HUMAN_APPROVAL`. Below 0.95 the phase is `KEEP_COLLECTING`. `--approve <experimentId>` plus typed `APPROVE <id>` on a TTY.
8. **Rollout** — Completes the experiment, sets the environment-default featurestate (`identity==null && feature_segment==null`) winner to 100% / losers 0%, and deletes losing multivariate options. A control winner verifies every variant allocation is 0% and skips the featurestate PATCH. Unknown arms throw. If generation 2 stays below 0.95: **Gen-2 inconclusive (chance_to_win X < 0.95 after N visits); champion stays**.

## Commands

```bash
npm run orch                 # dry-run: scan, mutate, gate, pause
npm run orch -- --apply      # also create flag/metric/experiment and send traffic
npm run orch -- --approve 12 # TTY: type APPROVE 12 to roll out
npm run orch -- --cleanup    # delete lift_orch_ flags with the orch marker
npm run orch -- --generations 2 --apply   # L2: pause gen-1, champion becomes control
npm run orch:selfhost        # official compose in a scratch dir, image 2.295.2
```

`--allow-remote` is required for any non-loopback `FLAGSMITH_API_URL`, `FLAGSMITH_ADMIN_API_URL`, `FLAGSMITH_EVENTS_URL`, or site URL. Keys and tokens are never printed. Bootstrap credentials come from env (`FLAGSMITH_BOOTSTRAP_EMAIL` / `FLAGSMITH_BOOTSTRAP_PASSWORD`); there are no defaults.

## Time saved

Manual estimate for one checkout run: **vs est. manual 115 min (itemised estimate)** (scan 10, write specs 40, re-axe 20, Flagsmith UI 15, personas 20, read/rollout 10). The conductor reports wall-clock versus that estimate at the end of a run.

L2 (`--generations 2`): generation 1 must produce a Flagsmith winner (`chance_to_win` from `/results`). That champion becomes **control**, labelled in Flagsmith as `Control = gen-1 champion <id>` (payload key remains `control`). Gen-1 is paused before gen-2 starts. New challengers are re-gated against the champion-applied axe baseline, then a new experiment starts. The gen-1 champion is already at the measured keyboard ceiling (UA `:focus-visible` on Place order).

If the run crashes after an experiment has started, a `try/finally` pauses it.

## Self-hosted Flagsmith

Compose runs **outside** the repo (`~/.lift-flagsmith-2.295.2` or `$LIFT_FLAGSMITH_SCRATCH`). The script downloads `docker-compose.yml` from the **v2.295.2** tag, binds `127.0.0.1:8000`, overrides Django/Postgres secrets with random values stored in the scratch `.env`, and never uses sudo. `EXPERIMENTATION_ENABLED` is on in the official file. Warehouse: Flagsmith database (`warehouse_type=postgres`, `config.source=flagsmith_database`).

If `migrate-db` fails on a VM, `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` on **your** VM is acceptable. It is not in repo scripts.

Config from env: `FLAGSMITH_API_URL`, `FLAGSMITH_ADMIN_API_TOKEN`, `FLAGSMITH_ENVIRONMENT_KEY`, `FLAGSMITH_SERVER_KEY`, `FLAGSMITH_PROJECT_ID`.

The Flagsmith UI experiment URL includes the public client environment key. That key is acceptable in recordings; URLs are never faked with `history.replaceState`. If you must hide it, blur only that region with ffmpeg.
