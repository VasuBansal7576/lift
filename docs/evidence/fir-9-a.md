# Phase A evidence recordings

Recordings live in `/opt/cursor/artifacts/fir-9-a/` (not committed). Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the real checkout page on `http://127.0.0.1:4174` (viewport 1280×800, video + trace on, slowMo). Playwright writes raw files under `playwright/`; the collect script copies clear names next to them.

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. An on-page banner (test-only) shows the axe-core violation count, including the gate rules `label`, `button-name`, `color-contrast`. Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page, then `runtime/runtime.js` applies `checkout-treatment.json`. Labels appear, Shop becomes a button, terms contrast is fixed, Place order becomes a labelled button. Banner shows axe violations dropping and the gate clearing. |
| `03-keyboard-submit-once.webm` + `.trace.zip` | After the treatment spec: keyboard opens checkout, fills the form, Tabs to Place order, one Enter. Banner reports exactly one original click; confirmation is visible. |
| `04-malicious-fail-open.webm` + `.trace.zip` | A spec with CSS url-smuggling (`h1{color:"/*"; background-image:url(...)}`) and `:is(body){opacity:0}` is rejected. Place order markup and body opacity stay unchanged. |
| `05-sticky-identity.webm` + `.trace.zip` | First load mints `lift_vid`; reload keeps the same cookie. Banner prints the id before and after. Path=/ is host-wide (fine on a demo `*.github.io` host). |

The on-page banner is injected only by this evidence spec (`#lift-evidence-banner`). It is not part of the product runtime.
