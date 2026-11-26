# Demo script (about 2 minutes 40 seconds)

Record in 1080p. Speak slower than feels natural. Every number on screen is **SIMULATED** traffic: Playwright persona bots, not humans. Do not say “users converted” or “we improved the web.”

**WebAIM figure (verified 2026-11-26):** [The WebAIM Million — 2026 report](https://webaim.org/projects/million/) states **95.9% of home pages had detected WCAG 2 failures** (February 2026 sample of the top 1,000,000 home pages; up from 94.8% in the 2025 analysis). Use **95.9%** and **2026**, not an older year.

## Shot list

| Time | On screen | Voiceover |
|------|-----------|-----------|
| **0:00–0:18** | WebAIM Million page, WCAG Conformance paragraph highlighted: “95.9% of home pages had detected WCAG 2 failures.” URL visible. | “The 2026 WebAIM Million found detected WCAG failures on 95.9 percent of the top million home pages. That is almost all of them. Lift asks a smaller question: if you fix those barriers, does conversion move — and can Flagsmith be the thing that decides.” |
| **0:18–0:38** | Northline Market checkout at `http://127.0.0.1:4174/checkout/?lift_variant=control`. Tab through the header. Shop is hover-only; focus skips the Checkout link. Banner: “Demo store. Experiment traffic is simulated.” | “Control. A keyboard user can see Shop, but Tab never opens it. The checkout link is in a hover menu. Mouse users are fine. That is a 2.1.1 barrier, not a new offer.” |
| **0:38–0:55** | Same page with `?lift_variant=treatment`. Tab reaches Shop, Enter opens Checkout. Footer: URL override. Cut to `sites/checkout/index.html` `data-barrier="hover_menu"` and the matching Flagsmith flag name. | “Treatment puts the same menu on the keyboard path, behind a Flagsmith flag. Lift does not patch production sites. It ships the fix as a flag so Flagsmith can experiment on it.” |
| **0:55–1:18** | Flagsmith UI: Development → Features → `checkout_a11y` multivariate flag (control vs keyed `treatment`). Then Experiments → experiment **632**. Hypothesis visible. | “This is a native Flagsmith Experiment, not a wrapper. Multivariate flag, 50/50 rollout, conversion metric. Lift created it with the Admin API. Identities and events go to Flagsmith. Lift does not pick the winner in application code.” |
| **1:18–1:38** | Terminal: a short slice of `npm run traffic` or a recorded fleet log. Lines like `lift-sim-… keyboard treatment converted` / `keyboard control blocked`. Optional: Node SDK snippet `getIdentityFlags` + `trackEvent`. | “Playwright bots walk the flow as mouse, keyboard, screen-reader, and low-vision personas. The Node SDK evaluates the experiment locally. Conversions are `trackEvent` into the Flagsmith warehouse. The mix is assumed — 70/10/10/10 — not measured traffic.” |
| **1:38–1:58** | Flagsmith experiment **632** results: control vs treatment n/sum, `chance_to_win`, lift CI. Then Lift dashboard row for checkout: rolled out, P(win) >99.9%, observed lift next to expected lift. | “Flagsmith’s `chance_to_win` is the decision. Lift waits until each arm’s n matches the local visit log, then completes the experiment. Checkout rolled out. The lift is about what you would expect from the persona mix: blocked people convert at zero in control.” |
| **1:58–2:18** | Split: checkout row “rolled out” vs Lumen Cloud pricing row **637** tagged **designed to lose (pipeline check)**, pulled to control, lift about −50%. Flagsmith complete payload: `rollout_decision: control`. | “Pricing is the other half. We injected a treatment-only extra step and dropped 60 percent of treatment conversions on purpose. Flagsmith pulled to control. The decision is not hard-coded. The loss is. That is a pipeline check of `pull_to_control`.” |
| **2:18–2:32** | Live dashboard https://vasubansal7576.github.io/lift/ (or local `:4173`). Black **SIMULATED TRAFFIC** banner. Headline: conversion lift across 7 sites, **32.2% median**. Pricing footnote visible. | “Seven real fixes. Median lift 32.2 percent, simulated traffic, assumed mix. Pricing sits outside the headline. This is Flagsmith running the experiment, not a claim about real users.” |
| **2:32–2:45** | Hold the dashboard. Fade. | “Accessibility work usually stops at a lint report. Lift puts the fix behind a flag and lets Flagsmith keep or kill it on a conversion metric. The traffic is fake so the pipeline can be shown end to end. The mechanism is real.” |

Total: **2:45**. If you need to cut, drop the HTML/flag close-up at 0:38 and keep the keyboard demo.

## Recording checklist

### Commands (nothing live; reuse committed results)

```bash
npm install
npx playwright install chromium
npm run site -- --allow-mock          # http://127.0.0.1:4174
npm run dashboard                     # http://127.0.0.1:4173
```

Do **not** run `npm run fleet` or `npm run experiment` for this recording. Experiments **632–651** are already completed on Flagsmith Development.

### URLs to open

| What | URL |
|------|-----|
| WebAIM Million 2026 | https://webaim.org/projects/million/ |
| Checkout control (keyboard stuck) | http://127.0.0.1:4174/checkout/?lift_variant=control |
| Checkout treatment | http://127.0.0.1:4174/checkout/?lift_variant=treatment |
| Pricing (pipeline check) | http://127.0.0.1:4174/pricing/?lift_variant=treatment |
| Local dashboard | http://127.0.0.1:4173/ |
| GitHub Pages dashboard | https://vasubansal7576.github.io/lift/ |

### Flagsmith pages (org Lift, project 56470, environment Development `120798`)

| What | URL |
|------|-----|
| Feature `checkout_a11y` | https://app.flagsmith.com/project/56470/environment/120798 |
| Experiment 632 (checkout, rolled out) | https://app.flagsmith.com/project/56470/environment/120798/experiments/632 |
| Experiment 637 (pricing, pulled) | https://app.flagsmith.com/project/56470/environment/120798/experiments/637 |
| Warehouse | Environment Settings → Warehouse (must show **Connected**) |

Sign in before recording. Zoom the results table so `chance_to_win` and n/sum are readable. Keep the SIMULATED banner in frame on every site and dashboard shot.

### Spoken guardrails

- Say “simulated traffic” at least three times (open, traffic shot, dashboard).
- Do not say the 32.2% is a real-user lift.
- Do not say pricing “failed” as if the product was bad; say it was designed to lose.
- Cite WebAIM as **2026, 95.9%**, with the page on screen.
