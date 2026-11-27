# Phase A evidence recordings

Recordings live in `artifacts/fir-9-a/` by default (gitignored). Override with `EVIDENCE_DIR`. Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the real checkout page on `http://127.0.0.1:4174` (viewport 1280×800, video + trace on, slowMo). Playwright writes raw files under `playwright/`; the collect script copies clear names next to them.

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. An on-page banner (test-only) shows the axe-core violation count, including the gate rules `label`, `button-name`, `color-contrast`. Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page, then `runtime/runtime.js` applies `checkout-treatment.json`. Labels appear, Shop becomes a button, terms contrast is fixed, Place order becomes a labelled button. Banner shows axe dropping **4 → 1**. Gate rules `label`, `button-name`, and `color-contrast` clear. The leftover rule is `region` on `.sim-banner` (the fixture “Demo store…” note sits outside `header`/`main` landmarks). It is not a gate rule, not one of the five checkout barriers, and `replaceTag` cannot emit landmark tags. |
| `03-keyboard-submit-once.webm` + `.trace.zip` | After the treatment spec, **no mouse**: Tab to Shop, Enter opens the menu (`toggleDisclosure` + page CSS `.hover-menu.lift-open`), Tab to Checkout, Enter, fill the form, Tab to Place order, one Enter. Banner reports exactly one original click; confirmation is visible. |
| `04-typed-body-tag.webm` + `.trace.zip` | Typed injectCSS `{ tag: 'body' }` is rejected at parse time. Place order markup and the page HTML are unchanged. |
| `04-typed-opacity.webm` + `.trace.zip` | Typed `property: 'opacity'` is rejected at parse time. Body opacity and Place order markup stay unchanged. |
| `04-typed-not-state.webm` + `.trace.zip` | Typed `state: 'not(x)'` is rejected at parse time. The page is unchanged. |
| `04-typed-body-class-anchor.webm` + `.trace.zip` | A class anchor that matches `<body class="lift-atk">` is accepted at parse (class+declarations are otherwise legal) and **undone at apply time** (page-container / forbidden-host backstop). Body color is unchanged. |
| `04-typed-color-eq-background.webm` + `.trace.zip` | `{ color: #fff, background-color: #fff }` is rejected (parse-time contrast 4.5:1). The page is unchanged. |
| `04-typed-hover-invisible.webm` + `.trace.zip` | State rule `hover { color }` is rejected at parse time. Color/background are forbidden on hover/focus/focus-visible/active. The page is unchanged. |
| `04-replace-button-to-span.webm` + `.trace.zip` | After the treatment spec, `replaceTag` button→span on Place order is refused (interactive host + accessibility monotonicity). The control stays a `BUTTON` with `type=button`. |
| `04-late-content.webm` + `.trace.zip` | A legal injectCSS spec is applied, then late DOM content with white-on-white text is inserted. The MutationObserver re-runs contrast, undoes the spec, and records a fail-open event. |
| `04-descendant-contrast.webm` + `.trace.zip` | A parent match has acceptable contrast; a text-bearing descendant does not. The spec is undone at apply time. |
| `05-sticky-identity.webm` + `.trace.zip` | The page itself renders `document.cookie` (including `lift_vid=...`) plus `data-variant` / `#flag-status` before and after reload. The cookie string is read from the page, not injected by the runner. **Variant stability is only meaningful with a live Flagsmith environment key.** When that key is present and Flagsmith assigns a variant, it stays the same across reload; without it the spec falls back to `?lift_variant=control`. |

The on-page banner is injected only by this evidence spec (`#lift-evidence-banner`). The cookie readout (`#lift-cookie-readout`) is also evidence-only. Neither is part of the product runtime.
