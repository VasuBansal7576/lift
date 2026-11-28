# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/t1-t2/`, `/opt/cursor/artifacts/`, and the Agent Store.

Flagsmith URLs are real. The public client environment key in `/environment/<key>/` is acceptable and is not masked. Addresses are never rewritten with `history.replaceState`. Login happens before ffmpeg starts. After ffmpeg starts, navigation is a visible xdotool pointer move+click or visible omnibox typing; reloads are a visible F5 with `performance` navigation type `reload`.

**Recording config (must match `record-proof.ts`):** T2 uses `--traffic-n 1000` and `LIFT_ORCH_MAX_EXTRA_ROUNDS=0` (one pre-registered look, no optional stopping). L2 gen-1 uses `--traffic-n 400`; gen-2 uses `--traffic-n 240` (fixed horizon, disclosed by the conductor so warehouse can still infer). Seed `LIFT_TRAFFIC_SEED=20261127` unless overridden. Concurrency 16.

**Approval:** the recording harness types `APPROVE <id>` in the on-screen xterm **standing in for the human approver**. A human did not type it. The approve CLI itself prints `approved by: recording harness (stand-in for the human approver)` after the matching phrase. APPROVE is typed only when Flagsmith `chance_to_win >= 0.95`.

**Mutator:** deterministic template mutator; LLM path available with `GROQ_API_KEY`, `GEMINI_API_KEY`, or `LIFT_LLM_API_URL` + `LIFT_LLM_API_KEY`. Recordings use the template path unless those keys are set.

Every clip starts on a fresh empty `$` prompt. Every judged line is stdout from `cli.ts` / approve / analyst (no `echo` stand-ins).

| File | What it shows |
| --- | --- |
| `t2a-gate-launch` | Empty prompt, typed orch command (`--traffic-n 1000`). Scan → template mutator → axe gate (hostile canary rejected with `added axe rules` / `nodes increased`) → Flag agent launches the experiment. Click the current Running experiment and hold. |
| `t2b-approve-rollout` | Typed `--approve <id>`. Analyst decision line from the program, held. Harness types `APPROVE <id>`; CLI prints the stand-in disclosure; wait for `Rolled out full-v1. Experiment N completed`, then env-default `full-v1` at 100%. |
| `t1-experiment` | Typed `--results <id>`. Real Flagsmith Experiment results page, opened by a visible pointer click on the current experiment row. Arms panel held, then a visible scroll (wheel / Page_Down) to Analysis. |
| `l2a-gen1-champion` | Typed L2 gen-1 command. Gen-1 analyst result arriving live; conductor prints `gen-1 champion …` from data; click the current gen-1 experiment. |
| `l2b-gen2-gate-rollout` | Typed `--from-generation 2` with disclosed gen-2 `traffic-n 240`. Live gen-2 axe gate. Conductor prints `Control = gen-1 champion <id>` and the ceiling note from the champion spec. If gen-2 is below 0.95: `Gen-2 inconclusive (chance_to_win X < 0.95 after N visits); champion stays`. Click the gen-2 experiment. |

## Persona model (honest traffic)

Every arm uses the **same** base keep rate. A visit converts only if the persona succeeds on the **served** variant:

- **Mouse (70%)** — pointer path (hover menu works on control).
- **Keyboard (10%)** — real Tab/Enter; fails if submit is not in the tab order, Enter does not activate it, or Place order has no visible focus indicator (WCAG 2.4.7, `focus_visible`). Applied identically to every arm. The gen-1 champion already has UA `:focus-visible` on Place order, so it is at the measured ceiling; gen-2 outline/type/cursor challengers do not change persona outcomes.
- **Screen-reader (10%)** — accessibility tree names; fails on unlabeled controls.
- **Low-vision (10%)** — 200% zoom plus computed-style contrast below 4.5:1 (`#terms-copy`, `label[for=terms]`).

Then a shared seeded random abandon rate is applied. The seed and `runId` (`LIFT_RUN_ID`) are logged. Identical surfaces get statistically equal rates; moving an accessibility barrier to the other arm flips the winner. Name-keyed keep rates are not used.

Traffic is labelled SIMULATED. Each clip is one continuous live take (no stitching). Recordings do not end on the sign-in page.

Recorded 28 Nov 2026 against self-hosted Flagsmith **2.295.2**. The Flag agent is the role that drives Flagsmith. Time saved is labelled **vs est. manual 115 min (itemised estimate)**.
