# Phase A evidence recordings

Recordings live in `artifacts/fir-9-a/` by default (gitignored). Override with `EVIDENCE_DIR`. Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the real checkout page on `http://127.0.0.1:4174` (viewport 1280×800, video + trace on, slowMo). Playwright writes raw files under `playwright/`; the collect script copies clear names next to them.

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. An on-page banner (test-only) shows the axe-core violation count, including the gate rules `label`, `button-name`, `color-contrast`. Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page, then `runtime/runtime.js` applies `checkout-treatment.json`. Labels appear, Shop becomes a button, terms contrast is fixed, Place order becomes a labelled button. Banner shows axe dropping 4 → 1. Gate rules `label`, `button-name`, and `color-contrast` clear. The leftover rule is `region` on `.sim-banner` (the fixture “Demo store…” note sits outside `header`/`main` landmarks). It is not a gate rule, not one of the five checkout barriers, and `replaceTag` cannot emit landmark tags. |
| `03-keyboard-submit-once.webm` + `.trace.zip` | After the treatment spec: hover opens Shop (page CSS owns `display`; injectCSS v0 cannot emit `display` or combinators), then keyboard fills the form, Tabs to Place order, one Enter. Banner reports exactly one original click; confirmation is visible. |
| `04-comment-smuggle.webm` + `.trace.zip` | A spec whose `injectCSS` still carries raw CSS text `h1{color:"/*"; background-image:url(...)}` is rejected (`rules` required). Place order markup is unchanged. |
| `04-is-body-opacity.webm` + `.trace.zip` | A spec with raw CSS `:is(body){opacity:0}` is rejected. That selector is unrepresentable in typed rules (no `:is`, no `body`/`html`/`head`/` :root` targets, no `opacity`). Place order markup and body opacity stay unchanged. |
| `05-sticky-identity.webm` + `.trace.zip` | The page itself renders `document.cookie` (including `lift_vid=...`) plus `data-variant` / `#flag-status` before and after reload. The cookie string is read from the page, not injected by the runner. When Flagsmith assigns a variant, it stays the same across reload. |

The on-page banner is injected only by this evidence spec (`#lift-evidence-banner`). The cookie readout (`#lift-cookie-readout`) is also evidence-only. Neither is part of the product runtime.
