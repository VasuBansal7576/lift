# STEP 0 — Flagsmith CLI, Admin API, Experiments, Docker

Cited 27 Nov 2026. Never use paid tiers for this work.

## 1. Official Flagsmith CLI — what it actually does

There are two CLIs that share the `flagsmith` name:

### Current CLI (v2) — use this

- Docs: https://docs.flagsmith.com/integrating-with-flagsmith/CLI
- Source / command list: https://github.com/Flagsmith/flagsmith-cli
- Full reference: https://flagsmith.github.io/flagsmith-cli/
- Install: `curl -fsSL https://get.flagsmith.com | sh` (npm `@flagsmith/cli` is a fallback)

**First-class commands CAN create flags and segments.** They cannot create metrics or experiments.

| Area | Commands | Create? |
| --- | --- | --- |
| Features / flags | `feature create/get/list/update/delete`, `feature variant add/update/delete`, `flag list/get/update/enable/disable` | **Yes** — flags, multivariate variants, weights |
| Segments | `segment create/get/list/update/delete` | **Yes** |
| Org / project / env | `organisation`, `project`, `environment` (+ `environment key`, `environment document`) | **Yes** |
| Evaluate | `evaluate` / `eval`, `environment document` | Read / SDK-style |
| Experiments / metrics | **No `flagsmith experiment` (or metric) command** | **No** first-class command |

The CLI still covers the rest via raw Admin API:

```bash
flagsmith api api/v1/environments/<key>/experiment-metrics/ -X POST --input -
flagsmith api api/v1/environments/<key>/experiments/ -X POST --input -
flagsmith api api/v1/environments/<key>/experiments/<id>/start/ -X POST
```

That is the official coding-agent path: https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent  
Quote: *“Make the API calls below with `flagsmith api <path>`”* for metrics and experiments. Also: *“`--variants` on `feature create` can't set keys”* — create the flag, then `feature variant add --key`.

### Legacy npm CLI — fetch only (deprecated)

- https://docs.flagsmith.com/integrating-with-flagsmith/legacy-cli
- Only `flagsmith get [ENVIRONMENT]` — retrieve flags into a file (`flagsmith.json`).
- **Cannot** create flags, segments, or experiments.
- Official mapping: legacy `flagsmith get` → new `flagsmith eval --js`.

**Answer:** current CLI can create flags and segments. It cannot create experiments as a first-class command. Use `flagsmith api` / Admin API for metrics, warehouse, experiments, start, results, complete. The old npm CLI could only fetch.

## 2. Admin API and official MCP

**Admin API** covers the whole job (flags, segments, warehouse, metrics, experiments, start, results/`chance_to_win`, complete/`rollout_decision`, environment default). Same routes Lift already uses, documented in the coding-agent prompt above.

**Official MCP:** https://docs.flagsmith.com/integrating-with-flagsmith/mcp-server  
SaaS URL `https://mcp.flagsmith.com`; self-host by running the server from the Flagsmith repo (`mcp/` subdirectory). Core tools include `create_feature`, `create_feature_multivariate_option`, `create_project_segment`, **`create_metric`**, **`create_experiment`**, `list_experiments`, `get_experiment_results`.

The same official coding-agent prompt says: *“Don't use the Flagsmith MCP server: it can't start experiments.”*  
So MCP can create an experiment object, but **start / complete / rollout still need Admin API** (`POST .../experiments/{id}/start/` and `.../complete/`). This skill uses CLI for flags, then `flagsmith api` (Admin API) for metrics/experiments/start/complete.

## 3. Experiments + win probability — OSS self-host and Cloud free

**Self-hosted open source: yes**, with no edition restriction.

- https://docs.flagsmith.com/experimentation/self-hosting — *“Experimentation works in both the Open Source version and the Enterprise Edition, with no edition restriction.”*
- Turn on with `EXPERIMENTATION_ENABLED=true` (official compose already sets this).
- Try-out warehouse: Environment Settings → Warehouse → **Flagsmith database** (`warehouse_type: postgres`, `config.source: flagsmith_database`). Docs: https://docs.flagsmith.com/deployment-self-hosting/hosting-guides/docker (Experimentation section) and https://docs.flagsmith.com/experimentation/self-hosting
- That warehouse is **evaluation-only**; production should use ClickHouse/Databricks. Fine for this hackathon.

**Cloud free tier: yes.** FAQ: *“Experimentation is available on all Flagsmith SaaS plans and private or on-premises deployments. You can use Flagsmith's managed warehouse to store your experiment data on all plans”* — https://www.flagsmith.com/feature/experimentation-platform

**Win probability** is part of native Experimentation results (`chance_to_win` / “Chance to be best” / “Win Probability”), not a paid add-on: https://docs.flagsmith.com/experimentation and https://docs.flagsmith.com/experimentation/analyse-an-experiment

This work never uses paid tiers.

## 4. Official one-command Docker self-host

https://docs.flagsmith.com/deployment-self-hosting/hosting-guides/docker

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml
docker-compose -f docker-compose.yml up
```

Then http://localhost:8000 — first account is a superuser. Coding-agent bootstrap (API, no UI click): https://docs.flagsmith.com/getting-started/run-locally-with-a-coding-agent (`POST /api/v1/auth/users/`, org, project, environments, warehouse, CLI key).

`selfhost/docker-compose.yml` is that official file. `npm run selfhost:up` runs it and bootstraps via the API.

## Verified on this VM (27 Nov 2026)

Self-hosted Flagsmith `2.295.2` (`is_enterprise: false`, `is_saas: false`, `experimentation_enabled: true`). Warehouse status **connected**. `flagsmith api` created experiment id 1 and started it. Demo checkout read `checkout_a11y` from `FLAGSMITH_API_URL=http://127.0.0.1:8000/api/v1/` and flipped control → treatment.
