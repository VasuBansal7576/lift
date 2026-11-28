# Edge Worker live recordings

Proof videos are **continuous screen captures** of a real browser window (address
bar visible) plus a real terminal, against **self-hosted Flagsmith 2.295.2**.
They are not Playwright webm, not stitched stills, and not overlay text standing
in for evidence.

```bash
# Flagsmith already up at http://127.0.0.1:8000 (image flagsmith/flagsmith:2.295.2)
# edge/.dev.vars already has the public client key (never display it)
npm run edge:put-spec -- runtime/checkout-treatment.json
npm run edge:record
```

`live.mjs` starts the edge-origin site and `wrangler dev`, then drives headed
Chromium. A human or Cloud Agent captures the desktop (URL bar, DevTools,
terminal) with the VM screen recorder.

Scenes (also exported as `SCENES` from `live.mjs`):

| File | Must show |
| --- | --- |
| `edge-zero-code-fix` | Terminal `git status` clean. Origin URL with axe count. Worker URL with lower axe count. Keyboard checkout completing. |
| `edge-flag-flip` | Flagsmith UI weight 0 → 100, save. Worker reload. Elements: Shop `span` → `button`. |
| `edge-fail-open` | Terminal `docker compose stop`. Reload. Network/Elements: no Lift scripts. Page + checkout still work. |
| `edge-sticky` | Application → Cookies `lift_vid`, reload, same value. |

Never show keys, tokens, or passwords (including `edge/.dev.vars` and shell history).
