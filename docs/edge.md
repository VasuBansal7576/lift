# Lift Layer 1 — edge Worker

A Cloudflare Worker reverse proxy that sits **in front of any origin** and ships WCAG fixes with **zero HTML changes** to the site. Visitors are bucketed by a sticky `lift_vid` identity into a Flagsmith multivariate flag. The flag’s value is a patch-spec id stored in Workers KV. `runtime/runtime.js` applies the spec in the browser.

Free-tier demo: `wrangler dev` / Miniflare locally. No Cloudflare account required.

The checkout fixture’s `app.js` **fail-opens**: control cart, place-order, and keyboard handlers always bind, even if Flagsmith is missing. The edge demo origin (`npm run site -- --edge-origin`) skips the in-page `checkout_a11y` experiment so only the Worker experiment runs.

## Layout

| Path | Role |
| --- | --- |
| `edge/worker.js` | Worker entry (`fetch` → `handleRequest`) |
| `edge/lib/` | Cookie, CSP, Flagsmith eval, HTML injection, bootstrap source, origin URL |
| `edge/wrangler.toml` | ORIGIN, Flagsmith URL/flag name, KV `SPECS`, runtime assets |
| `tests/e2e/edge-wrangler.toml` | Isolated e2e config; **does not touch** `edge/.dev.vars` |
| `edge/put-spec.ts` | `npm run edge:put-spec` — validate then write KV |
| `edge/bootstrap-flag.ts` | Create the self-hosted multivariate flag (Track 3). Requires `FLAGSMITH_BOOTSTRAP_PASSWORD`. |
| `edge/runtime-assets` | Symlink to `runtime/` so the Worker serves `/__lift/runtime/*` |
| `edge/record/` | Live headed-Chrome recordings against real Flagsmith 2.295.2 |

## Config (env)

Set in `edge/wrangler.toml` `[vars]` or overridden with `wrangler dev --var`. The **client** environment key is a secret binding in `edge/.dev.vars` (gitignored). Copy `edge/.dev.vars.example`.

| Binding | Purpose |
| --- | --- |
| `ORIGIN` | Origin **origin** only: scheme + host + optional port. A path on `ORIGIN` is dropped — `dest.pathname` is the incoming request path. |
| `FLAGSMITH_API_URL` | Flagsmith **API** root, with `/api/v1/`. Cloud: `https://edge.api.flagsmith.com/api/v1/`. Self-hosted: `http://127.0.0.1:8000/api/v1/` |
| `FLAGSMITH_ENVIRONMENT_KEY` | Public **client** environment key (`X-Environment-Key`). A value starting with `ser.` is treated as unset (fail-open, warning without the value). Never an org admin token. Never logged. |
| `FLAGSMITH_FLAG_NAME` | Multivariate flag (default `lift_edge_spec`) |
| `FLAGSMITH_SDK_URL` | Injected JS SDK (default jsDelivr `@flagsmith/flagsmith@12.4.0`) |
| `FLAGSMITH_EVAL_TIMEOUT_MS` | Server-side eval budget (default `300`) |
| `SPECS` | KV namespace; keys are spec ids |

Self-hosted Flagsmith is the Track 3 integration point. The Worker only talks to `FLAGSMITH_API_URL`; cloud and OSS share the same identities API.

`FLAGSMITH_BOOTSTRAP_PASSWORD` is **required** for `edge/bootstrap-flag.ts`. There is no default password.

## What the Worker does

1. Resolves the origin URL **from parts** of a copy of `ORIGIN`. If `dest.origin !== origin`, or the path is `//host` / `///host` / `/\host` / `/%2F%2Fhost`, it returns **400** (open-proxy / SSRF). `/%2F%2Fhost` is rejected even though assigning it as a pathname would stay on the origin host — encoded leading slashes are treated as a host override. Malformed percent-encoding returns **404**. Exceptions never return 502.
2. Proxies GET/HEAD/POST to `ORIGIN` (rewrites `Location` back onto the Worker host). A path prefix on `ORIGIN` is not joined onto the request; only the origin (scheme/host/port) is kept.
3. **Document GET only** (`Sec-Fetch-Dest: document`, or `Accept` includes `text/html` when dest is absent): sets `lift_vid` if missing, evaluates Flagsmith **in parallel** with the origin fetch, injects Lift. CSS, JS, images, HEAD, and non-GET skip eval, injection, and the cookie.
4. Server-side eval is **authoritative** (`evaluated: true` in the JSON config). The browser does not re-eval unless the server skipped eval. The jsDelivr SDK `<script>` is injected only when `evaluated` is false.
5. Control (empty / `"control"` value): injects `/__lift/runtime/runtime.js` and bootstrap. No spec is applied.
6. Treatment: the multivariate **value is the spec id**. The Worker loads that JSON from KV and inlines it.
7. Personalised HTML is never cacheable in a shared cache: `Cache-Control: private, no-store, no-cache, must-revalidate`. `ETag` and `Last-Modified` are stripped after injection.
8. `Server-Timing: liftwall;dur=…` is **wall time** for the Worker handler (not CPU). Real CPU is in `wrangler tail`.

The Worker does **not** apply the spec itself (keeps CPU under the 10 ms free-tier budget). Application is `runtime.js` in the browser, which already fail-opens.

HTML is **buffered** (1 MiB cap) before injection so a Miniflare / HTMLRewriter streaming error can fail-open from the origin bytes. The Worker does not `clone()` the origin stream. Over-size HTML is passed through unmodified.

## Fail open

Any of these returns the **origin HTML unmodified** (no injected scripts). Fail-open HTML keeps the origin `Cache-Control` and CSP; they are not rewritten. The sticky cookie may still be set on document GET.

| Reason | `Server-Timing` desc |
| --- | --- |
| Non-HTML | `non-html` |
| HEAD / non-GET / non-document | `head` / `method` / `non-document` |
| Flagsmith HTTP error / network | `flagsmith-down` |
| Flagsmith eval > 300 ms | `flagsmith-timeout` |
| Spec id in the flag but missing from KV | `kv-miss` |
| KV value is not JSON / rewriter throws | `parse-error` |
| `strict-dynamic` CSP without a nonce | `csp-strict-dynamic-no-nonce` |
| HTML larger than 1 MiB | `html-too-large` |

The bootstrap also fail-opens: SDK errors, `applyPatchSpec` failures, and 404 spec fetches leave the DOM as the origin sent it.

## Sticky identity

Cookie name `lift_vid` matches `sites/shared/identity.js`. Same visitor → same Flagsmith identity → same variant across reloads. The Worker mints a UUID when the cookie is absent. Document GET only. Not HttpOnly so the page can read it.

## Specs in KV

```bash
npm run edge:put-spec -- runtime/checkout-treatment.json
npm run edge:put-spec -- --validate-only path/to/bad.json   # exits 1 if invalid
```

Validation uses `shared/patch-spec.ts` (`parsePatchSpec`). Invalid specs are rejected and **not** written. Local KV uses `--persist-to edge/.wrangler/state` so `wrangler dev` sees the same keys.

The demo treatment value is `checkout-treatment-v0`. Control has no spec.

## CSP

The Worker never adds `'unsafe-inline'` or `'unsafe-eval'`.

- Script **nonce** on the origin policy is copied onto every injected `<script>` (including the JSON config).
- `'strict-dynamic'` is kept. Parser-inserted scripts need that nonce; without a nonce the Worker **fail-opens** (no injection).
- CSS from `injectCSS` is moved onto `document.adoptedStyleSheets` in bootstrap, or stamped with the style nonce if Constructable Stylesheets are unavailable.
- A `<meta http-equiv="Content-Security-Policy">` is rewritten the same way as the header. If it cannot be honoured, injection is skipped.

Host allowlists (`'self'`, jsDelivr, Flagsmith origin) are still added for browsers that ignore `'strict-dynamic'`.

## Local demo

Terminal 1 — origin in **edge mode** (no in-page experiment):

```bash
npm run site -- --port 4174 --edge-origin
```

Terminal 2 — self-hosted Flagsmith **outside this repo**:

```bash
mkdir -p /tmp/flagsmith-lift && cd /tmp/flagsmith-lift
curl -o docker-compose.yml https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml
# pin 2.295.2 in that file, then:
docker compose up -d
```

If `migrate-db` hangs on a **throwaway Cloud Agent / CI VM**, `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` can unblock Docker bridge traffic. **VM only, never on a host you care about.** Do not put that sysctl in repo scripts.

```bash
FLAGSMITH_BOOTSTRAP_PASSWORD=… npx tsx edge/bootstrap-flag.ts
npm run edge:put-spec -- runtime/checkout-treatment.json
npx wrangler dev --config edge/wrangler.toml --persist-to edge/.wrangler/state
```

Open `http://127.0.0.1:8787/checkout/`. Control identities see the original barriers; treatment identities get labels, a named Place order control, contrast, and a keyboard-operable Shop trigger. Mouse checkout completes for both; keyboard checkout completes for treatment.

## Tests

- Unit: `tests/unit/edge-*.test.ts` — injection, cookie, spec validation, SSRF variants, CSP, HEAD/non-GET, fail-open, wall time, HTMLRewriter streaming fail-open.
- E2E: `tests/e2e/edge-*.spec.ts` — Playwright through `wrangler dev` with a mock Flagsmith so CI does not need Docker. Uses `tests/e2e/edge-wrangler.toml` + `tests/e2e/.dev.vars` and **does not overwrite** `edge/.dev.vars`. Real Flagsmith is used for recordings (`edge/record/`).

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```
