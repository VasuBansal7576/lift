# Lift

Hackathon entry for WeMakeDevs Toggle Wars (Flagsmith), **Test Something Real** track.

**Hypothesis:** fixing accessibility barriers raises conversions.

An agent scans a demo checkout, ships Kane-style WCAG fixes behind a **Flagsmith multivariate flag**, runs a native Flagsmith experiment, sends simulated persona traffic, then **auto-rolls out the winner or pulls the loser through the Flagsmith Admin API**.

If you delete Flagsmith, variant assignment, experiment enrolment, and rollout/rollback all stop. Flagsmith is the mechanism, not a wrapper.

> **All traffic is simulated.** Playwright bots (mouse, keyboard-only, screen-reader, low-vision) attempt checkout. Numbers on the dashboard, identity traits, and this README are labelled **SIMULATED**.

Hard deadline 29 Nov 2026 20:00 IST. This branch is **one site, end to end**.

## What this branch contains

| Path | Role |
|------|------|
| `sites/checkout/` | Northline Market checkout with 5 real WCAG barriers |
| `agent/` | Scan → bootstrap Flagsmith flags/metrics/experiment → decide → complete/rollout |
| `traffic/` | Seeded Playwright personas + Node SDK local evaluation |
| `dashboard/` | Static results page (`dashboard/results.json`) |
| `docker-compose.flagsmith.yml` | Official Flagsmith compose (self-host) |

## Barriers (control = broken, treatment = fixed)

All five toggle together on the experiment flag `checkout_a11y` (`control` vs keyed variant `treatment`). Per-barrier flags (`a11y_hover_menu`, `a11y_unlabeled_icon`, `a11y_div_button`, `a11y_missing_labels`, `a11y_low_contrast`) are created at 0% treatment for later sequential tests.

| Flag / id | WCAG | Who it blocks in control |
|-----------|------|--------------------------|
| hover-only Shop → Checkout menu | 2.1.1 | keyboard, screen-reader |
| unlabeled bag icon | 4.1.2 | screen-reader |
| `div` Place order (not focusable) | 2.1.1 / 4.1.2 | keyboard, screen-reader |
| email/card fields with no `<label>` | 1.3.1 / 3.3.2 | screen-reader |
| grey-on-grey terms copy (~1.4:1) | 1.4.3 | low-vision (zoom 200%, contrast floor 4.5:1) |

Mouse users still convert in control (they can hover, click the glyph, fill by position, check the box). That is the point: the lift is accessibility, not a new offer.

Fixes reuse Curb Cut’s repair ideas (`mirrorHoverToFocus`, `addLabel`, `makeFocusable` / native button, `setContrast`) in source rather than a runtime patch DSL.

## Flagsmith features used

Designed against [Flagsmith Experimentation](https://docs.flagsmith.com/experimentation) and the [coding-agent setup prompt](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent).

| Feature | Cloud free plan (app.flagsmith.com) | Self-hosted OSS compose |
|---------|-------------------------------------|-------------------------|
| Multivariate flags + keyed variants | Yes | Yes |
| Identities + traits (`simulated`, `persona`, `converted`) | Yes | Yes |
| Management API (create flags, start/complete experiments) | Yes (org API token) | Yes |
| Native **Experiments** + **Metrics** + Identities | **Yes** on the Lift free-plan org (Experiments is unlocked) | Yes: official compose already sets `EXPERIMENTATION_ENABLED=true`. Same Management API (`/experiments/`, `/experiment-metrics/`, `/results/`) |
| Managed Flagsmith warehouse (`warehouse_type: flagsmith`) | **Cloud-only**, available on this free plan | Not available. Self-host uses `warehouse_type: postgres` with `config.source: flagsmith_database` (the Flagsmith Postgres). Eval only — not for production load |
| SDK events (`enableEvents`, `getExperimentFlag`, `trackEvent`) | `FLAGSMITH_EVENTS_URL=https://events.api.flagsmith.com/` | `FLAGSMITH_EVENTS_URL=http://localhost:8000/api/` (SDKs append `v1/events`) |
| Win probability (`chance_to_win`) | After warehouse is **Connected** and ≥50 identities / 5 conversions per arm | Same API against the Flagsmith-database warehouse |
| Complete experiment → rollout variant or revert to control | Yes (`POST .../experiments/{id}/complete/` with `rollout_decision: variant\|control`) | Yes |

Bring-your-own ClickHouse / Databricks / PostgreSQL on Cloud is Scale-Up/Enterprise. Lift does not need it: the free-plan **Flagsmith** warehouse is the live-demo path.

**Gap (self-host vs cloud):** native Experiments **is** on OSS. The missing piece is the **managed warehouse**. If Environment Settings → Warehouse is not connected, Flagsmith will not create experiments. Lift then cannot read `chance_to_win`. If the experiment exists but results are empty or still under the 50/5 floor, the dashboard uses a **local Beta-Binomial** win probability and **says so** — it never pretends Flagsmith computed it. Cloud warehouse first-event processing can lag (status **Pending Connection**); click **Send your first event** on the Warehouse card, then run traffic.

### API budget (stay under 50k/month)

Simulated traffic uses `@flagsmith/nodejs` **local evaluation** (one environment document, then in-process bucketing) and **batched events**. Playwright does **not** call the JS SDK per bot — the Node client already asked Flagsmith for the variant. The checkout JS SDK is for live humans only.

A 120-visitor run is on the order of: 1 env-document fetch + a handful of event batches + bootstrap/admin calls + one results refresh. Well under 50k.

## Quick start

```bash
cp .env.example .env
# fill FLAGSMITH_* from cloud or from a local instance
npm install
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

### Cloud (live demo)

Org **Lift** (`42178`), project **Lift** (`56470`), environments Development and Production.

1. Create an Organisation API token (Organisation Settings → API Access).
2. Copy the Development **client** key and **server-side** key.
3. Environment Settings → Warehouse → enable **Flagsmith** if it is not already connected.
4. Put them in `.env`:

```
FLAGSMITH_API_URL=https://api.flagsmith.com/api/v1/
FLAGSMITH_EVENTS_URL=https://events.api.flagsmith.com/
FLAGSMITH_DASHBOARD_URL=https://app.flagsmith.com
FLAGSMITH_ORGANISATION_ID=42178
FLAGSMITH_PROJECT_ID=56470
FLAGSMITH_ENVIRONMENT_NAME=Development
FLAGSMITH_ENVIRONMENT_KEY=...
FLAGSMITH_SERVER_KEY=...
FLAGSMITH_ADMIN_API_TOKEN=...
```

5. `npm run bootstrap` — creates flags, metric `checkout_completed`, experiment, starts it.
6. `npm run site` and `npm run experiment` (or `npm run traffic` then `npm run decide`).
7. Open `http://127.0.0.1:4173` (`npm run dashboard`) — banner says **SIMULATED TRAFFIC**.

### Self-host (local dev)

```bash
npm run flagsmith:up          # official compose, http://localhost:8000
# Create the first user, org, project, API token, enable Warehouse → Flagsmith database
# Fill .env (FLAGSMITH_API_URL=http://localhost:8000/api/v1/, events URL .../api/)
npm run bootstrap
```

**Gap:** native experiment *results* (`chance_to_win`) need a warehouse. Cloud free plan: enable **Flagsmith** warehouse. Self-host: enable **Flagsmith database** (`warehouse_type=postgres`, `config.source=flagsmith_database`) — eval only, events share the flags Postgres. If results are empty or still collecting, Lift computes a **local Beta-Binomial** win probability and labels the source `local_bayesian`. The live demo should wait for Flagsmith's own `chance_to_win`.

## Tests

```bash
npm run test:unit    # decision + Bayesian stats + scanner
npm run test:e2e     # one Playwright spec per persona, control vs treatment
```

CI (`.github/workflows/ci.yml`) runs both. E2E injects `?lift_variant=` so GitHub Actions does not need Flagsmith. Production assignment still goes through Flagsmith; without it the live page refuses to bucket.

## Commands

| Script | What it does |
|--------|----------------|
| `npm run scan` | Detect the five barriers in `sites/checkout` |
| `npm run bootstrap` | Management API: flags, warehouse, metric, experiment, start |
| `npm run site` | Serve the checkout at :4174 |
| `npm run traffic` | Seeded N visitors, local eval, persona bots, events to Flagsmith |
| `npm run decide` | Read Flagsmith results (fallback local Bayes), complete/rollout |
| `npm run experiment` | scan → bootstrap if needed → traffic → decide → `dashboard/results.json` |
| `npm run dashboard` | Serve the results page at :4173 |

## Scale-up (6–12 sites)

1. Clone the checkout fixture into `sites/signup`, `sites/pricing`, … each with 3–5 barriers and one `*_a11y` experiment flag.
2. Keep **one metric per site** (`signup_completed`, `plan_selected`) so event names stay unique.
3. Run experiments **sequentially** (or one site at a time) so the free-plan 50k cap and 1-project limit hold.
4. After `checkout_a11y` ships, start per-barrier flags at 50/50 for attribution.
5. Dashboard already has a `sites` field; fold each site’s `results.json` into a fleet headline.

## Honest limits

- Bots, not humans. Every result surface says so.
- First experiment is **one combined flag**, not five concurrent Flagsmith experiments, to keep API calls and warehouse load small.
- Flagsmith will show **Collecting data** until ~50 identities / 5 conversions per arm. Default `LIFT_TRAFFIC_N=120`.
- Results refresh is at most once per 5 minutes (Flagsmith throttle).
