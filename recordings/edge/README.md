# Edge Worker recordings

These four scenes were captured by hand (headed Chrome with the address bar
visible, DevTools, and a real terminal) against **self-hosted Flagsmith
2.295.2**. `edge/record/live.mjs` (`npm run edge:record`) is a helper for
bringing the origin, Worker, and headed Chromium up; it is not the camera.

They are not Playwright webm and not stitched stills.

| File | What it shows |
| --- | --- |
| `edge-zero-code-fix.mp4` | Terminal `git status` clean. Origin URL with axe count. Worker URL with a lower axe count. Keyboard checkout completing. |
| `edge-flag-flip.mp4` | Flagsmith 2.295.2 UI: treatment weight 0% → 100%, save. Worker reload. Elements: Shop `span` → `role=button`. |
| `edge-fail-open.mp4` | `docker compose stop` on Flagsmith. Reload. No Lift scripts. Page and checkout still work. |
| `edge-sticky.mp4` | Application → Cookies `lift_vid`, real reload, same value. |

`Server-Timing: liftwall` is wall time, not CPU. Real CPU is `wrangler tail`.
