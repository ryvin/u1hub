// modules/costing-report.js — cost reports over the ledger. Fork module
// helper (ryvin/u1hub), required by modules/costing.js; not a feature module
// of its own. Pure functions only: nothing here reads a file or a printer.
//
//   report(rows, projects, clients, rates, { from, to, groupBy, tz_offset_min })
//     -> the ledger rows inside [from, to) grouped by client, project,
//        printer, type (printer type), month, material or outcome, each group
//        summed from costOf (the same arithmetic the Projects tab shows) with
//        a coverage tally saying how much of every number is actual versus
//        estimated or suggested.
//   reportCsv(rep)   -> one line per group plus a TOTAL line.
//   reportHtml(rep)  -> the printable page, every string escaped, no script.
//
// Two kinds of grouping. Grouped by CLIENT or PROJECT the groups line up with
// projects, so labour (line items created inside the range, plus setup
// minutes), extras, the failure allowance, overhead, what was charged and the
// margin are real per-group numbers, computed by projectSummary over the rows
// in range. Grouped by printer, type, month, material or outcome a project's
// labour or charge has no honest share per group, so those columns are null
// and `aligned` is false; `cost` there is the print cost (material + machine
// + energy), and the page says so. The charged amount belongs to the range
// that holds the project's newest print (its work finished there); a project
// with no prints puts it in the range holding its creation.
//
// Months are keyed in the caller's clock: tz_offset_min is JavaScript's
// getTimezoneOffset() (minutes to ADD to local time to reach UTC; 300 for US
// Eastern in winter), default 0 = UTC. A test passes it explicitly, so no
// expectation depends on where the harness runs (CLAUDE.md rule 7).
//
// Internal string handling only: every value is a field of a ledger row the
// Hub wrote itself (at, outcome, material.material, project_id); nothing is
// parsed out of free text.

"use strict";

const GROUPINGS = ["client", "project", "printer", "type", "month", "material", "outcome"];
const ALIGNED = new Set(["client", "project"]);
const CHART_MAX = 12;                        // bars drawn before the tail folds into "other"

const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const num = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// modules/costing.js requires this file before its own exports exist, so the
// arithmetic is looked up at call time, never at load.
const costing = () => require("./costing.js");
const indexBy = v => { if (!v) return {}; if (Array.isArray(v)) { const o = {}; for (const x of v) if (x && x.id != null) o[String(x.id)] = x; return o; } return v; };

function monthKey(ms, tzOffsetMin) {
  const d = new Date(ms - (tzOffsetMin || 0) * 60000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

// Which bucket a line's source falls in. "actual" is a measurement the Hub or
// the printer made; "estimated" is a slicer or metadata figure or a suggested
// rate; "blank" has no number at all.
const TIME_ACTUAL = new Set(["actual", "hub-clock", "history"]);
const GRAMS_ACTUAL = new Set(["deduction", "history"]);
function bucketsOf(c) {
  const m = c.material || {};
  return {
    time: c.hours == null ? "blank" : (TIME_ACTUAL.has(c.time_source) ? "actual" : "estimated"),
    grams: m.grams == null ? "blank" : (GRAMS_ACTUAL.has(m.grams_source) ? "actual" : "estimated"),
    material: m.cost == null ? "blank" : (m.source === "deduction" ? "actual" : "estimated"),
    machine: !c.machine ? "blank" : (c.machine.source === "typed" ? "actual" : "estimated"),
    energy: !c.energy || c.energy.cost == null ? "blank" : (c.energy.source === "metered" || c.energy.source === "watts" ? "actual" : "estimated")
  };
}
const LINES = ["time", "grams", "material", "machine", "energy"];
function emptyCoverage() { const o = {}; for (const k of LINES) o[k] = { actual: 0, estimated: 0, blank: 0, actual_pct: null }; return o; }
function finishCoverage(cov) {
  for (const k of LINES) { const c = cov[k], n = c.actual + c.estimated + c.blank; c.actual_pct = n ? Math.round(c.actual / n * 100) : null; }
  return cov;
}

function emptyGroup(key, label) {
  return { key, label, prints: 0, done: 0, failed: 0, counted: 0, uncounted: 0, pieces: 0,
    hours: null, grams: null, material: null, machine: null, energy: null, direct: null,
    failure_cost: null, failure_share: null,
    labor: null, labor_minutes: null, extras: null, failure: null, overhead: null, cost: null, charged: null, margin: null, margin_pct: null,
    coverage: emptyCoverage(), projects: 0, _rows: [], _pids: new Set() };
}
const addTo = (g, k, v) => { if (v != null) g[k] = r2((g[k] || 0) + v); };

function report(rows, projects, clients, rates, opts) {
  const o = opts || {};
  const { costOf, projectSummary } = costing();
  const P = indexBy(projects), C = indexBy(clients), R = rates || {};
  const from = num(o.from), to = num(o.to), tz = num(o.tz_offset_min) || 0;
  const groupBy = GROUPINGS.includes(o.groupBy) ? o.groupBy : "client";
  const aligned = ALIGNED.has(groupBy);
  const inRange = t => t != null && (from == null || t >= from) && (to == null || t < to);
  const all = (rows || []).filter(r => r && num(r.at) != null);
  const sel = all.filter(r => inRange(num(r.at)));

  const keyOf = r => {
    const pr = r.project_id != null ? P[String(r.project_id)] : null;
    switch (groupBy) {
      case "client": { const c = pr && pr.client_id != null ? C[String(pr.client_id)] : null; return c ? ["cl:" + c.id, c.name] : (pr ? ["cl:none", "(no client)"] : ["pr:none", "(no project)"]); }
      case "project": return pr ? ["pr:" + pr.id, pr.name] : ["pr:none", "(no project)"];
      case "printer": return ["pi:" + r.printer_id, r.printer || ("printer " + (Number(r.printer_id) + 1))];
      case "type": return ["ty:" + (r.type || "u1"), r.type || "u1"];
      case "month": { const k = monthKey(r.at, tz); return ["mo:" + k, k]; }
      case "material": { const m = (r.material || {}).material; return m ? ["ma:" + m, m] : ["ma:none", "(unknown)"]; }
      default: return ["oc:" + r.outcome, r.outcome || "(unknown)"];
    }
  };

  const groups = new Map();
  for (const r of sel) {
    const [key, label] = keyOf(r);
    let g = groups.get(key);
    if (!g) { g = emptyGroup(key, label); groups.set(key, g); }
    g._rows.push(r);
    if (r.project_id != null) g._pids.add(String(r.project_id));
  }
  // Projects with no print in range still carry items created in range (and
  // a charge, when they never printed): they join the aligned groupings.
  if (aligned) for (const pr of Object.values(P)) {
    const items = (pr.items || []).some(i => inRange(num(i.created)));
    const never = !all.some(r => String(r.project_id) === String(pr.id));
    if (!items && !(never && num(pr.charged) != null && inRange(num(pr.created)))) continue;
    const [key, label] = keyOf({ project_id: pr.id, at: pr.created });
    let g = groups.get(key);
    if (!g) { g = emptyGroup(key, label); groups.set(key, g); }
    g._pids.add(String(pr.id));
  }

  const totals = emptyGroup("total", "Total");
  const fill = (g, rowsOf) => {
    for (const r of rowsOf) {
      const c = costOf(r, R), counted = r.counted !== false;
      g.prints++; if (r.outcome === "done") g.done++; else g.failed++;
      if (!counted) { g.uncounted++; continue; }
      g.counted++;
      if (r.outcome === "done") g.pieces += num(r.pieces) > 0 ? r.pieces : 1;
      addTo(g, "hours", c.hours); addTo(g, "grams", c.material.grams); addTo(g, "material", c.material.cost);
      addTo(g, "machine", c.machine && c.machine.cost); addTo(g, "energy", c.energy && c.energy.cost); addTo(g, "direct", c.direct);
      if (r.outcome !== "done") addTo(g, "failure_cost", c.direct);
      const b = bucketsOf(c);
      for (const k of LINES) g.coverage[k][b[k]]++;
    }
    if (g.hours != null) g.hours = Math.round(g.hours * 1000) / 1000;
    g.failure_share = g.direct > 0 && g.failure_cost != null ? r1(g.failure_cost / g.direct * 100) : (g.direct > 0 ? 0 : null);
    finishCoverage(g.coverage);
  };

  const out = [];
  for (const g of groups.values()) {
    fill(g, g._rows);
    if (aligned) {
      g.labor = 0; g.labor_minutes = 0; g.extras = 0; g.failure = 0; g.overhead = 0; g.cost = g.direct != null ? g.direct : null; g.charged = null;
      for (const pid of g._pids) {
        const pr = P[pid]; if (!pr) continue;
        g.projects++;
        const prRows = g._rows.filter(r => String(r.project_id) === pid);
        const items = (pr.items || []).filter(i => inRange(num(i.created)));
        const s = projectSummary({ ...pr, items, charged: null }, prRows, R);
        g.labor_minutes = r2(g.labor_minutes + (s.labor.minutes || 0));
        if (s.labor.minutes && s.labor.cost == null) g.labor_blank = true;
        addTo(g, "labor", s.labor.cost); addTo(g, "extras", s.extras); addTo(g, "failure", s.failure); addTo(g, "overhead", s.overhead);
        // s.cost is direct + labour + extras + allowance + overhead for this project
        if (s.cost != null) g.cost = r2((g.cost == null ? 0 : g.cost) + (s.cost - (s.direct || 0)));
        // The charge lands in the range that holds the project's newest print.
        if (num(pr.charged) != null) {
          const mine = all.filter(r => String(r.project_id) === pid);
          const newest = mine.length ? Math.max(...mine.map(r => r.at)) : num(pr.created);
          if (inRange(newest)) addTo(g, "charged", r2(pr.charged));
        }
      }
      if (g._pids.size === 0) { g.labor = null; g.labor_minutes = null; g.extras = null; g.failure = null; g.overhead = null; }
      g.margin = g.charged != null && g.cost != null ? r2(g.charged - g.cost) : null;
      g.margin_pct = g.margin != null && g.charged > 0 ? Math.round(g.margin / g.charged * 100) : null;
    } else g.cost = g.direct;
    delete g._rows; delete g._pids;
    out.push(g);
  }
  // Months read in order; everything else by cost, biggest first, blanks last.
  if (groupBy === "month") out.sort((a, b) => a.key.localeCompare(b.key));
  else out.sort((a, b) => (b.cost == null ? -1 : b.cost) - (a.cost == null ? -1 : a.cost) || a.label.localeCompare(b.label));

  // Totals: sums of the groups (not a re-fill, so they tie to the table).
  const sumKeys = ["hours", "grams", "material", "machine", "energy", "direct", "failure_cost", "labor", "labor_minutes", "extras", "failure", "overhead", "cost", "charged"];
  for (const g of out) {
    for (const k of ["prints", "done", "failed", "counted", "uncounted", "pieces", "projects"]) totals[k] += g[k];
    for (const k of sumKeys) addTo(totals, k, g[k]);
    for (const k of LINES) for (const b of ["actual", "estimated", "blank"]) totals.coverage[k][b] += g.coverage[k][b];
    if (g.labor_blank) totals.labor_blank = true;
  }
  if (totals.hours != null) totals.hours = Math.round(totals.hours * 1000) / 1000;
  totals.failure_share = totals.direct > 0 && totals.failure_cost != null ? r1(totals.failure_cost / totals.direct * 100) : (totals.direct > 0 ? 0 : null);
  totals.margin = totals.charged != null && totals.cost != null ? r2(totals.charged - totals.cost) : null;
  totals.margin_pct = totals.margin != null && totals.charged > 0 ? Math.round(totals.margin / totals.charged * 100) : null;
  finishCoverage(totals.coverage);
  delete totals._rows; delete totals._pids;

  return { group_by: groupBy, aligned, from, to, tz_offset_min: tz, rows: sel.length, ledger_rows: all.length, groups: out, totals,
    note: aligned ? "Labour counts line items created inside the range plus setup minutes per counted print; a charge counts in the range holding the project's newest print."
                  : "Cost here is the print cost (material + machine + energy). Labour, extras, overhead and charges belong to projects and have no share per " + groupBy + "; group by client or project to see them." };
}

// ---- CSV ----------------------------------------------------------------------------
const CSV_COLS = [
  ["group", g => g.label], ["prints", g => g.prints], ["done", g => g.done], ["failed", g => g.failed], ["counted", g => g.counted], ["pieces", g => g.pieces],
  ["hours", g => g.hours], ["grams", g => g.grams], ["material", g => g.material], ["machine", g => g.machine], ["energy", g => g.energy], ["direct", g => g.direct],
  ["failure_cost", g => g.failure_cost], ["failure_share_pct", g => g.failure_share],
  ["labour", g => g.labor], ["labour_minutes", g => g.labor_minutes], ["extras", g => g.extras], ["failure_allowance", g => g.failure], ["overhead", g => g.overhead],
  ["cost", g => g.cost], ["charged", g => g.charged], ["margin", g => g.margin], ["margin_pct", g => g.margin_pct],
  ["time_actual_pct", g => g.coverage.time.actual_pct], ["grams_actual_pct", g => g.coverage.grams.actual_pct], ["material_actual_pct", g => g.coverage.material.actual_pct],
  ["machine_typed_pct", g => g.coverage.machine.actual_pct], ["energy_typed_pct", g => g.coverage.energy.actual_pct]
];
function reportCsv(rep) {
  const { csvCell } = require("./margin.js");
  const lines = [CSV_COLS.map(c => c[0]).join(",")];
  for (const g of rep.groups) lines.push(CSV_COLS.map(c => csvCell(c[1](g))).join(","));
  lines.push(CSV_COLS.map(c => csvCell(c[1]({ ...rep.totals, label: "TOTAL" }))).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ---- the printable page -------------------------------------------------------------
const GROUP_LABEL = { client: "client", project: "project", printer: "printer", type: "printer type", month: "month", material: "material", outcome: "outcome" };
function rangeText(rep) {
  const d = t => new Date(t).toISOString().slice(0, 10);
  if (rep.from == null && rep.to == null) return "all time";
  return (rep.from != null ? d(rep.from) : "the start") + " to " + (rep.to != null ? d(rep.to - 1) : "now");
}
// Bars of cost per group: one series, one hue, the tail past CHART_MAX folded
// into "other". Plain markup so it prints; the table beside it is the data.
function chartHtml(rep) {
  const gs = rep.groups.filter(g => g.cost != null && g.cost > 0);
  if (!gs.length) return "";
  const shown = gs.slice(0, CHART_MAX);
  const rest = gs.slice(CHART_MAX);
  if (rest.length) shown.push({ label: "other (" + rest.length + ")", cost: r2(rest.reduce((a, g) => a + g.cost, 0)) });
  const max = Math.max(...shown.map(g => g.cost));
  return '<div class="bars">' + shown.map(g => '<div class="bar" title="' + esc(g.label + ": $" + g.cost.toFixed(2)) + '"><div class="bl">' + esc(g.label) + '</div><div class="bt"><div class="bf" style="width:' + Math.max(1, Math.round(g.cost / max * 100)) + '%"></div></div><div class="bv">$' + g.cost.toFixed(2) + "</div></div>").join("") + "</div>";
}
function reportHtml(rep) {
  const usd = v => v == null ? "—" : "$" + Number(v).toFixed(2);
  const pct = v => v == null ? "—" : v + "%";
  const hrs = h => h == null ? "—" : (h < 1 ? Math.round(h * 60) + " min" : (Math.round(h * 10) / 10) + " h");
  const cov = c => c.actual_pct == null ? "—" : c.actual_pct + "%";
  const al = rep.aligned;
  const head = "<tr><th>" + esc(GROUP_LABEL[rep.group_by] || rep.group_by) + "</th><th class=n>Prints</th><th class=n>Failed</th><th class=n>Time</th><th class=n>Grams</th><th class=n>Material</th><th class=n>Machine</th><th class=n>Energy</th><th class=n>Direct</th><th class=n>Failed cost</th>" +
    (al ? "<th class=n>Labour</th><th class=n>Extras</th><th class=n>Overhead</th><th class=n>Cost</th><th class=n>Charged</th><th class=n>Margin</th>" : "") +
    "<th class=n>Actual: time</th><th class=n>grams</th><th class=n>material</th></tr>";
  const row = (g, cls) => "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + esc(g.label) + "</td><td class=n>" + g.prints + "</td><td class=n>" + g.failed + "</td><td class=n>" + hrs(g.hours) + "</td><td class=n>" + (g.grams != null ? g.grams + " g" : "—") +
    "</td><td class=n>" + usd(g.material) + "</td><td class=n>" + usd(g.machine) + "</td><td class=n>" + usd(g.energy) + "</td><td class=n><b>" + usd(g.direct) + "</b></td><td class=n>" + usd(g.failure_cost) + (g.failure_share != null && g.failure_share > 0 ? " (" + g.failure_share + "%)" : "") + "</td>" +
    (al ? "<td class=n>" + usd(g.labor) + "</td><td class=n>" + usd(g.extras) + "</td><td class=n>" + usd(g.overhead != null && g.failure != null ? r2(g.overhead + g.failure) : (g.overhead != null ? g.overhead : g.failure)) + "</td><td class=n><b>" + usd(g.cost) + "</b></td><td class=n>" + usd(g.charged) + "</td><td class=n>" + usd(g.margin) + (g.margin_pct != null ? " (" + pct(g.margin_pct) + ")" : "") + "</td>" : "") +
    "<td class=n>" + cov(g.coverage.time) + "</td><td class=n>" + cov(g.coverage.grams) + "</td><td class=n>" + cov(g.coverage.material) + "</td></tr>";
  const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width, initial-scale=1\"><title>Cost report by " + esc(GROUP_LABEL[rep.group_by] || rep.group_by) + "</title><style>" +
    "body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:32px auto;max-width:1100px;padding:0 16px}h1{font-size:22px;margin:0 0 2px}h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#666;margin:26px 0 6px}" +
    "table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:5px 7px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}tr.total td{font-weight:700;border-top:2px solid #333}.meta{color:#666;font-size:13px}.note{color:#777;font-size:12px;margin-top:8px}.wrap{overflow:auto}" +
    ".bars{margin:8px 0 4px}.bar{display:flex;align-items:center;gap:10px;margin:3px 0;font-size:12px}.bl{flex:0 0 180px;text-align:right;color:#444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{flex:1;height:16px;background:#f1f1f1}.bf{height:100%;background:#b8860b;border-radius:0 4px 4px 0}.bv{flex:0 0 80px;font-variant-numeric:tabular-nums}" +
    "@media print{body{margin:0}a{display:none}}</style></head><body>" +
    "<h1>Cost report by " + esc(GROUP_LABEL[rep.group_by] || rep.group_by) + "</h1><div class=meta>" + esc(rangeText(rep)) + " · " + rep.rows + " of " + rep.ledger_rows + " ledger rows · " + esc(when) + "</div>" +
    "<h2>Cost per " + esc(GROUP_LABEL[rep.group_by] || rep.group_by) + "</h2>" + (chartHtml(rep) || "<p class=note>Nothing costed in this range.</p>") +
    "<h2>Groups</h2><div class=wrap><table>" + head + rep.groups.map(g => row(g, "")).join("") + row(rep.totals, "total") + "</table></div>" +
    "<p class=note>" + esc(rep.note) + " \"Actual\" columns: the share of counted prints whose time, grams and material price are measured (the printer's clock, the rolls that were loaded or the filament actually extruded) rather than a slicer, metadata or suggested figure." +
    (rep.totals.labor_blank ? " Some labour minutes have no labour rate and are not costed." : "") + "</p>" +
    "</body></html>";
}

module.exports = { report, reportCsv, reportHtml, GROUPINGS, monthKey, CHART_MAX };
