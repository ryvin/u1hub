# Public quote page — design (`u1-quote` service + Hub quote backend)

Date 2026-10-07. Fork ryvin/u1hub. Owner-approved in conversation, section by section.
Builds on the Estimate module (docs/estimate.md, docs/superpowers/specs/2026-10-06-estimate-design.md).

## 1. Purpose and decisions

Anyone online uploads an STL or 3MF at **quote.satisfyingprints3d.com** and gets an instant
price (or price range) and a "ready by" date based on the farm's real costs and schedule, then
can request the print. The owner reviews every request and replies with the final quote.

Owner decisions (2026-10-07):
- Audience: anyone online.
- Price: **a range the owner confirms, working towards firm instant prices** — every quote
  carries a confidence; a "firm prices" switch (off at first) makes exact-confidence quotes firm.
- Order flow: request with name, email, notes and options → owner notified → owner reviews and
  sends the final quote; payment outside the Hub for now.
- Visitor options: quantity, material & colour, quality (Standard / Strong), rush.
- Ready date: queue + working hours + post-processing days.
- Architecture: **B — a separate public service**; the Hub stays private.

## 2. Architecture

```
Internet ── Cloudflare tunnel (existing snapmaker-cloudflared) ──▶ u1-quote :4560 (new container)
                                                                     │ page, upload, quote, request, status
                                                                     │ X-Quote-Key shared secret
                                                                     ▼ http://host.docker.internal:4545
                                                                  u1-print-hub (LAN; its public name
                                                                  u1hub.pinedamail.com stays behind
                                                                  Cloudflare Access)
                                                                     └ /api/quote-backend/* (estimate module)
```

### 2.1 `u1-quote` (new, public)
- Lives in the fork at `quote/` (own `package.json`, `Dockerfile`, `server.js`, `public/`,
  `test/`), compose file `quote/compose.yml` (service `u1-quote`, container `u1-quote`,
  port **4560**, `extra_hosts: host.docker.internal:host-gateway`). Node 22, Express only.
- Holds no Hub code and no Hub files. Config by env: `HUB_URL`, `QUOTE_KEY`,
  `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`, `MAX_MB` (100), rate limits, `PUBLIC_URL`.
- Routes: `GET /` (the page), `POST /upload` (raw body, streamed to the Hub), `GET /q/:token`
  (status page), `GET /api/q/:token` (customer view JSON), `POST /api/q/:token/options`,
  `POST /api/q/:token/request`, `POST /api/q/:token/delete`, `GET /healthz`.
- Every visitor-facing view is what the Hub returned; the service only filters again
  (defence in depth: an allow-list of fields).

### 2.2 Hub quote backend (estimate module)
- `/api/quote-backend/*`, accepted only with header `X-Quote-Key` equal to
  `config.json estimate.quote_key` (constant-time compare); 401 otherwise. Works in every auth
  mode (the auth gate allow-lists the path only when the header is present and valid).
- Endpoints: `POST upload` (raw body → a quote: an estimate with `public: true` and a random
  128-bit `token`), `GET quote/:token`, `POST quote/:token/options`, `POST quote/:token/request`
  (contact + notes), `POST quote/:token/delete`.
- Customer view (only these fields): `status`, `confidence`, `price` (firm) or `price_low` /
  `price_high`, `each`, `qty`, `material`, `colour`, `quality`, `rush`, `ready_by` (date),
  `valid_until`, `multicolour`, `fits` (boolean only), `notes_from_owner`, `final_price` (once
  sent), `limits` (option lists). Never: costs, rates, printer names, file names, candidates,
  other quotes.
- Owner side (Estimate tab): a **Requests** list (new / quoted / accepted / declined /
  closed), each opening the full internal estimate; "Send quote" sets `final_price` and a note
  (status → quoted); "Accept" links it to a costing client/project (created from the contact)
  and optionally queues it in Dispatch; "Decline"; "Close" (starts retention).
- Notification on a new request through the notify module (`ctx.use("notify…")` as it exposes).

## 3. The numbers

### 3.1 Confidence and price
| Source | Confidence | Shown |
|---|---|---|
| printed before (size "same", ≥ 1 done) or embedded plate gcode | exact | firm if the switch is on, else a narrow range |
| 3MF slice info | good | range: grams fixed, time ± the fit's band |
| geometry only | rough | range: grams ± the calibration `k` band, time ± the fit's band |

Range: costing's pricing run at the band's low and high grams/minutes; recommended price at each
end; rounded outward to $0.50; costing's `min_fee` applied. Settings: `firm_prices` (off),
`round_to` (0.50), `valid_days` (14). Quote accuracy: when a request is accepted and its project
has prints, quoted vs actual is recorded per confidence and shown in the Requests list.

### 3.2 Options
- Quantity 1–100 (public cap; configurable), costing's quantity breaks.
- Material & colour: an owner-curated list in Settings (seeded from Spoolman colours), each
  `{ material, colour name, hex, in_stock }`; out-of-stock entries are shown disabled.
  A multi-colour 3MF shows "printed in its own colours" instead of a picker.
- Quality: Standard / Strong (the estimate presets).
- Rush: the owner's multiplier; rush also schedules ahead of the queue.

### 3.3 Ready date
Pure function `readyBy({ now, printers, queue, job, hours, post_days, rush })`:
1. Each fitting printer's free-from time: `now`, or now + its remaining print time.
2. Queued Dispatch jobs, in order, each on the earliest-free fitting printer (unless rush:
   this job first).
3. This job's plates (quantity) on the earliest-free fitting printers.
4. A plate may start only inside working hours (`hours`: days of week + start/end), may run past
   the end.
5. Ready = last plate's finish + `post_days` working days → a date (owner's timezone).
Recomputed when the owner sends the final quote.

## 4. Safety, privacy, operations

- Turnstile on upload and request (verified server-side by `u1-quote`); per-IP limits from
  `CF-Connecting-IP` (uploads 5/h, requests 3/day, defaults), a global cap (60 uploads/h); `.stl`
  / `.3mf` only; `MAX_MB` 100; streamed; the Hub's hardened reader (zipcap, closed-solid check,
  async STL) does the parsing and enforces its own caps on the backend path.
- Strict CSP (self + Turnstile), no other third-party script; every string escaped.
- Retention: unrequested quotes and their files deleted after 7 days; requests keep files until
  closed + 30 days; a visitor's "delete my files" button. A plain privacy note on the page.
- Status links: 128-bit random tokens; no listing; no accounts.
- Hub unreachable → "Quotes are paused — try again soon", uploads refused (not queued).
- Tunnel: one ingress rule `quote.satisfyingprints3d.com → http://host.docker.internal:4560` in
  the existing tunnel config (`/mnt/e/Code/YT_Steam_Manager/cloudflared-config.yml`, owned by
  that project) plus its DNS route (skill `cloudflare-dns-tunnels`), **no** Cloudflare Access on
  this hostname. Port 4560 and container name `u1-quote` checked free 2026-10-07.

## 5. Testing
- `quote/test/quote-standalone.js` against a fake Hub: limits, Turnstile pass/fail (Cloudflare's
  published test keys), size cap, the field allow-list, status token, retention, "paused".
- Estimate suite: the backend refuses a missing/wrong key; customer views never contain a fake
  estimate's printer names, file names or cost fields (asserted by searching the JSON).
- `readyBy` with fixed queue/hours fixtures and hand-worked dates (no wall clock: `now` is an
  input).
- Playwright on a throwaway pair (Hub + service), then one live check through
  quote.satisfyingprints3d.com.

## 6. Out of scope (now)
Online payment; email sending (the owner replies from their own mail; the status page shows the
final quote); customer accounts; automatic job creation without the owner's accept.
