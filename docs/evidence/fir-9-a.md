# Phase A evidence recordings

## Recorder clips (video evidence)

Only the headed recorder mp4s produced by `node scripts/record-phase-a.mjs` are video evidence. They are live continuous takes: the real pointer is moved and clicked with xdotool, and evidence is typed in the visible DevTools Console or read from the app's own UI / Application → Cookies.

The Playwright spec clips from `tests/evidence/phase-a.spec.ts` (both `playwright.evidence.config.ts` and `playwright.evidence.mock.config.ts`) are **TEST RUNS**. They are not video evidence. They do not show Console, axe, cookie, or banner output for this record.

Output directory: `artifacts/fir-9-a/recorder/` by default, or `EVIDENCE_MP4_DIR`. None of these six clips use `?lift_variant=` or `--allow-mock`. The store banner "Demo store. Experiment traffic is simulated." is the fixture's own copy.

Required env for the recorder: `FLAGSMITH_ENVIRONMENT_KEY`, `FLAGSMITH_IDENTITY_URL`, `FLAGSMITH_FEATURE_ID`, and (for clip 01) `FLAGSMITH_ADMIN_API_TOKEN`.

| File | What it shows | Timestamps |
| --- | --- | --- |
| `01-control-treatment-axe.mp4` | Flagsmith identity override + footer `checkout_a11y=control`; both arms type the same local `/vendor/axe.min.js` load with `onerror`; control `axe.run()` lists four gate ids; visible Reset/Confirm; hold of `treatment` / Using environment defaults; visible Chrome reload onto treatment; typed `axe.run()` lists `['region']`. | Flagsmith `"control"` override ~0–2s; footer control + unlabeled button ~6–10s; typed local axe four ids ~12–16s; Reset + Confirm dialog ~18–20s; `treatment` / Using environment defaults ~24s; reload pointer ~27s; treatment Place order + axe `['region']` ~30–36s |
| `02-keyboard-submit-once.mp4` | Empty treatment form; typed click listener; pointer into Email; Tab across fields with card `0000` (Chrome does not offer to save); Enter submits once; typed `clicks` is `1` with the order confirmation. | Clicks listener ~0–4s; keyboard fill + Enter ~4–8s; confirmation + `clicks` `1` ~8–10s |
| `03-per-node-attribution.mp4` | Two typed `demo-target` nodes; colour change on A and move of B; `LiftRuntime.getRuntimeStats()` / `lastAttributions` show page vs spec. | Typed nodes ~8–26s; spec + colour/move ~26–38s; stats `undos:1`, node-a `page`, node-b `spec` ~42–44s |
| `04-cssom-edit-detected.mp4` | Visible Chrome reload; clean console; `sheet.disabled` false; one typed CSSOM colour edit; then `disabled` true; `undos: 1`. | Reload ~0–2s; typed Sample `demo-target` + spec ~4–14s; `disabled` false + CSSOM `#eee` ~16–18s; `disabled` true, `{undos:1, attributions:1, ticksRan:1}` ~24–28s |
| `05-page-contrast-no-loop.mp4` | Visible Chrome reload; typed Go node; colour fights; `getRuntimeStats()` three times ~5s apart with `undos` staying 0 and `ticksRan` 4, then 5, then 6. | Reload ~0–2s; typed Go + colour fights ~4–20s; stats `undos:0` / `ticksRan:4` ~24s; `ticksRan:5` ~32s; `ticksRan:6` ~38s |
| `06-sticky-identity.mp4` | Application → Cookies shows `lift_vid` and the footer variant; visible Chrome reload; the same `lift_vid` and variant again. | Cookies + footer treatment ~3–10s; reload pointer ~11s; same `lift_vid` + treatment ~13–19s |

## Playwright spec runs (tests, not video evidence)

`npm run evidence:a` runs `tests/evidence/phase-a.spec.ts`. Those outputs are **test runs**, not video evidence. They do not stand in for Console, axe, cookie, or banner readouts.

- Flagsmith-dependent test `05-sticky-identity` uses `playwright.evidence.config.ts` (no `--allow-mock`, no `?lift_variant=`).
- The typed / fail-open tests use `playwright.evidence.mock.config.ts` (`--allow-mock`). Tests that open `/checkout/?lift_variant=control` (or `treatment`) are forced-arm mock runs.
