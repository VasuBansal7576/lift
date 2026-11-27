# Phase A evidence recordings

Recordings live in `artifacts/fir-9-a/` by default (gitignored). Override with `EVIDENCE_DIR`. Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the real checkout page on `http://127.0.0.1:4174` (viewport 1280×800, video + trace on, slowMo). Playwright writes raw files under `playwright/`; the collect script copies clear names next to them.

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. An on-page banner (test-only) shows the axe-core violation count, including the gate rules `label`, `button-name`, `color-contrast`. Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page, then `runtime/runtime.js` applies `checkout-treatment.json`. Labels appear, Shop is promoted in place (`role=button` + tabindex), terms contrast is fixed, Place order is promoted in place with an accessible name. Banner shows axe dropping **4 → 1**. Gate rules `label`, `button-name`, and `color-contrast` clear. The leftover rule is `region` on `.sim-banner` (the fixture “Demo store…” note sits outside `header`/`main` landmarks). It is not a gate rule, not one of the five checkout barriers, and `promoteToControl` cannot emit landmark tags. |
| `03-keyboard-submit-once.webm` + `.trace.zip` | After the treatment spec, **no mouse**: Tab to Shop, Enter opens the menu (`toggleDisclosure` + page CSS `.hover-menu.lift-open`), Tab to Checkout, Enter, fill the form, Tab to Place order, one Enter. Banner reports exactly one original click; confirmation is visible. |
| `04-typed-body-tag.webm` + `.trace.zip` | Typed injectCSS `{ tag: 'body' }` is rejected at parse time. Place order markup and the page HTML are unchanged. |
| `04-typed-opacity.webm` + `.trace.zip` | Typed `property: 'opacity'` is rejected at parse time. Body opacity and Place order markup stay unchanged. |
| `04-typed-not-state.webm` + `.trace.zip` | Typed `state: 'not(x)'` is rejected at parse time. The page is unchanged. |
| `04-typed-body-class-anchor.webm` + `.trace.zip` | A class anchor that matches `<body class="lift-atk">` is accepted at parse (class+declarations are otherwise legal) and **undone at apply time** (page-container / forbidden-host backstop). Body color is unchanged. |
| `04-typed-color-eq-background.webm` + `.trace.zip` | `{ color: #fff, background-color: #fff }` is rejected (parse-time contrast 4.5:1). The page is unchanged. |
| `04-typed-hover-invisible.webm` + `.trace.zip` | State rule `hover { color }` is rejected at parse time. Color/background are forbidden on hover/focus/focus-visible/active. The page is unchanged. |
| `04-replace-button-to-span.webm` + `.trace.zip` | After the treatment spec, `replaceTag` is parse-rejected (`use promoteToControl`). Place order stays the original `DIV` with `role=button`. |
| `04-late-content.webm` + `.trace.zip` | A legal injectCSS spec is applied, then late DOM content with white-on-white text is inserted. The recording **selects** the ghost text and shows an on-screen readout of computed color, background, and contrast ratio during **BAD STATE**, then the MutationObserver undoes the spec and shows **UNDONE** with the restored ratio. |
| `04-descendant-contrast.webm` + `.trace.zip` | A parent match has acceptable contrast; a descendant ghost line does not. The fixture stays at normal size inside the checkout box. The recording selects the ghost text, shows the contrast readout during **BAD STATE**, then undoes the spec. The checkout form stays intact. |
| `04-promote-keeps-handlers.webm` + `.trace.zip` | A `div` is promoted in place. The original click handler fires on mouse and keyboard (an accordion opens). The real checkout form still submits once and shows the order confirmation. No stray Pay now control. |
| `04-focus-within-color.webm` + `.trace.zip` | Typed `focus-within { color }` is rejected. State rules may set only `outline-*` and `text-decoration-*`. |
| `04-covered-control.webm` + `.trace.zip` | A fixed cookie bar grown with font-size/padding/min-height/line-height **visibly overlaps** Buy (Buy outlined in red) during **BAD STATE**, then the spec is undone so Buy is hittable again. |
| `04-reapply-guard.webm` + `.trace.zip` | The same spec id is applied twice (second apply is a noop). Adding `.dark` still undoes the injected style — cumulative undos are kept. |
| `04-cssom-insertRule.webm` + `.trace.zip` | A legal injectCSS spec is applied, then `CSSStyleSheet.insertRule` paints white-on-white. The guard sees the CSSOM change and undoes. |
| `05-sticky-identity.webm` + `.trace.zip` | The page itself renders `document.cookie` (including `lift_vid=...`) plus `data-variant` / `#flag-status` before and after reload. The cookie string is read from the page, not injected by the runner. **Variant stability is only meaningful with a live Flagsmith environment key.** When that key is present and Flagsmith assigns a variant, it stays the same across reload; without it the spec falls back to `?lift_variant=control`. |

The on-page banner is injected only by this evidence spec (`#lift-evidence-banner`). The cookie readout (`#lift-cookie-readout`) is also evidence-only. Neither is part of the product runtime.
