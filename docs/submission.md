# Toggle Wars submission (draft)

Track: **Test Something Real**. Product: Flagsmith.

## Short description

Lift ships WCAG accessibility fixes behind Flagsmith flags, runs them as native Flagsmith Experiments on simulated conversion traffic, and lets Flagsmith’s `chance_to_win` roll a fix out or pull it. An agent creates the flags, metric, warehouse connection, and experiment; Playwright personas send `trackEvent` conversions; Lift completes the experiment through the Admin API (`rollout_decision`) and verifies new identities see the winning arm.

**Live fleet (SIMULATED):** 32.2% median conversion lift across 7 real fixes (IQR 31.0%–50.5%). An eighth site, pricing, is a designed-to-lose check of `pull_to_control` (observed −50.2%; 60% of treatment conversions dropped by construction, expected −50%). Traffic is Playwright bots with an assumed 70/10/10/10 persona mix, not humans.

## How Flagsmith is used

Flagsmith is the mechanism, not a wrapper:

- **Multivariate flags** — bundled `<site>_a11y` experiment (`control` vs keyed `treatment`) plus per-barrier flags the page reads.
- **Identities and traits** — Node runner: `simulated`, `persona`, `converted` (on success), and `site`. Browser JS SDK: init with `simulated: false` and `site`, then `converted` on success. Segments are not used for targeting.
- **JS SDK** — live browsers bucket with `@flagsmith/flagsmith@12.4.0`.
- **Node SDK local evaluation** — bots get a variant without a Flags API call per visitor.
- **Events** — `trackEvent` / `flushEvents` into `events.api.flagsmith.com`.
- **Warehouse** — managed `warehouse_type: flagsmith` on the free cloud tier; required before experiments can be created.
- **Metrics + Experiments** — create, start, poll `results` / `results/refresh` for `chance_to_win`, complete with `rollout_decision`.
- **v2 feature versioning** — `PATCH /api/__future__/environments/{key}/features/{id}/` sets the environment default after complete.
- **Admin API keys** — organisation token to manage; client key for browsers; server-side key for local eval.

Lift’s own Beta-Binomial math is labelled `local_bayesian` and does not complete a Flagsmith experiment unless `LIFT_ALLOW_LOCAL_DECISION=true`.

## Track, links, license

| Field | Value |
|-------|--------|
| Track | Test Something Real |
| Repo | https://github.com/VasuBansal7576/lift |
| Dashboard | https://vasubansal7576.github.io/lift/ |
| Demo script | [docs/demo-script.md](demo-script.md) |
| Flagsmith org / project | Lift / Lift (`42178` / `56470`), Development |
| Experiments | 632, 635, 637, 640, 642, 644, 647, 651 |
| License | MIT |
| Related | [curbcut](https://github.com/VasuBansal7576/curbcut) |

## Simulated disclosure (paste as-is)

All traffic is simulated. Playwright persona bots (mouse, keyboard-only, screen-reader, contrast-threshold / low-vision) complete each site’s conversion flow. Dashboard numbers, identity traits, and README figures are labelled SIMULATED. The persona mix is an assumption (70/10/10/10), not measured web traffic. Blocked personas convert 0% in control, so the size of the lift is set by that mix — this demonstrates the Flagsmith pipeline, not real-user impact. Pricing is designed to lose (60% of treatment conversions dropped by construction).
