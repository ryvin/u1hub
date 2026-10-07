# Public Quote Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone online uploads an STL/3MF at quote.satisfyingprints3d.com, gets a price (range or firm) and a ready-by date from the farm's real costs and queue, and can request the print; the owner answers from a Requests list in the Hub's Estimate tab.

**Architecture:** Two halves. (1) The Hub's `estimate` fork module grows a key-protected backend, `/api/quote-backend/*`, plus owner routes and UI; quotes are estimates with `public: true` and a 128-bit token, priced by the existing `compute()`/`priceEstimate()` chain. Pure logic lives in two new files, `modules/estimate/quote.js` (confidence, ranges, the customer allow-list, validation, retention) and `modules/estimate/readyby.js` (the schedule). (2) A new, separate, public Express service, `quote/` → container `u1-quote` on :4560, holding no Hub code: page, Turnstile, rate limits, and a second allow-list. It talks to the Hub over `host.docker.internal:4545` with an `X-Quote-Key` header.

**Tech Stack:** Node 22, Express 4 (`^4.19.2`, the root's), no other runtime dependency. Cloudflare Turnstile (siteverify over `fetch`). Docker Desktop on WSL2. The existing Cloudflare tunnel `snapmaker-cloudflared`.

**Spec:** `docs/superpowers/specs/2026-10-07-public-quote-design.md` (owner-approved 2026-10-07).

## Global Constraints

- Fork rules (docs/FORK.md): features stay in modules; a core file changes by one line at most (here: one line in `auth.js`); **the version is never bumped**; every new suite has a falsify switch that must turn it red (rule 6); no test depends on the wall clock or timing (rule 7: `now` is an input).
- Commits as `ryvin <18613731+ryvin@users.noreply.github.com>` (`git -c user.name=ryvin -c user.email=18613731+ryvin@users.noreply.github.com commit ...`); explicit `git add <paths>`, never `-A`; never commit state files (`data/`, `config.json`, `estimates.json`, `quote/.env`). Work on branch `quote` cut from `ryvin`; ff-merge to `ryvin`; push `git push fork ryvin`.
- The Hub stays private. `/api/quote-backend/*` answers only with `X-Quote-Key` equal to `config.json estimate.quote_key` (constant-time compare); 401 otherwise; works in every auth mode.
- Customer view carries only: `status`, `confidence`, `price` (firm) or `price_low`/`price_high`, `each`, `qty`, `material`, `colour`, `quality`, `rush`, `ready_by`, `valid_until`, `multicolour`, `fits` (boolean), `notes_from_owner`, `final_price`, `limits`, plus the analysis `phase`/`error` flag. Never costs, rates, printer names, file names, candidates, other quotes.
- Confidence: printed before (size `same`, ≥ 1 done) or plate gcode → **exact**; 3MF slice info → **good**; geometry → **rough**. Ranges rounded outward to `round_to` (0.50); costing's `min_fee` applies; `firm_prices` off by default; `valid_days` 14.
- Options: qty 1–100 (`qty_max`), owner palette `{ id, material, colour, hex, in_stock }` (out of stock shown disabled), quality Standard/Strong (presets `standard`/`strong`), rush (owner's `rush_multiplier`, and it schedules ahead of the queue). Multi-colour 3MF: "printed in its own colours", no picker.
- Ready date: `readyBy({ now, printers, queue, job, hours, post_days, rush })`, pure.
- Service limits (env defaults): `MAX_MB` 100, uploads 5/h per IP, requests 3/day per IP, 60 uploads/h global; `.stl`/`.3mf` only; Turnstile on upload and request, verified server-side.
- Retention: unrequested quotes and files deleted after 7 days; requests keep files until closed (or declined) + 30 days; visitor "delete my files".
- Strict CSP: `default-src 'self'`; scripts and frames also `https://challenges.cloudflare.com`; no other third-party script; every string escaped.
- Hub unreachable or quotes disabled → "Quotes are paused — try again soon", uploads refused, not queued.
- Port 4560 and container name `u1-quote` (checked free 2026-10-07, re-check before deploy). Tunnel: one ingress rule `quote.satisfyingprints3d.com → http://host.docker.internal:4560`, no Access, in `/mnt/e/Code/YT_Steam_Manager/cloudflared-config.yml` (another project's file: owner confirms before the edit and the tunnel restart).
- Deploy only when no printer is within ~15 min of finishing and no SME runner (`ps -eo args | grep "[n]ode scripts/sme-runner.js"`). Kill test processes by listening port, never `pkill -f`.

## Review Focus

1. **A quote analysed before the owner set prices** (no rates) → `priceAt` returns null; the customer sees "We'll price this by hand" with a ready date and can still request — never `$0.00`. Pinned in Task 1 (`priceRange` null) and Task 4 (booted, no rates set: no price field is ever 0).
2. **The visitor reloads the status page during analysis or after the owner deleted the quote** → `phase: "analysing"` then the quote; a gone token → 404 "This quote has expired", never a 500. Pinned in Task 4 and Task 7.
3. **The open-quote retention rule meeting the old 30-day prune** → the old "unsaved > 30 days" rule must skip `public` estimates, or an open request vanishes at day 30. Pinned in Task 3.
4. **A palette entry removed or set out of stock after a visitor picked it** → options re-check on every recompute; the view drops back to the first in-stock entry and says so (`colour_changed: true`), never prices a colour the owner can't print. Pinned in Task 1 (`inputsFor` fallback).
5. **Spoofed `CF-Connecting-IP` from the LAN** straight at :4560 → limits still hold per socket address unless `TRUST_CF=1`; Turnstile still required. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `modules/estimate/quote.js` (new) | Pure: `QUOTE_DEFAULTS`, `keyOk`, `confidenceOf`, `pickPublicSource`, `bandsFor`, `priceRange`, `checkOptions`, `checkContact`, `checkPalette`, `checkSettings`, `customerView`, `expired`, `VIEW_FIELDS`. |
| `modules/estimate/readyby.js` (new) | Pure: `localParts`, `nextStart`, `addWorkingDays`, `readyBy`. |
| `modules/estimate/quote-backend.js` (new) | `mount(ctx, H)`: the `/api/quote-backend/*` routes and the owner's `/api/estimate/quote/*` routes. |
| `modules/estimate.js` (modify) | Extract `receive()` from the upload route; expose `H`; `compute()` adds `print.k_err` and `print.multicolour`; prune honours `quote.expired` and skips `public` in the old rule; mount the backend before `/:id` routes. |
| `auth.js` (modify, one line) | Let `/api/quote-backend/*` past the session gate when an `X-Quote-Key` header is present (the module checks the value). |
| `public/modules/estimate-ui.js` (modify) | "Quote requests" card and "Public quotes" settings card. |
| `test/quote-backend-standalone.js` (new) | Pure units of quote.js and readyby.js + booted Hub backend/owner routes. Port 45994. Falsify `U1HUB_QUOTE_FALSIFY=1`. |
| `quote/package.json`, `quote/server.js`, `quote/lib/{config,limits,turnstile,hub,view,upload}.js` (new) | The public service. |
| `quote/public/{index.html,app.js,style.css}` (new) | The page (upload, options, request) and the status page (same page, `/q/:token`). |
| `quote/test/quote-standalone.js` (new) | Service against a fake Hub and a fake siteverify. Ports 45996 (service), 45997 (fakes). Falsify `QUOTE_FALSIFY=1`. |
| `quote/Dockerfile`, `quote/compose.yml`, `quote/.env.example`, `quote/.dockerignore` (new) | Packaging. |
| `docs/quote.md` (new), `docs/estimate.md`, `docs/FORK.md`, `package.json`, `.gitignore` (modify) | Docs, suite wiring, `quote/.env` ignored. |

---

### Task 1: Pure quote logic (`modules/estimate/quote.js`)

**Files:**
- Create: `modules/estimate/quote.js`
- Create: `test/quote-backend-standalone.js` (pure section only in this task)

**Interfaces:**
- Produces:
  - `QUOTE_DEFAULTS` frozen `{ enabled:false, firm_prices:false, round_to:0.5, valid_days:14, rush_multiplier:1.5, qty_max:100, post_days:1, hours:{ days:[1,2,3,4,5], start:"09:00", end:"17:00", tz:"UTC" }, palette:[] }`
  - `keyOk(given:string, want:string) → boolean` (false when `want` shorter than 32 chars)
  - `confidenceOf(v) → "exact"|"good"|"rough"|null` (`v` = estimate `view()` output)
  - `pickPublicSource(est) → { source:"printed", candidate_key } | null`
  - `bandsFor(confidence, v) → { g:number, t:number }` (fractions)
  - `priceRange({ grams, minutes, confidence, g, t, firm, round_to, min_fee }, priceAt) → { price } | { price_low, price_high } | null`; `priceAt(grams, minutes) → number|null`
  - `checkOptions(body, settings, multicolour) → { options:{ qty, palette_id, quality, rush } } | { error }`
  - `inputsFor(options, settings, multicolour) → { qty, material, preset, rush, colour_name, colour_changed }`
  - `checkContact(body) → { contact:{ name, email, notes } } | { error }`
  - `checkPalette(list) → { palette } | { error }`; `checkSettings(body, current) → { settings } | { error }`
  - `customerView(q) → object` with only `VIEW_FIELDS` keys
  - `expired(est, now) → boolean`; constants `UNREQUESTED_MS` (7 d), `CLOSED_MS` (30 d)

- [ ] **Step 1: Write the failing test** — `test/quote-backend-standalone.js` (pure part; the booted part is added in Task 4)

```js
"use strict";
// test/quote-backend-standalone.js — fork module estimate (ryvin/u1hub): the
// public-quote backend. Pure units (quote.js, readyby.js), then a booted Hub
// (backend key, upload -> token -> customer view, options, request, owner
// routes, retention). Rule 6: U1HUB_QUOTE_FALSIFY=1 flips the allow-list
// expectation; the run must go red. Rule 7: every time is an input.
//
// Run: node test/quote-backend-standalone.js   (part of npm run test:standalone)
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const REPO = path.join(__dirname, "..");
const PORT = 45994, HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_QUOTE_FALSIFY === "1";
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 600) : "")); } }
const Q = require("../modules/estimate/quote.js");

function pureQuote() {
  console.log("\n-- quote.js --");
  const KEY = "k".repeat(40);
  ok(Q.keyOk(KEY, KEY) && !Q.keyOk("x", KEY) && !Q.keyOk("", KEY) && !Q.keyOk(KEY, "short") && !Q.keyOk(undefined, KEY), "keyOk: equal long key only");

  const cand = { key: "c1", size_check: "same", done: 2, actual_minutes: 10, grams: 4 };
  ok(Q.pickPublicSource({ candidates: [cand] }).candidate_key === "c1", "pickPublicSource: a same-size, printed-before match is used");
  ok(Q.pickPublicSource({ candidates: [{ ...cand, size_check: "different" }] }) === null && Q.pickPublicSource({ candidates: [{ ...cand, done: 0 }] }) === null, "pickPublicSource: different size or never done is not used");

  const V = (source, band_pct, extra) => ({ source, print: { band_pct, k_err: null }, candidates: [cand], candidate_key: "c1", ...(extra || {}) });
  ok(Q.confidenceOf(V("printed", 0)) === "exact", "printed before, same size -> exact");
  ok(Q.confidenceOf(V("sliced", 0)) === "exact" && Q.confidenceOf(V("sliced", 29)) === "good", "plate gcode -> exact, slice info -> good");
  ok(Q.confidenceOf(V("geometry", 33)) === "rough" && Q.confidenceOf(V("none", null)) === null, "geometry -> rough, nothing -> null");

  ok(JSON.stringify(Q.bandsFor("good", V("sliced", 29))) === JSON.stringify({ g: 0, t: 0.29 }), "good: grams fixed, time ± the fit's band");
  ok(Q.bandsFor("rough", V("geometry", 33)).g === 0.30 && Q.bandsFor("rough", V("geometry", 33, { print: { band_pct: 33, k_err: 0.2 } })).g === 0.2
     && Q.bandsFor("rough", V("geometry", 33, { print: { band_pct: 33, k_err: 0.01 } })).g === 0.15, "rough: grams ± k's error, 15 % floor, 30 % without a k");

  const lin = (g, m) => g * 0.5 + m * 0.1;   // a fake priceAt: $0.50/g + $0.10/min
  const good = Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5, min_fee: null }, lin);
  // low = 10 + 7 = 17.00, high = 10 + 13 = 23.00
  ok(good.price_low === 17 && good.price_high === 23 && !("price" in good), "good range: priced at both ends", good);
  const odd = Q.priceRange({ grams: 21, minutes: 100, confidence: "rough", g: 0.3, t: 0.3, round_to: 0.5, min_fee: null }, lin);
  // low = 7.35 + 7 = 14.35 -> 14.00, high = 13.65 + 13 = 26.65 -> 27.00
  ok(odd.price_low === 14 && odd.price_high === 27, "rounded outward to $0.50", odd);
  const ex = Q.priceRange({ grams: 20, minutes: 100, confidence: "exact", round_to: 0.5, firm: false }, lin);
  // centre 20.00 -> 19.00 .. 21.00 (±5 %)
  ok(ex.price_low === 19 && ex.price_high === 21, "exact, not firm: a narrow ±5 % range", ex);
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "exact", round_to: 0.5, firm: true }, lin).price === 20, "exact and firm: one price");
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5, firm: true }, lin).price_low === 17, "firm applies to exact only");
  ok(Q.priceRange({ grams: 2, minutes: 10, confidence: "rough", g: 0.3, t: 0.3, round_to: 0.5, min_fee: 5 }, lin).price_low === 5, "the low end never goes under the minimum fee");
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5 }, () => null) === null, "no rates -> no price (never $0)");

  const S = { ...Q.QUOTE_DEFAULTS, palette: [{ id: "pla-blk", material: "PLA", colour: "Black", hex: "#000000", in_stock: true }, { id: "petg-red", material: "PETG", colour: "Red", hex: "#ff0000", in_stock: false }] };
  ok(Q.checkOptions({ qty: 3, palette_id: "pla-blk", quality: "strong", rush: true }, S, false).options.qty === 3, "options: valid set accepted");
  ok(/qty/.test(Q.checkOptions({ qty: 101 }, S, false).error) && /qty/.test(Q.checkOptions({ qty: 0 }, S, false).error) && /qty/.test(Q.checkOptions({ qty: "x" }, S, false).error), "options: qty 1-100");
  ok(/colour/.test(Q.checkOptions({ palette_id: "petg-red" }, S, false).error) && /colour/.test(Q.checkOptions({ palette_id: "nope" }, S, false).error), "options: unknown or out-of-stock colour refused");
  ok(!Q.checkOptions({ palette_id: "nope" }, S, true).error, "options: a multi-colour model ignores the colour");
  ok(/quality/.test(Q.checkOptions({ quality: "hueforge" }, S, false).error), "options: quality is standard or strong");
  const inp = Q.inputsFor({ qty: 2, palette_id: "pla-blk", quality: "strong", rush: true }, S, false);
  ok(inp.qty === 2 && inp.material === "PLA" && inp.preset === "strong" && inp.rush === 1.5 && inp.colour_name === "Black", "inputsFor: palette -> material, rush -> multiplier", inp);
  const gone = Q.inputsFor({ qty: 1, palette_id: "petg-red", quality: "standard", rush: false }, S, false);
  ok(gone.colour_changed === true && gone.colour_name === "Black" && gone.rush === 1, "inputsFor: an out-of-stock pick falls back to the first in-stock colour and says so", gone);

  ok(Q.checkContact({ name: "Ann", email: "ann@example.com", notes: "hi" }).contact.email === "ann@example.com", "contact: valid");
  ok(Q.checkContact({ name: "", email: "ann@example.com" }).error && Q.checkContact({ name: "Ann", email: "nope" }).error && Q.checkContact({ name: "Ann", email: "a@b.co", notes: "x".repeat(2001) }).error, "contact: name, email and notes length checked");
  ok(Q.checkContact({ name: "A\u0000nn\u0007", email: "a@b.co" }).contact.name === "Ann", "contact: control characters stripped");

  ok(Q.checkPalette([{ material: "pla", colour: "Blue", hex: "#0000FF", in_stock: true }]).palette[0].material === "PLA", "palette: material upper-cased, id assigned");
  ok(Q.checkPalette([{ material: "PLA", colour: "Blue", hex: "blue" }]).error, "palette: hex must be #rrggbb");
  ok(Q.checkSettings({ round_to: 0 }, Q.QUOTE_DEFAULTS).error && Q.checkSettings({ hours: { days: [8] } }, Q.QUOTE_DEFAULTS).error && Q.checkSettings({ hours: { tz: "Mars/Base" } }, Q.QUOTE_DEFAULTS).error, "settings: bad round_to, day or timezone refused");
  ok(Q.checkSettings({ firm_prices: true, post_days: 2 }, Q.QUOTE_DEFAULTS).settings.post_days === 2, "settings: valid change accepted");

  const leaky = { status: "quote", confidence: "rough", price_low: 1, price_high: 2, cost: { total: 9 }, printer: "davinci", files: [{ name: "secret.stl" }], candidates: [1], email: "x@y.z", qty: 1 };
  const cv = Q.customerView(leaky);
  const allowed = FALSIFY ? [...Q.VIEW_FIELDS, "cost"] : Q.VIEW_FIELDS;
  ok(Object.keys(cv).every(k => Q.VIEW_FIELDS.includes(k)) && Object.keys(leaky).filter(k => !allowed.includes(k)).every(k => !(k in cv)), "customerView keeps only the allow-list" + (FALSIFY ? " [FALSIFIED]" : ""), cv);

  const D = 24 * 3600 * 1000, now = 100 * D;
  ok(Q.expired({ public: true, status: "quote", created: now - 8 * D }, now) && !Q.expired({ public: true, status: "quote", created: now - 6 * D }, now), "unrequested: gone after 7 days");
  ok(!Q.expired({ public: true, status: "new", created: now - 90 * D }, now), "an open request never expires");
  ok(Q.expired({ public: true, status: "closed", created: 0, closed_at: now - 31 * D }, now) && !Q.expired({ public: true, status: "declined", created: 0, closed_at: now - 29 * D }, now), "closed/declined: gone 30 days after");
  ok(!Q.expired({ status: "quote", created: 0 }, now), "a non-public estimate is not this rule's business");
}

async function main() {
  pureQuote();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/quote-backend-standalone.js`
Expected: crash `Cannot find module '../modules/estimate/quote.js'`.

- [ ] **Step 3: Write the implementation** — `modules/estimate/quote.js`

```js
// modules/estimate/quote.js — the public quote's numbers and its guards, pure:
// confidence from the estimate's source, a price range priced at both ends by
// costing's own chain (priceAt), the visitor's options and contact checks, the
// owner's settings checks, the customer allow-list, and retention.
// Fork module estimate (ryvin/u1hub). Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md
"use strict";
const crypto = require("crypto");
const DAY = 24 * 3600 * 1000;
const UNREQUESTED_MS = 7 * DAY, CLOSED_MS = 30 * DAY;
const EXACT_BAND = 0.05, GEO_G_DEFAULT = 0.30, GEO_G_MIN = 0.15;
const QUALITIES = ["standard", "strong"];
const QUOTE_DEFAULTS = Object.freeze({ enabled: false, firm_prices: false, round_to: 0.5, valid_days: 14, rush_multiplier: 1.5, qty_max: 100, post_days: 1,
  hours: Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: "09:00", end: "17:00", tz: "UTC" }), palette: Object.freeze([]) });
const VIEW_FIELDS = Object.freeze(["status", "phase", "error", "confidence", "price", "price_low", "price_high", "each", "qty", "material", "colour", "colour_changed", "quality", "rush",
  "ready_by", "valid_until", "multicolour", "fits", "notes_from_owner", "final_price", "limits", "files_deleted"]);
const r2 = x => Math.round(x * 100) / 100;
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

function keyOk(given, want) {
  if (typeof want !== "string" || want.length < 32 || typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const chosen = v => (v.candidates || []).find(c => c.key === v.candidate_key) || (v.candidates || [])[0] || null;
function pickPublicSource(est) {
  const c = (est.candidates || []).find(x => x.size_check === "same" && x.done >= 1 && x.actual_minutes != null);
  return c ? { source: "printed", candidate_key: c.key } : null;
}
function confidenceOf(v) {
  const band = v.print ? v.print.band_pct : null;
  if (v.source === "printed") { const c = chosen(v); return c && c.size_check === "same" && c.done >= 1 && band === 0 ? "exact" : "rough"; }
  if (v.source === "sliced") return band === 0 ? "exact" : "good";
  if (v.source === "geometry") return "rough";
  return null;
}
function bandsFor(confidence, v) {
  const t = Math.max(0, Number(v.print && v.print.band_pct) || 0) / 100;
  if (confidence === "exact") return { g: 0, t: 0 };
  if (confidence === "good") return { g: 0, t };
  const k = v.print && v.print.k_err;
  return { g: k == null ? GEO_G_DEFAULT : Math.max(GEO_G_MIN, k), t };
}
function priceRange(o, priceAt) {
  const step = o.round_to > 0 ? o.round_to : 0.5;
  const down = x => r2(Math.floor(x / step + 1e-9) * step), up = x => r2(Math.ceil(x / step - 1e-9) * step), near = x => r2(Math.round(x / step) * step);
  const floor = x => (o.min_fee != null && x < o.min_fee ? o.min_fee : x);
  if (o.confidence === "exact") {
    const p = priceAt(o.grams, o.minutes);
    if (p == null) return null;
    return o.firm ? { price: floor(near(p)) } : { price_low: floor(down(p * (1 - EXACT_BAND))), price_high: floor(up(p * (1 + EXACT_BAND))) };
  }
  const lo = priceAt(o.grams * (1 - o.g), o.minutes == null ? null : o.minutes * (1 - o.t));
  const hi = priceAt(o.grams * (1 + o.g), o.minutes == null ? null : o.minutes * (1 + o.t));
  if (lo == null || hi == null) return null;
  return { price_low: floor(down(lo)), price_high: floor(up(hi)) };
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function checkOptions(b, S, multicolour) {
  const out = {};
  if (own(b, "qty")) { const q = Number(b.qty); if (!Number.isInteger(q) || q < 1 || q > S.qty_max) return { error: "qty must be 1-" + S.qty_max }; out.qty = q; }
  if (own(b, "palette_id") && !multicolour) {
    const p = (S.palette || []).find(x => x.id === String(b.palette_id));
    if (!p || !p.in_stock) return { error: "that colour is not available" };
    out.palette_id = p.id;
  }
  if (own(b, "quality")) { if (!QUALITIES.includes(b.quality)) return { error: "quality must be standard or strong" }; out.quality = b.quality; }
  if (own(b, "rush")) out.rush = b.rush === true;
  return { options: out };
}
function inputsFor(o, S, multicolour) {
  const stock = (S.palette || []).filter(p => p.in_stock);
  const want = (S.palette || []).find(p => p.id === o.palette_id);
  const pick = multicolour ? null : (want && want.in_stock ? want : stock[0] || null);
  return { qty: o.qty || 1, preset: QUALITIES.includes(o.quality) ? o.quality : "standard", rush: o.rush ? S.rush_multiplier : 1,
           material: pick ? pick.material : "PLA", colour_name: pick ? pick.colour : null, palette_id: pick ? pick.id : null,
           colour_changed: !multicolour && !!o.palette_id && (!pick || pick.id !== o.palette_id) };
}
function checkContact(b) {
  const name = clean(b.name, 80), email = clean(b.email, 200), notes = String(b.notes == null ? "" : b.notes);
  if (!name) return { error: "please give your name" };
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return { error: "please give a valid email" };
  if (notes.length > 2000) return { error: "notes are limited to 2000 characters" };
  return { contact: { name, email, notes: notes.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim() } };
}
function checkPalette(list) {
  if (!Array.isArray(list) || list.length > 60) return { error: "palette must be a list of at most 60 colours" };
  const out = [], ids = new Set();
  for (const e of list) {
    const material = clean(e && e.material, 20).toUpperCase(), colour = clean(e && e.colour, 40), hex = String((e && e.hex) || "");
    if (!material || !colour) return { error: "each colour needs a material and a name" };
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { error: "colour " + colour + ": hex must be #rrggbb" };
    let id = clean(e.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, "") || (material + "-" + colour).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    while (ids.has(id)) id += "-2";
    ids.add(id);
    out.push({ id, material, colour, hex: hex.toLowerCase(), in_stock: e.in_stock !== false });
  }
  return { palette: out };
}
function tzOk(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
function checkSettings(b, cur) {
  const S = { ...QUOTE_DEFAULTS, ...(cur || {}), hours: { ...QUOTE_DEFAULTS.hours, ...((cur || {}).hours || {}) } };
  const numIn = (k, lo, hi) => { if (!own(b, k)) return null; const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) return k + " must be " + lo + "-" + hi; S[k] = v; return null; };
  for (const [k, lo, hi] of [["round_to", 0.01, 100], ["valid_days", 1, 90], ["rush_multiplier", 1, 5], ["qty_max", 1, 1000], ["post_days", 0, 30]]) { const e = numIn(k, lo, hi); if (e) return { error: e }; }
  for (const k of ["enabled", "firm_prices"]) if (own(b, k)) S[k] = b[k] === true;
  if (own(b, "hours")) {
    const h = b.hours || {}, H = { ...S.hours };
    if (own(h, "days")) { if (!Array.isArray(h.days) || !h.days.length || !h.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: "working days are 0 (Sun) to 6 (Sat)" }; H.days = [...new Set(h.days)].sort(); }
    for (const k of ["start", "end"]) if (own(h, k)) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h[k]))) return { error: "hours " + k + " must be HH:MM" }; H[k] = h[k]; }
    if (own(h, "tz")) { if (!tzOk(h.tz)) return { error: "unknown timezone " + String(h.tz).slice(0, 40) }; H.tz = h.tz; }
    if (H.start >= H.end) return { error: "working hours must start before they end" };
    S.hours = H;
  }
  if (own(b, "palette")) { const p = checkPalette(b.palette); if (p.error) return p; S.palette = p.palette; }
  return { settings: S };
}
function customerView(q) {
  const out = {};
  for (const k of VIEW_FIELDS) if (q[k] !== undefined) out[k] = q[k];
  return out;
}
function expired(est, now) {
  if (!est || !est.public) return false;
  if (est.status === "quote") return now - est.created > UNREQUESTED_MS;
  if (est.status === "closed" || est.status === "declined") return est.closed_at != null && now - est.closed_at > CLOSED_MS;
  return false;
}
module.exports = { QUOTE_DEFAULTS, VIEW_FIELDS, UNREQUESTED_MS, CLOSED_MS, EXACT_BAND, keyOk, pickPublicSource, confidenceOf, bandsFor, priceRange,
                   checkOptions, inputsFor, checkContact, checkPalette, checkSettings, customerView, expired };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/quote-backend-standalone.js`
Expected: `N passed, 0 failed` (all quote.js checks `ok`).

- [ ] **Step 5: Falsify (rule 6)**

Run: `U1HUB_QUOTE_FALSIFY=1 node test/quote-backend-standalone.js; echo exit=$?`
Expected: `FAIL customerView keeps only the allow-list [FALSIFIED]` and `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add modules/estimate/quote.js test/quote-backend-standalone.js
git commit -m "feat(estimate): pure public-quote logic (confidence, ranges, allow-list, checks, retention)"
```

---

### Task 2: Ready-by date (`modules/estimate/readyby.js`)

**Files:**
- Create: `modules/estimate/readyby.js`
- Modify: `test/quote-backend-standalone.js` (add `pureReadyBy()`, call it from `main()` after `pureQuote()`)

**Interfaces:**
- Produces: `readyBy({ now, printers:[{ name, type, fits:boolean, free_in_min }], queue:[{ type, minutes, plates }], job:{ minutes, plates }, hours:{ days, start, end, tz }, post_days, rush }) → { finish_at:number, ready_by:"YYYY-MM-DD" } | null`; also `localParts(ms, tz) → { date, wd, min }`, `nextStart(ms, hours) → ms`, `addWorkingDays(ms, n, hours) → "YYYY-MM-DD"`.
- Rule: every plate (queue and this job) starts only inside working hours and may run past their end; queue plates go on the earliest-free printer **of their type**; this job's plates go on the earliest-free printer with `fits`; rush puts this job's plates before the queue. One plate per piece (qty plates).

- [ ] **Step 1: Write the failing test** — add to `test/quote-backend-standalone.js`

```js
const RB = require("../modules/estimate/readyby.js");
function pureReadyBy() {
  console.log("\n-- readyby.js --");
  const H = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "UTC" };
  const MON8 = Date.UTC(2026, 9, 5, 8, 0);           // Mon 2026-10-05 08:00Z
  const P = (over) => [{ name: "a", type: "u1", fits: true, free_in_min: 0, ...(over || {}) }];
  const base = { now: MON8, printers: P(), queue: [], job: { minutes: 120, plates: 1 }, hours: H, post_days: 1, rush: false };
  let r = RB.readyBy(base);
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0) && r.ready_by === "2026-10-06", "idle printer, before hours: starts 09:00, done 11:00, ready next working day", r);
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 9, 16, 30) });
  ok(r.finish_at === Date.UTC(2026, 9, 9, 18, 30) && r.ready_by === "2026-10-12", "Fri 16:30 start runs past 17:00; +1 working day skips the weekend", r);
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 9, 17, 30) });
  ok(r.finish_at === Date.UTC(2026, 9, 12, 11, 0) && r.ready_by === "2026-10-13", "Fri after hours: waits for Mon 09:00", r);
  const queue = [{ type: "u1", minutes: 300, plates: 1 }];
  r = RB.readyBy({ ...base, queue });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 16, 0), "behind a 5 h queued job: 14:00-16:00", r);
  r = RB.readyBy({ ...base, queue, rush: true });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "rush goes ahead of the queue", r);
  r = RB.readyBy({ ...base, queue: [{ type: "kobra-s1", minutes: 300, plates: 1 }] });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "a queued job for another printer type does not delay this one", r);
  r = RB.readyBy({ ...base, printers: [...P(), { name: "b", type: "u1", fits: true, free_in_min: 0 }], job: { minutes: 120, plates: 2 } });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "two plates on two printers run side by side", r);
  r = RB.readyBy({ ...base, printers: [...P({ free_in_min: 600 }), { name: "big", type: "u1", fits: false, free_in_min: 0 }] });
  ok(r.finish_at === Date.UTC(2026, 9, 6, 11, 0) && r.ready_by === "2026-10-07", "busy until 18:00: next morning; a printer it doesn't fit is not used", r);
  ok(RB.readyBy({ ...base, printers: P({ fits: false }) }) === null, "nothing fits -> null");
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 5, 13, 0), hours: { ...H, tz: "America/Chicago" }, post_days: 0 });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 16, 0) && r.ready_by === "2026-10-05", "Chicago hours: 08:00 CDT waits for 09:00 CDT (14:00Z)", r);
  ok(RB.localParts(Date.UTC(2026, 9, 5, 13, 0), "America/Chicago").min === 8 * 60, "localParts: 13:00Z is 08:00 in Chicago");
}
```

And in `main()`: `pureQuote(); pureReadyBy();`

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/quote-backend-standalone.js`
Expected: crash `Cannot find module '../modules/estimate/readyby.js'`.

- [ ] **Step 3: Write the implementation** — `modules/estimate/readyby.js`

```js
// modules/estimate/readyby.js — when a quote could be ready: what each printer
// is doing, the Dispatch queue in order, this job's plates on the printers it
// fits, plates only started inside working hours, then post-processing days.
// Pure: `now` is an input (CLAUDE.md rule 7). Fork module estimate (ryvin/u1hub).
"use strict";
const STEP_MS = 15 * 60000, MAX_STEPS = 21 * 96;
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FMT = new Map();
function fmt(tz) {
  if (!FMT.has(tz)) FMT.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }));
  return FMT.get(tz);
}
function localParts(ms, tz) {
  const parts = fmt(tz || "UTC").formatToParts(new Date(ms)), g = t => (parts.find(p => p.type === t) || {}).value;
  return { date: g("year") + "-" + g("month") + "-" + g("day"), wd: WD[g("weekday")], min: Number(g("hour")) * 60 + Number(g("minute")) };
}
const hm = s => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
function inHours(ms, H) { const l = localParts(ms, H.tz); return H.days.includes(l.wd) && l.min >= hm(H.start) && l.min < hm(H.end); }
function nextStart(ms, H) {
  if (!H || !Array.isArray(H.days) || !H.days.length) return ms;
  if (inHours(ms, H)) return ms;
  let t = Math.ceil(ms / STEP_MS) * STEP_MS;   // every timezone offset is a whole quarter hour
  for (let i = 0; i < MAX_STEPS; i++, t += STEP_MS) if (inHours(t, H)) return t;
  return ms;   // hours that never open: ignore them rather than never finishing
}
function addWorkingDays(ms, n, H) {
  const tz = (H && H.tz) || "UTC", days = (H && H.days && H.days.length) ? H.days : [0, 1, 2, 3, 4, 5, 6];
  const [y, m, d] = localParts(ms, tz).date.split("-").map(Number);
  let k = 0, left = Math.max(0, Math.round(n || 0));
  while (left > 0) { k++; if (days.includes(new Date(Date.UTC(y, m - 1, d + k)).getUTCDay())) left--; }
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}
function readyBy(o) {
  const free = (o.printers || []).map(p => ({ ...p, at: o.now + Math.max(0, Number(p.free_in_min) || 0) * 60000 }));
  const place = (pick, minutes) => {
    let best = null, bestStart = Infinity;
    for (const p of free) if (pick(p)) { const s = nextStart(p.at, o.hours); if (s < bestStart) { best = p; bestStart = s; } }
    if (!best) return null;
    best.at = bestStart + Math.max(0, minutes) * 60000;
    return best.at;
  };
  const runQueue = () => { for (const q of o.queue || []) for (let i = 0; i < (q.plates || 0); i++) place(p => p.type === q.type, Number(q.minutes) || 0); };
  if (!o.rush) runQueue();
  let last = null;
  for (let i = 0; i < Math.max(1, o.job.plates || 1); i++) {
    const end = place(p => p.fits, Number(o.job.minutes) || 0);
    if (end == null) return null;
    last = Math.max(last || 0, end);
  }
  return { finish_at: last, ready_by: addWorkingDays(last, o.post_days, o.hours) };
}
module.exports = { readyBy, nextStart, addWorkingDays, localParts };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/quote-backend-standalone.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add modules/estimate/readyby.js test/quote-backend-standalone.js
git commit -m "feat(estimate): readyBy - queue, working hours and post days, now as an input"
```

---

### Task 3: Prepare `estimate.js` (receive(), H, compute extras, retention)

**Files:**
- Modify: `modules/estimate.js` (upload route body → `receive()`; `compute()` print block; `prune()`)
- Test: `test/estimate-standalone.js` (existing, must stay green) and `test/quote-backend-standalone.js` (new `pruneRule()` pure check)

**Interfaces:**
- Produces, inside `register()`:
  - `receive(req, res, { cap, existing, make, after })` — streams the raw body to `<DIR>/<id>/<file_id>.<ext>` exactly as the upload route does today; `make(id)` builds a new estimate record; `after(est, f, job, jobId)` replaces the default JSON reply (default replies `{ id, file_id, jobId }`).
  - `H = { S, get, save, compute, view, receive, JOBS, DIR, fileOf, use, MAX_MB }` passed to `require("./estimate/quote-backend.js").mount(ctx, H)` (Task 4).
  - `compute()` → `print.k_err` (the calibrated k's `err` for the colour mode, or null) and `print.multicolour` (`colours > 1`).
  - `pruneAt(now)` — deletes `QUOTE.expired(est, now)` estimates, and unsaved non-public estimates older than 30 days; `prune()` = `pruneAt(Date.now())`.

- [ ] **Step 1: Write the failing test** — `test/quote-backend-standalone.js`: the rule `pruneAt` applies is `dropOnPrune(est, now)`; add it to quote.js's exports in Step 3 and test it here.

```js
function pruneRule() {
  console.log("\n-- retention rule --");
  const D = 24 * 3600 * 1000, now = 100 * D;
  ok(Q.dropOnPrune({ public: true, status: "new", created: now - 40 * D, saved: false }, now) === false, "an open public request survives the old 30-day unsaved rule");
  ok(Q.dropOnPrune({ status: "quote", created: now - 31 * D, saved: false }, now) === true && Q.dropOnPrune({ created: now - 31 * D, saved: true }, now) === false, "internal estimates: unsaved > 30 days dropped, saved kept");
  ok(Q.dropOnPrune({ public: true, status: "quote", created: now - 8 * D }, now) === true, "an unrequested public quote is dropped after 7 days");
}
```

Call it from `main()` after `pureReadyBy()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/quote-backend-standalone.js`
Expected: `TypeError: Q.dropOnPrune is not a function`.

- [ ] **Step 3: Implement**

In `modules/estimate/quote.js`, before `module.exports`, add and export `dropOnPrune`:

```js
const INTERNAL_MS = 30 * DAY;
// The estimate module's one prune rule: public quotes by expired(); internal ones unsaved > 30 days.
function dropOnPrune(est, now) { return est.public ? expired(est, now) : (!est.saved && now - est.created > INTERNAL_MS); }
```

In `modules/estimate.js`:

1. Add the requires next to the others: `const QUOTE = require("./estimate/quote.js");`
2. Replace the body of `ctx.app.post("/api/estimate/upload", ...)` with a call to a new function `receive(req, res, opts)` declared just above the routes. `receive` is the old body, with these changes only: `cap` comes from `opts.cap`; `existing` from `opts.existing`; the new-estimate literal becomes `opts.make(id)`; after `JOBS.set(jobId, job)` it calls `opts.after ? opts.after(est, f, job, jobId) : res.json({ id, file_id, jobId })` before starting `analyse(...)`, and `analyse` gets a `.then(() => opts.analysed && opts.analysed(est))` so the backend can set its source when analysis ends. The internal route becomes:

```js
  const newEstimate = id => ({ id, created: Date.now(), files: [], candidates: [], inputs: { ...DEFAULT_INPUTS }, source: null, candidate_key: null, saved: false, project_id: null, client_id: null, note: "" });
  ctx.app.post("/api/estimate/upload", (req, res) => receive(req, res, { cap: MAX_MB * 1048576, capMb: MAX_MB, existing: get(req.query.id), make: newEstimate }));
```

(`receive`'s 413 text uses `opts.capMb`.)

3. In `compute()`, in the returned `print` object add `k_err: CALS.k && CALS.k[mode] && CALS.k[mode].err != null ? CALS.k[mode].err : null, multicolour: colours > 1`.
4. Replace `prune()` with:

```js
  function pruneAt(now) {
    for (const est of Object.values(S.estimates)) if (QUOTE.dropOnPrune(est, now)) { delete S.estimates[est.id]; fs.rm(path.join(DIR, est.id), { recursive: true, force: true }, () => {}); }
    save();
  }
  const prune = () => pruneAt(Date.now());
```

and drop the now-unused `PRUNE_MS` constant.
5. Just before the line `// ---- routes (fixed paths before /:id) ----`, build `H` and mount the backend (the file arrives in Task 4; until then guard the require):

```js
  const H = { S, get, save: () => save(), compute, view, receive, newEstimate, JOBS, DIR, fileOf, use, checkInputs, DEFAULT_INPUTS, pruneAt };
  try { require("./estimate/quote-backend.js").mount(ctx, H); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }
```

(`receive` is a `function` declaration so it is hoisted; declare it in the routes section.)

- [ ] **Step 4: Run tests**

Run: `node test/quote-backend-standalone.js && node test/estimate-standalone.js 2>&1 | tail -3`
Expected: both end `… passed, 0 failed` (estimate suite count unchanged: 97).

- [ ] **Step 5: Commit**

```bash
git add modules/estimate.js modules/estimate/quote.js test/quote-backend-standalone.js
git commit -m "refactor(estimate): receive() upload helper, compute k_err/multicolour, one prune rule that spares open public requests"
```

---

### Task 4: Hub quote backend (`/api/quote-backend/*`) + gate line

**Files:**
- Create: `modules/estimate/quote-backend.js`
- Modify: `auth.js` (the gate: one line)
- Modify: `test/quote-backend-standalone.js` (booted section)

**Interfaces:**
- Consumes: `H` from Task 3; `QUOTE.*` (Task 1); `RB.readyBy` (Task 2); `ctx.cfg.estimate.quote_key`, `ctx.cfg.estimate.quote` (settings, merged over `QUOTE_DEFAULTS`); `ctx.use("notify.send")`, `ctx.use("dispatch.jobs")`, `ctx.use("costing.rates")`; `ctx.fleet()`, `ctx.printers`.
- Produces (all need `X-Quote-Key`; all JSON):
  - `GET  /api/quote-backend/ping` → `{ ok:true, enabled, max_mb, limits }`
  - `POST /api/quote-backend/upload` (raw body, `X-File-Name`) → `{ token }`; 503 `{ paused:true }` when disabled; cap `QUOTE_MAX_MB` (env `U1HUB_QUOTE_MAX_MB`, default 100)
  - `GET  /api/quote-backend/quote/:token` → customer view
  - `POST /api/quote-backend/quote/:token/options` `{ qty, palette_id, quality, rush }` → customer view
  - `POST /api/quote-backend/quote/:token/request` `{ name, email, notes }` → customer view (`status:"new"`)
  - `POST /api/quote-backend/quote/:token/delete` → `{ ok:true }`
  - Exported helper `publicView(est) → Promise<customer view>` used by the owner routes (Task 5).
- Stored on a public estimate: `public:true, token, status:"quote"|"new"|"quoted"|"accepted"|"declined"|"closed", options:{qty, palette_id, quality, rush}, contact, requested_at, final_price, owner_note, ready_final, closed_at, files_deleted`.

- [ ] **Step 1: Write the failing test** — append the booted section to `test/quote-backend-standalone.js`

```js
const { createMock } = require("./mock-moonraker.js");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = "test-quote-key-0123456789abcdef0123456789";
let CHILD = null, LOG = "";
async function startHub(dir) {
  LOG = "";
  CHILD = spawn(process.execPath, ["server.js"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_POLL_MS: "400", U1HUB_EVENTS_POLL_MS: "3600000", U1HUB_SYNC_MS: "3600000",
           U1HUB_COSTING_BACKFILL_BOOT_MS: "0", U1HUB_COSTING_IMPORT_BOOT_MS: "0", U1HUB_COSTING_IMPORT_MS: "0", U1HUB_ESTIMATE_CALIBRATE_BOOT_MS: "0",
           U1HUB_ESTIMATE_LIB_TTL_MS: "0", SME_HOME: path.join(dir, "sme-home"), U1HUB_PROFILE: "" } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  // waits for observable state, not a timer (a cold boot over /mnt/e measured 15 s)
  for (let i = 0; i < 400; i++) { try { const r = await fetch(HUB + "/api/auth/status"); if (r.ok) return; } catch {} await sleep(150); }
  throw new Error("hub did not start:\n" + LOG.slice(-2000));
}
async function stopHub() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }
const kh = (k) => (k === null ? {} : { "X-Quote-Key": k === undefined ? KEY : k });
async function bget(p, k) { const r = await fetch(HUB + p, { headers: kh(k) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function bpost(p, b, k) { const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json", ...kh(k) }, body: JSON.stringify(b || {}) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function bup(name, buf, k) { const r = await fetch(HUB + "/api/quote-backend/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), ...kh(k) }, body: buf }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
function cubeTris(s) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(t => t.map(i => v[i]));
}
function binStl(tris) { const b = Buffer.alloc(84 + tris.length * 50); b.writeUInt32LE(tris.length, 80); tris.forEach((t, i) => { let o = 84 + i * 50 + 12; for (const p of t) for (const c of p) { b.writeFloatLE(c, o); o += 4; } }); return b; }
const waitReady = async (token) => { for (let i = 0; i < 400; i++) { const r = await bget("/api/quote-backend/quote/" + token); if (r.body && r.body.phase !== "analysing") return r; await sleep(50); } return { status: 0, body: { error: "timeout" } }; };

async function booted() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-quote-")), gdir = path.join(tmp, "gcode");
  fs.mkdirSync(gdir, { recursive: true });
  const moon = createMock("u1"); const mport = await moon.listen(0);
  // a fake ntfy server: the request notification must arrive here
  const NTFY = []; const ntfy = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { NTFY.push({ url: req.url, body: b, title: req.headers["title"] || req.headers["x-title"] }); res.end("{}"); }); });
  await new Promise(r => ntfy.listen(0, "127.0.0.1", r));
  const palette = [{ id: "pla-black", material: "PLA", colour: "Black", hex: "#000000", in_stock: true }, { id: "petg-red", material: "PETG", colour: "Red", hex: "#ff0000", in_stock: true }];
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: gdir, port: PORT, printers: [{ name: "SECRET-PRINTER", url: "http://127.0.0.1:" + mport }],
    notify: { enabled: true, url: "http://127.0.0.1:" + ntfy.address().port, topic: "quotes" },
    estimate: { quote_key: KEY, quote: { enabled: true, palette, hours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", tz: "UTC" } } } }, null, 2));
  // the same earlier-print fixture as the estimate suite: a 20 mm cube printed once in 10 min
  fs.writeFileSync(path.join(tmp, "prints.json"), JSON.stringify({ prints: [{ id: "p1", at: 1, printer_id: 0, printer: "SECRET-PRINTER", type: "u1", file: "cube_PLA_10m.gcode", outcome: "done", seconds: 600, seconds_source: "actual", material: { grams: 4, source: "slicer", grams_source: "slicer" }, counted: true, pieces: 1 }] }));
  fs.writeFileSync(path.join(gdir, "cube_PLA_10m.gcode"), "; HEADER_BLOCK_START\n; max_z_height: 20.00\n; HEADER_BLOCK_END\nG1 X1\n; filament used [g] = 4.00\n; total filament used [g] = 4.00\n; estimated printing time (normal mode) = 10m 0s\n; CONFIG_BLOCK_START\n; filament_type = PLA\n; filament_colour = #FF0000\n; print_settings_id = 0.20 Standard\n; CONFIG_BLOCK_END\n");
  try {
    await startHub(tmp);
    console.log("\n-- the backend key --");
    ok((await bget("/api/quote-backend/ping", null)).status === 401, "no key -> 401");
    ok((await bget("/api/quote-backend/ping", "wrong-key-wrong-key-wrong-key-wrong-key")).status === 401, "wrong key -> 401");
    const ping = await bget("/api/quote-backend/ping");
    ok(ping.status === 200 && ping.body.enabled === true && ping.body.max_mb === 100, "right key -> ping, 100 MB cap", ping.body);

    console.log("\n-- upload -> token -> customer view --");
    let r = await bup("SECRETNAME_widget.stl", binStl(cubeTris(20)));
    ok(r.status === 200 && /^[0-9a-f]{32}$/.test(r.body && r.body.token || ""), "upload -> a 128-bit hex token", r.body);
    const T1 = r.body.token;
    let v = await waitReady(T1);
    ok(v.status === 200 && v.body.status === "quote" && v.body.confidence === "rough" && v.body.fits === true && v.body.qty === 1, "an unknown model: rough, fits, qty 1", v.body);
    const txt = JSON.stringify(v.body);
    ok(!/SECRETNAME|SECRET-PRINTER|cost|candidates|rates|est_/i.test(txt), "the customer view carries no file name, printer name, cost or candidate", txt.slice(0, 400));
    ok(v.body.price !== 0 && v.body.price_low !== 0 && v.body.price_high !== 0, "no rates set: never a $0 price", v.body);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(v.body.ready_by || "") && /^\d{4}-\d{2}-\d{2}$/.test(v.body.valid_until || ""), "ready_by and valid_until are dates", v.body);
    ok(Array.isArray(v.body.limits.palette) && v.body.limits.palette.length === 2 && v.body.limits.qty_max === 100 && v.body.material === "PLA" && v.body.colour === "Black", "limits carry the palette; default colour is the first in stock", v.body.limits);

    r = await bup("cube.stl", binStl(cubeTris(20)));
    v = await waitReady(r.body.token);
    ok(v.body.confidence === "exact", "printed before (same size, done) -> exact", v.body);

    console.log("\n-- options --");
    r = await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 4, palette_id: "petg-red", quality: "strong", rush: true });
    ok(r.status === 200 && r.body.qty === 4 && r.body.material === "PETG" && r.body.colour === "Red" && r.body.quality === "strong" && r.body.rush === true, "options change the quote", r.body);
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 101 })).status === 400, "qty over the cap -> 400");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { palette_id: "nope" })).status === 400, "unknown colour -> 400");

    console.log("\n-- tokens --");
    ok((await bget("/api/quote-backend/quote/" + "0".repeat(32))).status === 404, "an unknown token -> 404");
    ok((await bget("/api/quote-backend/quote/__proto__")).status === 404, "a prototype key is no token");

    console.log("\n-- request --");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "bad" })).status === 400, "a bad email -> 400");
    r = await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "ann@example.com", notes: "for a gift" });
    ok(r.status === 200 && r.body.status === "new", "request -> status new", r.body);
    for (let i = 0; i < 100 && !NTFY.length; i++) await sleep(50);
    ok(NTFY.length === 1 && /Ann/.test(NTFY[0].body), "the owner is notified (ntfy)", NTFY);
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "ann@example.com" })).status === 409, "a second request on the same quote -> 409");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 2 })).status === 409, "options are frozen once requested");

    console.log("\n-- delete my files --");
    r = await bup("throwaway.stl", binStl(cubeTris(10)));
    const T3 = r.body.token; await waitReady(T3);
    ok((await bpost("/api/quote-backend/quote/" + T3 + "/delete")).status === 200 && (await bget("/api/quote-backend/quote/" + T3)).status === 404, "an unrequested quote is deleted outright");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/delete")).status === 200, "a requested quote: delete accepted");
    v = await bget("/api/quote-backend/quote/" + T1);
    ok(v.status === 200 && v.body.files_deleted === true && v.body.status === "new", "...its files go, the request stays", v.body);

    console.log("\n-- paused --");
    // (Task 5 adds the owner settings route; here the switch is flipped through it once it exists)
    return { tmp, moon, ntfy, T1 };
  } catch (e) { await stopHub(); throw e; }
}
```

Change `main()` to:

```js
async function main() {
  pureQuote(); pureReadyBy(); pruneRule();
  let ctxB = null;
  try { ctxB = await booted(); }
  catch (e) { fail++; console.log("  FAIL booted section threw: " + e.message); }
  finally { await stopHub(); if (ctxB) { ctxB.moon.close && ctxB.moon.close(); ctxB.ntfy.close(); } }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
```

Also add one gate test in a **password-mode** boot (the main boot is auth mode open). Append to `booted()` before `return`… no — separate function run after `booted()` in `main()`:

```js
async function gateInPasswordMode() {
  console.log("\n-- the gate in password mode --");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-quote-pw-"));
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: path.join(tmp, "g"), port: PORT, printers: [], estimate: { quote_key: KEY, quote: { enabled: true } } }));
  fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ mode: "password" }));   // password mode, no session
  await startHub(tmp);
  try {
    ok((await bget("/api/estimate/info", null)).status === 401, "password mode: an ordinary API route needs a session");
    ok((await bget("/api/quote-backend/ping", null)).status === 401, "password mode: the backend without a key -> 401");
    ok((await bget("/api/quote-backend/ping")).status === 200, "password mode: the backend with the key -> 200");
    ok((await bget("/api/estimate/info", "anything")).status === 401, "a quote key does not open other routes");
  } finally { await stopHub(); }
}
```

and call `await gateInPasswordMode();` inside `main()` after the booted block (wrapped the same way).

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/quote-backend-standalone.js 2>&1 | tail -25`
Expected: `FAIL right key -> ping …` (404 — no route yet) and the following booted checks fail.

- [ ] **Step 3: Implement — `auth.js` (one line)**

In the gate, change:

```js
    if (ALLOW.has(p) || p.startsWith("/api/auth/")) return next();
```

to:

```js
    if (ALLOW.has(p) || p.startsWith("/api/auth/") || (p.startsWith("/api/quote-backend/") && req.get("X-Quote-Key"))) return next();   // fork (ryvin/u1hub): the public quote service; modules/estimate/quote-backend.js checks the key
```

- [ ] **Step 4: Implement — `modules/estimate/quote-backend.js`**

```js
// modules/estimate/quote-backend.js — the Hub side of the public quote page
// (u1-quote, quote/). /api/quote-backend/* answers only with X-Quote-Key =
// config.json estimate.quote_key; a quote is an estimate with public:true and
// a 128-bit token, priced by the same compute() as the Estimate tab, and every
// answer is customerView()'s allow-list. The owner's routes are in mountOwner().
// Fork module estimate (ryvin/u1hub). Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md
"use strict";
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const QUOTE = require("./quote.js"), RB = require("./readyby.js"), PRICE = require("./price.js");
const QUOTE_MAX_MB = Math.max(0.001, Number(process.env.U1HUB_QUOTE_MAX_MB) || 100);
const DAY = 24 * 3600 * 1000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

function mount(ctx, H) {
  const conf = () => (ctx.cfg.estimate = ctx.cfg.estimate || {});
  const settings = () => { const s = conf().quote || {}; return { ...QUOTE.QUOTE_DEFAULTS, ...s, hours: { ...QUOTE.QUOTE_DEFAULTS.hours, ...(s.hours || {}) }, palette: s.palette || [] }; };
  const TOKENS = new Map();
  for (const e of Object.values(H.S.estimates)) if (e.public && e.token) TOKENS.set(e.token, e.id);
  const byToken = t => { const id = TOKENS.get(String(t || "")); const e = id ? H.get(id) : null; return e && e.public ? e : null; };
  const bad = (res, code, error, extra) => res.status(code).json({ error, ...(extra || {}) });
  const guard = (req, res, next) => (QUOTE.keyOk(req.get("X-Quote-Key"), conf().quote_key) ? next() : bad(res, 401, "bad quote key"));
  const paused = res => bad(res, 503, "Quotes are paused - try again soon", { paused: true });

  function applyOptions(est) {
    const S = settings(), multicolour = !!est.multicolour;
    const I = QUOTE.inputsFor(est.options || {}, S, multicolour);
    est.inputs = { ...H.DEFAULT_INPUTS, ...(est.inputs || {}), qty: I.qty, material: I.material, preset: I.preset, rush: I.rush };
    return I;
  }
  async function schedule(v, S) {
    const printers = ctx.printers || [], fitting = new Set(v.fits || []);
    let fleet = []; try { fleet = (await ctx.fleet()) || []; } catch {}
    const P = printers.map((p, i) => { const f = fleet[i] || {}; return { name: p.name, type: p.type || "u1", fits: fitting.has(p.name),
      free_in_min: f.state === "printing" || f.state === "paused" ? Math.round((f.etaSec || 0) / 60) : 0 }; });
    const jobs = (H.use("dispatch.jobs", () => [])() || []).filter(j => j.state === "queued");
    const queue = jobs.map(j => ({ type: j.type || "u1", minutes: Number(j.est_minutes) || 0, plates: Number(j.remaining) || 0 }));
    return RB.readyBy({ now: Date.now(), printers: P, queue, job: { minutes: v.print.minutes || 0, plates: v.inputs.qty }, hours: S.hours, post_days: S.post_days, rush: v.inputs.rush > 1 });
  }
  async function publicView(est) {
    const S = settings();
    const job = [...H.JOBS.values()].find(j => j.id === est.id && !j.done);
    const base = { status: est.status, files_deleted: !!est.files_deleted, notes_from_owner: est.owner_note || "", final_price: est.final_price != null ? est.final_price : undefined,
                   valid_until: isoDay(est.created + S.valid_days * DAY),
                   limits: { qty_max: S.qty_max, qualities: ["standard", "strong"], rush_multiplier: S.rush_multiplier, palette: S.palette.map(p => ({ id: p.id, material: p.material, colour: p.colour, hex: p.hex, in_stock: p.in_stock })) } };
    if (job) return QUOTE.customerView({ ...base, phase: "analysing" });
    if ((est.files || []).length && est.files.every(f => f.error)) return QUOTE.customerView({ ...base, phase: "done", error: "We couldn't read this file as a 3D model." });
    const I = applyOptions(est);
    const v = await H.view(est);
    est.multicolour = !!v.print.multicolour;
    const confidence = QUOTE.confidenceOf(v);
    const b = QUOTE.bandsFor(confidence, v);
    const rates = H.use("costing.rates", () => ({}))() || {};
    const pid = v.printer_id, ptype = ((ctx.printers || [])[pid] || {}).type || "u1";
    const priceAt = (g, m) => PRICE.priceEstimate({ grams: g, minutes: m, qty: v.inputs.qty, printer_id: pid, type: ptype, material: v.inputs.material, rush: v.inputs.rush,
      failure_rate: null, name: "quote" }, rates, (ctx.cfg && ctx.cfg.margin) || {}).recommended.price;
    const fits = v.fits == null ? null : v.fits.length > 0;
    const range = fits === false || v.print.grams == null ? null
      : QUOTE.priceRange({ grams: v.print.grams, minutes: v.print.minutes, confidence, g: b.g, t: b.t, firm: S.firm_prices, round_to: S.round_to, min_fee: rates.min_fee != null ? Number(rates.min_fee) : null }, priceAt);
    const sched = fits === false ? null : await schedule(v, S).catch(() => null);
    const each = range ? (range.price != null ? +(range.price / v.inputs.qty).toFixed(2) : undefined) : undefined;
    return QUOTE.customerView({ ...base, phase: "done", confidence, ...(range || {}), each, qty: v.inputs.qty, material: v.inputs.material, colour: v.print.multicolour ? "multi" : I.colour_name,
      colour_changed: I.colour_changed || undefined, quality: v.inputs.preset, rush: v.inputs.rush > 1, ready_by: est.ready_final || (sched ? sched.ready_by : null), multicolour: !!v.print.multicolour, fits });
  }
  const send = (res, est) => publicView(est).then(v => res.json(v)).catch(e => bad(res, 500, "quote failed: " + e.message));

  ctx.app.get("/api/quote-backend/ping", guard, (req, res) => { const S = settings(); res.json({ ok: true, enabled: !!S.enabled, max_mb: QUOTE_MAX_MB }); });
  ctx.app.post("/api/quote-backend/upload", guard, (req, res) => {
    if (!settings().enabled) { req.resume(); return paused(res); }
    const token = crypto.randomBytes(16).toString("hex");
    H.receive(req, res, { cap: QUOTE_MAX_MB * 1048576, capMb: QUOTE_MAX_MB, existing: null,
      make: id => ({ ...H.newEstimate(id), public: true, token, status: "quote", options: { qty: 1, quality: "standard", rush: false }, contact: null, owner_note: "", final_price: null }),
      after: (est) => { TOKENS.set(token, est.id); H.save(); res.json({ token }); },
      analysed: est => { const p = QUOTE.pickPublicSource(est); if (p) { est.source = p.source; est.candidate_key = p.candidate_key; H.save(); } } });
  });
  ctx.app.get("/api/quote-backend/quote/:token", guard, (req, res) => { const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired"); send(res, est); });
  ctx.app.post("/api/quote-backend/quote/:token/options", guard, (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    if (est.status !== "quote") return bad(res, 409, "this quote has been requested; the options are fixed");
    const c = QUOTE.checkOptions(req.body || {}, settings(), !!est.multicolour); if (c.error) return bad(res, 400, c.error);
    est.options = { ...(est.options || {}), ...c.options }; H.save(); send(res, est);
  });
  ctx.app.post("/api/quote-backend/quote/:token/request", guard, async (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    if (est.status !== "quote") return bad(res, 409, "this quote has already been requested");
    const c = QUOTE.checkContact(req.body || {}); if (c.error) return bad(res, 400, c.error);
    est.contact = c.contact; est.status = "new"; est.requested_at = Date.now(); H.save();
    const v = await publicView(est).catch(() => ({}));
    const price = v.price != null ? "$" + v.price : v.price_low != null ? "$" + v.price_low + "-$" + v.price_high : "to be priced";
    try { const n = H.use("notify.send", null); if (n) await n({ title: "New quote request", body: c.contact.name + " <" + c.contact.email + ">: " + v.qty + " x, " + price + (v.ready_by ? ", ready " + v.ready_by : ""), priority: 4, tags: "moneybag" }); } catch {}
    res.json(v);
  });
  ctx.app.post("/api/quote-backend/quote/:token/delete", guard, (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    fs.rm(path.join(H.DIR, est.id), { recursive: true, force: true }, () => {});
    if (est.status === "quote") { delete H.S.estimates[est.id]; TOKENS.delete(est.token); }
    else { est.files_deleted = true; }
    H.save(); res.json({ ok: true });
  });
  return { publicView, settings, TOKENS, byToken };
}
module.exports = { mount, QUOTE_MAX_MB };
```

Note for the implementer: `publicView` relies on `H.view(est)` re-running analysis results only (no file reads), so `files_deleted` quotes still view. `H.view` must not throw when files are gone — check `compute()` reads only `est.files[*].facts/sliced` (it does; `thumb` is the only file reader).

- [ ] **Step 5: Run test to verify it passes**

Run: `node test/quote-backend-standalone.js 2>&1 | tail -15`
Expected: `… passed, 0 failed`. If "printed before -> exact" fails, print `v.body` and the internal `/api/estimate/<id>` (`candidates`) — the cube fixture must give `size_check:"same"`, `done:1`.

- [ ] **Step 6: Run the estimate suite (regression)**

Run: `node test/estimate-standalone.js 2>&1 | tail -2`
Expected: `97 passed, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add auth.js modules/estimate/quote-backend.js test/quote-backend-standalone.js
git commit -m "feat(estimate): /api/quote-backend - key-gated public quotes (token, options, request, delete), allow-listed views"
```

---

### Task 5: Owner routes (settings, key, palette seed, requests, send/accept/decline/close)

**Files:**
- Modify: `modules/estimate/quote-backend.js` (add `mountOwner` inside `mount`, call it)
- Modify: `test/quote-backend-standalone.js` (owner section inside `booted()`, before `return`)

**Interfaces:**
- Produces (Hub session, like every other `/api/estimate/*` route):
  - `GET  /api/estimate/quote/settings` → `{ ...settings, key_set:boolean }` (never the key)
  - `POST /api/estimate/quote/settings` body = partial settings → same shape; `ctx.saveConfig()`
  - `POST /api/estimate/quote/key` → `{ key }` (new 32-byte hex key, shown once; saved to `estimate.quote_key`)
  - `POST /api/estimate/quote/palette/seed` → `{ palette }` suggestions (not saved) from `ctx.spoolShelf()` and every printer's `ctx.loadout(i)`, deduped by material+hex, `in_stock:true`
  - `GET  /api/estimate/quote/requests` → `{ requests:[{ id, status, contact, requested_at, created, quote:<publicView>, final_price, owner_note, project_id, client_id, actual }] }` newest first, every public estimate with `status !== "quote"`
  - `POST /api/estimate/quote/requests/:id/send` `{ final_price, note }` → status `quoted`, `ready_final` recomputed and frozen
  - `POST …/:id/accept` `{ project_id, client_id }` → status `accepted`, links (the UI creates them through `/api/costing/clients` and `/api/costing/projects` first)
  - `POST …/:id/decline` `{ note }` → status `declined`, `closed_at`
  - `POST …/:id/close` → status `closed`, `closed_at`
- Ruling carried from the spec: "optionally queues it in Dispatch" is **not built** — Dispatch queues gcode and a quote is an unsliced STL/3MF; the Requests card links to the Slice tab instead. Cost if wrong: one manual step per accepted job.

- [ ] **Step 1: Write the failing test** — insert into `booted()` before `return`, replacing the `-- paused --` comment block:

```js
    console.log("\n-- owner: settings --");
    async function jget(p) { return bget(p, null); }
    async function jpost(p, b) { return bpost(p, b, null); }
    let s = await jget("/api/estimate/quote/settings");
    ok(s.status === 200 && s.body.key_set === true && !JSON.stringify(s.body).includes(KEY) && s.body.palette.length === 2, "settings: key_set, never the key itself", s.body);
    ok((await jpost("/api/estimate/quote/settings", { round_to: 0 })).status === 400, "settings: bad value -> 400");
    s = await jpost("/api/estimate/quote/settings", { firm_prices: true });
    ok(s.status === 200 && s.body.firm_prices === true, "settings: firm_prices on");
    r = await bup("cube.stl", binStl(cubeTris(20)));
    v = await waitReady(r.body.token);
    ok(v.body.confidence === "exact" && (v.body.price == null || (v.body.price_low == null && v.body.price_high == null)), "firm + exact -> one price (or none without rates), never a range", v.body);
    await jpost("/api/estimate/quote/settings", { firm_prices: false });
    s = await jpost("/api/estimate/quote/settings", { enabled: false });
    ok((await bup("x.stl", binStl(cubeTris(20)))).status === 503 && (await bget("/api/quote-backend/ping")).body.enabled === false, "disabled -> uploads refused (paused), ping says so");
    await jpost("/api/estimate/quote/settings", { enabled: true });
    const seed = await jpost("/api/estimate/quote/palette/seed");
    ok(seed.status === 200 && Array.isArray(seed.body.palette), "palette seed answers (empty shelf -> empty list)", seed.body);

    console.log("\n-- owner: requests --");
    let L = await jget("/api/estimate/quote/requests");
    const req1 = (L.body.requests || []).find(x => x.contact && x.contact.name === "Ann");
    ok(L.status === 200 && req1 && req1.status === "new" && req1.contact.email === "ann@example.com", "the request is listed with its contact", L.body);
    ok((await jpost("/api/estimate/quote/requests/" + req1.id + "/send", { final_price: -1 })).status === 400, "send: a negative price -> 400");
    r = await jpost("/api/estimate/quote/requests/" + req1.id + "/send", { final_price: 42.5, note: "Ready Friday." });
    ok(r.status === 200 && r.body.status === "quoted", "send -> quoted");
    v = await bget("/api/quote-backend/quote/" + T1);
    ok(v.body.status === "quoted" && v.body.final_price === 42.5 && v.body.notes_from_owner === "Ready Friday.", "the visitor's view shows the final price and note", v.body);
    r = await jpost("/api/estimate/quote/requests/" + req1.id + "/accept", { project_id: "pr_x", client_id: "cl_x" });
    ok(r.status === 200 && r.body.status === "accepted" && r.body.project_id === "pr_x", "accept links the project");
    r = await jpost("/api/estimate/quote/requests/" + req1.id + "/close");
    ok(r.status === 200 && r.body.status === "closed" && r.body.closed_at > 0, "close starts retention");
    ok((await jpost("/api/estimate/quote/requests/nope/close")).status === 404, "an unknown request -> 404");
    ok((await jget("/api/estimate")).body.saved.every(x => x.id !== req1.id), "public quotes stay out of the saved-estimates list");

    console.log("\n-- owner: new key --");
    const nk = await jpost("/api/estimate/quote/key");
    ok(nk.status === 200 && /^[0-9a-f]{64}$/.test(nk.body.key), "a new key is issued once", nk.body);
    ok((await bget("/api/quote-backend/ping")).status === 401 && (await bget("/api/quote-backend/ping", nk.body.key)).status === 200, "the old key stops working, the new one works");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/quote-backend-standalone.js 2>&1 | grep -c FAIL`
Expected: a non-zero count; first failure `settings: key_set …` (404).

- [ ] **Step 3: Implement** — in `quote-backend.js`, inside `mount` before `return`, add:

```js
  // ---- the owner's side (Hub session) ----
  const ownerView = async est => {
    let actual = null;
    if (est.project_id) { try { const s = H.use("costing.projectSummary", () => null)(est.project_id); actual = s ? s.cost : null; } catch {} }
    return { id: est.id, status: est.status, contact: est.contact, created: est.created, requested_at: est.requested_at || null, closed_at: est.closed_at || null,
             quote: await publicView(est).catch(() => null), final_price: est.final_price, owner_note: est.owner_note || "", project_id: est.project_id, client_id: est.client_id, actual,
             files_deleted: !!est.files_deleted };
  };
  const reqOf = id => { const e = H.get(id); return e && e.public && e.status !== "quote" ? e : null; };
  const settingsOut = () => ({ ...settings(), key_set: typeof conf().quote_key === "string" && conf().quote_key.length >= 32 });
  ctx.app.get("/api/estimate/quote/settings", (req, res) => res.json(settingsOut()));
  ctx.app.post("/api/estimate/quote/settings", (req, res) => {
    const c = QUOTE.checkSettings(req.body || {}, conf().quote || {}); if (c.error) return bad(res, 400, c.error);
    conf().quote = c.settings; ctx.saveConfig(); res.json(settingsOut());
  });
  ctx.app.post("/api/estimate/quote/key", (req, res) => { const key = crypto.randomBytes(32).toString("hex"); conf().quote_key = key; ctx.saveConfig(); res.json({ key }); });
  ctx.app.post("/api/estimate/quote/palette/seed", (req, res) => {
    const seen = new Set(), out = [];
    const add = (material, colour, hex) => {
      const h = String(hex || "").toLowerCase(), m = String(material || "PLA").toUpperCase();
      if (!/^#[0-9a-f]{6}$/.test(h) || seen.has(m + h)) return;
      seen.add(m + h); out.push({ material: m, colour: String(colour || h).slice(0, 40), hex: h, in_stock: true });
    };
    try { for (const s of Object.values(ctx.spoolShelf() || {})) add(s.material, s.color_name, s.hex); } catch {}
    (ctx.printers || []).forEach((p, i) => { try { for (const s of ctx.loadout(i) || []) add(s.material, s.color_name, s.hex); } catch {} });
    const c = QUOTE.checkPalette(out); res.json({ palette: c.palette || [] });
  });
  ctx.app.get("/api/estimate/quote/requests", async (req, res) => {
    const list = Object.values(H.S.estimates).filter(e => e.public && e.status !== "quote").sort((a, b) => (b.requested_at || b.created) - (a.requested_at || a.created));
    res.json({ requests: await Promise.all(list.map(ownerView)) });
  });
  const act = (name, fn) => ctx.app.post("/api/estimate/quote/requests/:id/" + name, async (req, res) => {
    const est = reqOf(req.params.id); if (!est) return bad(res, 404, "no such request");
    const err = await fn(est, req.body || {}); if (err) return bad(res, 400, err);
    H.save(); res.json(await ownerView(est));
  });
  act("send", async (est, b) => {
    const p = Number(b.final_price);
    if (!Number.isFinite(p) || p < 0 || p > 1e6) return "final_price must be a dollar amount";
    est.final_price = Math.round(p * 100) / 100; est.owner_note = String(b.note || "").slice(0, 2000); est.status = "quoted";
    est.ready_final = null;
    const v = await publicView(est).catch(() => null); est.ready_final = v && v.ready_by ? v.ready_by : null;
  });
  act("accept", async (est, b) => { est.status = "accepted"; est.project_id = b.project_id ? String(b.project_id).slice(0, 80) : null; est.client_id = b.client_id ? String(b.client_id).slice(0, 80) : null; });
  act("decline", async (est, b) => { est.status = "declined"; est.closed_at = Date.now(); if (b.note) est.owner_note = String(b.note).slice(0, 2000); });
  act("close", async est => { est.status = "closed"; est.closed_at = Date.now(); });
```

Register order: `mount()` runs before the `/:id` routes (Task 3, step 3.5), so `/api/estimate/quote/settings` is never captured by `GET /api/estimate/:id`.

- [ ] **Step 4: Run tests**

Run: `node test/quote-backend-standalone.js 2>&1 | tail -3 && node test/estimate-standalone.js 2>&1 | tail -1`
Expected: `… passed, 0 failed` and `97 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add modules/estimate/quote-backend.js test/quote-backend-standalone.js
git commit -m "feat(estimate): owner quote routes - settings, key, palette seed, requests (send/accept/decline/close)"
```

---

### Task 6: Owner UI in the Estimate tab

**Files:**
- Modify: `public/modules/estimate-ui.js` (two cards: "Quote requests", "Public quotes"; read the whole file first)

**Interfaces:**
- Consumes: Task 5 routes; `/api/costing/clients` `{ name, email }` → `{ client }`, `/api/costing/projects` `{ name, client_id }` → `{ project }`.

- [ ] **Step 1: Add the cards.** In `mount()`, below the saved-estimates box, add two containers `<div id="estReq"></div><div id="estQset"></div>`; `onShow` calls `paintRequests()` and `paintQuoteSettings()`.

```js
  // ---- public quotes: requests (fork; docs/quote.md) ----
  const STATUS = { new: "New", quoted: "Quoted", accepted: "Accepted", declined: "Declined", closed: "Closed" };
  const rng = q => !q ? "—" : q.price != null ? usd(q.price) : q.price_low != null ? usd(q.price_low) + "–" + usd(q.price_high) : "by hand";
  async function paintRequests() {
    const box = document.getElementById("estReq"); if (!box) return;
    const r = await jget("/api/estimate/quote/requests");
    const list = (r && r.requests) || [];
    box.innerHTML = '<div class="estcard"><h3>Quote requests</h3>' + (!list.length ? '<div class="estsub">No requests yet. They arrive from the public quote page.</div>'
      : '<table class="esttable"><tr><th>Who</th><th>Status</th><th>Quoted</th><th>Final</th><th>Actual</th><th></th></tr>' + list.map(x =>
        '<tr><td>' + esc(x.contact ? x.contact.name : "?") + '<div class="estsub">' + esc(x.contact ? x.contact.email : "") + (x.contact && x.contact.notes ? " · " + esc(x.contact.notes) : "")
        + ' · ' + esc((x.quote && x.quote.qty) || 1) + ' × ' + esc((x.quote && (x.quote.colour || x.quote.material)) || "") + (x.quote && x.quote.rush ? " · rush" : "") + ' · ' + esc((x.quote && x.quote.confidence) || "") + (x.files_deleted ? " · files deleted by the visitor" : "") + '</div></td>'
        + '<td>' + esc(STATUS[x.status] || x.status) + '</td><td>' + rng(x.quote) + '</td><td>' + usd(x.final_price) + '</td><td>' + (x.project_id ? usd(x.actual) : "—") + '</td>'
        + '<td class="estbtns"><button class="btn" data-est="ropen" data-id="' + esc(x.id) + '">Open</button>'
        + (x.status === "new" || x.status === "quoted" ? '<button class="btn" data-est="rsend" data-id="' + esc(x.id) + '">Send quote</button>' : "")
        + (x.status === "quoted" ? '<button class="btn" data-est="raccept" data-id="' + esc(x.id) + '">Accept</button>' : "")
        + (x.status === "new" || x.status === "quoted" ? '<button class="btn" data-est="rdecline" data-id="' + esc(x.id) + '">Decline</button>' : "")
        + (x.status === "accepted" || x.status === "declined" ? "" : "") + (x.status !== "closed" ? '<button class="btn" data-est="rclose" data-id="' + esc(x.id) + '">Close</button>' : "")
        + '</td></tr>').join("") + '</table>') + '</div>';
  }
```

Handlers (in the existing `data-est` click switch):
- `ropen` → `openEstimate(id)` (the existing open-saved path; a public quote is an estimate).
- `rsend` → a small inline form row (price input prefilled with the high end of the range, note textarea, Send button) posting `/api/estimate/quote/requests/<id>/send`, then `paintRequests()`.
- `raccept` → `jpost("/api/costing/clients", { name, email })`, then `jpost("/api/costing/projects", { name: "Quote " + date + " - " + name, client_id })`, then `/accept` with both ids; show the error from any step and stop there.
- `rdecline` / `rclose` → post, repaint.

```js
  // ---- public quotes: settings ----
  async function paintQuoteSettings() {
    const box = document.getElementById("estQset"); if (!box) return;
    const S = await jget("/api/estimate/quote/settings"); if (!S || S.error) return;
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    box.innerHTML = '<div class="estcard"><h3>Public quotes</h3>'
      + '<div class="estrow"><label><input type="checkbox" data-qs="enabled"' + (S.enabled ? " checked" : "") + '> Taking quotes</label>'
      + '<label><input type="checkbox" data-qs="firm_prices"' + (S.firm_prices ? " checked" : "") + '> Firm prices for exact quotes</label>'
      + '<span class="estsub">Service key: ' + (S.key_set ? "set" : "not set") + '</span><button class="btn" data-est="qkey">New key</button></div>'
      + '<div class="estrow">' + [["round_to", "Round to $"], ["valid_days", "Valid days"], ["rush_multiplier", "Rush ×"], ["qty_max", "Max qty"], ["post_days", "Post-processing days"]]
          .map(([k, l]) => '<label class="estsub">' + l + ' <input class="field" style="width:70px" data-qs="' + k + '" value="' + esc(S[k]) + '"></label>').join("") + '</div>'
      + '<div class="estrow">' + day.map((d, i) => '<label class="estsub"><input type="checkbox" data-qd="' + i + '"' + (S.hours.days.includes(i) ? " checked" : "") + '>' + d + '</label>').join("")
      + '<input class="field" style="width:70px" data-qh="start" value="' + esc(S.hours.start) + '"><input class="field" style="width:70px" data-qh="end" value="' + esc(S.hours.end) + '">'
      + '<input class="field" style="width:170px" data-qh="tz" value="' + esc(S.hours.tz) + '"></div>'
      + '<table class="esttable" id="estPal"><tr><th>Material</th><th>Colour</th><th>Hex</th><th>In stock</th><th></th></tr>' + S.palette.map(palRow).join("") + '</table>'
      + '<div class="estrow"><button class="btn" data-est="qpadd">Add colour</button><button class="btn" data-est="qpseed">Suggest from loaded spools</button><button class="btn" data-est="qsave">Save</button><span class="estsub" id="estQmsg"></span></div></div>';
  }
  const palRow = p => '<tr><td><input class="field" data-pf="material" value="' + esc(p.material) + '"></td><td><input class="field" data-pf="colour" value="' + esc(p.colour) + '"></td>'
    + '<td><input class="field" data-pf="hex" value="' + esc(p.hex) + '" style="width:90px"><span class="estsw" style="background:' + esc(p.hex) + '"></span></td>'
    + '<td><input type="checkbox" data-pf="in_stock"' + (p.in_stock ? " checked" : "") + '></td><td><button class="btn" data-est="qpdel">Remove</button></td></tr>';
```

`qsave` collects the inputs into `{ enabled, firm_prices, round_to, valid_days, rush_multiplier, qty_max, post_days, hours:{ days, start, end, tz }, palette:[…] }`, posts `/api/estimate/quote/settings`, and writes the error or "Saved" into `#estQmsg`. `qkey` asks with the module's existing in-page confirm pattern (no `window.confirm`), posts `/api/estimate/quote/key`, and shows the key once in `#estQmsg` with "Put this in quote/.env as QUOTE_KEY — it is not shown again." `qpseed` appends the suggested rows not already present. Add `.estsw{display:inline-block;width:14px;height:14px;border-radius:3px;margin-left:6px;vertical-align:middle;border:1px solid var(--line)}` to the module's style block. The hex swatch value is validated server-side (`#rrggbb`), and `esc()` covers the attribute.

- [ ] **Step 2: Syntax check**

Run: `node --check public/modules/estimate-ui.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Verify in a real browser (throwaway Hub)**

Boot a throwaway Hub from a /tmp copy of the seeded test state (reuse the Task 4 fixture: run `node test/quote-backend-standalone.js` with `KEEP=1`? — no: boot directly):

```bash
SCR=/tmp/claude-1000/-mnt-e-Code-u1hub/28174693-d8e3-41e8-979b-5eac95ef85d1/scratchpad
mkdir -p $SCR/qhub/gcode && cat > $SCR/qhub/config.json <<'EOF'
{ "gcodeFolder": "GDIR", "port": 45992, "printers": [], "estimate": { "quote_key": "test-quote-key-0123456789abcdef0123456789", "quote": { "enabled": true } } }
EOF
sed -i "s#GDIR#$SCR/qhub/gcode#" $SCR/qhub/config.json
(cd /mnt/e/Code/u1hub && U1HUB_DIR=$SCR/qhub U1HUB_PORT=45992 nohup node server.js > $SCR/qhub/hub.log 2>&1 &)
```

With the Playwright MCP: open `http://127.0.0.1:45992`, unregister the service worker (`navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))`), open the Estimate tab, then: add two palette colours, Save → "Saved"; reload → they persist; New key → key shown once. Create a request with `curl` against the backend (upload + request as in Task 4) and confirm the Requests card lists it; Send quote 25 → status Quoted; Accept → a client and project appear in the Projects tab; Close. Screenshot each state to the scratchpad. Stop the Hub by port: `kill $(ss -ltnp | grep ':45992 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)`.

Expected: every step works with no console errors (`browser_console_messages` empty of errors).

- [ ] **Step 4: Commit**

```bash
git add public/modules/estimate-ui.js
git commit -m "feat(estimate-ui): Quote requests and Public quotes cards"
```

---

### Task 7: The `u1-quote` service (server, limits, Turnstile, Hub client, allow-list)

**Files:**
- Create: `quote/package.json`, `quote/server.js`, `quote/lib/config.js`, `quote/lib/limits.js`, `quote/lib/turnstile.js`, `quote/lib/hub.js`, `quote/lib/view.js`
- Create: `quote/test/quote-standalone.js`

**Interfaces:**
- `config.js`: `load(env) → { port, hubUrl, quoteKey, siteKey, secret, verifyUrl, maxMb, uploadsPerHour, requestsPerDay, globalUploadsPerHour, readsPerHour, trustCf, publicUrl }`; throws if `QUOTE_KEY` (< 32 chars), `TURNSTILE_SITEKEY` or `TURNSTILE_SECRET` is missing.
- `limits.js`: `createLimiter() → { hit(bucket, key, max, windowMs, now) → boolean }` (true = allowed, recorded), pure with `now` injected.
- `turnstile.js`: `verify(token, ip, { secret, verifyUrl, fetchImpl }) → Promise<boolean>`.
- `hub.js`: `createHub({ hubUrl, quoteKey, timeoutMs }) → { ping(), get(token), post(token, action, body), upload(req, name, maxBytes) }`, each resolving `{ status, body }`; network failure / timeout → `{ status: 503, body: { error: "Quotes are paused - try again soon", paused: true } }`.
- `view.js`: `FIELDS` (same list as `modules/estimate/quote.js` `VIEW_FIELDS`), `clean(body)`.
- Routes: `GET /`, `GET /q/:token` (same page), `GET /api/config` → `{ siteKey, maxMb }`, `POST /upload` (raw, headers `X-File-Name`, `X-Turnstile-Token`), `GET /api/q/:token`, `POST /api/q/:token/options`, `POST /api/q/:token/request` (body includes `turnstile`), `POST /api/q/:token/delete`, `GET /healthz`.

- [ ] **Step 1: Write the failing test** — `quote/test/quote-standalone.js`

```js
"use strict";
// quote/test/quote-standalone.js — the public u1-quote service against a fake
// Hub and a fake Turnstile siteverify (no network). Rule 6: QUOTE_FALSIFY=1
// flips the allow-list expectation; the run must go red. Rule 7: the limiter
// takes `now`; the booted checks wait on observable state.
// Run: node quote/test/quote-standalone.js
const { spawn } = require("child_process");
const http = require("http"), path = require("path");
const FALSIFY = process.env.QUOTE_FALSIFY === "1";
const SVC_PORT = 45996, FAKE_PORT = 45997, SVC = "http://127.0.0.1:" + SVC_PORT;
const KEY = "test-quote-key-0123456789abcdef0123456789";
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 500) : "")); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the fakes: one server, /hub/* is the Hub backend, /siteverify is Turnstile ----
const FAKE = { up: true, uploads: [], requests: [], lastKey: null };
const LEAKY = { status: "quote", phase: "done", confidence: "rough", price_low: 10, price_high: 14, qty: 1, cost: { total: 3 }, printer: "davinci", files: [{ name: "secret.stl" }], ready_by: "2026-10-08", limits: { qty_max: 100, palette: [] } };
function fakeServer() {
  return http.createServer((req, res) => {
    let chunks = []; req.on("data", d => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks), j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/siteverify") { const p = new URLSearchParams(body.toString()); return j(200, { success: p.get("response") === "good-token" && p.get("secret") === "test-secret" }); }
      if (!FAKE.up) { req.socket.destroy(); return; }
      FAKE.lastKey = req.headers["x-quote-key"];
      if (FAKE.lastKey !== KEY) return j(401, { error: "bad quote key" });
      if (req.url === "/api/quote-backend/ping") return j(200, { ok: true, enabled: true, max_mb: 100 });
      if (req.url === "/api/quote-backend/upload") { FAKE.uploads.push({ name: decodeURIComponent(req.headers["x-file-name"] || ""), bytes: body.length }); return j(200, { token: "a".repeat(32) }); }
      const m = /^\/api\/quote-backend\/quote\/([0-9a-f]{32})(?:\/(\w+))?$/.exec(req.url);
      if (!m) return j(404, { error: "This quote has expired" });
      if (m[2] === "request") { FAKE.requests.push(JSON.parse(body.toString() || "{}")); return j(200, { ...LEAKY, status: "new" }); }
      if (m[2] === "delete") return j(200, { ok: true });
      return j(200, LEAKY);
    });
  });
}
let CHILD = null, LOG = "";
async function startSvc(extra) {
  LOG = "";
  CHILD = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(SVC_PORT),
    HUB_URL: "http://127.0.0.1:" + FAKE_PORT, QUOTE_KEY: KEY, TURNSTILE_SITEKEY: "test-site", TURNSTILE_SECRET: "test-secret", TURNSTILE_VERIFY_URL: "http://127.0.0.1:" + FAKE_PORT + "/siteverify",
    MAX_MB: "1", UPLOADS_PER_HOUR: "3", REQUESTS_PER_DAY: "2", GLOBAL_UPLOADS_PER_HOUR: "60", HUB_TIMEOUT_MS: "1500", ...(extra || {}) } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  for (let i = 0; i < 200; i++) { try { if ((await fetch(SVC + "/healthz")).status) return; } catch {} await sleep(50); }
  throw new Error("service did not start:\n" + LOG);
}
async function stopSvc() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }
const up = (name, buf, tok, ip) => fetch(SVC + "/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-Turnstile-Token": tok || "good-token", ...(ip ? { "CF-Connecting-IP": ip } : {}) }, body: buf }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const jget = p => fetch(SVC + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const jpost = (p, b, ip) => fetch(SVC + p, { method: "POST", headers: { "Content-Type": "application/json", ...(ip ? { "CF-Connecting-IP": ip } : {}) }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  console.log("\n-- pure --");
  const { createLimiter } = require("../lib/limits.js");
  const L = createLimiter(), H = 3600000;
  ok(L.hit("u", "ip1", 2, H, 0) && L.hit("u", "ip1", 2, H, 1) && !L.hit("u", "ip1", 2, H, 2), "limiter: third in the window refused");
  ok(L.hit("u", "ip2", 2, H, 2), "limiter: per key");
  ok(L.hit("u", "ip1", 2, H, H + 1), "limiter: the window slides");
  const V = require("../lib/view.js");
  const cv = V.clean(LEAKY), allowed = FALSIFY ? [...V.FIELDS, "cost"] : V.FIELDS;
  ok(Object.keys(LEAKY).filter(k => !allowed.includes(k)).every(k => !(k in cv)) && cv.price_low === 10, "view.clean keeps only the allow-list" + (FALSIFY ? " [FALSIFIED]" : ""), cv);
  const HUBQ = require("../../modules/estimate/quote.js");
  ok(JSON.stringify(V.FIELDS) === JSON.stringify(HUBQ.VIEW_FIELDS), "the service's allow-list equals the Hub's");
  const { load } = require("../lib/config.js");
  let threw = false; try { load({ QUOTE_KEY: "short", TURNSTILE_SITEKEY: "s", TURNSTILE_SECRET: "t" }); } catch { threw = true; }
  ok(threw, "config: a short QUOTE_KEY refuses to start");

  const fake = fakeServer(); await new Promise(r => fake.listen(FAKE_PORT, "127.0.0.1", r));
  try {
    await startSvc();
    console.log("\n-- page and headers --");
    const page = await fetch(SVC + "/"); const html = await page.text();
    const csp = page.headers.get("content-security-policy") || "";
    ok(page.status === 200 && /<title>/.test(html) && /default-src 'self'/.test(csp) && /challenges\.cloudflare\.com/.test(csp) && !/unsafe-inline/.test(csp.split("script-src")[1] || ""), "page served with a strict CSP", csp);
    ok((await fetch(SVC + "/q/" + "a".repeat(32))).status === 200, "the status page path serves the page");
    const cfg = await jget("/api/config");
    ok(cfg.body.siteKey === "test-site" && cfg.body.maxMb === 1 && !JSON.stringify(cfg.body).includes("test-secret") && !JSON.stringify(cfg.body).includes(KEY), "config: site key only, never secrets", cfg.body);

    console.log("\n-- upload --");
    ok((await up("a.stl", Buffer.alloc(10), "bad-token")).status === 403, "a failed Turnstile -> 403, nothing sent");
    ok((await up("a.obj", Buffer.alloc(10))).status === 400, "only .stl / .3mf");
    ok((await up("a.stl", Buffer.alloc(1048576 + 10), null, "9.9.9.1")).status === 413, "over MAX_MB -> 413");
    let r = await up("model.stl", Buffer.alloc(1000), null, "1.1.1.1");
    ok(r.status === 200 && r.body.token === "a".repeat(32) && FAKE.uploads.some(u => u.name === "model.stl" && u.bytes === 1000) && FAKE.lastKey === KEY, "upload streamed to the Hub with the key", r.body);
    await up("m.stl", Buffer.alloc(10), null, "1.1.1.1"); await up("m.stl", Buffer.alloc(10), null, "1.1.1.1");
    ok((await up("m.stl", Buffer.alloc(10), null, "1.1.1.1")).status === 429, "the 4th upload in an hour from one IP -> 429");
    ok((await up("m.stl", Buffer.alloc(10), null, "2.2.2.2")).status === 200, "another IP is not limited by it");

    console.log("\n-- quote --");
    r = await jget("/api/q/" + "a".repeat(32));
    ok(r.status === 200 && !("cost" in r.body) && !("printer" in r.body) && !("files" in r.body) && r.body.price_low === 10, "the quote view is allow-listed again", r.body);
    ok((await jget("/api/q/not-a-token")).status === 404, "a malformed token never reaches the Hub");

    console.log("\n-- request --");
    ok((await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "bad-token" }, "3.3.3.3")).status === 403, "request needs Turnstile");
    r = await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", notes: "x", turnstile: "good-token" }, "3.3.3.3");
    ok(r.status === 200 && r.body.status === "new" && FAKE.requests.length === 1 && !("turnstile" in FAKE.requests[0]), "request forwarded without the Turnstile token", FAKE.requests);
    await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "good-token" }, "3.3.3.3");
    ok((await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "good-token" }, "3.3.3.3")).status === 429, "3rd request in a day -> 429");

    console.log("\n-- paused --");
    FAKE.up = false;
    r = await up("p.stl", Buffer.alloc(10), null, "4.4.4.4");
    ok(r.status === 503 && r.body.paused === true, "Hub unreachable -> 503 paused", r.body);
    const hz = await jget("/healthz");
    ok(hz.status === 200 && hz.body.hub === false, "healthz reports the Hub down", hz.body);
    FAKE.up = true;
    await stopSvc();

    console.log("\n-- client IP --");
    await startSvc({ TRUST_CF: "0", UPLOADS_PER_HOUR: "1" });
    await up("x.stl", Buffer.alloc(10), null, "5.5.5.1");
    ok((await up("x.stl", Buffer.alloc(10), null, "5.5.5.2")).status === 429, "TRUST_CF=0: a spoofed CF-Connecting-IP does not reset the limit");
    await stopSvc();
  } finally { await stopSvc(); fake.close(); }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node quote/test/quote-standalone.js`
Expected: crash `Cannot find module '../lib/limits.js'`.

- [ ] **Step 3: Implement**

`quote/package.json`:

```json
{
  "name": "u1-quote",
  "private": true,
  "description": "Public quote page for the U1 Print Hub (fork ryvin/u1hub). Talks to the Hub's /api/quote-backend over a shared key.",
  "main": "server.js",
  "scripts": { "start": "node server.js", "test": "node test/quote-standalone.js" },
  "engines": { "node": ">=22" },
  "dependencies": { "express": "^4.19.2" }
}
```

`quote/lib/config.js`:

```js
"use strict";
// u1-quote configuration, from the environment only (quote/.env via compose).
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
function load(env) {
  const c = {
    port: n(env.PORT, 4560), hubUrl: String(env.HUB_URL || "http://host.docker.internal:4545").replace(/\/+$/, ""),
    quoteKey: String(env.QUOTE_KEY || ""), siteKey: String(env.TURNSTILE_SITEKEY || ""), secret: String(env.TURNSTILE_SECRET || ""),
    verifyUrl: String(env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify"),
    maxMb: n(env.MAX_MB, 100), uploadsPerHour: n(env.UPLOADS_PER_HOUR, 5), requestsPerDay: n(env.REQUESTS_PER_DAY, 3),
    globalUploadsPerHour: n(env.GLOBAL_UPLOADS_PER_HOUR, 60), readsPerHour: n(env.READS_PER_HOUR, 300), hubTimeoutMs: n(env.HUB_TIMEOUT_MS, 10000),
    trustCf: env.TRUST_CF !== "0", publicUrl: String(env.PUBLIC_URL || "")
  };
  if (c.quoteKey.length < 32) throw new Error("QUOTE_KEY must be the Hub's estimate.quote_key (32+ characters)");
  if (!c.siteKey || !c.secret) throw new Error("TURNSTILE_SITEKEY and TURNSTILE_SECRET are required");
  return c;
}
module.exports = { load };
```

`quote/lib/limits.js`:

```js
"use strict";
// Sliding-window counters in memory, `now` injected (rule 7). A restart forgets them; that is acceptable for abuse limits.
function createLimiter() {
  const B = new Map();
  function hit(bucket, key, max, windowMs, now) {
    const k = bucket + "\u0000" + key, list = (B.get(k) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { B.set(k, list); return false; }
    list.push(now); B.set(k, list);
    if (B.size > 50000) for (const [kk, l] of B) if (!l.length || now - l[l.length - 1] > 86400000) B.delete(kk);
    return true;
  }
  return { hit };
}
module.exports = { createLimiter };
```

`quote/lib/turnstile.js`:

```js
"use strict";
// Cloudflare Turnstile server-side check (siteverify). Fails closed.
async function verify(token, ip, o) {
  if (!token || String(token).length > 4096) return false;
  try {
    const form = new URLSearchParams({ secret: o.secret, response: String(token) });
    if (ip) form.set("remoteip", ip);
    const r = await (o.fetchImpl || fetch)(o.verifyUrl, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j && j.success === true;
  } catch { return false; }
}
module.exports = { verify };
```

`quote/lib/view.js`:

```js
"use strict";
// The second allow-list (defence in depth): must equal modules/estimate/quote.js VIEW_FIELDS (the suite checks).
const FIELDS = Object.freeze(["status", "phase", "error", "confidence", "price", "price_low", "price_high", "each", "qty", "material", "colour", "colour_changed", "quality", "rush",
  "ready_by", "valid_until", "multicolour", "fits", "notes_from_owner", "final_price", "limits", "files_deleted"]);
function clean(b) { const out = {}; if (b && typeof b === "object") for (const k of FIELDS) if (b[k] !== undefined) out[k] = b[k]; return out; }
module.exports = { FIELDS, clean };
```

`quote/lib/hub.js`:

```js
"use strict";
// The Hub's /api/quote-backend, over the shared key. Any network failure or timeout is "paused", never a 500.
const { Readable, Transform } = require("stream");
const PAUSED = { status: 503, body: { error: "Quotes are paused - try again soon", paused: true } };
function createHub(o) {
  const H = { "X-Quote-Key": o.quoteKey };
  async function call(p, init) {
    try {
      const r = await fetch(o.hubUrl + "/api/quote-backend" + p, { ...init, headers: { ...H, ...(init && init.headers) }, signal: AbortSignal.timeout(init && init.long ? 300000 : o.timeoutMs), ...(init && init.body && init.duplex ? { duplex: "half" } : {}) });
      let body = null; try { body = await r.json(); } catch {}
      if (r.status === 401 || r.status >= 500) return r.status === 503 && body && body.paused ? { status: 503, body } : PAUSED;
      return { status: r.status, body };
    } catch { return PAUSED; }
  }
  return {
    ping: () => call("/ping"),
    get: token => call("/quote/" + token),
    post: (token, action, body) => call("/quote/" + token + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }),
    // Streams the visitor's body to the Hub, counting bytes; over maxBytes the stream errors and the caller answers 413.
    upload(req, name, maxBytes, onOver) {
      let n = 0;
      const counter = new Transform({ transform(chunk, enc, cb) { n += chunk.length; if (n > maxBytes) { onOver(); return cb(new Error("too big")); } cb(null, chunk); } });
      req.pipe(counter);
      return call("/upload", { method: "POST", long: true, duplex: "half", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: Readable.toWeb(counter) });
    }
  };
}
module.exports = { createHub, PAUSED };
```

`quote/server.js`:

```js
"use strict";
// u1-quote — the public quote page for the U1 Print Hub (fork ryvin/u1hub).
// Holds no Hub code and no Hub files: every quote lives in the Hub, reached at
// HUB_URL with X-Quote-Key. This service adds what the public edge needs:
// Turnstile, per-IP and global limits, a size cap, a strict CSP, and a second
// field allow-list. Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md; ops: docs/quote.md.
const express = require("express"), path = require("path");
const { load } = require("./lib/config.js"), { createLimiter } = require("./lib/limits.js"), { verify } = require("./lib/turnstile.js");
const { createHub } = require("./lib/hub.js"), V = require("./lib/view.js");
const C = load(process.env);
const hub = createHub({ hubUrl: C.hubUrl, quoteKey: C.quoteKey, timeoutMs: C.hubTimeoutMs });
const L = createLimiter(), HOUR = 3600000, DAY = 24 * HOUR;
const app = express();
app.disable("x-powered-by");
const TOKEN = /^[0-9a-f]{32}$/;
const ipOf = req => (C.trustCf && req.get("CF-Connecting-IP")) || req.socket.remoteAddress || "?";
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.use((req, res, next) => { res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }); next(); });
const page = (req, res) => res.sendFile(path.join(__dirname, "public", "index.html"));
app.get("/", page);
app.get("/q/:token", page);
app.use("/static", express.static(path.join(__dirname, "public"), { index: false }));
const json = express.json({ limit: "16kb" });
const out = (res, r) => res.status(r.status).json(r.status === 200 ? V.clean(r.body) : { error: (r.body && r.body.error) || "Something went wrong", paused: !!(r.body && r.body.paused) });
const tooMany = (res, what) => res.status(429).json({ error: "Too many " + what + " - please try again later" });
const readLimit = (req, res, next) => (L.hit("read", ipOf(req), C.readsPerHour, HOUR, Date.now()) ? next() : tooMany(res, "requests"));

app.get("/api/config", (req, res) => res.json({ siteKey: C.siteKey, maxMb: C.maxMb }));
app.get("/healthz", async (req, res) => { const r = await hub.ping(); res.json({ ok: true, hub: r.status === 200, enabled: !!(r.body && r.body.enabled) }); });
app.post("/upload", async (req, res) => {
  const ip = ipOf(req);
  let name = ""; try { name = path.basename(decodeURIComponent(String(req.get("X-File-Name") || ""))).slice(0, 200); } catch {}
  if (!/\.(stl|3mf)$/i.test(name)) { req.resume(); return res.status(400).json({ error: "Please upload an .stl or .3mf file" }); }
  const len = Number(req.get("Content-Length"));
  if (len > C.maxMb * 1048576) { req.resume(); res.set("Connection", "close"); return res.status(413).json({ error: "Files are limited to " + C.maxMb + " MB" }); }
  if (!(await verify(req.get("X-Turnstile-Token"), ip, { secret: C.secret, verifyUrl: C.verifyUrl }))) { req.resume(); return res.status(403).json({ error: "Please complete the check and try again" }); }
  const now = Date.now();
  if (!L.hit("upload", ip, C.uploadsPerHour, HOUR, now)) { req.resume(); return tooMany(res, "uploads"); }
  if (!L.hit("upload-all", "*", C.globalUploadsPerHour, HOUR, now)) { req.resume(); return res.status(503).json({ error: "We're busy right now - please try again in a while", paused: true }); }
  let over = false;
  const r = await hub.upload(req, name, C.maxMb * 1048576, () => { over = true; });
  if (over) { res.set("Connection", "close"); return res.status(413).json({ error: "Files are limited to " + C.maxMb + " MB" }); }
  if (r.status !== 200 || !r.body || !TOKEN.test(String(r.body.token || ""))) return out(res, r.status === 200 ? { status: 502, body: {} } : r);
  res.json({ token: r.body.token });
});
const withToken = fn => (req, res) => (TOKEN.test(req.params.token) ? fn(req, res) : res.status(404).json({ error: "This quote has expired" }));
app.get("/api/q/:token", readLimit, withToken(async (req, res) => out(res, await hub.get(req.params.token))));
app.post("/api/q/:token/options", readLimit, json, withToken(async (req, res) => {
  const b = req.body || {}, body = {};
  for (const k of ["qty", "palette_id", "quality", "rush"]) if (k in b) body[k] = b[k];
  out(res, await hub.post(req.params.token, "options", body));
}));
app.post("/api/q/:token/request", json, withToken(async (req, res) => {
  const ip = ipOf(req), b = req.body || {};
  if (!(await verify(b.turnstile, ip, { secret: C.secret, verifyUrl: C.verifyUrl }))) return res.status(403).json({ error: "Please complete the check and try again" });
  if (!L.hit("request", ip, C.requestsPerDay, DAY, Date.now())) return tooMany(res, "requests today");
  out(res, await hub.post(req.params.token, "request", { name: b.name, email: b.email, notes: b.notes }));
}));
app.post("/api/q/:token/delete", readLimit, withToken(async (req, res) => { const r = await hub.post(req.params.token, "delete", {}); res.status(r.status).json(r.status === 200 ? { ok: true } : { error: (r.body && r.body.error) || "Something went wrong" }); }));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(C.port, () => console.log("u1-quote listening on " + C.port + " -> " + C.hubUrl));
```

Note: `json` parsing runs per route, so the raw `/upload` body is never consumed by a body parser.

- [ ] **Step 4: Run test to verify it passes**

Run: `node quote/test/quote-standalone.js`
Expected: `… passed, 0 failed`. (The `-- page and headers --` checks need `quote/public/index.html`; until Task 8, create a minimal `quote/public/index.html` with `<!doctype html><title>Quote</title>` so this task's suite runs green, and Task 8 replaces it.)

- [ ] **Step 5: Falsify**

Run: `QUOTE_FALSIFY=1 node quote/test/quote-standalone.js; echo exit=$?`
Expected: `FAIL view.clean keeps only the allow-list [FALSIFIED]`, `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add quote/package.json quote/server.js quote/lib quote/test/quote-standalone.js quote/public/index.html
git commit -m "feat(quote): u1-quote service - Turnstile, limits, Hub client, allow-list, strict CSP"
```

---

### Task 8: The public page

**Files:**
- Create/replace: `quote/public/index.html`, `quote/public/app.js`, `quote/public/style.css`
- Modify: `quote/test/quote-standalone.js` (page checks)

**Interfaces:**
- Consumes: Task 7's routes. Turnstile widget script `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, rendered with `turnstile.render(el, { sitekey, callback })`, and `turnstile.reset(widgetId)` after each use (a token is single-use).

Design (no framework, no inline script or style — CSP): one centred column, max 640 px, 16 px side gutter; brand line "Satisfying Prints 3D"; a drop zone ("Drop an STL or 3MF, or choose a file", the 100 MB limit, the privacy line: "Your file is used only to price this quote. It's deleted after 7 days unless you request the print, and you can delete it any time."); the Turnstile widget; a progress line ("Uploading 42 %", then "Reading your model…" while `phase:"analysing"`, polled every 1.5 s, at most 2 minutes). Quote card: the big price ("$14.00 – $18.50", or "$16.00", or "We'll price this one by hand"), a confidence chip with plain words (exact → "Based on a print we've made", good → "From your file's slicer data", rough → "Estimated from the shape — we'll confirm"), "each" when firm, "Ready by Tue 13 Oct", "Quote valid until …". Options: quantity stepper (1..qty_max), colour swatches from `limits.palette` (out of stock: disabled, struck through, "out of stock" title) or "Printed in its own colours" when `multicolour`, Standard/Strong toggle, Rush checkbox ("Rush ×1.5 — goes ahead of the queue"). Each change posts `/options` (debounced 300 ms) and repaints. `fits:false` → "Too big for our printers — send us a message instead" with the request form still available. Request form: name, email, notes, the Turnstile widget, "Request this print". After a request: the page moves to `/q/<token>` (history.replaceState) and shows the status ("Requested — we'll reply by email", "Quoted: $42.50" + owner note, "Accepted", "Declined", "Closed") and a "Delete my files" button. The status page loads straight from the URL token. Every dynamic string goes through `textContent` (no `innerHTML` with data). Colours: tokens on `:root`, a dark scheme under `prefers-color-scheme: dark`, explicit `body` background, system font stack plus tabular numbers for prices, easing `cubic-bezier(.2,.7,.2,1)` (no keyword easings), no gradients.

- [ ] **Step 1: Write the failing test** — append to the `-- page and headers --` block of `quote/test/quote-standalone.js`:

```js
    const js = await fetch(SVC + "/static/app.js"), css = await fetch(SVC + "/static/style.css");
    ok(js.status === 200 && css.status === 200, "app.js and style.css served");
    ok(/src="\/static\/app\.js"/.test(html) && /href="\/static\/style\.css"/.test(html) && !/<script>[^<]/.test(html) && !/style="/.test(html), "no inline script or style (the CSP would block them)");
    const appjs = await js.text();
    ok(!/\.innerHTML\s*=\s*[^"'`]/.test(appjs.replace(/innerHTML = ""/g, "")), "app.js never assigns data to innerHTML");
    ok(/turnstile\.reset/.test(appjs) && /X-Turnstile-Token/.test(appjs), "app.js resets Turnstile after use and sends the token");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node quote/test/quote-standalone.js 2>&1 | grep FAIL`
Expected: `FAIL app.js and style.css served` (404s).

- [ ] **Step 3: Implement the three files**

`quote/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Print Quote</title>
<meta name="description" content="Upload an STL or 3MF and get a 3D printing price and ready date from Satisfying Prints 3D.">
<link rel="stylesheet" href="/static/style.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<script src="/static/app.js" defer></script>
</head>
<body>
<main class="wrap">
  <header class="brand"><span class="mark" aria-hidden="true"></span><span>Satisfying Prints 3D</span></header>
  <h1>Get a print quote</h1>
  <section id="upload" class="card">
    <label class="drop" id="drop" for="file">
      <input type="file" id="file" accept=".stl,.3mf" hidden>
      <strong>Drop an STL or 3MF</strong><span>or choose a file · up to <b id="maxmb">100</b> MB</span>
    </label>
    <div id="ts-upload" class="ts"></div>
    <p class="msg" id="upmsg" role="status" aria-live="polite"></p>
    <p class="fine">Your file is used only to price this quote. It is deleted after 7 days unless you request the print, and you can delete it any time.</p>
  </section>
  <section id="quote" class="card" hidden>
    <div class="price" id="price"></div>
    <div class="chips"><span class="chip" id="conf"></span><span class="chip" id="ready"></span></div>
    <p class="fine" id="valid"></p>
    <p class="warn" id="note" hidden></p>
    <div id="opts" class="opts">
      <div class="row"><span class="lbl">Quantity</span><div class="qty"><button type="button" id="qminus" aria-label="Fewer">−</button><input id="qty" inputmode="numeric" value="1" aria-label="Quantity"><button type="button" id="qplus" aria-label="More">+</button></div></div>
      <div class="row"><span class="lbl">Colour</span><div id="swatches" class="swatches"></div></div>
      <div class="row"><span class="lbl">Quality</span><div class="seg" role="radiogroup"><button type="button" data-q="standard" role="radio">Standard</button><button type="button" data-q="strong" role="radio">Strong</button></div></div>
      <div class="row"><label class="check"><input type="checkbox" id="rush"> <span id="rushlbl">Rush</span></label></div>
    </div>
    <form id="reqform" class="req">
      <h2>Request this print</h2>
      <input id="name" placeholder="Your name" maxlength="80" required autocomplete="name">
      <input id="email" type="email" placeholder="Email" maxlength="200" required autocomplete="email">
      <textarea id="notes" placeholder="Anything we should know? (optional)" maxlength="2000" rows="3"></textarea>
      <div id="ts-request" class="ts"></div>
      <button type="submit" class="primary" id="reqbtn">Request this print</button>
      <p class="msg" id="reqmsg" role="status" aria-live="polite"></p>
    </form>
    <div id="status" class="status" hidden></div>
    <button type="button" class="ghost" id="del">Delete my files</button>
  </section>
</main>
</body>
</html>
```

`quote/public/app.js` — implement with these functions, all DOM writes through `textContent`/`setAttribute`/`createElement`:

```js
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const S = { cfg: null, token: null, q: null, ts: { upload: null, request: null }, tok: { upload: null, request: null }, timer: null, pending: null };
  const usd = n => "$" + Number(n).toFixed(2);
  const CONF = { exact: "Based on a print we've made", good: "From your file's slicer data", rough: "Estimated from the shape - we'll confirm" };
  const STATUS = { new: "Requested - we'll reply by email.", quoted: "Quoted", accepted: "Accepted - we're on it.", declined: "We can't take this one.", closed: "Closed" };
  const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  async function api(path, init) {
    const r = await fetch(path, init); let b = null; try { b = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error((b && b.error) || "Something went wrong"), { status: r.status, paused: b && b.paused });
    return b;
  }
  function widget(slot, el) {
    const go = () => { S.ts[slot] = window.turnstile.render(el, { sitekey: S.cfg.siteKey, callback: t => { S.tok[slot] = t; }, "expired-callback": () => { S.tok[slot] = null; } }); };
    if (window.turnstile) go(); else { const iv = setInterval(() => { if (window.turnstile) { clearInterval(iv); go(); } }, 200); }
  }
  const spent = slot => { S.tok[slot] = null; if (window.turnstile && S.ts[slot] != null) window.turnstile.reset(S.ts[slot]); };
  function upload(file) {
    const msg = $("upmsg");
    if (!/\.(stl|3mf)$/i.test(file.name)) { msg.textContent = "Please choose an .stl or .3mf file."; return; }
    if (file.size > S.cfg.maxMb * 1048576) { msg.textContent = "Files are limited to " + S.cfg.maxMb + " MB."; return; }
    if (!S.tok.upload) { msg.textContent = "Please complete the check above first."; return; }
    const x = new XMLHttpRequest();
    x.open("POST", "/upload");
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    x.setRequestHeader("X-Turnstile-Token", S.tok.upload);
    spent("upload");
    x.upload.onprogress = e => { if (e.lengthComputable) msg.textContent = "Uploading " + Math.round(e.loaded / e.total * 100) + " %"; };
    x.onload = () => {
      let b = null; try { b = JSON.parse(x.responseText); } catch {}
      if (x.status !== 200 || !b || !b.token) { msg.textContent = (b && b.error) || "Upload failed - please try again."; return; }
      S.token = b.token; history.replaceState(null, "", "/q/" + b.token);
      msg.textContent = "Reading your model…"; poll(Date.now());
    };
    x.onerror = () => { msg.textContent = "Upload failed - please check your connection."; };
    x.send(file);
  }
  async function poll(t0) {
    try {
      const q = await api("/api/q/" + S.token);
      if (q.phase === "analysing") { if (Date.now() - t0 > 120000) { $("upmsg").textContent = "This is taking longer than usual - reload the page in a minute."; return; } S.timer = setTimeout(() => poll(t0), 1500); return; }
      $("upmsg").textContent = ""; paint(q);
    } catch (e) { $("upmsg").textContent = e.status === 404 ? "This quote has expired." : e.message; }
  }
  function paint(q) { /* fills #price, #conf, #ready, #valid, #note, swatches, quality, rush, status; see the design notes above */ }
  function setOption(patch) {
    clearTimeout(S.pending);
    S.pending = setTimeout(async () => { try { paint(await api("/api/q/" + S.token + "/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })); } catch (e) { $("note").hidden = false; $("note").textContent = e.message; } }, 300);
  }
  // wire: drop zone (dragover/drop/change), qty stepper (clamped to limits.qty_max), swatch clicks -> setOption({ palette_id }),
  // quality buttons -> setOption({ quality }), rush -> setOption({ rush }), request form submit (needs S.tok.request; posts
  // { name, email, notes, turnstile }; spent("request") right after the fetch starts), delete (confirm by a second click within 4 s,
  // posts /delete, then shows "Your files are deleted."). Boot: api("/api/config") -> S.cfg; $("maxmb").textContent; render both widgets;
  // if location.pathname is /q/<32 hex> -> S.token = it; poll(Date.now()).
})();
```

The implementer writes `paint()` and the wiring in full per the design notes; the comment lines above are the exact behaviour list, not code to leave in. Constraints the test pins: no `innerHTML =` with data (clear with `textContent = ""` or `replaceChildren()`), `turnstile.reset` after each use, the `X-Turnstile-Token` header.

`quote/public/style.css`: tokens on `:root` (`--bg #f7f5f2; --card #ffffff; --ink #1b1a19; --dim #5f5b57; --line #e4dfd8; --accent #0f766e; --warn #b45309; --radius 14px`), the dark set under `@media (prefers-color-scheme: dark) { :root { --bg #141312; --card #1d1c1a; --ink #f2efea; --dim #a7a199; --line #34312d; --accent #2dd4bf; --warn #f59e0b } }`, `body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}`, `.wrap{max-width:640px;margin:0 auto;padding:24px 16px 64px}`, `.price{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}`, drop zone dashed 2 px `var(--line)` turning `var(--accent)` on `.over`, transitions `160ms cubic-bezier(.2,.7,.2,1)`, swatches 32 px circles with a 2 px ring on `.on` and `opacity:.35` + `cursor:not-allowed` on `[disabled]`, `.chip` pill in `color-mix(in srgb, var(--accent) 12%, transparent)`, all widths fluid (no horizontal scroll at 360 px).

- [ ] **Step 4: Run tests**

Run: `node quote/test/quote-standalone.js | tail -2`
Expected: `… passed, 0 failed`.

- [ ] **Step 5: E2E through the real UI (throwaway pair)**

Start the throwaway Hub from Task 6 Step 3 (port 45992, `enabled:true`, a two-colour palette saved), then the service against it with Cloudflare's always-pass test keys (verify the current values first at https://developers.cloudflare.com/turnstile/troubleshooting/testing/ — expected: site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`):

```bash
cd /mnt/e/Code/u1hub/quote && PORT=45998 HUB_URL=http://127.0.0.1:45992 QUOTE_KEY=test-quote-key-0123456789abcdef0123456789 \
  TURNSTILE_SITEKEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA TRUST_CF=0 \
  nohup node server.js > $SCR/qsvc.log 2>&1 &
```

Playwright MCP: open `http://127.0.0.1:45998/`, wait for the Turnstile widget to pass, upload `test` fixture STL (write a 20 mm cube with the suite's `binStl` into the scratchpad), wait for the price; change qty to 3, pick the second colour, Strong, Rush → price and ready date change; fill name/email, pass Turnstile, Request → status "Requested"; reload `/q/<token>` → same status; in the Hub (45992) Estimate tab, Send quote 30 → reload the status page → "Quoted $30.00"; Delete my files → "Your files are deleted." Check at 360 px width (`browser_resize`) for no horizontal scroll (`document.documentElement.scrollWidth <= 360`), and dark mode (`browser_emulate_media` colorScheme dark) screenshot. `browser_console_messages`: no CSP violations or errors. Stop both by port (45998, 45992).

Expected: every step as described; screenshots in the scratchpad.

- [ ] **Step 6: Commit**

```bash
git add quote/public quote/test/quote-standalone.js
git commit -m "feat(quote): the public quote page (upload, options, request, status, delete) under a strict CSP"
```

---

### Task 9: Packaging, docs, suite wiring, harness

**Files:**
- Create: `quote/Dockerfile`, `quote/compose.yml`, `quote/.env.example`, `quote/.dockerignore`, `docs/quote.md`
- Modify: `package.json` (`test:standalone` += `node test/quote-backend-standalone.js && node quote/test/quote-standalone.js`), `.gitignore` (`quote/.env`), `docs/estimate.md` (Public quotes section), `docs/FORK.md` (estimate row: quote backend; the auth.js gate line under core edits)

- [ ] **Step 1: Files**

`quote/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
USER node
EXPOSE 4560
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:4560/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
```

`quote/compose.yml`:

```yaml
# u1-quote: the public quote page (docs/quote.md). Reached only through the
# Cloudflare tunnel (quote.satisfyingprints3d.com -> host.docker.internal:4560).
name: u1-quote
services:
  u1-quote:
    build: .
    container_name: u1-quote
    restart: unless-stopped
    env_file: .env
    environment:
      PORT: "4560"
      HUB_URL: http://host.docker.internal:4545
      TRUST_CF: "1"
    ports:
      - "4560:4560"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs: [/tmp]
networks:
  default:
    ipam:
      config:
        - subnet: 10.215.0.0/24
```

(Subnet: check it is free first — `docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'` must not list 10.215.0.0/24 and the LAN is 192.168.1.0/24 — skill `infra-collision-audit`.)

`quote/.env.example`:

```
# Copy to quote/.env (gitignored). QUOTE_KEY comes from the Hub: Estimate tab -> Public quotes -> New key.
QUOTE_KEY=
TURNSTILE_SITEKEY=
TURNSTILE_SECRET=
PUBLIC_URL=https://quote.satisfyingprints3d.com
MAX_MB=100
UPLOADS_PER_HOUR=5
REQUESTS_PER_DAY=3
GLOBAL_UPLOADS_PER_HOUR=60
```

`quote/.dockerignore`: `node_modules`, `test`, `.env`, `*.log`.

`docs/quote.md`: what it is (two halves, diagram from the spec §2), owner setup (enable, palette, hours/timezone, new key → `quote/.env`, Turnstile widget for `quote.satisfyingprints3d.com` in the Cloudflare dashboard), the confidence table, the limits and retention, the routes on both sides, operations (build/up commands, healthz, "paused" meaning, logs), the tunnel rule, and the verification record (filled in Task 10).

- [ ] **Step 2: Docker build check**

Run: `cd /mnt/e/Code/u1hub/quote && docker build -t u1-quote:test . 2>&1 | tail -2 && docker image ls u1-quote:test --format '{{.Repository}}:{{.Tag}} {{.ID}}'`
Expected: an image line `u1-quote:test <id>`.

Then a container smoke on a spare port (no `.env` → must refuse to start): `docker run --rm u1-quote:test 2>&1 | tail -1` → `QUOTE_KEY must be …`. Remove the test image after: `docker image rm u1-quote:test`.

- [ ] **Step 3: Suites and harness**

Run each 3× in isolation (rule 7 evidence), then the harness from a /tmp copy:

```bash
for i in 1 2 3; do node test/quote-backend-standalone.js | tail -1; node quote/test/quote-standalone.js | tail -1; node test/estimate-standalone.js | tail -1; done
rm -rf /tmp/u1hub-h && cp -r /mnt/e/Code/u1hub /tmp/u1hub-h && rm -rf /tmp/u1hub-h/data && cd /tmp/u1hub-h && U1HUB_HARNESS_SKIP_SLICE=1 npm test > /tmp/u1hub-h/harness.log 2>&1; tail -3 /tmp/u1hub-h/harness.log
```

Expected: each line `… passed, 0 failed` (3× the same counts); harness `… passed, 0 failed` with the count unchanged from before this branch (967) or higher.

- [ ] **Step 4: Commit**

```bash
git add quote/Dockerfile quote/compose.yml quote/.env.example quote/.dockerignore docs/quote.md docs/estimate.md docs/FORK.md package.json .gitignore
git commit -m "chore(quote): Docker packaging, docs, suites in test:standalone"
```

- [ ] **Step 5: Final whole-branch review** (per the execution skill), fixes RED→GREEN, then ff-merge `quote` → `ryvin` and `git push fork ryvin`.

---

### Task 10: Deploy (owner-gated, outward-facing)

Every step here changes something outside the repo; ask the owner before each of 2, 3 and 4.

- [ ] **Step 1: Owner inputs** — Turnstile widget (site key + secret) created by the owner for hostname `quote.satisfyingprints3d.com`; the owner's timezone and hours entered in Public quotes; palette filled; `enabled` stays off until Step 5.
- [ ] **Step 2: Hub rebuild** — only inside the deploy window (no printer within ~15 min of finishing; `ps -eo args | grep "[n]ode scripts/sme-runner.js"` empty). `cd /mnt/e/Code/u1hub && docker compose build && docker compose up -d`; verify `docker image ls` shows the new image and `curl -s -o /dev/null -w '%{http_code}' -H "X-Quote-Key: <key>" http://127.0.0.1:4545/api/quote-backend/ping` → `200`, and without the header → `401`.
- [ ] **Step 3: Quote container** — owner generates the key (New key), it goes into `quote/.env` with the Turnstile pair; re-check 4560 / `u1-quote` / subnet free; `cd quote && docker compose up -d --build`; `curl -s http://127.0.0.1:4560/healthz` → `{"ok":true,"hub":true,"enabled":false}`.
- [ ] **Step 4: Tunnel** — with the owner's go-ahead (the restart blips every hostname on that tunnel for a few seconds): add above the final `http_status:404` rule in `/mnt/e/Code/YT_Steam_Manager/cloudflared-config.yml`:

```yaml
  # Public quote page (repo /mnt/e/Code/u1hub, quote/ -> container u1-quote on
  # host port 4560). PUBLIC on purpose: no Access application. The Hub stays
  # behind Access; u1-quote reaches it with a shared key. Added 2026-10-07.
  - hostname: quote.satisfyingprints3d.com
    service: http://host.docker.internal:4560
```

then the DNS route and restart per skill `cloudflare-dns-tunnels` (`cloudflared tunnel route dns <tunnel> quote.satisfyingprints3d.com`, `docker restart snapmaker-cloudflared`). Verify: `brewshot https://quote.satisfyingprints3d.com --eval "document.title"` → `Print Quote`; `curl -sI https://u1hub.pinedamail.com | head -1` still redirects to Access (the Hub stayed private).
- [ ] **Step 5: Live check** — owner turns on "Taking quotes"; one real upload from a phone off the LAN, a request, the ntfy notification arrives, Send quote from the Hub, the status page shows it, Close. Record the result in `docs/quote.md` → commit `docs(quote): live verification` and push.
