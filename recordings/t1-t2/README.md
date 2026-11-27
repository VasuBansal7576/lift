# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/t1-t2/`, `/opt/cursor/artifacts/`, and the Agent Store.

Flagsmith URLs are real. The public client environment key in `/environment/<key>/` is acceptable and is not masked. Addresses are never rewritten with `history.replaceState`. Login happens before ffmpeg starts.

| File | What it shows |
| --- | --- |
| `t2-orchestrator-run` (662s) | Continuous run on `lift_orch_t2_120030` / experiment 19. Scanner → template mutator (LLM optional when a key is set) → axe gate → Flag agent creates the Flagsmith experiment → 220 SIMULATED visits → `chance_to_win=0.979` from `/results` → `WAITING_FOR_HUMAN_APPROVAL` → typed `APPROVE 19` on a TTY → rollout (`complete()` sets winner 100/0) → Flagsmith experiment page with **full-v1 rolled out to everyone** at the real URL. |
| `t1-experiment` (12s) | Real Flagsmith Experiment results page for experiment 19, reached by navigating Organisation → Lift → experiment. Enrolment 220, variants, 98% chance to win, full-v1 rolled out. |
| `l2-generation-2` (2205s) | Gen-1 experiment 20 reaches 99% (`full-v1`, 440 enrolled) from `/results`, is paused, champion becomes control. Gen-2 challengers are gated against the champion-applied axe baseline (g2-focus/type/cursor pass; hostile contrast rejected). Experiment 21 traffic (SIMULATED) reaches `chance_to_win=0.953` for **g2-type**. Typed `APPROVE 21`, rollout, Flagsmith shows **g2-type rolled out to everyone** at the real URL. |

Traffic is labelled SIMULATED. Long stretches are recorded at 1× (no speed-up overlay). Recordings do not end on the sign-in page.

Recorded 27 Nov 2026 against self-hosted Flagsmith **2.295.2**. The Flag agent is the role that drives Flagsmith. The mutator is a template mutator; LLM optional when a key is set. Time saved is labelled **vs est. manual 115 min (itemised estimate)**.
