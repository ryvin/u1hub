// modules/costing.js — what a piece of client work cost, and what to charge
// for it. Fork module (ryvin/u1hub), not part of upstream dlgambill/u1hub.
// Design and research: docs/proposals/costing.md; the built feature, its
// formulas and the decisions behind them: docs/costing.md.
//
// Three things, two files beside config.json (both gitignored):
//
//   prints.json  — the LEDGER. One row per print the Hub watched finish, be
//   cancelled or error, written from core/events.js's print.* edges with the
//   actual duration (print.done carries durationSec), the slicer's grams and
//   time estimate as the fallback, and — when the resources module deducted
//   filament for that print — the grams priced at the loaded rolls' own
//   prices. Every number carries a `source` so a summary can say "material:
//   actual" or "energy: estimated at 250 W". Append-only, capped at
//   LEDGER_MAX; a row is edited only to assign it, count it out, or fix its
//   piece count.
//
//   projects.json — CLIENTS, PROJECTS (a long-running piece of client work:
//   many prints, many bundles, one bill), their non-print LINE ITEMS (labour
//   minutes, hardware, packaging, shipping), and PENDING assignments ("the
//   next print of this file belongs to that project", set from the job card).
//
//   cfg.costing  — the RATES: $/kWh, labour $/h, failure and overhead %,
//   minimum fee, platform fee, pricing knobs, and a per-printer block
//   (purchase price, life hours, maintenance per hour, average watts). Every
//   rate is optional. An unset rate leaves that cost line BLANK, never a
//   guessed zero — the same rule modules/resources.js keeps for spool prices.
//
// Nothing here decides anything. costOf and projectSummary add up what is
// known and label what is not; the pricing helper shows several answers side
// by side and the person picks. Rates you have not typed produce blanks you
// can see, not numbers you would have to distrust.
//
// The one line this module needs from upstream: modules/resources.js emits
// "filament.deducted" with the deduction record after it has already taken
// the grams off the rolls. Listening to print.done and calling deductFor a
// second time would deduct twice; reading resources.json would duplicate the
// pricing arithmetic. The event is the record it already produced.
//
// Grams and time come from the slicer's own comment block in the gcode file
// (parser.js, the same read resources.js and margin.js make); the piece count
// comes from the file name through margin.js's qtyFromName. Internal string
// handling of files the Hub owns, not an external provider.
//
// A file sent straight from the slicer to the printer is NOT in the library,
// so that read finds nothing. The fallback chain per row, each step labelled
// in `material.source` / `est_source` / `seconds_source` so a summary never
// has to guess (docs/costing.md "Where each number comes from"):
//   grams: deduction (the rolls)  ->  library gcode  ->  the printer's own
//          Moonraker file metadata (GET /server/files/metadata, a few hundred
//          bytes of JSON, fetched at print.done while the file is still on
//          the printer)  ->  Moonraker's job history filament_used, millimetres
//          turned into grams by material density.
//   time:  print.done durationSec  ->  history print_duration  ->  the slicer's
//          estimate from the library file or the printer's metadata.
// Rows left blank by an older Hub are backfilled the same way, one GET at a
// time with a pause between (2026-09-14: bulk gcode downloads through
// Moonraker OOM-killed it mid-print; metadata is JSON, but the pacing stays).
//
// Rates the person has not typed can be SUGGESTED: cited numbers for a U1
// (purchase, life hours, maintenance reserve, average watts) and the U.S.
// residential electricity price, each with its source in docs/costing.md.
// costOf uses a suggestion only where the typed rate is unset and labels the
// line "suggested"; Settings shows them as placeholders and a button writes
// them as real rates. Still never a guessed zero: a blank stays a blank until
// a cited number or a typed one fills it.

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { parseGcodeMap, estMinutes } = require("../parser.js");
const { qtyFromName, csvCell } = require("./margin.js");
const REPORT = require("./costing-report.js");    // report / reportCsv / reportHtml, pure

// The ledger cap. 10,000 rows: three printers at five prints a day each is
// ~5,500 rows a year, so this holds about two years of a busy farm, and at
// ~1 KB a row the file (written whole on every assignment) stays near 10 MB.
// Oldest rows go first. Overridable for a bigger farm or a test.
const LEDGER_MAX = Math.max(10, Number(process.env.U1HUB_COSTING_LEDGER_MAX) || 10000);
const FACTS_MAX = 500;                 // parsed-file cache entries
const STASH_MS = 10 * 60 * 1000;       // a deduction and its ledger row must be within this
const HEAD_BYTES = 64 * 1024, TAIL_BYTES = 512 * 1024;
const ITEM_KINDS = ["labor", "hardware", "packaging", "shipping", "other"];
const STATES = ["open", "quoted", "delivered", "closed"];
const OUTCOMES = ["done", "cancelled", "error"];
// key -> [min, max]. Anything outside is a 400, not a clamp.
const RATE_KEYS = {
  kwh_rate: [0, 10], labor_rate: [0, 1000], failure_pct: [0, 100], overhead_pct: [0, 100],
  min_fee: [0, 100000], platform_fee_pct: [0, 50], platform_fee_fixed: [0, 100],
  markup_pct: [0, 1000], margin_pct: [0, 95], hour_rate: [0, 1000], setup_minutes: [0, 600]
};
const PRINTER_KEYS = { purchase: [0, 100000], life_hours: [1, 1000000], maint_per_hour: [0, 100], avg_watts: [1, 5000] };
const BREAKS = [1, 10, 50];

// Filament length -> grams. 1.75 mm filament; densities in g/cm^3 are the
// slicer-default table (sources and dates in docs/costing.md). A material the
// table does not know is priced as PLA and says so (`density_assumed`).
const FILAMENT_DIAMETER_MM = 1.75;
const DENSITY = Object.freeze({ PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21 });

// Suggested rates: every number cited in docs/costing.md ("Suggested values"),
// with the date it was read. They apply to a U1 (row.type "u1"); a generic
// Klipper printer gets no printer suggestion. SUGGESTED_NOTES is what Settings
// prints beside each placeholder.
// `printers` is the U1 block (applies_to "u1"); `by_type` keys a block per
// printer type. A type with no block gets no printer suggestion at all. The
// Kobra S1 block carries only what could be cited: its price and the generic
// life-hours guide; no watts and no maintenance reserve (docs/costing.md).
const SUGGESTED = Object.freeze({
  kwh_rate: 0.183,
  printers: Object.freeze({ purchase: 849, life_hours: 5000, maint_per_hour: 0.10, avg_watts: 150 }),
  applies_to: "u1",
  by_type: Object.freeze({
    u1: Object.freeze({ purchase: 849, life_hours: 5000, maint_per_hour: 0.10, avg_watts: 150 }),
    "kobra-s1": Object.freeze({ purchase: 401, life_hours: 5000 })
  })
});
const SUGGESTED_TYPE_NOTES = Object.freeze({
  "kobra-s1": Object.freeze({
    purchase: "Anycubic Kobra S1 on store.anycubic.com, 2026-10-03 ($401 sale, $631 regular)",
    life_hours: "Snapmaker's cost guide figure for any well-maintained printer (~5,000 h); no Kobra-specific figure published",
    maint_per_hour: "no suggestion: no cited Kobra S1 parts prices or intervals",
    avg_watts: "no suggestion: the one measured figure found (Igor's Lab review, 180 W printing PLA) could not be read at source; type it if you trust it"
  })
});
const SUGGESTED_NOTES = Object.freeze({
  kwh_rate: "U.S. residential average, EIA Electric Power Monthly table 5.6.A, July 2026 (18.31 c/kWh)",
  purchase: "Snapmaker U1 on us.snapmaker.com, 2026-10-03 ($849 sale, $999 list)",
  life_hours: "Snapmaker's own cost guide: a common estimate for a well-maintained printer is around 5,000 h",
  maint_per_hour: "ESTIMATE: one $49 hot end per ~1,000 h, a $33.99 plate per ~1,000 h, belts/fans allowance (docs/costing.md)",
  avg_watts: "ESTIMATE for PLA at 120 V: no measured U1 figure published; a comparable CoreXY meters 103-135 W plus the U1's 10-30 W parked heads (docs/costing.md)"
});

const MOON_TIMEOUT_MS = 3500;
const META_MAX = 500;                   // printer-metadata cache entries
const HIST_TTL_MS = 60 * 1000;          // a printer's job history is re-read at most this often during a backfill
const HISTORY_MATCH_S = 30 * 60;        // a history job whose end is within this of the row's `at` is that print
const DUP_SLACK_MS = 10 * 60 * 1000;    // two print.done for one job: their computed starts agree within this
const HOURS_TTL_MS = 10 * 60 * 1000;    // Moonraker totals (life-hours progress) are re-read at most this often
const BACKFILL_PAUSE_MS = Math.max(0, Number(process.env.U1HUB_COSTING_BACKFILL_PAUSE_MS ?? 1000));
const BACKFILL_BOOT_MS = Math.max(0, Number(process.env.U1HUB_COSTING_BACKFILL_BOOT_MS ?? 15000));
// The job-history import (every printer's own Moonraker history -> ledger
// rows). Paged IMPORT_PAGE jobs at a time through the same paced GET as the
// backfill, at boot (after the backfill) and every IMPORT_MS; a job that
// ended inside IMPORT_SETTLE_MS is left for the next run so the Hub's own
// print.done, which is a few seconds behind the printer, writes that row.
const IMPORT_PAGE = Math.min(1000, Math.max(1, Number(process.env.U1HUB_COSTING_IMPORT_PAGE) || 100));
const IMPORT_MAX_PAGES = 100;                           // per printer per run: 10,000 jobs at the default page
const IMPORT_SETTLE_MS = Math.max(0, Number(process.env.U1HUB_COSTING_IMPORT_SETTLE_MS ?? 2 * 60 * 1000));
const IMPORT_MS = Math.max(0, Number(process.env.U1HUB_COSTING_IMPORT_MS ?? 3600000));
const IMPORT_BOOT_MS = Math.max(0, Number(process.env.U1HUB_COSTING_IMPORT_BOOT_MS ?? 15000));
const HUB_END_SLACK_MS = 10 * 60 * 1000;                // a Hub-watched row and a history job are the same print when their ends agree within this
const HUB_START_SLACK_MS = 5 * 60 * 1000;               // ...or their starts (end - print_duration) do
// Moonraker job status -> ledger outcome. in_progress is skipped (the Hub's
// own events will write it when it ends); anything unknown is a failed print.
const STATUS_OUTCOME = Object.freeze({ completed: "done", cancelled: "cancelled", error: "error", klippy_shutdown: "error", klippy_disconnect: "error", interrupted: "error", server_exit: "error" });
// Rinkhals (the Kobra S1 jailbreak) records finished prints as "cancelled":
// measured 2026-10-04 on kobrakai, 0 "completed" in 127 jobs, and 37 of its
// "cancelled" jobs had used 100% of the file's filament at 1.0x the slicer
// time. A "cancelled" job that consumed at least this share of the file's own
// filament total finished; the row keeps history_status so the printer's word
// is still visible.
const CANCELLED_BUT_DONE_SHARE = 0.99;
function outcomeOf(status, job) {
  if (status === "in_progress") return null;
  const o = STATUS_OUTCOME[status] || "error";
  if (o !== "cancelled") return o;
  const tot = Number(((job && job.metadata) || {}).filament_total), used = Number(job && job.filament_used);
  return (tot > 0 && used / tot >= CANCELLED_BUT_DONE_SHARE) ? "done" : "cancelled";
}
const MATCH_MAX_IDS = 10000;

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const num = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n || 200);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- pure: filament length -> grams ----------------------------------------------
// "PLA;PLA;PETG;PLA" (Moonraker's filament_type, one entry per tool) -> "PLA":
// the first non-empty entry, the tool the slicer lists first. Null when blank.
function materialOf(types) {
  const parts = String(types == null ? "" : types).split(/[;,]/).map(s => s.trim().toUpperCase()).filter(Boolean);
  return parts.length ? parts[0].slice(0, 20) : null;
}
// -> { density, material, assumed }. "PLA+", "PETG-CF" match their family.
function densityOf(material) {
  const m = String(material || "").toUpperCase();
  for (const k of Object.keys(DENSITY)) if (m.startsWith(k)) return { density: DENSITY[k], material: k, assumed: false };
  return { density: DENSITY.PLA, material: "PLA", assumed: true };
}
// mm of 1.75 mm filament -> grams: pi r^2 (cm^2) x length (cm) x density.
function mmToGrams(mm, material) {
  const len = num(mm);
  if (len == null || len <= 0) return null;
  const d = densityOf(material);
  const cm3 = Math.PI * Math.pow(FILAMENT_DIAMETER_MM / 20, 2) * (len / 10);
  return { grams: r2(cm3 * d.density), density: d.density, material: d.material, assumed: d.assumed };
}

// ---- pure: one print --------------------------------------------------------------
// print: a ledger row. rates: conf() below (or any object of the same shape;
// rates.suggested, when present, fills a printer rate or the $/kWh the person
// has not typed, for rows of the printer type it applies to).
// -> { material:{grams,grams_source,cost,source,partial}, hours, time_source,
//      machine:{per_hour,cost,source,basis}, energy:{kwh,cost,source}, direct, blanks[] }
// material.source is where the PRICE came from (deduction | flat | slicer),
// material.grams_source where the GRAMS came from (deduction | slicer |
// printer-meta | history). machine.basis says which halves exist
// (depreciation, maintenance, both); machine.source and energy.source say
// "suggested" when any input was a suggestion rather than a typed rate.
// Every cost is null when its inputs are missing; `direct` sums what is there
// and `blanks` names what is not, so a caller never mistakes "unknown" for 0.
function costOf(print, rates) {
  const p = print || {}, R = rates || {};
  const typed = ((R.printers || {})[String(p.printer_id)]) || {};
  const S = (R.suggested && typeof R.suggested === "object") ? R.suggested : null;
  // The printer block for this row's type: by_type first, else the default
  // block when the type is the one it applies to (or the row has no type).
  const SP = !S ? null : ((S.by_type && p.type != null && S.by_type[p.type]) || ((p.type == null || !S.applies_to || p.type === S.applies_to) ? (S.printers || null) : null));
  // A typed rate wins; a suggestion fills only an unset one, and says so.
  const pick = (key, perPrinter) => {
    const t = num(perPrinter ? typed[key] : R[key]);
    if (t != null) return { v: t, src: "typed" };
    const s = perPrinter ? (SP ? num(SP[key]) : null) : (S ? num(S[key]) : null);
    return s != null ? { v: s, src: "suggested" } : { v: null, src: null };
  };
  const m = p.material || {};
  const grams = num(m.grams);
  const material = { grams, grams_source: grams != null ? (m.grams_source || m.source || null) : null, cost: null, source: null, partial: !!m.partial };
  // A deduction that took nothing off any roll and priced nothing (no spool
  // recorded in any head) carries no price; the row is priced like one with no
  // deduction at all rather than left blank.
  // A roll that WAS deducted but has no price stays blank (never the flat rate
  // in disguise); only an explicit 0 g deducted counts as empty.
  const emptyDeduction = m.source === "deduction" && num(m.cost) == null && num(m.deducted_g) === 0;
  if ((m.source === "deduction" && !emptyDeduction) || m.source === "rolls") {
    material.source = m.source;
    material.cost = num(m.cost) != null ? r2(m.cost) : null;
    material.partial = !!m.partial || material.cost == null;
  } else if (grams != null) {
    if (num(R.cost_per_g) != null) { material.cost = r2(grams * R.cost_per_g); material.source = "flat"; }
    else if (num(m.slicer_cost) != null) { material.cost = r2(m.slicer_cost); material.source = "slicer"; }
  }
  if (m.density_assumed) material.density_assumed = true;
  let hours = null, time_source = null;
  if (num(p.seconds) > 0) { hours = p.seconds / 3600; time_source = p.seconds_source || "actual"; }
  else if (num(p.est_minutes) > 0) { hours = p.est_minutes / 60; time_source = p.est_source || "slicer"; }
  let machine = null;
  const purchase = pick("purchase", true), life = pick("life_hours", true), maint = pick("maint_per_hour", true);
  const dep = purchase.v != null && life.v > 0 ? purchase.v / life.v : null;
  if (hours != null && (dep != null || maint.v != null)) {
    const per_hour = (dep || 0) + (maint.v || 0);
    const used = [dep != null && purchase.src, dep != null && life.src, maint.v != null && maint.src].filter(Boolean);
    const basis = dep != null && maint.v != null ? "depreciation+maintenance" : (dep != null ? "depreciation" : "maintenance");
    const source = used.includes("suggested") ? (used.includes("typed") ? "typed+suggested" : "suggested") : "typed";
    machine = { per_hour: r3(per_hour), cost: r2(hours * per_hour), source, basis };
  }
  let energy = null;
  const e = p.energy || {};
  const rate = pick("kwh_rate", false), watts = pick("avg_watts", true);
  const rateCost = kwh => rate.v != null ? r2(kwh * rate.v) : null;
  if (num(e.kwh) != null) energy = { kwh: r3(e.kwh), cost: rateCost(e.kwh), source: rate.src === "suggested" && rate.v != null ? "suggested" : (e.source || "metered"), kwh_source: e.source || "metered", rate_source: rate.src };
  else if (hours != null && watts.v > 0) {
    const kwh = hours * watts.v / 1000;
    const sug = watts.src === "suggested" || (rate.v != null && rate.src === "suggested");
    energy = { kwh: r3(kwh), cost: rateCost(kwh), source: sug ? "suggested" : "watts", watts: watts.v, watts_source: watts.src, rate_source: rate.src };
  }
  const blanks = [];
  // its "partial" came from the head misses, which no longer describe the price
  if (emptyDeduction) { material.deduction_empty = true; material.partial = p.outcome != null ? p.outcome !== "done" : material.partial; }
  if (material.cost == null) blanks.push(material.source === "deduction" || material.source === "rolls" ? "material (a loaded roll has no price)" : (grams == null ? "material (no grams)" : "material (no rate)"));
  if (!machine) blanks.push(hours == null ? "machine (no time)" : "machine (no printer rates)");
  if (!energy) blanks.push(hours == null ? "energy (no time)" : "energy (no watts)");
  else if (energy.cost == null) blanks.push("energy (no $/kWh)");
  const parts = [material.cost, machine && machine.cost, energy && energy.cost].filter(v => v != null);
  const direct = parts.length ? r2(parts.reduce((a, b) => a + b, 0)) : null;
  return { material, hours: hours != null ? r3(hours) : null, time_source, machine, energy, direct, blanks };
}

// ---- pure: one project ----------------------------------------------------------
// project: { items:[...], charged, ... }; prints: its ledger rows; rates: conf().
function projectSummary(project, prints, rates) {
  const R = rates || {};
  const rows = (prints || []).map(p => ({ print: p, cost: costOf(p, R), counted: p.counted !== false }));
  const counted = rows.filter(r => r.counted);
  const sum = (arr, f) => { let s = 0, n = 0; for (const x of arr) { const v = f(x); if (v != null) { s += v; n++; } } return { total: n ? r2(s) : null, n }; };
  const material = sum(counted, r => r.cost.material.cost);
  const machine = sum(counted, r => r.cost.machine && r.cost.machine.cost);
  const energy = sum(counted, r => r.cost.energy && r.cost.energy.cost);
  const hours = sum(counted, r => r.cost.hours);
  const grams = sum(counted, r => r.cost.material.grams);
  const direct = sum(counted, r => r.cost.direct);
  const pieces = counted.filter(r => r.print.outcome === "done").reduce((a, r) => a + (num(r.print.pieces) > 0 ? r.print.pieces : 1), 0);
  const tally = (f) => { const t = {}; for (const r of counted) { const k = f(r) || "blank"; t[k] = (t[k] || 0) + 1; } return t; };
  const sources = {
    material: tally(r => r.cost.material.cost == null ? "blank" : r.cost.material.source),
    material_partial: counted.filter(r => r.cost.material.partial).length,
    grams: tally(r => r.cost.material.grams == null ? "blank" : r.cost.material.grams_source),
    time: tally(r => r.cost.time_source),
    machine: tally(r => r.cost.machine ? r.cost.machine.source : "blank"),
    energy: tally(r => r.cost.energy && r.cost.energy.cost != null ? r.cost.energy.source : "blank")
  };
  const items = Array.isArray(project && project.items) ? project.items : [];
  const laborMinutes = items.filter(i => i.kind === "labor").reduce((a, i) => a + (num(i.minutes) || 0), 0)
    + (num(R.setup_minutes) > 0 ? counted.length * R.setup_minutes : 0);
  const labor = { minutes: r2(laborMinutes), cost: laborMinutes ? (num(R.labor_rate) != null ? r2(laborMinutes / 60 * R.labor_rate) : null) : 0,
                  setup_minutes: num(R.setup_minutes) > 0 ? R.setup_minutes : null };
  const extras = r2(items.filter(i => i.kind !== "labor").reduce((a, i) => a + (num(i.cost) || 0), 0));
  const failed = rows.filter(r => r.print.outcome !== "done").length;
  const subtotal = r2((direct.total || 0) + (labor.cost || 0) + extras);
  // The allowance is for quoting: once a project carries real failed rows the
  // failures are in `direct` already and adding a percentage on top would count
  // them twice.
  const failure = num(R.failure_pct) > 0 && failed === 0 && direct.total != null ? r2(direct.total * R.failure_pct / 100) : 0;
  const overhead = num(R.overhead_pct) > 0 ? r2(subtotal * R.overhead_pct / 100) : 0;
  const anything = direct.total != null || labor.cost || extras;
  const cost = anything ? r2(subtotal + failure + overhead) : null;
  const blanks = [];
  if (sources.material.blank) blanks.push(sources.material.blank + " print" + (sources.material.blank === 1 ? "" : "s") + " with no material cost");
  if (sources.machine.blank) blanks.push(sources.machine.blank + " with no machine cost");
  if (sources.energy.blank) blanks.push(sources.energy.blank + " with no energy cost");
  if (laborMinutes && labor.cost == null) blanks.push("labour minutes with no labour rate");
  const charged = num(project && project.charged);
  const margin = charged != null && cost != null ? r2(charged - cost) : null;
  return {
    prints: rows.length, counted: counted.length, uncounted: rows.length - counted.length, failed, pieces,
    hours: hours.total, grams: grams.total,
    material: material.total, machine: machine.total, energy: energy.total, direct: direct.total,
    labor, extras, subtotal, failure, overhead, cost,
    charged, margin, margin_pct: margin != null && charged > 0 ? Math.round(margin / charged * 100) : null,
    sources, blanks, partial: blanks.length > 0 || sources.material_partial > 0,
    rows: rows.map(r => ({ id: r.print.id, counted: r.counted, ...r.cost }))
  };
}

// ---- pure: the pricing helper ----------------------------------------------------
// Several answers, none chosen. gross = what to list so that the net after a
// platform's percentage and fixed fee is the price you picked.
function grossUp(price, rates) {
  if (price == null) return null;
  const pct = num(rates && rates.platform_fee_pct) || 0, fixed = num(rates && rates.platform_fee_fixed) || 0;
  if (pct >= 100) return null;
  return (price + fixed) / (1 - pct / 100);
}
function netOf(gross, rates) {
  if (gross == null) return null;
  const pct = num(rates && rates.platform_fee_pct) || 0, fixed = num(rates && rates.platform_fee_fixed) || 0;
  return gross * (1 - pct / 100) - fixed;
}
// s: projectSummary(); floor: the per-gram floor for the project's grams
// (margin.quote's min_plate) or null.
function pricing(s, rates, floor) {
  const R = rates || {};
  if (!s || s.cost == null) return null;
  const cost = s.cost, pieces = s.pieces > 0 ? s.pieces : 1;
  const minFee = v => v == null ? null : (num(R.min_fee) != null ? Math.max(v, R.min_fee) : v);
  const methods = [];
  const add = (key, label, raw, note) => {
    const price = raw == null ? null : minFee(raw);
    methods.push({ key, label, note, price: price == null ? null : r2(price), raw: raw == null ? null : r2(raw),
                   per_piece: price == null ? null : r2(price / pieces), gross: price == null ? null : r2(grossUp(price, R)) });
  };
  add("markup", "Cost + markup", num(R.markup_pct) != null ? cost * (1 + R.markup_pct / 100) : null,
      num(R.markup_pct) != null ? R.markup_pct + "% on cost" : "set a markup % in Settings");
  add("margin", "Target margin", num(R.margin_pct) != null ? cost / (1 - R.margin_pct / 100) : null,
      num(R.margin_pct) != null ? "cost / (1 - " + R.margin_pct + "%)" : "set a target margin % in Settings");
  add("machine_hour", "Machine-hour rate", num(R.hour_rate) != null && s.hours != null ? s.hours * R.hour_rate + (s.material || 0) + (s.labor.cost || 0) + s.extras : null,
      num(R.hour_rate) != null ? (s.hours != null ? s.hours + " h at $" + R.hour_rate + "/h + material + labour + extras" : "no print time on this project") : "set an hourly machine rate in Settings");
  add("per_gram", "Per-gram floor", floor != null ? floor : null,
      floor != null ? "grams x sell floor (Worth printing? settings)" : "no grams, or the margin module is off");
  const variable = s.direct != null && pieces ? s.direct / pieces : null;
  const fixed = (s.labor.cost || 0) + s.extras;
  const breaks = BREAKS.map(n => {
    if (variable == null || num(R.markup_pct) == null) return { qty: n, cost_each: null, each: null };
    const c = (variable * n + fixed) * (1 + (num(R.overhead_pct) || 0) / 100);
    return { qty: n, cost_each: r2(c / n), each: r2(minFee(c * (1 + R.markup_pct / 100)) / n) };
  });
  return { cost, pieces, methods, breaks, min_fee: num(R.min_fee), platform: { pct: num(R.platform_fee_pct), fixed: num(R.platform_fee_fixed) } };
}

// ---- pure: CSV ---------------------------------------------------------------------
const CSV_COLS = [
  ["kind", r => r.kind], ["id", r => r.id], ["at", r => r.at ? new Date(r.at).toISOString() : ""], ["printer", r => r.printer], ["file", r => r.file],
  ["outcome", r => r.outcome], ["counted", r => r.kind === "print" ? (r.counted === false ? "no" : "yes") : ""], ["pieces", r => r.pieces],
  ["seconds", r => r.seconds], ["hours", r => r.hours], ["time_source", r => r.time_source],
  ["grams", r => r.grams], ["material_cost", r => r.material_cost], ["material_source", r => r.material_source], ["material_partial", r => r.material_partial == null ? "" : (r.material_partial ? "yes" : "no")],
  ["machine_cost", r => r.machine_cost], ["energy_kwh", r => r.energy_kwh], ["energy_cost", r => r.energy_cost], ["direct", r => r.direct],
  ["label", r => r.label], ["minutes", r => r.minutes], ["item_cost", r => r.item_cost]
];
function projectCsv(project, prints, rates) {
  const rows = [];
  for (const p of prints || []) {
    const c = costOf(p, rates);
    rows.push({ kind: "print", id: p.id, at: p.at, printer: p.printer, file: p.file, outcome: p.outcome, counted: p.counted, pieces: p.pieces,
      seconds: p.seconds, hours: c.hours, time_source: c.time_source, grams: c.material.grams, material_cost: c.material.cost, material_source: c.material.source,
      material_partial: c.material.partial, machine_cost: c.machine ? c.machine.cost : null, energy_kwh: c.energy ? c.energy.kwh : null,
      energy_cost: c.energy ? c.energy.cost : null, direct: c.direct });
  }
  for (const i of (project && project.items) || [])
    rows.push({ kind: i.kind, id: i.id, at: i.created, label: i.label, minutes: i.kind === "labor" ? i.minutes : null, item_cost: i.kind === "labor" ? null : i.cost });
  const lines = [CSV_COLS.map(c => c[0]).join(",")];
  for (const r of rows) lines.push(CSV_COLS.map(c => csvCell(c[1](r))).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ---- pure: the printable quote --------------------------------------------------
// Plain server-rendered HTML, every string escaped, no scripts. The browser's
// own print dialog makes the PDF.
function quoteHtml(o) {
  const { project, client, summary: s, pricing: pz, prints, rates } = o;
  const usd = v => v == null ? "—" : "$" + Number(v).toFixed(2);
  const hrs = h => h == null ? "—" : (h < 1 ? Math.round(h * 60) + " min" : (Math.round(h * 10) / 10) + " h");
  const SRC = { deduction: "actual (loaded rolls)", flat: "flat $/g", slicer: "slicer estimate", actual: "actual", history: "printer history", "hub-clock": "Hub clock", "printer-meta": "printer metadata",
                watts: "typed watts", metered: "metered", typed: "typed rates", suggested: "suggested rates", "typed+suggested": "typed + suggested rates" };
  const srcLine = t => Object.entries(t || {}).map(([k, n]) => n + " " + (SRC[k] || k)).join(", ");
  const rows = (prints || []).map(p => {
    const c = costOf(p, rates);
    return "<tr" + (p.counted === false ? ' class="off"' : "") + "><td>" + esc(String(p.file).replace(/\.gcode$/i, "")) + (p.counted === false ? " <em>(not charged)</em>" : "") + "</td><td>" + esc(p.printer) + "</td><td>" + esc(p.outcome) +
      "</td><td class=n>" + (p.pieces || 1) + "</td><td class=n>" + hrs(c.hours) + "</td><td class=n>" + (c.material.grams != null ? c.material.grams + " g" : "—") +
      "</td><td class=n>" + usd(c.material.cost) + "</td><td class=n>" + usd(c.machine && c.machine.cost) + "</td><td class=n>" + usd(c.energy && c.energy.cost) + "</td><td class=n><b>" + usd(c.direct) + "</b></td></tr>";
  }).join("");
  const items = ((project && project.items) || []).map(i => "<tr><td>" + esc(i.kind) + "</td><td>" + esc(i.label) + "</td><td class=n>" +
    (i.kind === "labor" ? (i.minutes + " min" + (num(rates.labor_rate) != null ? " · " + usd(i.minutes / 60 * rates.labor_rate) : " · no labour rate")) : usd(i.cost)) + "</td></tr>").join("");
  const line = (k, v, note) => "<tr><td>" + esc(k) + "</td><td class=n>" + v + "</td><td class=note>" + esc(note || "") + "</td></tr>";
  const methods = pz ? pz.methods.filter(m => m.price != null).map(m => "<tr><td>" + esc(m.label) + "</td><td class=n>" + usd(m.price) + "</td><td class=n>" + usd(m.per_piece) + "</td><td class=n>" + usd(m.gross) + "</td><td class=note>" + esc(m.note) + "</td></tr>").join("") : "";
  const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return "<!doctype html><html><head><meta charset=utf-8><title>Quote — " + esc(project.name) + "</title><style>" +
    "body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:32px auto;max-width:860px;padding:0 16px}h1{font-size:22px;margin:0 0 2px}h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#666;margin:26px 0 6px}" +
    "table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td.note{color:#777;font-size:12px}tr.off td{color:#999}tr.total td{font-weight:700;border-top:2px solid #333}" +
    ".meta{color:#666;font-size:13px}.blank{color:#a15c00;font-size:12px;margin-top:6px}@media print{body{margin:0}a{display:none}}</style></head><body>" +
    "<h1>" + esc(project.name) + "</h1><div class=meta>" + (client ? esc(client.name) + (client.email ? " · " + esc(client.email) : "") + " · " : "") + esc(when) + " · " + esc(project.state) + "</div>" +
    (project.notes ? "<p>" + esc(project.notes) + "</p>" : "") +
    "<h2>Prints</h2><table><tr><th>File</th><th>Printer</th><th>Outcome</th><th class=n>Pieces</th><th class=n>Time</th><th class=n>Filament</th><th class=n>Material</th><th class=n>Machine</th><th class=n>Energy</th><th class=n>Direct</th></tr>" +
    (rows || "<tr><td colspan=10>No prints on this project yet.</td></tr>") + "</table>" +
    (items ? "<h2>Line items</h2><table><tr><th>Kind</th><th>Item</th><th class=n>Amount</th></tr>" + items + "</table>" : "") +
    "<h2>Cost</h2><table>" +
    line("Material", usd(s.material), srcLine(s.sources.material) + (s.sources.material_partial ? " · " + s.sources.material_partial + " partial" : "") + (s.sources.grams ? " · grams: " + srcLine(s.sources.grams) : "")) +
    line("Machine time", usd(s.machine), srcLine(s.sources.machine)) + line("Energy", usd(s.energy), srcLine(s.sources.energy)) +
    line("Labour", usd(s.labor.cost), s.labor.minutes + " min" + (s.labor.setup_minutes ? " incl. " + s.labor.setup_minutes + " min setup per print" : "")) + line("Extras", usd(s.extras), "hardware, packaging, shipping") +
    (s.failure ? line("Failure allowance", usd(s.failure), rates.failure_pct + "% of print cost (no failed prints recorded)") : "") +
    (s.overhead ? line("Overhead", usd(s.overhead), rates.overhead_pct + "% of subtotal") : "") +
    '<tr class=total><td>Cost</td><td class=n>' + usd(s.cost) + "</td><td class=note>" + esc(s.counted + " of " + s.prints + " prints counted" + (s.failed ? ", " + s.failed + " failed" : "")) + "</td></tr>" +
    (s.charged != null ? line("Charged", usd(s.charged), s.margin != null ? "margin " + usd(s.margin) + (s.margin_pct != null ? " (" + s.margin_pct + "%)" : "") : "") : "") + "</table>" +
    (s.blanks.length ? '<div class=blank>Not included: ' + esc(s.blanks.join("; ")) + ".</div>" : "") +
    (methods ? "<h2>Pricing</h2><table><tr><th>Method</th><th class=n>Price</th><th class=n>Per piece</th><th class=n>Listed (fees grossed up)</th><th></th></tr>" + methods + "</table>" : "") +
    "</body></html>";
}

// ---- module ----------------------------------------------------------------------------
function register(ctx) {
  const PFILE = path.join(ctx.baseDir, "projects.json");
  const LFILE = path.join(ctx.baseDir, "prints.json");
  let P = { clients: {}, projects: {}, pending: {} };
  let L = { prints: [] };
  try { const j = JSON.parse(fs.readFileSync(PFILE, "utf8")); if (j && typeof j === "object") P = { clients: j.clients || {}, projects: j.projects || {}, pending: j.pending || {} }; } catch {}
  try { const j = JSON.parse(fs.readFileSync(LFILE, "utf8")); if (j && Array.isArray(j.prints)) L = { prints: j.prints }; } catch {}

  // Same shape as modules/dispatch.js save(): tmp+rename where the filesystem
  // allows it, a direct write where it refuses rename-over-existing (a share),
  // latched so the warning prints once. Called from handlers and event
  // listeners only, never from a timer.
  let SAVE_FALLBACK = false;
  function writeState(file, obj) {
    const data = JSON.stringify(obj, null, 1), tmp = file + ".tmp";
    if (!SAVE_FALLBACK) {
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); return; }
      catch (e) { SAVE_FALLBACK = true; ctx.hublog("warn", "costing: atomic save failed (" + e.code + " " + e.message + ") - direct writes for the rest of this run"); }
    }
    try { fs.writeFileSync(file, data); } catch (e) { ctx.hublog("warn", "costing: save failed - " + e.message); }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  const saveP = () => writeState(PFILE, P);
  const saveL = () => writeState(LFILE, L);
  const newId = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const printers = () => ctx.printers || [];

  // ---- rates ------------------------------------------------------------------------
  const flat = () => { const q = ctx.use("margin.quote"); if (!q) return { cost_per_g: null, sell_per_g: null }; const r = q({ grams: 1, minutes: null, name: "" }) || {}; return { cost_per_g: num(r.cost_per_g), sell_per_g: num(r.sell_per_g) }; };
  function conf() {
    const c = (ctx.cfg && typeof ctx.cfg.costing === "object" && ctx.cfg.costing) || {};
    const out = {};
    for (const k of Object.keys(RATE_KEYS)) out[k] = num(c[k]);
    out.printers = {};
    for (const [i, p] of Object.entries((c.printers && typeof c.printers === "object") ? c.printers : {})) {
      out.printers[i] = {};
      for (const k of Object.keys(PRINTER_KEYS)) out.printers[i][k] = num(p && p[k]);
    }
    return { ...out, ...flat(), suggested: SUGGESTED };
  }
  const ratesView = () => ({ ...conf(), suggested: { ...SUGGESTED, notes: SUGGESTED_NOTES, type_notes: SUGGESTED_TYPE_NOTES },
    printer_names: printers().map((p, i) => ({ idx: i, name: p.name || ("printer " + (i + 1)), type: p.type || "u1", hours: HOURS[String(i)] ? HOURS[String(i)].hours : null, hours_at: HOURS[String(i)] ? HOURS[String(i)].at : null })),
    keys: Object.keys(RATE_KEYS), printer_keys: Object.keys(PRINTER_KEYS) });

  // ---- Moonraker, read-only: tiny JSON GETs, bounded, never a gcode body ------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const baseOf = idx => { const p = printers()[idx]; const b = p && String(p.url || "").replace(/\/+$/, ""); return b || null; };
  let GETS = 0;                                   // every Moonraker GET this module made (the harness reads it)
  async function moonGet(base, pathq) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), MOON_TIMEOUT_MS);
    try {
      GETS++;
      const r = await fetch(base + pathq, { signal: ac.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()) || {}).result || null;
    } finally { clearTimeout(t); }
  }
  // Backfill pacing: one request at a time, BACKFILL_PAUSE_MS apart.
  let LAST_PACED = 0, MIN_GAP = null;      // MIN_GAP: smallest gap between two paced GETs in the current backfill
  async function pacedGet(base, pathq) {
    const wait = LAST_PACED + BACKFILL_PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    if (LAST_PACED) MIN_GAP = MIN_GAP == null ? now - LAST_PACED : Math.min(MIN_GAP, now - LAST_PACED);
    LAST_PACED = now;
    return moonGet(base, pathq);
  }
  // Life-hours progress per printer from /server/history/totals, the same read
  // modules/logbook.js makes, cached ten minutes. Awaited by GET /api/costing.
  const HOURS = {};
  let HOURS_AT = 0, HOURS_BUSY = null;
  function refreshHours(force) {
    if (!force && HOURS_AT && Date.now() - HOURS_AT < HOURS_TTL_MS) return Promise.resolve();
    if (HOURS_BUSY) return HOURS_BUSY;
    HOURS_BUSY = Promise.all(printers().map(async (p, i) => {
      const base = baseOf(i); if (!base) return;
      try {
        const tot = ((await moonGet(base, "/server/history/totals")) || {}).job_totals || {};
        if (Number.isFinite(tot.total_print_time)) HOURS[String(i)] = { hours: Math.round(tot.total_print_time / 36) / 100, at: Date.now() };
      } catch {}
    })).then(() => { HOURS_AT = Date.now(); }).finally(() => { HOURS_BUSY = null; });
    return HOURS_BUSY;
  }
  // The printer's own metadata for a file (grams, estimate, per-tool types),
  // cached per printer+file. A 404 (file gone, or never scanned) is cached as
  // "none" so a boot backfill does not ask again; POST /api/costing/backfill
  // clears those. A network failure is not cached at all.
  const META = new Map();
  function shapeMeta(m) {
    if (!m || typeof m !== "object") return null;
    const material = materialOf(m.filament_type);
    let grams = num(m.filament_weight_total) > 0 ? r2(m.filament_weight_total) : null, conv = null;
    if (grams == null && num(m.filament_total) > 0) { conv = mmToGrams(m.filament_total, material); grams = conv ? conv.grams : null; }
    const est_minutes = num(m.estimated_time) > 0 ? Math.round(m.estimated_time / 60) : null;
    if (grams == null && est_minutes == null) return null;
    return { found: true, at: Date.now(), grams, grams_via: conv ? "mm" : "weight", density: conv ? conv.density : null, density_assumed: conv ? conv.assumed : false, est_minutes, material, slicer: m.slicer ? String(m.slicer).slice(0, 60) : null };
  }
  async function metaFor(idx, name, paced) {
    const base = baseOf(idx); if (!base) return null;
    const key = idx + ":" + name, hit = META.get(key);
    if (hit) return hit.found ? hit : null;
    const m = await (paced ? pacedGet : moonGet)(base, "/server/files/metadata?filename=" + encodeURIComponent(name));
    const rec = shapeMeta(m) || { found: false, at: Date.now() };
    META.set(key, rec);
    if (META.size > META_MAX) META.delete(META.keys().next().value);
    return rec.found ? rec : null;
  }
  // The printer's job history (newest first), cached a minute per printer.
  const HIST = new Map();
  async function historyFor(idx, paced) {
    const base = baseOf(idx); if (!base) return null;
    const hit = HIST.get(idx);
    if (hit && Date.now() - hit.at < HIST_TTL_MS) return hit.jobs;
    const r = await (paced ? pacedGet : moonGet)(base, "/server/history/list?limit=200&order=desc");
    const jobs = r && Array.isArray(r.jobs) ? r.jobs : [];
    HIST.set(idx, { at: Date.now(), jobs });
    return jobs;
  }
  // The history job that IS this row: same file, ended within HISTORY_MATCH_S
  // of the row's timestamp; the closest wins.
  function matchJob(jobs, row) {
    const end = row.at / 1000;
    let best = null, gap = Infinity;
    for (const j of jobs || []) {
      if (!j || path.basename(String(j.filename || "")) !== row.file) continue;
      const je = num(j.end_time) != null ? j.end_time : (num(j.start_time) != null && num(j.total_duration) != null ? j.start_time + j.total_duration : null);
      if (je == null) continue;
      const g = Math.abs(je - end);
      if (g < HISTORY_MATCH_S && g < gap) { best = j; gap = g; }
    }
    return best;
  }
  // Fill what the row lacks from printer metadata; true when anything changed.
  function applyMeta(row, meta) {
    if (!meta) return false;
    let changed = false;
    row.material = row.material || { grams: null, cost: null, source: null, partial: row.outcome !== "done", heads: [] };
    if (row.material.grams == null && meta.grams != null) {
      const prog = num(row.material.progress);
      Object.assign(row.material, { grams: r2(meta.grams * (prog != null ? prog : 1)), source: (row.material.source === "deduction" || row.material.source === "rolls") ? row.material.source : "printer-meta", grams_source: "printer-meta",
        material: meta.material || null, density: meta.density, density_assumed: !!meta.density_assumed });
      changed = true;
    }
    // The estimate is kept beside an actual duration, as it is for library files.
    if (!(num(row.est_minutes) > 0) && meta.est_minutes != null) { row.est_minutes = meta.est_minutes; row.est_source = "printer-meta"; changed = true; }
    if (!row.material.material && meta.material) row.material.material = meta.material;
    return changed;
  }
  // Fill what the row still lacks from its history job; true when anything changed.
  function applyJob(row, job) {
    if (!job) return false;
    let changed = false;
    const meta = shapeMeta(job.metadata);
    if (meta && applyMeta(row, meta)) changed = true;
    row.material = row.material || { grams: null, cost: null, source: null, partial: row.outcome !== "done", heads: [] };
    if (row.material.grams == null && num(job.filament_used) > 0) {
      const mat = row.material.material || (meta && meta.material) || materialOf(job.metadata && job.metadata.filament_type) || null;
      const conv = mmToGrams(job.filament_used, mat);
      if (conv) {
        Object.assign(row.material, { grams: conv.grams, source: (row.material.source === "deduction" || row.material.source === "rolls") ? row.material.source : "history", grams_source: "history",
          material: conv.material, density: conv.density, density_assumed: conv.assumed, filament_mm: r2(job.filament_used) });
        changed = true;
      }
    }
    if (!(num(row.seconds) > 0) && num(job.print_duration) > 0) { row.seconds = Math.round(job.print_duration); row.seconds_source = "history"; changed = true; }
    if (job.job_id && !row.history_job) { row.history_job = String(job.job_id); changed = true; }
    return changed;
  }

  // ---- file facts (slicer grams, time, cost), head+tail read, cached ---------------
  const FACTS = new Map();
  async function fileFacts(name, slug) {
    const fp = path.join(ctx.gcodeFolderFor(slug), name);
    let st;
    try { st = await fsp.stat(fp); } catch { return null; }
    const key = slug + ":" + name, hit = FACTS.get(key);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit;
    let text;
    if (st.size <= HEAD_BYTES + TAIL_BYTES) text = await fsp.readFile(fp, "utf8");
    else {
      const fh = await fsp.open(fp, "r");
      try {
        const h = Buffer.alloc(HEAD_BYTES); await fh.read(h, 0, HEAD_BYTES, 0);
        const t = Buffer.alloc(TAIL_BYTES); await fh.read(t, 0, TAIL_BYTES, st.size - TAIL_BYTES);
        text = h.toString("utf8") + "\n" + t.toString("utf8");
      } finally { await fh.close(); }
    }
    const r = parseGcodeMap(text, { scanBody: false }) || {};
    const a = r.amounts || {};
    const grams = num(a.total_g) != null ? a.total_g : (a.have_grams ? a.slot_sum_g : null);
    let slicer_cost = num(a.total_cost);
    if (slicer_cost == null && Array.isArray(a.slots) && a.slots.some(s => num(s.slicer_cost) != null)) slicer_cost = r2(a.slots.reduce((x, s) => x + (num(s.slicer_cost) || 0), 0));
    const rec = { size: st.size, mtime: st.mtimeMs, grams: grams != null ? r2(grams) : null, slicer_cost, est_minutes: r.estTime ? estMinutes(r.estTime) : null };
    FACTS.set(key, rec);
    if (FACTS.size > FACTS_MAX) FACTS.delete(FACTS.keys().next().value);
    return rec;
  }

  // ---- the ledger ----------------------------------------------------------------------
  const START = new Map();       // printer idx -> { file, at }
  const STASH = new Map();       // "idx:file" -> deduction rec that arrived before its row
  const pendKey = (slug, name) => String(slug || "u1") + ":" + String(name || "");
  // A multiACE print's colours are not its heads: the head-by-head deduction
  // (resources.js, T1-T4 against whatever spool each head records) names the
  // wrong rolls for a >4-colour job, so it is kept on the row for the record
  // and never prices it. priceColours below does that instead.
  function applyDeduction(row, rec) {
    if (row.multiace) {
      row.material = { ...(row.material || {}), deduction_ignored: { grams: num(rec.grams), cost: num(rec.cost), misses: rec.misses || [], why: "multiACE: colours are not heads" } };
      row.deduction_at = rec.at;
      return;
    }
    row.material = { ...(row.material || {}), cost: num(rec.cost), source: "deduction",
      partial: !!rec.cost_partial || (rec.misses || []).length > 0 || num(rec.cost) == null || row.outcome !== "done",
      deducted_g: num(rec.grams), heads: (rec.entries || []).map(e => ({ head: e.head, spool_id: e.spool_id, color_name: e.color_name, grams: e.grams, cost: e.cost })),
      misses: rec.misses || [] };
    row.deduction_at = rec.at;
  }
  // Each colour of a multiACE print at the price of the roll the shelf
  // matches for it (resources.priceFor: the rollup's own colour matcher). The
  // row is priced from the rolls only when EVERY colour with grams found a
  // priced roll; otherwise it keeps the flat / slicer price and the per-colour
  // list says which colour had no price. Never a guessed number.
  function priceColours(row) {
    const cols = (row.multiace && row.multiace.colours) || [];
    if (!cols.length) return;
    const price = ctx.use("resources.priceFor");
    const found = typeof price === "function" ? (price(cols.map(c => ({ hex: c.hex, material: c.material }))) || []) : [];
    const heads = cols.map((c, i) => {
      const p = found[i] || null;
      const g = num(c.grams);
      const cost = p && num(p.cost_per_g) != null && g != null ? r2(g * p.cost_per_g) : null;
      return { t: c.t, hex: c.hex, material: c.material, ace: c.ace, slot: c.slot, grams: g, spool_id: p ? p.spool_id : null, spool: p ? p.name : null, cost };
    });
    // A colour whose grams are unknown cannot be priced, so it blocks the
    // rolls price (null is not 0); a colour with 0 g is simply not used.
    const counted = heads.filter(h => h.grams == null || h.grams > 0);
    const priced = counted.filter(h => h.cost != null);
    row.material = { ...row.material, heads };
    if (counted.length && priced.length === counted.length) {
      const share = row.outcome === "done" ? 1 : (num(row.material.progress) != null ? row.material.progress : null);
      const cost = r2(priced.reduce((a, h) => a + h.cost, 0) * (share == null ? 1 : share));
      row.material = { ...row.material, cost, source: "rolls", partial: row.outcome !== "done" };
    }
  }
  function jobOf(idx, name) {
    const get = ctx.use("dispatch.jobs");
    const jobs = typeof get === "function" ? (get() || []) : [];
    return jobs.find(j => j && j.printing_on === idx && path.basename(String(j.file || "")) === name) || null;
  }
  async function record(ev, outcome) {
    const idx = Number(ev.id);
    const p = printers()[idx];
    const name = path.basename(String(ev.filename || ""));
    if (!name || !Number.isInteger(idx)) return null;
    const slug = (p && p.type) || "u1";
    const facts = await fileFacts(name, slug).catch(() => null);
    let seconds = null, seconds_source = null, progress = null;
    if (outcome === "done") { seconds = num(ev.durationSec) > 0 ? Math.round(ev.durationSec) : null; seconds_source = seconds != null ? "actual" : null; }
    else {
      try {
        const me = ((await ctx.fleet()) || []).find(x => x.id === idx);
        if (me && num(me.printDuration) > 0) { seconds = Math.round(me.printDuration); seconds_source = "actual"; }
        if (me && num(me.progress) > 0 && me.progress < 1) progress = r3(me.progress);
      } catch {}
      const s = START.get(idx);
      if (seconds == null && s && s.file === name) { seconds = Math.round((Date.now() - s.at) / 1000); seconds_source = "hub-clock"; }
    }
    const now = Date.now();
    START.delete(idx);
    // The same print reported done twice (the printer's state flapped back to
    // printing and to complete again, print_duration still counting): the two
    // events compute the same START. One row, the longer duration, no second
    // print on the bill.
    if (outcome === "done" && seconds != null) {
      const start = now - seconds * 1000;
      const dup = [...L.prints].reverse().find(r => r.printer_id === idx && r.file === name && r.outcome === "done" && num(r.seconds) > 0 && r.seconds_source !== "history" && Math.abs((r.at - r.seconds * 1000) - start) < DUP_SLACK_MS);
      if (dup) {
        const before = dup.seconds;
        dup.seconds = Math.max(dup.seconds, seconds); dup.at = now; dup.done_twice = (dup.done_twice || 0) + 1;
        saveL();
        ctx.hublog("info", "costing: " + dup.printer + " done " + name + " reported again (" + before + " s -> " + dup.seconds + " s); same print, row updated, nothing added");
        return dup;
      }
    }
    const grams = facts && facts.grams != null ? r2(facts.grams * (progress != null ? progress : 1)) : null;
    const key = pendKey(slug, name);
    const job = jobOf(idx, name);
    const row = { id: newId("pt"), at: now, printer_id: idx, printer: (p && p.name) || ev.printer || ("printer " + (idx + 1)), file: name, type: slug, outcome,
      project_id: P.pending[key] || null, job_id: job ? job.id : null, bundle_id: job && job.bundle_id ? job.bundle_id : null,
      seconds, seconds_source, est_minutes: facts ? facts.est_minutes : null, est_source: facts && facts.est_minutes != null ? "slicer" : null,
      material: { grams, cost: null, source: grams != null ? "slicer" : null, grams_source: grams != null ? "slicer" : null, partial: outcome !== "done", progress, slicer_cost: facts ? facts.slicer_cost : null, heads: [] },
      energy: null, pieces: qtyFromName(name) || 1, counted: true, note: "" };
    // Not in the library (sent straight from the slicer to the printer): ask
    // the printer, which still has the file, for its metadata. One small GET.
    if (row.material.grams == null || (row.seconds == null && row.est_minutes == null)) {
      try { applyMeta(row, await metaFor(idx, name, false)); }
      catch (e) { ctx.hublog("warn", "costing: " + row.printer + " metadata for " + name + " - " + e.message); }
    }
    // A pending assignment is spent by the print that FINISHES; a cancelled
    // attempt lands in the project too but leaves the assignment for the retry.
    if (outcome === "done" && row.project_id) { delete P.pending[key]; saveP(); }
    // Fork module multiace: a print started through the printer's multiACE
    // preflight carries the plan, its swap count and the Hub's purge-top-up
    // estimate on the row (additive; absent when the module is off or the
    // print went the stock way). The estimated swap time joins est_minutes
    // because that is the fallback when no actual duration exists; actual
    // seconds already contain the swaps. Attached BEFORE any deduction, which
    // applyDeduction then keeps out of the price (see there).
    try {
      const mj = ctx.use("multiace.jobinfo"), mi = mj ? mj(idx, name) : null;
      if (mi) {
        row.multiace = { plan: mi.plan, swaps: mi.swaps, swaps_basis: mi.swaps_basis || null, est_added_sec: mi.est_added_sec, purge_mm: mi.purge_mm, purge_g: mi.purge_g, heads: mi.heads || [], colours: Array.isArray(mi.colours) ? mi.colours : [], sent_at: mi.ts };
        if (num(row.est_minutes) > 0 && num(mi.est_added_sec) > 0) { row.est_minutes = r2(row.est_minutes + mi.est_added_sec / 60); row.est_source = (row.est_source || "slicer") + "+multiace"; }
        priceColours(row);
      }
    } catch (e) { ctx.hublog("warn", "costing: multiACE pricing for " + name + " - " + e.message); }
    const stash = STASH.get(idx + ":" + name);
    if (stash && Date.now() - stash.at < STASH_MS) { applyDeduction(row, stash.rec); STASH.delete(idx + ":" + name); }
    L.prints.push(row);
    if (L.prints.length > LEDGER_MAX) L.prints.splice(0, L.prints.length - LEDGER_MAX);
    saveL();
    ctx.hublog("info", "costing: " + row.printer + " " + outcome + " " + name + (seconds != null ? " after " + seconds + " s" : "") +
      (row.material.grams != null ? " · " + row.material.grams + " g (" + row.material.grams_source + ")" : " · no grams") + (row.project_id ? " -> project " + row.project_id : ""));
    return row;
  }

  // ---- backfill: rows an older Hub left blank -----------------------------------
  // One Moonraker GET at a time, BACKFILL_PAUSE_MS apart; a row is marked
  // `autofill` whatever the outcome so the boot pass never asks twice for the
  // same blank. POST /api/costing/backfill forces a retry of every blank row.
  const needsFill = r => (r.material || {}).grams == null || (!(num(r.seconds) > 0) && !(num(r.est_minutes) > 0));
  let BACKFILL = null, LAST_BACKFILL = null;
  function backfill(opts) {
    if (BACKFILL) return BACKFILL;
    const force = !!(opts && opts.force);
    BACKFILL = (async () => {
      if (force) { for (const [k, v] of META) if (!v.found) META.delete(k); HIST.clear(); }
      const todo = L.prints.filter(r => needsFill(r) && (force || !r.autofill));
      const out = { at: Date.now(), forced: force, blank: L.prints.filter(needsFill).length, checked: todo.length, filled: 0, meta: 0, history: 0, none: 0, requests: 0, errors: 0, ms: 0, pause_ms: BACKFILL_PAUSE_MS, min_gap_ms: null };
      const gets0 = GETS;
      LAST_PACED = 0; MIN_GAP = null;
      for (const row of todo) {
        const idx = Number(row.printer_id);
        let how = [];
        try {
          if (baseOf(idx)) {
            if (applyMeta(row, await metaFor(idx, row.file, true))) how.push("meta");
            if (needsFill(row)) { const jobs = await historyFor(idx, true); if (applyJob(row, matchJob(jobs, row))) how.push("history"); }
          }
        } catch (e) { out.errors++; ctx.hublog("warn", "costing: backfill " + row.printer + " " + row.file + " - " + e.message); }
        row.autofill = { at: Date.now(), result: how.length ? how.join("+") : "none", still_blank: needsFill(row) };
        if (how.includes("meta")) out.meta++;
        if (how.includes("history")) out.history++;
        if (how.length) out.filled++; else out.none++;
      }
      out.requests = GETS - gets0;
      out.min_gap_ms = MIN_GAP;
      out.ms = Date.now() - out.at;
      if (todo.length) saveL();
      LAST_BACKFILL = out;
      ctx.hublog("info", "costing: backfill " + (force ? "(forced) " : "") + out.checked + " blank row" + (out.checked === 1 ? "" : "s") + " checked, " + out.filled + " filled (" + out.meta + " from printer metadata, " + out.history + " from job history), " + out.none + " still blank, " + out.requests + " GETs in " + out.ms + " ms");
      return out;
    })().finally(() => { BACKFILL = null; });
    return BACKFILL;
  }

  // ---- import: every printer's own job history -> ledger rows ----------------------
  // Prints the Hub never watched (started from the printer's screen, or
  // finished while the Hub was down) are in each printer's Moonraker history.
  // Each job is keyed by printer + job_id so a run imports it once; a job the
  // Hub DID watch is recognised by printer + file + end (or start) time and
  // that row wins, gaining the job_id and any blank it can fill. One paced
  // GET per page, IMPORT_PAGE jobs a page, newest first; a run stops at the
  // first page with nothing new unless `full` asks it to read everything.
  // Offline printers are skipped and tried again next run.
  const jobEndMs = j => {
    const e = num(j.end_time); if (e > 0) return Math.round(e * 1000);
    const s = num(j.start_time), t = num(j.total_duration);
    return s > 0 ? Math.round((s + (t > 0 ? t : 0)) * 1000) : null;
  };
  // Two Hub rows for the same file can sit minutes apart (a cancelled attempt
  // and its retry); the one whose outcome agrees and whose end is closest
  // is the job's row.
  function hubRowFor(idx, name, job, outcome) {
    const end = jobEndMs(job), start = num(job.start_time) > 0 ? Math.round(job.start_time * 1000) : null;
    let best = null, score = Infinity;
    for (const r of L.prints) {
      if (r.printer_id !== idx || r.file !== name || r.history_job || r.source === "history") continue;
      const endGap = end != null ? Math.abs(r.at - end) : Infinity;
      const startGap = start != null && num(r.seconds) > 0 ? Math.abs((r.at - r.seconds * 1000) - start) : Infinity;
      if (endGap >= HUB_END_SLACK_MS && startGap >= HUB_START_SLACK_MS) continue;
      const s = Math.min(endGap, startGap) + (r.outcome === outcome ? 0 : HUB_END_SLACK_MS * 10);
      if (s < score) { best = r; score = s; }
    }
    return best;
  }
  function rowFromJob(idx, p, job, outcome, name, end) {
    const meta = shapeMeta(job.metadata);
    const seconds = num(job.print_duration) > 0 ? Math.round(job.print_duration) : null;
    const est_minutes = meta && meta.est_minutes != null ? meta.est_minutes : null;
    // A cancelled or failed job used a fraction of the file's filament: the
    // share of the slicer's estimated time it ran, when both are known.
    let progress = null;
    if (outcome !== "done" && seconds != null && est_minutes > 0) progress = r3(Math.min(1, seconds / (est_minutes * 60)));
    const material = { grams: null, cost: null, source: null, grams_source: null, partial: outcome !== "done", progress, slicer_cost: null, heads: [],
                       material: (meta && meta.material) || materialOf(job.metadata && job.metadata.filament_type) || null };
    if (meta && meta.grams != null && (outcome === "done" || progress != null))
      Object.assign(material, { grams: r2(meta.grams * (progress != null ? progress : 1)), source: "printer-meta", grams_source: "printer-meta", density: meta.density, density_assumed: !!meta.density_assumed });
    else if (num(job.filament_used) > 0) {
      const conv = mmToGrams(job.filament_used, material.material);
      if (conv) Object.assign(material, { grams: conv.grams, source: "history", grams_source: "history", material: conv.material, density: conv.density, density_assumed: conv.assumed, filament_mm: r2(job.filament_used) });
    }
    return { id: newId("pt"), at: end, printer_id: idx, printer: (p && p.name) || ("printer " + (idx + 1)), file: name, type: (p && p.type) || "u1", outcome,
      project_id: null, job_id: null, bundle_id: null, seconds, seconds_source: seconds != null ? "history" : null, est_minutes, est_source: est_minutes != null ? "printer-meta" : null,
      material, energy: null, pieces: qtyFromName(name) || 1, counted: true, note: "", source: "history", history_job: String(job.job_id), history_status: String(job.status || ""), imported_at: Date.now() };
  }
  let IMPORT = null, LAST_IMPORT = null;
  function importHistory(opts) {
    if (IMPORT) return IMPORT;
    const full = !!(opts && opts.full);
    IMPORT = (async () => {
      const out = { at: Date.now(), full, printers: [], imported: 0, matched: 0, known: 0, skipped: 0, pages: 0, requests: 0, errors: 0, offline: [], dropped: 0, ms: 0, pause_ms: BACKFILL_PAUSE_MS, min_gap_ms: null };
      const gets0 = GETS;
      LAST_PACED = 0; MIN_GAP = null;
      let fleet = []; try { fleet = (await ctx.fleet()) || []; } catch {}
      const known = new Set(L.prints.filter(r => r.history_job).map(r => r.printer_id + ":" + r.history_job));
      const settle = out.at - IMPORT_SETTLE_MS;
      let changed = false;
      for (let idx = 0; idx < printers().length; idx++) {
        const p = printers()[idx], base = baseOf(idx);
        if (!base) continue;
        const pr = { idx, name: p.name || ("printer " + (idx + 1)), type: p.type || "u1", status: "ok", pages: 0, seen: 0, imported: 0, matched: 0, known: 0, skipped: 0 };
        out.printers.push(pr);
        const me = fleet.find(f => f && f.id === idx);
        if (me && me.online === false) { pr.status = "offline"; out.offline.push(pr.name); continue; }
        try {
          for (let start = 0; pr.pages < IMPORT_MAX_PAGES; start += IMPORT_PAGE) {
            const r = await pacedGet(base, "/server/history/list?limit=" + IMPORT_PAGE + "&start=" + start + "&order=desc");
            pr.pages++;
            const jobs = r && Array.isArray(r.jobs) ? r.jobs : [];
            let fresh = 0;
            for (const job of jobs) {
              if (!job || job.job_id == null) continue;
              pr.seen++;
              const key = idx + ":" + job.job_id;
              const status = String(job.status || "");
              const outcome = outcomeOf(status, job);
              if (known.has(key)) {
                pr.known++;
                // a row imported before outcomeOf() knew about Rinkhals: fix it in place (a full import revisits every page)
                if (outcome === "done") {
                  const row = L.prints.find(r => r.printer_id === idx && String(r.history_job) === String(job.job_id) && r.outcome === "cancelled");
                  if (row) {
                    row.outcome = "done"; row.history_status = status;
                    if (row.material) { row.material.partial = false; row.material.progress = null; if (row.material.grams_source !== "deduction") { row.material.grams = null; row.material.cost = null; } }
                    applyJob(row, job);   // re-derive grams for a whole print
                    pr.reclassified = (pr.reclassified || 0) + 1; changed = true;
                  }
                }
                continue;
              }
              const name = path.basename(String(job.filename || ""));
              const end = jobEndMs(job);
              if (!outcome || !name || end == null || end > settle) { pr.skipped++; continue; }
              fresh++; known.add(key); changed = true;
              const hub = hubRowFor(idx, name, job, outcome);
              if (hub) { hub.history_job = String(job.job_id); hub.history_status = status; applyJob(hub, job); pr.matched++; continue; }
              L.prints.push(rowFromJob(idx, p, job, outcome, name, end));
              pr.imported++;
            }
            if (jobs.length < IMPORT_PAGE) break;
            if (!full && fresh === 0) break;
          }
          if (pr.pages >= IMPORT_MAX_PAGES) pr.status = "capped";
        } catch (e) { pr.status = "error"; pr.error = e.message; out.errors++; ctx.hublog("warn", "costing: import from " + pr.name + " - " + e.message); }
        for (const k of ["pages", "imported", "matched", "known", "skipped"]) out[k] += pr[k];
      }
      if (changed) {
        L.prints.sort((a, b) => a.at - b.at);
        if (L.prints.length > LEDGER_MAX) { out.dropped = L.prints.length - LEDGER_MAX; L.prints.splice(0, out.dropped); }
        saveL();
      }
      out.requests = GETS - gets0;
      out.min_gap_ms = MIN_GAP;
      out.ms = Date.now() - out.at;
      LAST_IMPORT = out;
      ctx.hublog("info", "costing: import " + (full ? "(full) " : "") + out.imported + " job" + (out.imported === 1 ? "" : "s") + " imported, " + out.matched + " matched to rows the Hub watched, " + out.known + " already known, " + out.skipped + " skipped" +
        (out.offline.length ? ", offline: " + out.offline.join(", ") : "") + (out.dropped ? ", " + out.dropped + " oldest rows dropped at the " + LEDGER_MAX + " cap" : "") + "; " + out.requests + " GETs over " + out.pages + " page" + (out.pages === 1 ? "" : "s") + " in " + out.ms + " ms");
      return out;
    })().finally(() => { IMPORT = null; });
    return IMPORT;
  }
  const bootImport = () => importHistory({}).catch(e => ctx.hublog("warn", "costing: import failed - " + e.message));
  if (BACKFILL_BOOT_MS > 0) {
    const t0 = setTimeout(() => { backfill({ force: false }).catch(e => ctx.hublog("warn", "costing: boot backfill failed - " + e.message)).then(() => { if (IMPORT_BOOT_MS > 0) bootImport(); }); }, BACKFILL_BOOT_MS);
    if (t0.unref) t0.unref();
  } else if (IMPORT_BOOT_MS > 0) { const t1 = setTimeout(bootImport, IMPORT_BOOT_MS); if (t1.unref) t1.unref(); }
  if (IMPORT_MS > 0) { const ti = setInterval(bootImport, IMPORT_MS); if (ti.unref) ti.unref(); }
  if (ctx.events) {
    ctx.events.on("print.started", ev => { if (Number.isInteger(Number(ev.id)) && ev.filename) START.set(Number(ev.id), { file: path.basename(String(ev.filename)), at: Date.now() }); });
    ctx.events.on("print.done", ev => { record(ev, "done").catch(e => ctx.hublog("warn", "costing: ledger write failed - " + e.message)); });
    ctx.events.on("print.cancelled", ev => { record(ev, "cancelled").catch(e => ctx.hublog("warn", "costing: ledger write failed - " + e.message)); });
    // print.error can fire from an idle printer; only a print this Hub watched start is a failed print.
    ctx.events.on("print.error", ev => { const s = START.get(Number(ev.id)); if (s && s.file === path.basename(String(ev.filename || ""))) record(ev, "error").catch(e => ctx.hublog("warn", "costing: ledger write failed - " + e.message)); });
    ctx.events.on("filament.deducted", rec => {
      if (!rec || !Number.isInteger(Number(rec.printer_id)) || !rec.file) return;
      const idx = Number(rec.printer_id);
      const row = [...L.prints].reverse().find(r => r.printer_id === idx && r.file === rec.file && r.material && r.material.source !== "deduction" && Math.abs((rec.at || Date.now()) - r.at) < STASH_MS);
      if (row) { applyDeduction(row, rec); saveL(); }
      else STASH.set(idx + ":" + rec.file, { rec, at: Date.now() });
    });
  }

  // ---- lookups ------------------------------------------------------------------------------
  const project = id => P.projects[String(id || "")] || null;
  const client = id => P.clients[String(id || "")] || null;
  const printsOf = pid => L.prints.filter(r => r.project_id === pid);
  const floorFor = grams => { const q = ctx.use("margin.quote"); if (!q || !(grams > 0)) return null; const r = q({ grams, minutes: null, name: "" }); return r && r.min_plate != null ? r.min_plate : null; };
  function full(pr) {
    const rows = printsOf(pr.id).sort((a, b) => b.at - a.at);
    const R = conf();
    const s = projectSummary(pr, rows, R);
    return { project: pr, client: client(pr.client_id), summary: s, pricing: pricing(s, R, floorFor(s.grams)), prints: rows.map(r => ({ ...r, cost: costOf(r, R) })) };
  }
  const brief = pr => { const s = projectSummary(pr, printsOf(pr.id), conf()); return { ...pr, summary: { cost: s.cost, charged: s.charged, margin: s.margin, margin_pct: s.margin_pct, prints: s.prints, counted: s.counted, failed: s.failed, pieces: s.pieces, hours: s.hours, partial: s.partial } }; };
  // What the whole ledger's numbers came from, for the tab's "filled by the
  // Hub / set by you" note: a tally per line of every row's source.
  const ledgerSources = R => {
    const t = { grams: {}, time: {}, material: {}, machine: {}, energy: {} };
    const add = (k, v) => { t[k][v] = (t[k][v] || 0) + 1; };
    for (const r of L.prints) {
      const c = costOf(r, R);
      add("grams", c.material.grams == null ? "blank" : c.material.grams_source || "unknown");
      add("time", c.time_source || "blank");
      add("material", c.material.cost == null ? "blank" : c.material.source);
      add("machine", c.machine ? c.machine.source : "blank");
      add("energy", c.energy && c.energy.cost != null ? c.energy.source : "blank");
    }
    return t;
  };
  const view = () => {
    const R = conf();
    return {
      clients: Object.values(P.clients).sort((a, b) => a.name.localeCompare(b.name)),
      projects: Object.values(P.projects).sort((a, b) => b.created - a.created).map(brief),
      pending: P.pending,
      unassigned: L.prints.filter(r => !r.project_id).slice(-30).reverse().map(r => ({ ...r, cost: costOf(r, R) })),
      unassigned_total: L.prints.filter(r => !r.project_id).length,
      ledger_total: L.prints.length, ledger_max: LEDGER_MAX,
      sources: ledgerSources(R), blank_rows: L.prints.filter(needsFill).length,
      imported_rows: L.prints.filter(r => r.source === "history").length,
      backfill: { running: !!BACKFILL, last: LAST_BACKFILL, pause_ms: BACKFILL_PAUSE_MS },
      import: { running: !!IMPORT, last: LAST_IMPORT, interval_ms: IMPORT_MS, page: IMPORT_PAGE }
    };
  };
  // ---- the prints list: filters shared by GET /api/costing/prints and the reports ----
  // from/to: epoch ms or anything Date.parse reads; [from, to). printer: index
  // or name. assigned: "1" | "0". q: a case-insensitive substring of the file
  // name, `*` a wildcard. source: "hub" | "history".
  const timeOf = v => { if (v === "" || v == null) return null; const n = Number(v); if (Number.isFinite(n)) return n; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
  const patternOf = s => { const t = clean(s, 200); return t ? new RegExp(t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i") : null; };
  function filtersOf(q) {
    const f = { from: timeOf(q.from), to: timeOf(q.to), printer: q.printer != null && q.printer !== "" ? String(q.printer) : null, type: q.type ? String(q.type) : null,
      outcome: OUTCOMES.includes(q.outcome) ? q.outcome : null, assigned: q.assigned === "1" ? true : (q.assigned === "0" || String(q.unassigned || "") === "1" ? false : null),
      project: q.project ? String(q.project) : null, client: q.client ? String(q.client) : null, q: clean(q.q, 200) || null, source: q.source === "hub" || q.source === "history" ? q.source : null };
    return f;
  }
  function matcherOf(f) {
    const re = f.q ? patternOf(f.q) : null;
    const projectsOfClient = f.client ? new Set(Object.values(P.projects).filter(p => p.client_id === f.client).map(p => p.id)) : null;
    return r => (f.from == null || r.at >= f.from) && (f.to == null || r.at < f.to) &&
      (f.printer == null || String(r.printer_id) === f.printer || r.printer === f.printer) && (f.type == null || (r.type || "u1") === f.type) &&
      (f.outcome == null || r.outcome === f.outcome) && (f.assigned == null || (!!r.project_id) === f.assigned) &&
      (f.project == null || r.project_id === f.project) && (projectsOfClient == null || projectsOfClient.has(r.project_id)) &&
      (re == null || re.test(r.file)) && (f.source == null || (r.source === "history" ? "history" : "hub") === f.source);
  }
  const facets = () => {
    const printers = new Map(), types = new Set(), materials = new Set();
    for (const r of L.prints) { printers.set(r.printer_id, { id: r.printer_id, name: r.printer, type: r.type || "u1" }); types.add(r.type || "u1"); if (r.material && r.material.material) materials.add(r.material.material); }
    return { printers: [...printers.values()].sort((a, b) => a.id - b.id), types: [...types].sort(), materials: [...materials].sort(), outcomes: OUTCOMES };
  };
  function reportFor(q) {
    const f = filtersOf(q);
    return REPORT.report(L.prints, P.projects, P.clients, conf(), { from: f.from, to: f.to, groupBy: String(q.group_by || q.groupBy || "client"), tz_offset_min: num(q.tz_offset_min) || 0 });
  }
  const bad = (res, msg) => res.status(400).json({ error: msg });

  // ---- routes: rates ------------------------------------------------------------------------
  ctx.app.get("/api/costing", async (req, res) => {
    try { await refreshHours(String((req.query || {}).refresh || "") === "1"); } catch {}
    res.json({ fork: "ryvin/u1hub", ...ratesView() });
  });
  // Fill blank grams/time from the printers now (forced: retries every blank
  // row, including ones a boot pass already asked about). Answers when done.
  ctx.app.post("/api/costing/backfill", async (req, res) => {
    if (BACKFILL) return res.status(409).json({ error: "A backfill is already running" });
    try { res.json({ ok: true, ...(await backfill({ force: true })) }); }
    catch (e) { res.status(500).json({ error: "backfill failed - " + e.message }); }
  });
  ctx.app.post("/api/costing/settings", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg.costing && typeof ctx.cfg.costing === "object") ? ctx.cfg.costing : {};
    const next = { ...cur, printers: { ...((cur.printers && typeof cur.printers === "object") ? cur.printers : {}) } };
    for (const [k, [lo, hi]] of Object.entries(RATE_KEYS)) {
      if (!(k in b)) continue;
      if (b[k] === "" || b[k] == null) { delete next[k]; continue; }
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < lo || v > hi) return bad(res, k + " must be a number between " + lo + " and " + hi);
      next[k] = v;
    }
    if (b.printers != null) {
      if (typeof b.printers !== "object" || Array.isArray(b.printers)) return bad(res, "printers must be an object keyed by printer index");
      for (const [i, pb] of Object.entries(b.printers)) {
        const idx = Number(i);
        if (!Number.isInteger(idx) || idx < 0 || idx >= printers().length) return bad(res, "no printer at index " + i);
        if (!pb || typeof pb !== "object") return bad(res, "printer " + i + " needs an object of rates");
        const pn = { ...(next.printers[String(idx)] || {}) };
        for (const [k, [lo, hi]] of Object.entries(PRINTER_KEYS)) {
          if (!(k in pb)) continue;
          if (pb[k] === "" || pb[k] == null) { delete pn[k]; continue; }
          const v = Number(pb[k]);
          if (!Number.isFinite(v) || v < lo || v > hi) return bad(res, "printer " + i + " " + k + " must be a number between " + lo + " and " + hi);
          pn[k] = v;
        }
        if (Object.keys(pn).length) next.printers[String(idx)] = pn; else delete next.printers[String(idx)];
      }
    }
    ctx.cfg.costing = next;
    ctx.saveConfig();
    res.json({ ok: true, ...ratesView() });
  });

  // ---- routes: clients and projects -------------------------------------------------
  ctx.app.get("/api/costing/projects", (req, res) => res.json(view()));
  ctx.app.post("/api/costing/clients", (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 120);
    if (!name) return bad(res, "Name the client");
    if (String(b.name).length > 120 || String(b.email || "").length > 200 || String(b.notes || "").length > 2000) return bad(res, "That is too long");
    const c = { id: newId("cl"), name, email: clean(b.email, 200), notes: clean(b.notes, 2000), created: Date.now() };
    P.clients[c.id] = c; saveP();
    res.json({ ok: true, client: c });
  });
  ctx.app.post("/api/costing/clients/update", (req, res) => {
    const b = req.body || {}, c = client(b.id);
    if (!c) return res.status(404).json({ error: "No such client" });
    if ("name" in b) { if (!clean(b.name) || String(b.name).length > 120) return bad(res, "Name the client (120 characters at most)"); c.name = clean(b.name, 120); }
    if ("email" in b) { if (String(b.email || "").length > 200) return bad(res, "That is too long"); c.email = clean(b.email, 200); }
    if ("notes" in b) { if (String(b.notes || "").length > 2000) return bad(res, "That is too long"); c.notes = clean(b.notes, 2000); }
    saveP(); res.json({ ok: true, client: c });
  });
  ctx.app.post("/api/costing/clients/remove", (req, res) => {
    const c = client((req.body || {}).id);
    if (!c) return res.status(404).json({ error: "No such client" });
    if (Object.values(P.projects).some(p => p.client_id === c.id)) return res.status(409).json({ error: "That client still has projects - remove or move them first" });
    delete P.clients[c.id]; saveP(); res.json({ ok: true });
  });
  ctx.app.post("/api/costing/projects", (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 160);
    if (!name || String(b.name).length > 160) return bad(res, "Name the project (160 characters at most)");
    if (b.client_id != null && b.client_id !== "" && !client(b.client_id)) return bad(res, "No such client");
    if (String(b.notes || "").length > 4000) return bad(res, "Notes are too long");
    const pr = { id: newId("pr"), client_id: b.client_id ? String(b.client_id) : null, name, state: STATES.includes(b.state) ? b.state : "open",
                 charged: null, deadline: num(b.deadline) > 0 ? Math.round(b.deadline) : null, notes: clean(b.notes, 4000), items: [], created: Date.now() };
    if ("charged" in b && b.charged !== "" && b.charged != null) { const v = Number(b.charged); if (!Number.isFinite(v) || v < 0 || v > 1e7) return bad(res, "charged must be a dollar amount"); pr.charged = r2(v); }
    P.projects[pr.id] = pr; saveP();
    res.json({ ok: true, project: brief(pr) });
  });
  ctx.app.post("/api/costing/projects/update", (req, res) => {
    const b = req.body || {}, pr = project(b.id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    if ("name" in b) { if (!clean(b.name) || String(b.name).length > 160) return bad(res, "Name the project (160 characters at most)"); pr.name = clean(b.name, 160); }
    if ("client_id" in b) { if (b.client_id != null && b.client_id !== "" && !client(b.client_id)) return bad(res, "No such client"); pr.client_id = b.client_id ? String(b.client_id) : null; }
    if ("state" in b) { if (!STATES.includes(b.state)) return bad(res, "state must be one of " + STATES.join(", ")); pr.state = b.state; }
    if ("notes" in b) { if (String(b.notes || "").length > 4000) return bad(res, "Notes are too long"); pr.notes = clean(b.notes, 4000); }
    if ("deadline" in b) pr.deadline = num(b.deadline) > 0 ? Math.round(b.deadline) : null;
    if ("charged" in b) {
      if (b.charged === "" || b.charged == null) pr.charged = null;
      else { const v = Number(b.charged); if (!Number.isFinite(v) || v < 0 || v > 1e7) return bad(res, "charged must be a dollar amount"); pr.charged = r2(v); }
    }
    saveP(); res.json({ ok: true, project: brief(pr) });
  });
  ctx.app.post("/api/costing/projects/remove", (req, res) => {
    const pr = project((req.body || {}).id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    let freed = 0;
    for (const r of L.prints) if (r.project_id === pr.id) { r.project_id = null; freed++; }
    for (const k of Object.keys(P.pending)) if (P.pending[k] === pr.id) delete P.pending[k];
    delete P.projects[pr.id]; saveP(); if (freed) saveL();
    res.json({ ok: true, prints_unassigned: freed });
  });

  // ---- routes: line items -----------------------------------------------------------------
  ctx.app.post("/api/costing/items", (req, res) => {
    const b = req.body || {}, pr = project(b.project_id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    const kind = ITEM_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) return bad(res, "kind must be one of " + ITEM_KINDS.join(", "));
    const label = clean(b.label, 200);
    if (!label || String(b.label).length > 200) return bad(res, "Label the item (200 characters at most)");
    const it = { id: newId("it"), kind, label, created: Date.now() };
    if (kind === "labor") { const m = Number(b.minutes); if (!Number.isFinite(m) || m <= 0 || m > 100000) return bad(res, "minutes must be a positive number"); it.minutes = r2(m); }
    else { const c = Number(b.cost); if (!Number.isFinite(c) || c < 0 || c > 1e6) return bad(res, "cost must be a dollar amount"); it.cost = r2(c); }
    pr.items.push(it); saveP();
    res.json({ ok: true, item: it, ...full(pr) });
  });
  ctx.app.post("/api/costing/items/remove", (req, res) => {
    const b = req.body || {}, pr = project(b.project_id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    const n = pr.items.length;
    pr.items = pr.items.filter(i => i.id !== b.id);
    if (pr.items.length === n) return res.status(404).json({ error: "No such item" });
    saveP(); res.json({ ok: true, ...full(pr) });
  });

  // ---- routes: prints ----------------------------------------------------------------------
  // GET /api/costing/prints?from&to&printer&type&outcome&assigned=1|0&project&client&q&source&offset&limit
  // (unassigned=1 still means assigned=0). Newest first, paged, with the total.
  ctx.app.get("/api/costing/prints", (req, res) => {
    const q = req.query || {}, R = conf();
    const f = filtersOf(q);
    const rows = L.prints.filter(matcherOf(f)).sort((a, b) => b.at - a.at);   // newest first (an older Hub appended backfilled rows out of order)
    const limit = Math.min(Math.max(1, Number(q.limit) || 200), 1000);
    const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    res.json({ prints: rows.slice(offset, offset + limit).map(r => ({ ...r, cost: costOf(r, R) })), total: rows.length, offset, limit, ledger_total: L.prints.length, ledger_max: LEDGER_MAX, filters: f, facets: facets() });
  });
  // Many rows at once: { print_ids: [...], project_id: <id> | null, counted: bool }.
  // A key that is absent is left alone; unknown ids are reported, not fatal.
  ctx.app.post("/api/costing/prints/bulk", (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.print_ids) || !b.print_ids.length) return bad(res, "Body needs { print_ids: [...] }");
    if (b.print_ids.length > MATCH_MAX_IDS) return bad(res, "At most " + MATCH_MAX_IDS + " prints at a time");
    const assign = "project_id" in b, pid = b.project_id ? String(b.project_id) : null;
    if (assign && pid && !project(pid)) return bad(res, "No such project");
    if (!assign && !("counted" in b)) return bad(res, "Nothing to change: give project_id or counted");
    const ids = new Set(b.print_ids.map(String));
    let updated = 0;
    for (const r of L.prints) {
      if (!ids.has(r.id)) continue;
      if (assign) r.project_id = pid;
      if ("counted" in b) r.counted = b.counted !== false;
      updated++;
    }
    if (updated) saveL();
    res.json({ ok: true, updated, missing: ids.size - updated });
  });
  // Every print whose file name matches a pattern -> one project. apply:false
  // (the default) previews the count and a sample; apply:true writes.
  ctx.app.post("/api/costing/prints/match", (req, res) => {
    const b = req.body || {};
    const re = patternOf(b.pattern);
    if (!re) return bad(res, "Body needs { pattern }");
    if (b.project_id != null && b.project_id !== "" && !project(b.project_id)) return bad(res, "No such project");
    const pid = b.project_id ? String(b.project_id) : null;
    const onlyUnassigned = b.only_unassigned !== false;
    const hits = L.prints.filter(r => re.test(r.file) && (!onlyUnassigned || !r.project_id) && r.project_id !== pid);
    const sample = [...new Set(hits.slice().reverse().map(r => r.file))].slice(0, 8);
    if (!b.apply) return res.json({ ok: true, preview: true, matched: hits.length, sample, project_id: pid });
    for (const r of hits) r.project_id = pid;
    if (hits.length) saveL();
    res.json({ ok: true, preview: false, matched: hits.length, applied: hits.length, sample, project_id: pid });
  });
  // Read every printer's job history into the ledger now. { full: true }
  // pages to the end instead of stopping at the first page with nothing new.
  ctx.app.post("/api/costing/import", async (req, res) => {
    if (IMPORT) return res.status(409).json({ error: "An import is already running" });
    try { res.json({ ok: true, ...(await importHistory({ full: !!(req.body || {}).full })) }); }
    catch (e) { res.status(500).json({ error: "import failed - " + e.message }); }
  });
  ctx.app.get("/api/costing/import", (req, res) => res.json({ running: !!IMPORT, last: LAST_IMPORT, interval_ms: IMPORT_MS, boot_ms: IMPORT_BOOT_MS, page: IMPORT_PAGE, settle_ms: IMPORT_SETTLE_MS }));

  // ---- routes: reports ----------------------------------------------------------------------
  // ?from&to&group_by=client|project|printer|type|month|material|outcome&tz_offset_min
  ctx.app.get("/api/costing/report", (req, res) => {
    const q = req.query || {};
    if (q.group_by && !REPORT.GROUPINGS.includes(String(q.group_by))) return bad(res, "group_by must be one of " + REPORT.GROUPINGS.join(", "));
    res.json({ ok: true, ...reportFor(q), groupings: REPORT.GROUPINGS });
  });
  ctx.app.get("/api/costing/report.csv", (req, res) => {
    const q = req.query || {};
    if (q.group_by && !REPORT.GROUPINGS.includes(String(q.group_by))) return bad(res, "group_by must be one of " + REPORT.GROUPINGS.join(", "));
    const rep = reportFor(q);
    res.type("text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="cost-report-by-' + rep.group_by + "-" + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send("﻿" + REPORT.reportCsv(rep));
  });
  ctx.app.get("/api/costing/report/print", (req, res) => {
    const q = req.query || {};
    if (q.group_by && !REPORT.GROUPINGS.includes(String(q.group_by))) return res.status(400).send("group_by must be one of " + REPORT.GROUPINGS.join(", "));
    res.set("Cache-Control", "no-cache");
    res.type("html").send(REPORT.reportHtml(reportFor(q)));
  });
  ctx.app.post("/api/costing/prints/assign", (req, res) => {
    const b = req.body || {}, row = L.prints.find(r => r.id === b.print_id);
    if (!row) return res.status(404).json({ error: "No such print" });
    if (b.project_id != null && b.project_id !== "" && !project(b.project_id)) return bad(res, "No such project");
    row.project_id = b.project_id ? String(b.project_id) : null;
    saveL(); res.json({ ok: true, print: { ...row, cost: costOf(row, conf()) } });
  });
  ctx.app.post("/api/costing/prints/update", (req, res) => {
    const b = req.body || {}, row = L.prints.find(r => r.id === b.print_id);
    if (!row) return res.status(404).json({ error: "No such print" });
    if ("counted" in b) row.counted = b.counted !== false;
    if ("pieces" in b) { const n = Number(b.pieces); if (!Number.isInteger(n) || n < 1 || n > 10000) return bad(res, "pieces must be a whole number from 1 to 10000"); row.pieces = n; }
    if ("note" in b) { if (String(b.note || "").length > 500) return bad(res, "Note is too long"); row.note = clean(b.note, 500); }
    saveL(); res.json({ ok: true, print: { ...row, cost: costOf(row, conf()) } });
  });
  // The job card: "the next print of this file belongs to that project".
  ctx.app.post("/api/costing/pending", (req, res) => {
    const b = req.body || {};
    const name = path.basename(String(b.file || ""));
    if (!name || name.length > 255) return bad(res, "Body needs { file }");
    const key = pendKey(b.type || "u1", name);
    if (b.project_id == null || b.project_id === "") delete P.pending[key];
    else { if (!project(b.project_id)) return bad(res, "No such project"); P.pending[key] = String(b.project_id); }
    saveP(); res.json({ ok: true, pending: P.pending });
  });

  // ---- routes: one project, CSV, quote --------------------------------------------------
  ctx.app.get("/api/costing/projects/:id.csv", (req, res) => {
    const pr = project(req.params.id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    res.type("text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + pr.name.replace(/[^\w.-]+/g, "_").slice(0, 60) + "-" + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send("﻿" + projectCsv(pr, printsOf(pr.id).sort((a, b) => a.at - b.at), conf()));
  });
  ctx.app.get("/api/costing/projects/:id/quote", (req, res) => {
    const pr = project(req.params.id);
    if (!pr) return res.status(404).send("No such project");
    res.set("Cache-Control", "no-cache");
    res.type("html").send(quoteHtml({ ...full(pr), rates: conf() }));
  });
  ctx.app.get("/api/costing/projects/:id", (req, res) => {
    const pr = project(req.params.id);
    if (!pr) return res.status(404).json({ error: "No such project" });
    res.json(full(pr));
  });

  ctx.provide("costing.costOf", (print, rates) => costOf(print, rates || conf()));
  ctx.provide("costing.projectSummary", id => { const pr = project(id); return pr ? projectSummary(pr, printsOf(pr.id), conf()) : null; });
  // The ledger rows themselves (read-only; the SME ranks and judges by them).
  ctx.provide("costing.prints", () => L.prints);
  ctx.provide("costing.rates", () => conf());   // the estimate module prices with these
  ctx.hublog("info", "costing (ryvin/u1hub fork module) armed: " + L.prints.length + " ledger rows, " + Object.keys(P.projects).length + " projects");
}

module.exports = { register, costOf, projectSummary, pricing, grossUp, netOf, projectCsv, quoteHtml, mmToGrams, materialOf, densityOf,
                   report: REPORT.report, reportCsv: REPORT.reportCsv, reportHtml: REPORT.reportHtml, GROUPINGS: REPORT.GROUPINGS, monthKey: REPORT.monthKey,
                   LEDGER_MAX, RATE_KEYS, PRINTER_KEYS, ITEM_KINDS, STATES, OUTCOMES, STATUS_OUTCOME, outcomeOf, CANCELLED_BUT_DONE_SHARE, DENSITY, FILAMENT_DIAMETER_MM, SUGGESTED, SUGGESTED_NOTES, SUGGESTED_TYPE_NOTES };
