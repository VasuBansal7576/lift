# Token count (flagsmith-a11y-experiment)

Measured after `npx tsx scripts/skill-run.ts --apply --start` against self-hosted Flagsmith (TTY prompt `APPROVE <experimentId>` after `chance_to_win`).

Method: `ceil(chars / 4)`.

## What a coding agent loads

| File | When loaded | chars | ~tokens |
| --- | --- | --- | --- |
| `SKILL.md` | Always (skill activation) | ~3200 | **~800** |
| `references/cli-vs-api.md` | Only if a CLI/API command fails | 1274 | 319 |
| `scripts/*.sh` | Not loaded (executed) | — | 0 |
| fixtures HTML | Not loaded (Playwright) | — | 0 |
| `TOKENS.md` | Not required for the job | — | 0 |

**Happy-path agent load: SKILL.md only.**

Via: flag create is **Admin HTTP** (`POST /projects/{id}/features/`). Metric/experiment/start/complete/results are **Admin HTTP** (`Authorization: Api-Key`). CLI (`flagsmith feature …`, `flagsmith flag update --weight`) is a fallback for flag/variant/weight only — there is no CLI experiment command.

`npx tsx scripts/skill-tokens.ts` regenerates the per-file table.
