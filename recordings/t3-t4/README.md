# T3 / T4 proof recordings

Live screen recordings (real terminal + headed Chrome with the **real, unaltered URL bar**). Green tests are not the proof. Never show server `ser.` keys, the admin token, or passwords. The public client environment key in a Flagsmith URL path is allowed.

`sanitizeFlagsmithUi` **asserts** on the DOM (inner text, form values, attributes, open shadow roots, same-origin iframes) before capture continues. It does not hide, cover, or rewrite anything on screen. A `ser.` match or secret label aborts the recording. This is not URL-bar masking.

Approval in `t4-skill-run.mp4` is sent to the real TTY as automated xdotool keystrokes (`xdotool type --delay 100` into the real terminal; the process reads `/dev/tty` and requires exactly `APPROVE <experimentId>`). The delay makes each character visible rather than a single burst. The harness types that line once and then waits for the `approved` marker; it does not retype blindly.

`t3-selfhost-up` cold-starts a **separate** compose project (`lift-selfhost-proof` on `127.0.0.1:8010`). It never stops or downs the shared `lift-selfhost` stack on `127.0.0.1:8000`. The terminal is opened first on an empty prompt; the typed command is exactly `npm run selfhost:proof-up`. Migrations run; their logs are hidden. Health polling is a single in-place `\r` line. After the clip, only that separate project is torn down.

Site-reads (`t3-site-reads-selfhosted-flag.mp4`) pass `lift_no_poll=1`. The Flagsmith JS SDK has `realtime: false` (SSE off; that is also the SDK default) and polling is opt-in via `startListening()`, which the page never calls. There is no fetch/EventSource monkeypatch. The identity value is the real Flagsmith response from `init` and stays frozen until a visible reload.

| File | Claim |
| --- | --- |
| `t3-selfhost-up.mp4` | Live cold start of compose project `lift-selfhost-proof` on port 8010: typed `npm run selfhost:proof-up`, compose starting, migrations (logs hidden), health polling with one in-place progress line, liveness HTTP 200 and version, then login to that instance's UI. Shared Flagsmith on :8000 is left running. |
| `t3-site-reads-selfhosted-flag.mp4` | Demo site `checkout_a11y=control` for identity `t3-control` (real checkout form: Shop control, labels, contrast); change the flag in the Flagsmith UI; visible reload-button click of the same identity shows the treatment form |
| `t3-dashboard.mp4` | Native Flagsmith UI: Lift project, flags (including skill flag variants/weights), a real `lift-demo-site` segment, the current experiment opened by id, and results. Closing Edit Feature glides onto the X, holds, then clicks; the pointer stays on the X while the panel closes. Recorded after `t4-skill-run` so Results are the T4 experiment. |
| `t4-skill-run.mp4` | Skill run: printed `guard ok`, axe-gate on a gate-only identity, unique `lift_a11y_stale_<ts>` created then `stale-flag deleted lift_a11y_stale_<ts>` with the API result, experiment start / `experiment_rollout` traffic (variant default allocation stays 0%; the experiment sets its own split), SIMULATED conversions (200 identities, equal base rates, conversion from measured a11y), `chance_to_win`, typed `APPROVE <id>`, rollout visible in the Flagsmith UI (Completed, 100%). "No results" for the stale flag is held at least 3s. Results cards (enrolled, chance to win, uplift) are scrolled into view and held still. |

Clips are also copied to `/opt/cursor/artifacts/` and `/cursor/stores/self/recordings/t3-t4/` when those paths exist, and only after a successful capture.
