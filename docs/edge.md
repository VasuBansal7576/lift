# Lift Layer 1 — edge Worker

A Cloudflare Worker reverse proxy that sits **in front of any origin** and ships WCAG fixes with **zero code changes** to the site. Visitors are bucketed by a sticky `lift_vid` identity into a Flagsmith multivariate flag. The flag’s value is a patch-spec id stored in Workers KV. `runtime/runtime.js` applies the spec in the browser.

Free-tier demo: `wrangler dev` / Miniflare locally. No Cloudflare account required.

## Layout

| Path | Role |
| --- | --- |
| `edge/worker.js` | Worker entry (`fetch` → `handleRequest`) |
| `edge/lib/` | Cookie, CSP, Flagsmith eval, HTML injection, bootstrap source |
| `edge/wrangler.toml` | ORIGIN, Flagsmith URL/flag name, KV `SPECS`, runtime assets |
| `edge/put-spec.ts` | `npm run edge:put-spec` — validate then write KV |
| `edge/bootstrap-flag.ts` | Create the self-hosted multivariate flag (Track 3) |
| `edge/runtime-assets` | Symlink to `runtime/` so the Worker serves `runtime.js` |

Do not edit `runtime/`, `sites/`, or the origin HTML. The origin in this repo is the checkout fixture served at `http://127.0.0.1:4174`.

## Config (env)

Set in `edge/wrangler.toml` `[vars]` or overridden with `wrangler dev --var`. The **client** environment key is a secret binding in `edge/.dev.vars` (gitignored). Copy `edge/.dev.vars.example`.

| Binding | Purpose |
| --- | --- |
| `ORIGIN` | Origin base URL (no trailing slash needed) |
| `FLAGSMITH_API_URL` | Flagsmith **API** root, with `/api/v1/`. Cloud: `https://edge.api.flagsmith.com/api/v1/`. Self-hosted: `http://127.0.0.1:8000/api/v1/` |
| `FLAGSMITH_ENVIRONMENT_KEY` | Public **client** environment key (`X-Environment-Key`). Never an org admin token. Never logged. |
| `FLAGSMITH_FLAG_NAME` | Multivariate flag (default `lift_edge_spec`) |
| `FLAGSMITH_SDK_URL` | Injected JS SDK (default jsDelivr `@flagsmith/flagsmith@12.4.0`) |
| `FLAGSMITH_EVAL_TIMEOUT_MS` | Server-side eval budget (default `300`) |
| `SPECS` | KV namespace; keys are spec ids |

Self-hosted Flagsmith is the Track 3 integration point. The Worker only talks to `FLAGSMITH_API_URL`; cloud and OSS share the same identities API.

## What the Worker does

1. Proxies the request to `ORIGIN` (rewrites `Location` back onto the Worker host).
2. Non-HTML is passed through unchanged.
3. For HTML:
   - Sets `lift_vid` if missing (`Path=/; Max-Age=1y; SameSite=Lax`; `Secure` on https; **not** HttpOnly so the SDK can read it).
   - Evaluates the visitor’s flag **server-side** (`GET {FLAGSMITH_API_URL}identities/?identifier=…`) with a **300 ms** timeout.
   - Control (empty / `"control"` value): injects the SDK, `runtime/runtime.js`, and bootstrap. No spec is applied.
   - Treatment: the multivariate **value is the spec id**. The Worker loads that JSON from KV and inlines it.
4. HTMLRewriter appends to `<head>`:
   - `application/json` config (`#lift-edge-config`) — not executable JS
   - Flagsmith JS SDK (module)
   - `/runtime/runtime.js`
   - `/__lift/bootstrap.js`
5. Personalised HTML is never cacheable in a shared cache: `Cache-Control: private, no-store, no-cache, must-revalidate`. `Server-Timing: liftcpu;dur=…` reports Worker CPU-ish wall time excluding origin/Flagsmith waits.

The Worker does **not** apply the spec itself (keeps CPU under the 10 ms free-tier budget). Application is `runtime.js` in the browser, which already fail-opens.

## Fail open

Any of these returns the **origin HTML unmodified** (no injected scripts). The sticky cookie may still be set.

| Reason | `Server-Timing` desc |
| --- | --- |
| Non-HTML | `non-html` |
| Flagsmith HTTP error / network | `flagsmith-down` |
| Flagsmith eval > 300 ms | `flagsmith-timeout` |
| Spec id in the flag but missing from KV | `kv-miss` |
| KV value is not JSON / rewriter throws | `parse-error` |

The bootstrap also fail-opens: SDK errors, `applyPatchSpec` failures, and 404 spec fetches leave the DOM as the origin sent it.

## Sticky identity

Cookie name `lift_vid` matches `sites/shared/identity.js`. Same visitor → same Flagsmith identity → same variant across reloads. The Worker mints a UUID when the cookie is absent.

## Specs in KV

```bash
npm run edge:put-spec -- runtime/checkout-treatment.json
npm run edge:put-spec -- --validate-only path/to/bad.json   # exits 1 if invalid
```

Validation uses `shared/patch-spec.ts` (`parsePatchSpec`). Invalid specs are rejected and **not** written. Local KV uses `--persist-to edge/.wrangler/state` so `wrangler dev` sees the same keys.

The demo treatment value is `checkout-treatment-v0`. Control has no spec.

## CSP

The Worker never adds `'unsafe-inline'` or `'unsafe-eval'`. If the origin sends `Content-Security-Policy`, the Worker **minimally** adds:

- `script-src` / existing `script-src-elem`: `'self'` and `https://cdn.jsdelivr.net`
- `connect-src`: `'self'` and the Flagsmith API origin

Bootstrap and runtime are same-origin (`/__lift/bootstrap.js`, `/runtime/runtime.js`). Config is `type="application/json"`, not a script. Nonces and hashes on the origin policy are kept. If `script-src` was `'none'`, it is replaced by those two sources only.

## Local demo

Terminal 1 — origin (unchanged checkout fixture):

```bash
npm run site -- --port 4174
```

Terminal 2 — self-hosted Flagsmith **outside this repo**:

```bash
mkdir -p /tmp/flagsmith-lift && cd /tmp/flagsmith-lift
curl -o docker-compose.yml https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml
# pin 2.295.2 in that file, then:
docker compose up -d
```

If `migrate-db` hangs on a fresh VM: `sudo sysctl -w net.bridge.bridge-nf-call-iptables=0` (do **not** put that in repo scripts).

```bash
npx tsx edge/bootstrap-flag.ts          # writes edge/.dev.vars
npm run edge:put-spec -- runtime/checkout-treatment.json
npx wrangler dev --config edge/wrangler.toml --persist-to edge/.wrangler/state
```

Open `http://127.0.0.1:8787/checkout/`. Control identities see the original barriers; treatment identities get labels, a named Place order control, contrast, and a keyboard-operable Shop trigger.

## Tests

- Unit: `tests/unit/edge-*.test.ts` — injection, cookie, spec validation, non-HTML, each fail-open mode.
- E2E: `tests/e2e/edge-*.spec.ts` — Playwright through `wrangler dev` with a mock Flagsmith so CI does not need Docker. Real Flagsmith is used for recordings.

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```
