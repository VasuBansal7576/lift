# Edge Worker recordings

Proof videos are live desktop captures produced with `npm run edge:record`
(`edge/record/live.mjs`) against **self-hosted Flagsmith 2.295.2**. They are
not Playwright webm and not stitched stills.

| File | What it shows |
| --- | --- |
| `edge-zero-code-fix.webm` | Terminal `git status` clean. Origin URL with axe count. Worker URL with a lower axe count. Keyboard checkout completing. |
| `edge-flag-flip.webm` | Flagsmith UI: treatment weight 0% → 100%, save. Worker reload. Elements: Shop `span` → `button`. |
| `edge-fail-open.webm` | `docker compose stop` on Flagsmith. Reload. No Lift scripts. Page and checkout still work. |
| `edge-sticky.webm` | Application → Cookies `lift_vid`, real reload, same value. |

`Server-Timing: liftwall` is wall time, not CPU. Real CPU is `wrangler tail`.
