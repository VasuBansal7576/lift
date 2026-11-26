# Lift

Hackathon entry for WeMakeDevs Toggle Wars (Flagsmith), **Test Something Real** track.

**Hypothesis:** fixing accessibility barriers raises conversions.

An agent scans **fixture** sites (data-barrier markers plus axe-core on control), ships WCAG fixes behind Flagsmith flags, runs a native Flagsmith experiment per site, sends simulated persona traffic, then auto-rolls out or pulls through the Flagsmith Admin API **when Flagsmith’s own `chance_to_win` is available**, or when `LIFT_ALLOW_LOCAL_DECISION=true`.

Live humans are assigned by the Flagsmith JS SDK (`@flagsmith/flagsmith@12.4.0`). Playwright bots get their variant from the **Node SDK** (Flagsmith local evaluation). Each site's page is then forced to that arm with `?lift_variant=` so the bot exercises the same HTML the identity was enrolled in — that is why bot pages show **URL override (no Flagsmith)** in the footer. The query is honoured only when the server overlays `allowMock: true` on `/config.json` in memory (never written to disk). Without Flagsmith, the live page will not bucket.

> **All traffic is simulated.** Playwright bots (mouse, keyboard-only, screen-reader, **contrast-threshold / low-vision**) complete each site's conversion flow. Numbers on the dashboard, identity traits, and this README are labelled **SIMULATED**. This demonstrates the pipeline; it is not evidence about real users. The live fleet on this branch is experiments **632–651**.

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

Default: **mouse 70%, keyboard 10%, screen-reader 10%, low-vision 10%** (`LIFT_PERSONA_MIX`). This is a modelling assumption, not a measurement of the web. Blocked personas convert 0% in control and mouse users are never blocked, so **expected lift by construction is about `1/(1 − blocked share) − 1`**. **Lift’s own floors** (not Flagsmith’s) are **50 identities and 5 conversions per arm** — they are not a reason to pick 10% minority weights. The assumed mix and this run’s realised mix are shown next to the dashboard headline.

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

Simulated traffic uses `@flagsmith/nodejs` **local evaluation** and batched events (`maxBuffer` default 1000, flushed on close). Playwright does **not** call the JS SDK per bot. The site JS SDK is for live humans only (`https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm`).

`sites/*/config.json` is gitignored. Bootstrap regenerates it (client environment key plus barrier map). CI and Pages generate a placeholder without the key when the file is missing. **The Development client key is in git history and is public-by-design** (Flagsmith client keys are meant to ship in frontend code).

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
6. `npm run experiment` (serves the chosen site; reuses port 4174 if `npm run site -- --allow-mock` is already up). Then `npm run decide` is not required. Single-site runs rebuild `dashboard/results.json` from `sites/*.json`; they do not overwrite the fleet aggregate with one site.
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

CI runs typecheck, unit, and Playwright. E2E uses `tsx scripts/serve-site.ts --allow-mock` so `?lift_variant=` is honoured. The live page ignores that query unless `config.allowMock` is true.

## Commands

| Script | What it does |
|--------|----------------|
| `npm run scan` | Fixture scan for `data-barrier` markers |
| `npm run bootstrap` | Management API: flags, warehouse, metric, experiment, start |
| `npm run site -- --allow-mock` | Serve the sites at :4174 with `?lift_variant=` honoured |
| `npm run traffic` | Seeded N visitors, local eval, persona bots, events to Flagsmith |
| `npm run decide` | Poll Flagsmith results; complete if `source=flagsmith`, or if `LIFT_ALLOW_LOCAL_DECISION=true` |
| `npm run verify:pull` | Recorded probe output: throwaway complete-to-control, then Node SDK eval |
| `npm run experiment` | One site: scan → bootstrap if needed → traffic → decide → `dashboard/sites/<id>.json`, then rebuild the fleet aggregate from `sites/*.json` (`producedBy: experiment`) |
| `npx tsx agent/src/snapshot.ts` | Re-read a **completed** experiment and rewrite `dashboard/sites/<id>.json` without sending traffic. Sets `producedBy: snapshot`. Prefer `npm run fleet` with `LIFT_FLEET_FORCE=true` for a live fleet. |
| `npm run fleet` | Sequential fixed-horizon run of every site (400 identities/site, ~200/arm, random 50/50), then aggregate `dashboard/results.json` |
| `npm run fleet:rebuild` | Re-aggregate `dashboard/results.json` from existing `dashboard/sites/*.json` (no traffic) |
| `npm run fleet:estimate` | Print the Flagsmith HTTP estimate (no traffic) |
| `npm run dashboard` | Serve the results page at :4173 |
| `npm run typecheck` | `tsc --noEmit` |

## Fleet (this branch)

`npm run fleet` runs each site sequentially against Flagsmith cloud **Development**, one look at a **fixed horizon of 400 identities per site (~200/arm, random 50/50)**. The cap is Playwright runtime for eight sequential sites, not the 50k/month Flagsmith API budget — local evaluation and batched events keep HTTP to a few hundred calls. Estimate first with `npm run fleet:estimate`.

Sites share `sites/shared/lift-sdk.js` and `traffic/src/generic-personas.ts`. The bots are **site-aware**: expected accessible names (menu, opener, submit, search, terms, friction confirm) live in each site's catalog entry (`shared/catalog.ts` → `accessible`), not in persona regexes.

**Lumen Cloud pricing** is a designed-to-lose pipeline check of `pull_to_control`. Treatment shows `[data-friction-step]`; bots click through the modal; then **60% of treatment conversions are dropped by construction** (`frictionKeepRate: 0.4` is P(keep), i.e. `rand() < 0.4` keeps). With the assumed mix, treatment cannot beat control, expected −50%. **The decision isn't hard-coded, but the loss is.**

**The wins are built in too.** Blocked personas convert 0% in control and mouse users are never blocked, so expected lift is about `1/(1 − blocked share) − 1` (for example **+42.9% at 30% blocked**, **+25% at 20%**). Each dashboard row shows observed lift next to that expected value. The size of the lift is set by the assumed persona mix and which personas each barrier blocks; this demonstrates the Flagsmith pipeline, not real-user impact.

The dashboard headline is **conversion lift across the 7 real fixes** (SIMULATED traffic, assumed mix). Pricing is shown separately as the designed-to-lose pipeline check. The number is the **unweighted median of per-site relative lifts**, with IQR and range, source `lift_median_of_flagsmith_lifts`. Pooled lift (summed n, with pooled arm counts) is a sensitivity check under the headline, not the headline, because the sites are different flows and not exchangeable. The 8-site figures (including pricing) stay as a secondary line. Set `HEADLINE_INCLUDE_DESIGNED_TO_LOSE=true` in `shared/aggregate.ts` to count all 8. Eight separate tests run at 95% with **no multiple-testing correction**. Each row links the Flagsmith experiment. Abandoned and superseded experiment IDs are listed in `results.json` and in a collapsible on the dashboard. Every site doc and fleet row has `producedBy` (`fleet` \| `snapshot` \| `reused` \| `experiment` \| `rebuild`). The fleet aggregate keeps `dataCommitSha` (the commit that produced the live rows) separate from `aggregationCommitSha` (the commit that rebuilt `results.json`).

`agent/src/snapshot.ts` re-reads a completed experiment and rewrites the site JSON without sending traffic. A forced fleet (`LIFT_FLEET_FORCE=true`) re-runs every site through the fleet runner so no row is reused or snapshotted. The committed live rows are fleet experiments **632–651**.

GitHub Pages deploys `dashboard/` via `.github/workflows/pages.yml` on **push to `main`** and `workflow_dispatch`. Pull requests upload the dashboard artifact without deploying. Enable Pages on the repo (source: GitHub Actions).

## Honest limits

- Bots, not humans. Every result surface says so.
- Each site has one bundled `<site>_a11y` experiment; per-barrier flags are wired but are not separate experiments.
- Lift waits for **50 identities and 5 conversions per arm** (Lift’s floors, not Flagsmith’s) before treating `chance_to_win` as a decision. Default design is a **fixed horizon**. **Fleet uses ~200/arm (400/site)**; **single-site default is 300/arm**. If `LIFT_RUN_ID` is unset, it defaults to a compact UTC timestamp so re-runs get fresh identities.
- `LIFT_CONTINUE_UNTIL=true` is **optional stopping** (add batches until P(win) crosses the threshold). It is off by default because peeking inflates false positives. `LIFT_MAX_ARM_N` (default 600) caps that path.
- A Flagsmith snapshot is used only when **each arm’s n exactly matches the local visit log**. Enrollment is probed with events off on visitor #0’s identity, so there are zero fake exposures. `as_of` after traffic is not enough on its own. If the warehouse is still short after the wait, the dashboard says **awaiting ingestion** and Lift does not complete.
- Results refresh is at most once per 5 minutes. Lift polls with backoff until `chance_to_win` exists and ingestion holds.
- Completing from local math requires `LIFT_ALLOW_LOCAL_DECISION=true` and is labelled everywhere. `npm run decide` completes in that case too.
- Site-1 checkout runs (586, 593, 605) and the first fleet (613–625) are listed under `supersededExperiments`. Abandoned experiments are **ID gaps; cause unknown** (615, 617, 620, 622, 623, and bootstrap retries). The dashboard is fleet experiments **632–651**.
