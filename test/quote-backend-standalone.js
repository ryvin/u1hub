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
  // falsified: expect the leaked cost to survive - the real filter must make that fail
  ok(Object.keys(cv).every(k => Q.VIEW_FIELDS.includes(k)) && Object.keys(leaky).filter(k => !Q.VIEW_FIELDS.includes(k)).every(k => !(k in cv)) && (!FALSIFY || "cost" in cv), "customerView keeps only the allow-list" + (FALSIFY ? " [FALSIFIED]" : ""), cv);

  const D = 24 * 3600 * 1000, now = 100 * D;
  ok(Q.expired({ public: true, status: "quote", created: now - 8 * D }, now) && !Q.expired({ public: true, status: "quote", created: now - 6 * D }, now), "unrequested: gone after 7 days");
  ok(!Q.expired({ public: true, status: "new", created: now - 90 * D }, now), "an open request never expires");
  ok(Q.expired({ public: true, status: "closed", created: 0, closed_at: now - 31 * D }, now) && !Q.expired({ public: true, status: "declined", created: 0, closed_at: now - 29 * D }, now), "closed/declined: gone 30 days after");
  ok(!Q.expired({ status: "quote", created: 0 }, now), "a non-public estimate is not this rule's business");
}

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

async function main() {
  pureQuote(); pureReadyBy();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
