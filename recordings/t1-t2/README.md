# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/t1-t2/`, `/opt/cursor/artifacts/`, and the Agent Store.

Flagsmith URLs are real. The public client environment key in `/environment/<key>/` is acceptable and is not masked. Addresses are never rewritten with `history.replaceState`.

| File | What it shows |
| --- | --- |
| `t2-orchestrator-run` | Continuous run: scanner → template mutator (LLM optional when a key is set) → axe gate → Flag agent creates the Flagsmith experiment → SIMULATED traffic → `chance_to_win ≥ 0.95` from `/results` → `WAITING_FOR_HUMAN_APPROVAL` → a human types `APPROVE <id>` on a TTY → rollout → Flagsmith feature/experiment page with the winner at 100%. |
| `t1-experiment` | Real Flagsmith Experiment results page, reached by navigating Organisation → Lift → Experiments on camera. Enrolment, variants, and chance to win. |
| `l2-generation-2` | Gen-1 concluded by real `/results`; that champion becomes control; gen-1 is paused; gen-2 challengers are gated against the champion-applied axe baseline; SIMULATED traffic; `chance_to_win ≥ 0.95`; typed `APPROVE <id>`; rollout visible in Flagsmith. |

Traffic is labelled SIMULATED. Long stretches are recorded at 1× (no speed-up overlay). Login happens before ffmpeg starts so credentials are not on screen. Recordings must not end on the sign-in page.

Recorded against self-hosted Flagsmith **2.295.2**. The Flag agent is the role that drives Flagsmith. The mutator is a template mutator; LLM optional when a key is set.
