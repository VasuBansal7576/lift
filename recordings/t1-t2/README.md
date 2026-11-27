# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/t1-t2/`, `/opt/cursor/artifacts/`, and the Agent Store.

Flagsmith URLs are real. The public client environment key in `/environment/<key>/` is acceptable and is not masked. Addresses are never rewritten with `history.replaceState`. Login happens before ffmpeg starts. After ffmpeg starts, navigation is a visible xdotool pointer move+click or visible omnibox typing; reloads are a visible F5 with `performance` navigation type `reload`.

**Recording config (must match `record-proof.ts`):** T2 uses `--traffic-n 1000` and `LIFT_ORCH_MAX_EXTRA_ROUNDS=0` (one pre-registered look, no optional stopping). L2 uses `--traffic-n 400` and the same extra-rounds=0. Seed `LIFT_TRAFFIC_SEED=20261127` unless overridden. Concurrency 16.

**Approval:** the recording harness typed `APPROVE <id>` in the on-screen xterm **standing in for the human approver**. A human did not type it. The terminal echo says so before the phrase is typed. APPROVE is typed only when Flagsmith `chance_to_win >= 0.95`. If T2 stays below 0.95, the harness types APPROVE on the gen-1 L2 winner instead. It never fakes a winner.

**Mutator:** deterministic template mutator; LLM path available with a key. Recordings use the template path unless `GROQ_API_KEY`, `GEMINI_API_KEY`, or `LIFT_LLM_API_KEY` is set.

| File | What it shows |
| --- | --- |
| `t2a-gate-launch` | Empty prompt, typed orch command (`--traffic-n 1000`). Scan → template mutator → axe gate (hostile canary rejected with `added axe rules` / `nodes increased`) → Flag agent launches the experiment. Traffic starts (SIMULATED). |
| `t2b-approve-rollout` | Readable decision line (`Flagsmith: N% \| Agent threshold: 95% \| Decision: …`) held next to the experiment. The harness types `APPROVE <id>` only at `chance_to_win >= 0.95`, then `complete()` and the env-default winner at 100%. Otherwise KEEP COLLECTING, no APPROVE. |
| `t1-experiment` | Real Flagsmith Experiment results page, opened by a visible pointer click on Experiments then the experiment row. Arms panel held, then a visible scroll to Analysis. |
| `l2a-gen1-champion` | Starts on a prompt or the gen-1 experiment (not the T2 experiment). Gen-1 analyst result arriving; champion line held. |
| `l2b-gen2-gate-rollout` | Live gen-2 axe gate. Control is labelled `Control = gen-1 champion full-v1`. Outcome line held. If gen-2 is below 0.95: `Gen-2 inconclusive (chance_to_win X < 0.95 after N visits); champion stays`. Champion is already at the measured ceiling (UA `:focus-visible` on Place order). Hostile canary reason is `added axe rules` / `nodes increased`. |

## Persona model (honest traffic)

Every arm uses the **same** base keep rate. A visit converts only if the persona succeeds on the **served** variant:

- **Mouse (70%)** — pointer path (hover menu works on control).
- **Keyboard (10%)** — real Tab/Enter; fails if submit is not in the tab order, Enter does not activate it, or Place order has no visible focus indicator (WCAG 2.4.7). Applied identically to every arm. The gen-1 champion already has UA `:focus-visible` on Place order, so it is at the measured ceiling; gen-2 outline/type/cursor challengers do not change persona outcomes.
- **Screen-reader (10%)** — accessibility tree names; fails on unlabeled controls.
- **Low-vision (10%)** — 200% zoom plus computed-style contrast below 4.5:1 (`#terms-copy`, `label[for=terms]`, or `.terms`).

Then a shared seeded random abandon rate is applied. The seed and `runId` (`LIFT_RUN_ID`) are logged. Identical surfaces get statistically equal rates; moving an accessibility barrier to the other arm flips the winner. Name-keyed keep rates are not used.

Traffic is labelled SIMULATED. Each clip is one continuous live take (no stitching). Recordings do not end on the sign-in page.

Recorded 27 Nov 2026 against self-hosted Flagsmith **2.295.2**. The Flag agent is the role that drives Flagsmith. Time saved is labelled **vs est. manual 115 min (itemised estimate)**.
