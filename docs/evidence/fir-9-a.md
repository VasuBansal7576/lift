# Phase A evidence recordings

Recordings live in `artifacts/fir-9-a/` by default (gitignored). Override with `EVIDENCE_DIR`. Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the real checkout page on `http://127.0.0.1:4174` (viewport 1280×800, video + trace on, slowMo). Playwright writes raw files under `playwright/`; the collect script copies clear names next to them.

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. An on-page banner (test-only) shows the axe-core violation count, including the gate rules `label`, `button-name`, `color-contrast`. Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page. An on-page panel runs `axe.run()` and lists rule ids plus node counts **before** the spec, the treatment applies on this page (not a hard cut), then the panel lists **after**. Labels appear, Shop is promoted in place, terms contrast is fixed, Place order is promoted. Gate rules clear; leftover `region` on `.sim-banner`. |
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
| `04-reapply-guard.webm` + `.trace.zip` | The same spec id is applied twice (second apply is a noop). A spec-caused white-on-white descendant is selected with a contrast readout against the **effective** (ancestor-composited) background. The guard undoes; Theme panel is readable again. |
| `04-cssom-insertRule.webm` + `.trace.zip` | A legal injectCSS spec is applied, then `CSSStyleSheet.insertRule` paints white-on-white. The guard sees the CSSOM change and undoes. The restored readout uses the effective background (≈17:1 on white), not `rgba(0,0,0,0)`. |
| `04-promote-no-double.webm` + `.trace.zip` | A host with its own Enter `preventDefault()` + `click()` handler is promoted. The on-screen counter shows **activations: 1**. |
| `04-guard-page-modal.webm` + `.trace.zip` | A contrast fix is applied, then a page modal appears. Banner: **page-caused, fix kept**. The injected CSS stays. |
| `04-guard-spec-caused.webm` + `.trace.zip` | A spec-caused white-on-white descendant still undoes the injected CSS. |
| `04-dropdown-keeps-fix.webm` + `.trace.zip` | A color-only fix on a nav whose submenu opens over a control keeps the fix. |
| `04-sticky-hit-target-covers-rejected.webm` + `.trace.zip` | A min-height/min-width link in a 40px sticky header grows over Buy. BAD STATE shows the overlap with Buy outlined; then the spec is rejected and Buy is hittable. |
| `04-capture-click-no-double.webm` + `.trace.zip` | A capture-phase Enter handler clicks without preventDefault. The on-screen counter shows **activations: 1**. |
| `04-label-in-name-attributed.webm` + `.trace.zip` | `aria-label="Checkout"` is applied, then the visible text becomes `Checkout (2)`. A live on-page panel recomputes the accessible name from the DOM on each change; the attribute op is undone. |
| `04-overflow-matches-contrast.webm` + `.trace.zip` | New `.item` matches past the 50-match cap are #111-on-#111, selected with an effective-background readout, then the spec is undone and they are readable. The restored readout is white on `#111` at **18.88:1**. |
| `04-page-contrast-no-loop.webm` + `.trace.zip` | The page flashes `#eee`/`#111` every 100 ms. Live counters (style mutations/s, loads/s, undos, attributions, elapsed s) update every 250 ms for 8 seconds. Undos stay at **0** and the min-width fix is kept. |
| `04-attribution-keeps-focus.webm` + `.trace.zip` | injectCSS plus a page-caused colour change. The promoted control keeps its focus ring, a user-opened disclosure stays open, and the attributions counter increments. |
| `04-per-node-attribution.webm` + `.trace.zip` | Node A is page-caused `#eee` on white; node B is spec-caused `#111` on `#111`. The spec is undone. |
| `04-cssom-edit-detected.webm` + `.trace.zip` | `cssRules[0].style.color = #eee` is detected and the spec is undone. |
| `05-sticky-identity.webm` + `.trace.zip` | The page itself renders `document.cookie` (including `lift_vid=...`) plus `data-variant` / `#flag-status` before and after reload. The cookie string is read from the page, not injected by the runner. **Variant stability is only meaningful with a live Flagsmith environment key.** When that key is present and Flagsmith assigns a variant, it stays the same across reload; without it the spec falls back to `?lift_variant=control`. |

The on-page banner is injected only by this evidence spec (`#lift-evidence-banner`). The cookie readout (`#lift-cookie-readout`) is also evidence-only. Neither is part of the product runtime.
