# Track 1 / Track 2 recordings

Media files are not committed (see `.gitignore`). Copies live in `artifacts/t1-t2/`, `/opt/cursor/artifacts/`, and the Agent Store.

Flagsmith URLs are real. The public client environment key in `/environment/<key>/` is acceptable and is not masked. Addresses are never rewritten with `history.replaceState`. Login happens before ffmpeg starts. After ffmpeg starts, navigation is a visible pointer click or visible omnibox typing; reloads are a visible F5 with `performance` navigation type `reload`.

**Approval:** the recording harness typed `APPROVE <id>` in the on-screen xterm **standing in for the human approver**. A human did not type it. The terminal echo says so before the phrase is typed.

| File | What it shows |
| --- | --- |
| `t2a-gate-launch` | Scan → template mutator → axe gate (hostile canary rejected with `added axe rules` / `nodes increased`) → Flag agent launches the experiment. Traffic starts (SIMULATED). |
| `t2b-approve-rollout` | Flagsmith `/results` after traffic. The harness types `APPROVE <id>` standing in for the human approver only when `chance_to_win >= 0.95`; otherwise it leaves the experiment collecting and does not type APPROVE. |
| `t1-experiment` | Real Flagsmith Experiment results page, reached by Organisation → Lift → Experiments → the honest t2 experiment. |
| `l2a-gen1-champion` | Generation-1 Flagsmith result and the champion arm. |
| `l2b-gen2-gate-rollout` | Generation-2 gate (champion is control) + experiment. If gen-2 does not beat the champion (`chance_to_win < 0.95`), the harness does not type APPROVE and the champion stays. Hostile canary reason is `added axe rules` / `nodes increased`. |

## Persona model (honest traffic)

Every arm uses the **same** base keep rate. A visit converts only if the persona succeeds on the **served** variant:

- **Mouse (70%)** — pointer path (hover menu works on control).
- **Keyboard (10%)** — real Tab/Enter; fails if submit is not in the tab order or Enter does not activate it.
- **Screen-reader (10%)** — accessibility tree names; fails on unlabeled controls.
- **Low-vision (10%)** — 200% zoom plus computed-style contrast below 4.5:1.

Then a shared seeded random abandon rate is applied. The seed is logged (`LIFT_TRAFFIC_SEED`). Identical surfaces get statistically equal rates; moving an accessibility barrier to the other arm flips the winner. Name-keyed keep rates are not used. If generation 2 does not beat the champion, the champion stays.

Traffic is labelled SIMULATED. Each clip is one continuous live take (no stitching). Recordings do not end on the sign-in page.

Recorded 27 Nov 2026 against self-hosted Flagsmith **2.295.2**. The Flag agent is the role that drives Flagsmith. The mutator is a template mutator; LLM optional when a key is set. Time saved is labelled **vs est. manual 115 min (itemised estimate)**.
