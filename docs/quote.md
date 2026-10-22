# Public quote page (`u1-quote` + the Hub's quote backend)

Anyone online uploads an STL or 3MF at **quote.satisfyingprints3d.com**, gets a
price (a range, or one firm price) and a "ready by" date from the farm's real
costs and queue, and can request the print. The owner answers every request
from the Hub. Design: [superpowers/specs/2026-10-07-public-quote-design.md](superpowers/specs/2026-10-07-public-quote-design.md);
plan: [superpowers/plans/2026-10-07-public-quote.md](superpowers/plans/2026-10-07-public-quote.md).

```
Internet ── Cloudflare tunnel (snapmaker-cloudflared) ──▶ u1-quote :4560   (quote/, public, no Hub code)
                                                            │  X-Quote-Key
                                                            ▼  http://host.docker.internal:4545
                                                         u1-print-hub  /api/quote-backend/*  (stays private)
```

## The two halves

**The Hub** (fork module `estimate`): a quote is an estimate with `public: true`
and a random 128-bit token, priced by the same `compute()` as the Estimate tab.
- `modules/estimate/quote.js` (pure): confidence, the price range, the
  visitor's options and contact checks, the owner's settings checks, the
  customer allow-list (`VIEW_FIELDS`), retention.
- `modules/estimate/readyby.js` (pure, `now` is an input): the ready date.
- `modules/estimate/quote-backend.js`: the key-gated `/api/quote-backend/*`
  routes and the owner's `/api/estimate/quote/*` routes.
- `auth.js`: one condition lets `/api/quote-backend/*` past the session gate
  only when an `X-Quote-Key` header is present; the module checks the value.
- The Estimate tab: **Quote requests** and **Public quotes** cards.

**The service** (`quote/`, container `u1-quote`): the page, Cloudflare
Turnstile, per-IP and global limits, the size cap, a strict CSP, and a second
copy of the field allow-list (the suite checks the two are equal). It holds no
quotes: every quote lives in the Hub.

## Owner setup (once)

1. Hub → Estimate → **Public quotes**: working days, hours and timezone (an
   IANA name such as `America/Chicago`), post-processing days, rush ×, max
   qty, round-to, valid days; the colour palette (**Suggest from loaded
   spools** fills it from the shelf and the loaded heads; check the names; an
   unticked *In stock* shows the colour disabled on the page). **Save**.
2. **New key** → copy the key into `quote/.env` as `QUOTE_KEY` (shown once).
3. Cloudflare dashboard → Turnstile → add a widget for
   `quote.satisfyingprints3d.com` → its site key and secret into `quote/.env`
   (`TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`). Template: `quote/.env.example`.
4. `cd quote && docker compose up -d --build`; `docker exec u1-quote wget -qO- http://127.0.0.1:4560/healthz`
   → `{"ok":true,"hub":true,…}` (no host port is published; see below).
   Tunnel rule (in `/mnt/e/Code/YT_Steam_Manager/cloudflared-config.yml`, before the
   final 404): `hostname: quote.satisfyingprints3d.com`, `service: http://u1-quote:4560`,
   no Access application; then recreate `snapmaker-cloudflared` and add the DNS route.
5. Tick **Taking quotes** when ready. Until then the page says quotes are
   paused and refuses uploads.

Prices come from the Projects tab rates (material, machine, energy, overhead,
markup, minimum fee). With no rates set a quote shows "We'll price this one by
hand" - never $0.

## The numbers

| The estimate's source | Confidence | The visitor sees |
|---|---|---|
| printed before (same size, done at least once), or the 3MF's own plate gcode | exact | a ±5 % range, or one price when **Firm prices** is on |
| the 3MF's slice info | good | a range: grams fixed, time ± the time fit's band |
| geometry only | rough | a range: grams ± the calibration's error (15 % floor, 30 % without one), time ± the fit's band |

Each end is priced by costing's own `pricing()`, rounded outward to `round_to`,
never under the minimum fee and never under one rounding step. Quantity, Strong
(the `strong` preset) and rush (× the owner's multiplier) re-price live.

**Ready by**: each printer the model fits is free now or when its print ends;
the queued Dispatch jobs go first in order (rush jumps them); one plate per
piece on the earliest-free fitting printer; a plate only starts inside working
hours and may run past them; then post-processing working days. The date is
frozen when the owner sends the final quote.

## Requests

The visitor's request (name, email, notes, a second Turnstile) sends an ntfy
notification (Settings → Notifications) and appears in **Quote requests**:
- **Send quote**: the final price and a note; the visitor's status page shows
  both.
- **Accept**: creates a costing client and a project (charged = the final
  price) and links them. Slice the file, then queue it in Dispatch (Dispatch
  queues gcode, a quote is a model).
- **Decline** / **Close**: start the 30-day retention.

A request keeps the colour, quantity and options it was made with
(`frozen` on the estimate), whatever the palette says later. The ntfy message is
sent without holding up the visitor's answer.

Retention: an unrequested quote and its file go after 7 days (so the page's
"valid until" for an unrequested quote is the earlier of `valid_days` and 7
days); a request keeps
its file until closed or declined + 30 days. The visitor's **Delete my files**
removes an unrequested quote at once, and only the file of a requested one.

## Limits and safety (service env, defaults)

`MAX_MB` 100, `UPLOADS_PER_HOUR` 5 per IP, `REQUESTS_PER_DAY` 3 per IP,
`GLOBAL_UPLOADS_PER_HOUR` 60, `READS_PER_HOUR` 300 per IP; `.stl`/`.3mf` only.
The client IP is `CF-Connecting-IP` only with `TRUST_CF=1` **and** when the
connection comes from a peer listed in `TRUSTED_PROXY`; otherwise it is the socket
address. Publishing no host port keeps the LAN out, but the container shares
`yt_steam_manager_default` with every other container of that compose project, and
any of them could send its own `CF-Connecting-IP` and pick its own rate-limit bucket
(review 2026-10-21). `TRUSTED_PROXY` takes IPs, CIDRs and hostnames, comma or space
separated; a hostname (the tunnel container's name on the Docker network) is
resolved before the service listens and every minute after, because a container's
address changes when it is recreated. compose sets it to `snapmaker-cloudflared`
unless `quote/.env` says otherwise. `TRUST_CF=1` with an empty `TRUSTED_PROXY`
trusts nobody: the header is ignored, every visitor shares the tunnel's limit, and
the service logs a warning at start. The startup line names whom it trusts
(`CF-Connecting-IP from snapmaker-cloudflared`). The Hub enforces its own 100 MB cap
(`U1HUB_QUOTE_MAX_MB`) and reads every upload with the Estimate tab's hardened
readers.

**Disk use.** Stored public-quote files are capped in total by
`estimate.quote_store_mb` in the Hub's `config.json` (default 2048). It is counted
from the quote records (each file's size at upload), not by walking the disk.
Files that are gone do not count: an upload whose analysis failed (its file is
deleted at once; the error record stays so the visitor's page still says "We
couldn't read this file"), a visitor's **Delete my files**, and pruned quotes. At
or over the cap the Hub answers new uploads 503 `paused` with "We're busy right
now - please try again in a while" (the page shows it as-is), and logs one warn
(`quote: public quote files use … MB, at estimate.quote_store_mb …`) until usage is
under the cap again. The cap is checked before an upload starts, so it can be
exceeded by the uploads already in flight (each at most `MAX_MB`; at most
`GLOBAL_UPLOADS_PER_HOUR` an hour). CSP: `default-src
'self'`, scripts and frames also from `challenges.cloudflare.com`, no inline
script or style. A Hub that does not answer, or answers 5xx or 401, shows
"Quotes are paused - try again soon"; nothing is queued.

The service runs as `node` (`NODE_ENV=production`) on a read-only filesystem,
listens on 4560 inside the container, publishes no host port, and joins the
tunnel container's network `yt_steam_manager_default` (external; owned by the
YT_Steam_Manager compose project; shared with that project's other containers,
hence `TRUSTED_PROXY`). It reaches the Hub at
`host.docker.internal:4545`. Errors (a broken JSON body, one over 16 kB) answer
a short JSON message, never a stack trace. The Hub analyses public uploads one
at a time (`ping` reports `analyses: { running, waiting, max_running }`); the
visitor sees "Reading your model…" while one waits.

## API

Service (public): `GET /`, `GET /q/:token` (the same page), `GET /api/config`
(`siteKey`, `maxMb`), `POST /upload` (raw body, `X-File-Name`,
`X-Turnstile-Token`), `GET /api/q/:token`, `POST /api/q/:token/options`
(`qty`, `palette_id`, `quality`, `rush`), `POST /api/q/:token/request` (`name`,
`email`, `notes`, `turnstile`), `POST /api/q/:token/delete`, `GET /healthz`.

Hub, with `X-Quote-Key`: `GET /api/quote-backend/ping`, `POST
/api/quote-backend/upload`, `GET /api/quote-backend/quote/:token`, `POST
…/quote/:token/options|request|delete`.

Hub, owner (session): `GET|POST /api/estimate/quote/settings`, `POST
/api/estimate/quote/key`, `POST /api/estimate/quote/palette/seed`, `GET
/api/estimate/quote/requests`, `POST
/api/estimate/quote/requests/:id/send|accept|decline|close`.

## Tests

- `test/quote-backend-standalone.js` (Hub side; falsify `U1HUB_QUOTE_FALSIFY=1`):
  the pure units, readyBy against hand-worked dates (UTC and Chicago), and a
  booted Hub: the key (missing, wrong, right; and in password mode a key opens
  nothing else), upload → token → a view with no file name, printer name or
  cost, options, request + ntfy, delete, the owner routes, a new key; the
  `quote_store_mb` cap (a failed analysis keeps no file and does not count, the
  next upload over the cap gets 503 paused, one warn).
- `quote/test/quote-standalone.js` (service; falsify `QUOTE_FALSIFY=1`) against
  a fake Hub and a fake siteverify: limits, Turnstile pass/fail, size cap, the
  allow-list, tokens, "paused", a spoofed `CF-Connecting-IP` with `TRUST_CF` unset,
  with `TRUST_CF=1` from a peer not in `TRUSTED_PROXY`, and with `TRUSTED_PROXY`
  empty; `TRUSTED_PROXY` matching (CIDR, IPv4-mapped, IPv6, a hostname); error bodies,
  the CSP and the page's no-inline/no-innerHTML rules.
- Each suite's port can be moved with `U1HUB_QUOTE_TEST_PORT` / `QUOTE_TEST_PORT`
  (the fake Hub takes the next port) so two runs on one machine do not collide.

## Verification record

- 2026-10-07, throwaway pair (Hub :45992 with the owner's real rates and one
  unreachable demo U1; service :45998 with Cloudflare's always-pass Turnstile
  test keys, a real siteverify call): upload a 30 mm cube → "rough",
  $0.50–$2.00, ready Thu; qty 50 → $41–$76.50, ready Oct 13; Strong and rush
  re-price; the out-of-stock colour is disabled; request → "Requested"; the
  owner's Send quote ($58 + note) → the status page shows both; Delete my files
  → the quote is gone (404). 360 px wide: no horizontal scroll; dark mode
  checked. The owner's cards: palette save and reload, a bad timezone refused,
  send → accept (client + project charged $25 created) → close, the two-click
  New key.
- Live check through quote.satisfyingprints3d.com: not yet (needs the
  Turnstile keys and the tunnel rule; plan Task 10).
