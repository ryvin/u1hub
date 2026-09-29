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

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { parseGcodeMap, estMinutes } = require("../parser.js");
const { qtyFromName, csvCell } = require("./margin.js");

const LEDGER_MAX = 5000;
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

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const num = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n || 200);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- pure: one print --------------------------------------------------------------
// print: a ledger row. rates: conf() below (or any object of the same shape).
// -> { material:{grams,cost,source,partial}, hours, time_source, machine, energy, direct, blanks[] }
// Every cost is null when its inputs are missing; `direct` sums what is there
// and `blanks` names what is not, so a caller never mistakes "unknown" for 0.
function costOf(print, rates) {
  const p = print || {}, R = rates || {};
  const pr = ((R.printers || {})[String(p.printer_id)]) || {};
  const m = p.material || {};
  const grams = num(m.grams);
  const material = { grams, cost: null, source: null, partial: !!m.partial };
  if (m.source === "deduction") {
    material.source = "deduction";
    material.cost = num(m.cost) != null ? r2(m.cost) : null;
    material.partial = !!m.partial || material.cost == null;
  } else if (grams != null) {
    if (num(R.cost_per_g) != null) { material.cost = r2(grams * R.cost_per_g); material.source = "flat"; }
    else if (num(m.slicer_cost) != null) { material.cost = r2(m.slicer_cost); material.source = "slicer"; }
  }
  let hours = null, time_source = null;
  if (num(p.seconds) > 0) { hours = p.seconds / 3600; time_source = "actual"; }
  else if (num(p.est_minutes) > 0) { hours = p.est_minutes / 60; time_source = "slicer"; }
  let machine = null;
  const dep = num(pr.purchase) != null && num(pr.life_hours) > 0 ? pr.purchase / pr.life_hours : null;
  const maint = num(pr.maint_per_hour);
  if (hours != null && (dep != null || maint != null)) {
    const per_hour = (dep || 0) + (maint || 0);
    machine = { per_hour: r3(per_hour), cost: r2(hours * per_hour), source: dep != null && maint != null ? "depreciation+maintenance" : (dep != null ? "depreciation" : "maintenance") };
  }
  let energy = null;
  const e = p.energy || {};
  const rate = num(R.kwh_rate);
  if (num(e.kwh) != null) energy = { kwh: r3(e.kwh), cost: rate != null ? r2(e.kwh * rate) : null, source: e.source || "metered" };
  else if (hours != null && num(pr.avg_watts) > 0) { const kwh = hours * pr.avg_watts / 1000; energy = { kwh: r3(kwh), cost: rate != null ? r2(kwh * rate) : null, source: "watts" }; }
  const blanks = [];
  if (material.cost == null) blanks.push(material.source === "deduction" ? "material (a loaded roll has no price)" : (grams == null ? "material (no grams)" : "material (no rate)"));
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
    time: tally(r => r.cost.time_source),
    machine: tally(r => r.cost.machine ? "typed" : "blank"),
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
  const SRC = { deduction: "actual (loaded rolls)", flat: "flat $/g", slicer: "slicer estimate", actual: "actual", watts: "typed watts", metered: "metered", typed: "typed rates" };
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
    line("Material", usd(s.material), srcLine(s.sources.material) + (s.sources.material_partial ? " · " + s.sources.material_partial + " partial" : "")) +
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
    return { ...out, ...flat() };
  }
  const ratesView = () => ({ ...conf(), printer_names: printers().map((p, i) => ({ idx: i, name: p.name || ("printer " + (i + 1)) })), keys: Object.keys(RATE_KEYS), printer_keys: Object.keys(PRINTER_KEYS) });

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
  function applyDeduction(row, rec) {
    row.material = { ...(row.material || {}), cost: num(rec.cost), source: "deduction",
      partial: !!rec.cost_partial || (rec.misses || []).length > 0 || num(rec.cost) == null || row.outcome !== "done",
      deducted_g: num(rec.grams), heads: (rec.entries || []).map(e => ({ head: e.head, spool_id: e.spool_id, color_name: e.color_name, grams: e.grams, cost: e.cost })),
      misses: rec.misses || [] };
    row.deduction_at = rec.at;
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
    const grams = facts && facts.grams != null ? r2(facts.grams * (progress != null ? progress : 1)) : null;
    const key = pendKey(slug, name);
    const job = jobOf(idx, name);
    const row = { id: newId("pt"), at: Date.now(), printer_id: idx, printer: (p && p.name) || ev.printer || ("printer " + (idx + 1)), file: name, type: slug, outcome,
      project_id: P.pending[key] || null, job_id: job ? job.id : null, bundle_id: job && job.bundle_id ? job.bundle_id : null,
      seconds, seconds_source, est_minutes: facts ? facts.est_minutes : null,
      material: { grams, cost: null, source: grams != null ? "slicer" : null, partial: outcome !== "done", progress, slicer_cost: facts ? facts.slicer_cost : null, heads: [] },
      energy: null, pieces: qtyFromName(name) || 1, counted: true, note: "" };
    // A pending assignment is spent by the print that FINISHES; a cancelled
    // attempt lands in the project too but leaves the assignment for the retry.
    if (outcome === "done" && row.project_id) { delete P.pending[key]; saveP(); }
    START.delete(idx);
    const stash = STASH.get(idx + ":" + name);
    if (stash && Date.now() - stash.at < STASH_MS) { applyDeduction(row, stash.rec); STASH.delete(idx + ":" + name); }
    L.prints.push(row);
    if (L.prints.length > LEDGER_MAX) L.prints.splice(0, L.prints.length - LEDGER_MAX);
    saveL();
    ctx.hublog("info", "costing: " + row.printer + " " + outcome + " " + name + (seconds != null ? " after " + seconds + " s" : "") + (row.project_id ? " -> project " + row.project_id : ""));
    return row;
  }
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
  const view = () => {
    const R = conf();
    return {
      clients: Object.values(P.clients).sort((a, b) => a.name.localeCompare(b.name)),
      projects: Object.values(P.projects).sort((a, b) => b.created - a.created).map(brief),
      pending: P.pending,
      unassigned: L.prints.filter(r => !r.project_id).slice(-30).reverse().map(r => ({ ...r, cost: costOf(r, R) })),
      unassigned_total: L.prints.filter(r => !r.project_id).length,
      ledger_total: L.prints.length, ledger_max: LEDGER_MAX
    };
  };
  const bad = (res, msg) => res.status(400).json({ error: msg });

  // ---- routes: rates ------------------------------------------------------------------------
  ctx.app.get("/api/costing", (req, res) => res.json({ fork: "ryvin/u1hub", ...ratesView() }));
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
  // GET /api/costing/prints?unassigned=1&project=<id>&limit=<n>
  ctx.app.get("/api/costing/prints", (req, res) => {
    const q = req.query || {}, R = conf();
    let rows = L.prints;
    if (String(q.unassigned || "") === "1") rows = rows.filter(r => !r.project_id);
    if (q.project) rows = rows.filter(r => r.project_id === String(q.project));
    const limit = Math.min(Math.max(1, Number(q.limit) || 200), LEDGER_MAX);
    res.json({ prints: rows.slice(-limit).reverse().map(r => ({ ...r, cost: costOf(r, R) })), total: rows.length, ledger_total: L.prints.length });
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
  ctx.hublog("info", "costing (ryvin/u1hub fork module) armed: " + L.prints.length + " ledger rows, " + Object.keys(P.projects).length + " projects");
}

module.exports = { register, costOf, projectSummary, pricing, grossUp, netOf, projectCsv, quoteHtml, LEDGER_MAX, RATE_KEYS, PRINTER_KEYS, ITEM_KINDS, STATES, OUTCOMES };
