# Phase A evidence recordings

Recordings live in `artifacts/fir-9-a/` by default (gitignored). Override with `EVIDENCE_DIR`. Produce them with:

```bash
npm run evidence:a
```

That runs `tests/evidence/phase-a.spec.ts` against the checkout page (viewport 1280×800, video + trace on, slowMo). Flagsmith-dependent clip `05-sticky-identity` uses `playwright.evidence.config.ts` (no `--allow-mock`). The typed/fail-open clips use `playwright.evidence.mock.config.ts`. Playwright writes raw files under `playwright/`; the collect script copies clear names next to them. Headed clips 01–05 are recorded with `node scripts/record-phase-a.mjs` (xdotool pointer + typed DevTools Console).

| File | What it shows |
| --- | --- |
| `01-control-barriers.webm` + `.trace.zip` | Control checkout with the five barriers visible. Typed `axe.run()` in the DevTools Console lists the gate rules `label`, `button-name`, `color-contrast` (and `region`). Shop trigger is a span; Place order is a div. |
| `02-treatment-before-after.webm` + `.trace.zip` | Same control page. Typed `axe.run()` in the DevTools Console lists rule ids **before** the spec, the treatment applies on this page (not a hard cut), then typed `axe.run()` lists **after**. Labels appear, Shop is promoted in place, terms contrast is fixed, Place order is promoted. Gate rules clear; leftover `region` on `.sim-banner`. |
| `03-keyboard-submit-once.webm` + `.trace.zip` | After the treatment spec, **no mouse**: Tab to Shop, Enter opens the menu (`toggleDisclosure` + page CSS `.hover-menu.lift-open`), Tab to Checkout, Enter, fill the form, Tab to Place order, one Enter. Typed `clicks` in the DevTools Console returns `1`; confirmation is visible. |
| `04-typed-body-tag.webm` + `.trace.zip` | Typed injectCSS `{ tag: 'body' }` is rejected at parse time. Place order markup and the page HTML are unchanged. |
| `04-typed-opacity.webm` + `.trace.zip` | Typed `property: 'opacity'` is rejected at parse time. Body opacity and Place order markup stay unchanged. |
| `04-typed-not-state.webm` + `.trace.zip` | Typed `state: 'not(x)'` is rejected at parse time. The page is unchanged. |
| `04-typed-body-class-anchor.webm` + `.trace.zip` | A class anchor that matches `<body class="lift-atk">` is accepted at parse (class+declarations are otherwise legal) and **undone at apply time** (page-container / forbidden-host backstop). Body color is unchanged. |
| `04-typed-color-eq-background.webm` + `.trace.zip` | `{ color: #fff, background-color: #fff }` is rejected (parse-time contrast 4.5:1). The page is unchanged. |
| `04-typed-hover-invisible.webm` + `.trace.zip` | State rule `hover { color }` is rejected at parse time. Color/background are forbidden on hover/focus/focus-visible/active. The page is unchanged. |
| `04-replace-button-to-span.webm` + `.trace.zip` | After the treatment spec, `replaceTag` is parse-rejected (`use promoteToControl`). Place order stays the original `DIV` with `role=button`. |
| `04-late-content.webm` + `.trace.zip` | A legal injectCSS spec is applied, then late DOM content with white-on-white text is inserted. The recording **selects** the ghost text and logs computed color, background, and contrast ratio in the DevTools Console, then the MutationObserver undoes the spec. |
| `04-descendant-contrast.webm` + `.trace.zip` | A parent match has acceptable contrast; a descendant ghost line does not. The fixture stays at normal size inside the checkout box. The recording selects the ghost text and logs contrast in the Console, then undoes the spec. The checkout form stays intact. |
| `04-promote-keeps-handlers.webm` + `.trace.zip` | A `div` is promoted in place. The original click handler fires on mouse and keyboard (an accordion opens). The real checkout form still submits once and shows the order confirmation. No stray Pay now control. |
| `04-focus-within-color.webm` + `.trace.zip` | Typed `focus-within { color }` is rejected. State rules may set only `outline-*` and `text-decoration-*`. |
| `04-covered-control.webm` + `.trace.zip` | A fixed cookie bar grown with font-size/padding/min-height/line-height **visibly overlaps** Buy (Buy outlined in red) during **BAD STATE**, then the spec is undone so Buy is hittable again. |
| `04-reapply-guard.webm` + `.trace.zip` | The same spec id is applied twice (second apply is a noop). A spec-caused white-on-white descendant is selected with a contrast readout against the **effective** (ancestor-composited) background. The guard undoes; Theme panel is readable again. |
| `04-cssom-insertRule.webm` + `.trace.zip` | A legal injectCSS spec is applied, then `CSSStyleSheet.insertRule` paints white-on-white. The guard sees the CSSOM change and undoes. The restored readout uses the effective background (≈17:1 on white), not `rgba(0,0,0,0)`. |
| `04-promote-no-double.webm` + `.trace.zip` | A host with its own Enter `preventDefault()` + `click()` handler is promoted. Typed/logged `clicks` in the DevTools Console is **1**. |
| `04-guard-page-modal.webm` + `.trace.zip` | A contrast fix is applied, then a page modal appears. Banner: **page-caused, fix kept**. The injected CSS stays. |
| `04-guard-spec-caused.webm` + `.trace.zip` | A spec-caused white-on-white descendant still undoes the injected CSS. |
| `04-dropdown-keeps-fix.webm` + `.trace.zip` | A color-only fix on a nav whose submenu opens over a control keeps the fix. |
| `04-sticky-hit-target-covers-rejected.webm` + `.trace.zip` | A min-height/min-width link in a 40px sticky header grows over Buy. BAD STATE shows the overlap with Buy outlined; then the spec is rejected and Buy is hittable. |
| `04-capture-click-no-double.webm` + `.trace.zip` | A capture-phase Enter handler clicks without preventDefault. Typed/logged `clicks` in the DevTools Console is **1**. |
| `04-label-in-name-attributed.webm` + `.trace.zip` | `aria-label="Checkout"` is applied, then the visible text becomes `Checkout (2)`. The accessible name is logged from the DOM on each change; the attribute op is undone. |
| `04-overflow-matches-contrast.webm` + `.trace.zip` | New `.item` matches past the 50-match cap are #111-on-#111, selected with an effective-background readout, then the spec is undone and they are readable. The restored readout is white on `#111` at **18.88:1**. |
| `04-page-contrast-no-loop.webm` + `.trace.zip` | The page flashes `#eee`/`#111` every 100 ms. `getRuntimeStats()` (undos, attributions) is logged to the Console for 8 seconds. Undos stay at **0** and the min-width fix is kept. |
| `04-attribution-keeps-focus.webm` + `.trace.zip` | injectCSS plus a page-caused colour change. The promoted control keeps its focus ring, a user-opened disclosure stays open, and the attributions counter increments. |
| `04-per-node-attribution.webm` + `.trace.zip` | Two probe nodes share one injectCSS colour rule. A page colour change on A and a spec-caused contrast fail on B are attributed by `LiftRuntime.getRuntimeStats()` (and `lastAttributions`); the spec is undone. |
| `04-cssom-edit-detected.webm` + `.trace.zip` | `cssRules[0].style.color = #eee` is detected and the spec is undone. |
| `05-sticky-identity.webm` + `.trace.zip` | DevTools Application → Cookies shows the minted `lift_vid` before and after a visible reload. The cookie is not injected by the runner. **Variant stability is only meaningful with a live Flagsmith environment key.** This clip runs without `--allow-mock` and without `?lift_variant=`. |

Evidence is the visible DevTools Console (`console.log` / `console.table`, or values typed live) or the app's own UI. Tests must not inject readout, banner, axe-panel, or cookie boxes.
