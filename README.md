# Lift

Hackathon entry for WeMakeDevs Toggle Wars (Flagsmith), **Test Something Real** track.

**Hypothesis:** fixing accessibility barriers raises conversions.

An agent scans a **fixture** checkout (data-barrier markers plus axe-core on control), ships WCAG fixes behind Flagsmith flags, runs a native Flagsmith experiment, sends simulated persona traffic, then auto-rolls out or pulls through the Flagsmith Admin API **when Flagsmith’s own `chance_to_win` is available**, or when `LIFT_ALLOW_LOCAL_DECISION=true`.

Live humans are assigned by the Flagsmith JS SDK (`@flagsmith/flagsmith@12.4.0`). Playwright bots get their variant from the **Node SDK** (Flagsmith local evaluation). The checkout page is then forced to that arm with `?lift_variant=` so the bot exercises the same HTML the identity was enrolled in — that is why bot pages show **URL override (no Flagsmith)** in the footer. The query is honoured only when the server overlays `allowMock: true` on `/config.json` in memory (never written to disk). Without Flagsmith, the live page will not bucket.

> **All traffic is simulated.** Playwright bots (mouse, keyboard-only, screen-reader, **contrast-threshold / low-vision**) attempt checkout. Numbers on the dashboard, identity traits, and this README are labelled **SIMULATED**. This demonstrates the pipeline; it is not evidence about real users.

Hard deadline 29 Nov 2026 20:00 IST. This branch is the **fleet**: one checkout plus additional demo sites, each with its own Flagsmith experiment.

## What this branch contains

| Path | Role |
|------|------|
| `sites/checkout/` plus 7 other fixtures | Distinct conversion flows, 3–5 WCAG barriers each, shared SDK/personas |
| `shared/catalog.ts` | Site list, flags, metrics, first-failure blockedBy |
| `agent/` | Fixture scan → bootstrap Flagsmith flags/metrics/experiment → decide → complete/rollout |
| `traffic/` | Seeded Playwright personas + Node SDK local evaluation |
| `dashboard/` | Static GitHub Pages app (`results.json` + `sites/*.json`) |
| `docker-compose.flagsmith.yml` | Official Flagsmith compose (self-host) |

## Barriers (control = broken, treatment = fixed)

The **bundled native experiment** is `checkout_a11y` (`control` vs keyed variant `treatment`). Each barrier also has its own flag; the site reads those flags. Dashboard copy: **barrier flags wired, bundled experiment**.

| Flag / id | WCAG | Who it blocks in control |
|-----------|------|--------------------------|
| hover-only Shop → Checkout menu | 2.1.1 | keyboard, screen-reader |
| unlabeled bag icon | 4.1.2 | screen-reader |
| `div` Place order (not focusable) | 2.1.1 / 4.1.2 | keyboard, screen-reader |
| email/card fields with no `<label>` | 1.3.1 / 3.3.2 | screen-reader |
| terms checkbox with no accessible name | 4.1.2 / 1.3.1 | screen-reader |
| grey-on-grey terms copy (~1.4:1) | 1.4.3 | contrast-threshold persona (simulated) |

Mouse users still convert in control (they can hover, click the glyph, fill by position, check the box). That is the point: the lift is accessibility, not a new offer.

The **low-vision / contrast-threshold persona (simulated)** uses a real 200% zoom (`deviceScaleFactor` + CSS zoom that affects layout) as a **realism step**. The **outcome is decided by the WCAG 4.5:1 contrast threshold** on computed colours, not by whether the zoom itself blocked the task. Unparsed colours throw; they are not skipped. Translucent colours are composited over the background or rejected.

The scanner looks for `data-barrier` markers in the fixture HTML. It does **not** crawl unknown sites. Playwright also runs axe-core against control and reports the violations it finds.

## Persona mix (assumption, not data)

Default: **mouse 70%, keyboard 10%, screen-reader 10%, low-vision 10%** (`LIFT_PERSONA_MIX`). This is a modelling assumption, not a measurement of the web. **Lift is a function of the assumed share of keyboard, screen-reader and low-vision users** — those personas are blocked in control and succeed in treatment (subject to a seeded ~75% baseline completion probability that applies to both arms when unblocked). **Lift’s own floors** (not Flagsmith’s) are **50 identities and 5 conversions per arm** — they are not a reason to pick 10% minority weights. The assumed mix and this run’s realised mix are shown next to the dashboard headline.

## Flagsmith features used

Designed against [Flagsmith Experimentation](https://docs.flagsmith.com/experimentation) and the [coding-agent setup prompt](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent).

| Feature | Cloud free plan (app.flagsmith.com) | Self-hosted OSS compose |
|---------|-------------------------------------|-------------------------|
| Multivariate flags + keyed variants | Yes | Yes |
| Identities + traits (`simulated`, `persona`, `converted`) | Yes | Yes |
| Management API (create flags, start/complete experiments) | Yes (org API token) | Yes |
| Native **Experiments** + **Metrics** + Identities | **Yes** on the Lift free-plan org | Yes (`EXPERIMENTATION_ENABLED=true`) |
| Managed Flagsmith warehouse (`warehouse_type: flagsmith`) | **Cloud-only** | Self-host: `warehouse_type: postgres` + `config.source: flagsmith_database` |
| SDK events | `https://events.api.flagsmith.com/` | `http://localhost:8000/api/` |
| Win probability (`chance_to_win`) | After warehouse is **Connected**. Lift waits for its own 50/5 floors before treating `chance_to_win` as a decision | Same API |
| Complete → rollout | `POST .../complete/` then GET to assert `rollout_decision` | Yes |

**Gap (self-host vs cloud):** native Experiments **is** on OSS. The missing piece is the **managed warehouse**. If the warehouse is not **Connected**, bootstrap warns and prints how to click **Send your first event**. Local Beta-Binomial math is labelled `local_bayesian` and **does not complete** the Flagsmith experiment unless `LIFT_ALLOW_LOCAL_DECISION=true`.

### API budget (stay under 50k/month)

Simulated traffic uses `@flagsmith/nodejs` **local evaluation** and batched events (`maxBuffer` default 1000, flushed on close). Playwright does **not** call the JS SDK per bot. Checkout JS SDK is for live humans only (`https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm`).

## Quick start

```bash
cp .env.example .env
# fill FLAGSMITH_* from cloud or from a local instance
npm install
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run test:e2e
```

### Cloud (live demo)

Org **Lift** (`42178`), project **Lift** (`56470`), environments Development and Production.

1. Create an Organisation API token (Organisation Settings → API Access).
2. Copy the Development **client** key and **server-side** key.
3. Environment Settings → Warehouse → enable **Flagsmith**. If status is Pending Connection, click **Send your first event**.
4. Put them in `.env` (see `.env.example`).
5. `npm run bootstrap`
6. `npm run experiment` (serves the checkout itself; reuses port 4174 if `npm run site` is already up). Then `npm run decide` is not required.
7. `npm run dashboard` — banner says **SIMULATED TRAFFIC**. Headline source is `flagsmith` or `local_bayesian`.

### Self-host (local dev)

```bash
npm run flagsmith:up
# Create the first user, org, project, API token, enable Warehouse → Flagsmith database
npm run bootstrap
npm run experiment
```

## Tests

```bash
npm run typecheck
npm run test:unit    # payloads, decide/complete, stats, scanner, contrast, assignVariant
npm run test:e2e     # URL override personas + stubbed Flagsmith JS path + per-barrier flag + axe-core on control
```

CI runs typecheck, unit, and Playwright. E2E uses `scripts/serve-site.mjs --allow-mock` so `?lift_variant=` is honoured. The live page ignores that query unless `config.allowMock` is true.

## Commands

| Script | What it does |
|--------|----------------|
| `npm run scan` | Fixture scan for `data-barrier` markers |
| `npm run bootstrap` | Management API: flags, warehouse, metric, experiment, start |
| `npm run site` | Serve the checkout at :4174 |
| `npm run traffic` | Seeded N visitors, local eval, persona bots, events to Flagsmith |
| `npm run decide` | Poll Flagsmith results; complete if `source=flagsmith`, or if `LIFT_ALLOW_LOCAL_DECISION=true` |
| `npm run verify:pull` | Recorded probe output: throwaway complete-to-control, then Node SDK eval |
| `npm run experiment` | One site: scan → bootstrap if needed → traffic → decide → `dashboard/sites/<id>.json` |
| `npm run fleet` | Sequential fixed-horizon run of every site (200/arm), then aggregate `dashboard/results.json` |
| `npm run fleet:estimate` | Print the Flagsmith HTTP estimate (no traffic) |
| `npm run dashboard` | Serve the results page at :4173 |
| `npm run typecheck` | `tsc --noEmit` |

## Fleet (this branch)

`npm run fleet` runs each site sequentially against Flagsmith cloud **Development**, one look at a **fixed horizon of 200 identities per arm** (400 visits/site). That is under the 300/arm site-1 default so eight sites fit the 50k/month API budget; local evaluation and batched events keep HTTP to a few hundred calls. Estimate first with `npm run fleet:estimate`.

Sites share `sites/shared/lift-sdk.js` and `traffic/src/generic-personas.ts`. **Lumen Cloud pricing** ships a treatment-only extra confirmation modal (`[data-friction-step]`). Converted visits then take an extra seeded dropout. Lift does **not** hard-code `pull_to_control` — if treatment loses, it falls out of the persona mix (70% mouse × extra friction).

The dashboard headline is **conversion lift across N sites** (SIMULATED traffic, assumed mix). The number is the **unweighted median of per-site relative lifts**. Pooled lift (summed n) is a sensitivity check, not the headline, because the sites are different flows and not exchangeable. Each row links the Flagsmith experiment.

GitHub Pages deploys `dashboard/` via `.github/workflows/pages.yml`. Enable Pages on the repo (source: GitHub Actions).

## Honest limits

- Bots, not humans. Every result surface says so.
- First experiment is **one bundled flag**. Per-barrier flags are wired on the page but not concurrent Flagsmith experiments.
- Lift waits for **50 identities and 5 conversions per arm** (Lift’s floors, not Flagsmith’s) before treating `chance_to_win` as a decision. Default design is a **fixed horizon**: `LIFT_TARGET_ARM_N=300` (so ~600 visitors), one look at Flagsmith, then decide. If `LIFT_RUN_ID` is unset, it defaults to a compact UTC timestamp so re-runs get fresh identities.
- `LIFT_CONTINUE_UNTIL=true` is **optional stopping** (add batches until P(win) crosses the threshold). It is off by default because peeking inflates false positives. `LIFT_MAX_ARM_N` (default 600) caps that path.
- A Flagsmith snapshot is used only when **each arm’s n is at least 95% of the local visit log**. `as_of` after traffic is not enough on its own. If the warehouse is still short after the wait, the dashboard says **awaiting ingestion** and Lift does not complete.
- Results refresh is at most once per 5 minutes. Lift polls with backoff until `chance_to_win` exists and ingestion holds.
- Completing from local math requires `LIFT_ALLOW_LOCAL_DECISION=true` and is labelled everywhere. `npm run decide` completes in that case too.
- Experiment **593** was an earlier sequential (optional-stopping) Development run. The dashboard is the latest fixed-horizon experiment.
