# Self-host Flagsmith for Lift (T3)

Official compose + API bootstrap so Lift reads flags from **your** Flagsmith, not cloud.

Facts (CLI vs API, OSS experiments, win probability): [FINDINGS.md](FINDINGS.md)

## One command

```bash
npm run selfhost:up
```

That is:

```bash
docker compose -f selfhost/docker-compose.yml --project-name lift-selfhost up -d
# wait until http://127.0.0.1:8000/health/liveness/ is 200
# POST /api/v1/auth/users/ (admin), org, project, Development env, warehouse, checkout_a11y
```

`selfhost:up` always bootstraps the compose instance at **http://127.0.0.1:8000**. It never reads `FLAGSMITH_API_URL` from the repo-root `.env`.

Compose file is the official one, images pinned to `flagsmith:2.295.2`: https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml  
Docs: https://docs.flagsmith.com/deployment-self-hosting/hosting-guides/docker

Stop: `npm run selfhost:down`

### Proof-up (recording-only instance on 8010)

`npm run selfhost:proof-up` starts a **separate** compose project (`lift-selfhost-proof` by default) on **http://127.0.0.1:8010**. It never downs `lift-selfhost` on port 8000.

- `COMPOSE_PROJECT_NAME` must end with `-proof`. The value `lift-selfhost` is refused.
- `FLAGSMITH_HTTP_PORT` selects the host port (default `8010`) and is interpolated in `selfhost/docker-compose.proof.yml`.
- Bootstrap writes **only** `selfhost/.env.proof` (gitignored). It does not reuse leftover SDK keys from that file; a fresh 8010 database registers a new admin and environment.
- The script prints compose progress and a one-line `health-poll N liveness HTTP <code>` until liveness is 200. It does not tail Flagsmith container logs.

```bash
COMPOSE_PROJECT_NAME=lift-selfhost-proof FLAGSMITH_HTTP_PORT=8010 npm run selfhost:proof-up
```

### Secrets

Credentials live **only** in gitignored `selfhost/.env` (mode 0600). A random bootstrap password is generated on first run. `selfhost/.env.example` is the template (password left blank).

`--write-root-env` is required to also write the repo-root `.env`. That flag is refused if the root file already holds a non-loopback `FLAGSMITH_API_URL`.

Never commit keys.

### Ports and compose demo secrets

Compose binds `127.0.0.1:8000` (API/UI) and does **not** publish the task processor. That is a **deviation from the official compose**, which publishes `0.0.0.0` and includes an `8001` mapping.

`selfhost:up` generates `POSTGRES_PASSWORD`, `DJANGO_SECRET_KEY`, and `WAREHOUSE_CREDENTIALS_SECRET` into `selfhost/.env` (mode 0600) and passes `--env-file`. Compose uses `${VAR:?}` — there are no default secrets in the YAML.

### Container VMs (manual)

Some container VMs drop Docker bridge DNS unless `net.bridge.bridge-nf-call-iptables` is 0. **VM only — set it yourself.** If `docker info` fails, `selfhost:up` exits with a JSON error.

## Point Lift at it (`FLAGSMITH_API_URL`)

Bootstrap sets (in `selfhost/.env`):

```
FLAGSMITH_API_URL=http://127.0.0.1:8000/api/v1/
```

and writes `sites/checkout/config.selfhost.json` (gitignored). Serve it with `npx tsx scripts/serve-site.ts --selfhost` so `config.json` is not clobbered.

```bash
npx tsx scripts/serve-site.ts --selfhost   # http://127.0.0.1:4174/checkout/
npm run selfhost:dashboard                 # http://127.0.0.1:4175  flags / variants / status
```

Toggle the flag (100% treatment) with the reusable module or:

```bash
npx tsx -e "import { createLiftSelfhost, loadSelfhostEnv } from './selfhost/src/index.ts';
const lift = createLiftSelfhost(loadSelfhostEnv());
await lift.setTreatmentWeight('checkout_a11y', 100);
"
```

## Safety

Mutating scripts default-deny any Admin or SDK URL that is not loopback (`127.0.0.1`, `localhost`, `::1`). Pass `--allow-remote` for a remote Flagsmith, and also `--confirm-prod` when the environment name looks like production.

Dry-run unless `--apply`. `--start` requires a passing axe gate on the **served** control (0% environment default) and treatment (gate-only identity override). After results, type exactly `APPROVE <experimentId>` at the TTY.

## Reusable module

`selfhost/src/index.ts`

| Function | What |
| --- | --- |
| `loadSelfhostEnv()` | Read `selfhost/.env` (not the root `.env`) |
| `composeLocalEnv()` | URLs forced to `http://127.0.0.1:8000` |
| `createLiftSelfhost(env)` | Client |
| `lift.health()` | Liveness |
| `lift.listFlags()` / `listManagedFlags()` | SDK flags API |
| `lift.setTreatmentWeight(name, percent)` | CLI `flag update --weight`, Admin API fallback |
| `lift.createMultivariateFlag(name, desc)` | Admin API |
| `compareAxeGate(control, variant)` | Reject variants that **add** axe violations |
| `assertSafeToMutate({ environmentName, confirmProd, apiUrl, allowRemote })` | Loopback + prod guard |
| `pickRolloutFromResults(payload)` | Highest `chance_to_win` (threshold 0.95) |
| `bootstrapSelfhost()` | First-run API bootstrap of the compose instance |
| `writeSiteConfigForSelfhost(env, site, flag, event)` | Write `sites/checkout/config.selfhost.json` (served via `--selfhost`; does not clobber `config.json`) |

## Agent skill (T4)

`skills/flagsmith-a11y-experiment/` — see its `SKILL.md`.

```bash
npx tsx scripts/skill-run.ts                  # dry-run, fixture demo + plan
npx tsx scripts/skill-run.ts --apply --start  # gate, start, traffic, TTY APPROVE <id>
```

## Proof recordings

Listed in [recordings/t3-t4/README.md](../recordings/t3-t4/README.md).
