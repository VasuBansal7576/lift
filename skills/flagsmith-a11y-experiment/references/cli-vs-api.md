# CLI vs Admin API (load only on failure)

Current Flagsmith CLI v2 (`flagsmith`, `@flagsmith/cli`): https://github.com/Flagsmith/flagsmith-cli

**This skill's default is Admin HTTP** (`Authorization: Api-Key`) for:

- `POST /projects/{id}/features/` (multivariate flag)
- `GET/POST .../experiment-metrics/` (lookup by name, then create)
- `GET/POST .../experiments/` (lookup by feature; resume if running)
- `POST .../experiments/{id}/start/` (only from `skill-run` after the served gate)
- `GET .../experiments/{id}/results/`
- `POST .../experiments/{id}/complete/`

**CLI fallback** (flag/variant/weight only — no experiment command):

- `flagsmith feature create <name> --value control --enabled`
- `flagsmith feature variant add <name> --value treatment --key treatment --weight 0`
- `flagsmith flag update <name> --weight treatment=0` (environment default stays 0%; experiment_rollout allocates traffic after `--start`)
- Feature delete is Admin HTTP `DELETE /projects/{id}/features/{featureId}/` (by id)

`--variants` on `feature create` cannot set keys. Always `variant add --key`.

Never print the key. OSS experiments need warehouse `postgres` / `flagsmith_database` and `EXPERIMENTATION_ENABLED=true`.
