// modules/costing-jobs.js — every job's cost, one row per ledger print, for a
// spreadsheet (CSV and XLSX) and a JSON export of everything costing holds.
// Fork helper (ryvin/u1hub), required by modules/costing.js; pure: nothing
// here reads a file or a printer.
//
//   jobRows(rows, projects, clients, rates, { from, to, tz_offset_min })
//     -> [{ id, date, printer, type, file, project, client, outcome, counted,
//          pieces, hours, time_source, grams, grams_source, material,
//          material_cost, material_source, machine_cost, energy_kwh,
//          energy_cost, total, per_piece, blanks }], oldest first, inside
//        [from, to) like the cost report. Every number is costOf's (the same
//        arithmetic as the Projects tab); a blank stays blank and says why.
//   jobsCsv(jobs)          -> text, one line per job.
//   jobsXlsx(jobs, rates)  -> Buffer. Sheet "Jobs": Total and Per piece are
//        live formulas over the cost cells (cached values included), and a
//        TOTAL row sums the counted jobs (as the report does), so editing a
//        cost or a counted cell recalculates; sheet
//        "Rates": the rates the costs were computed with. Written with the
//        Hub's own zip writer; no dependency.
//   exportAll({ prints, projects, clients, pending, rates, now })
//     -> one JSON-able object: rates, clients, projects (each with its
//        summary), pending assignments, and every print with its cost.
//
// Internal string handling only: every value is a field of a ledger row or a
// project the Hub wrote itself. Text cells that look like formulas are
// written with a leading ' so a spreadsheet shows them, never runs them.
"use strict";

const { zipWrite, makeEntry } = require("./slicing.js");
// modules/costing.js requires this file before its own exports exist: look the arithmetic up at call time.
const costing = () => require("./costing.js");
const r2 = v => Math.round(v * 100) / 100;
const num = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const indexBy = v => { if (!v) return {}; if (Array.isArray(v)) { const o = {}; for (const x of v) if (x && x.id != null) o[String(x.id)] = x; return o; } return v; };
const stamp = (ms, tz) => new Date(ms - (tz || 0) * 60000).toISOString().slice(0, 16).replace("T", " ");

// [header, key, xlsx column letter]
const COLS = [
  ["date", "date"], ["printer", "printer"], ["type", "type"], ["file", "file"], ["project", "project"], ["client", "client"],
  ["outcome", "outcome"], ["counted", "counted"], ["pieces", "pieces"], ["hours", "hours"], ["time_source", "time_source"],
  ["grams", "grams"], ["grams_source", "grams_source"], ["material", "material"], ["material_cost", "material_cost"],
  ["material_source", "material_source"], ["machine_cost", "machine_cost"], ["energy_kwh", "energy_kwh"], ["energy_cost", "energy_cost"],
  ["total", "total"], ["per_piece", "per_piece"], ["blanks", "blanks"], ["id", "id"]
].map(([h, k], i) => [h, k, String.fromCharCode(65 + i)]);
const L = Object.fromEntries(COLS.map(([, k, c]) => [k, c]));
const SUMMED = ["hours", "grams", "material_cost", "machine_cost", "energy_kwh", "energy_cost", "total"];

function jobRows(rows, projects, clients, rates, opts) {
  const o = opts || {}, P = indexBy(projects), C = indexBy(clients), R = rates || {};
  const from = num(o.from), to = num(o.to), tz = num(o.tz_offset_min) || 0;
  const { costOf } = costing();
  return (rows || []).filter(r => r && num(r.at) != null && (from == null || r.at >= from) && (to == null || r.at < to))
    .slice().sort((a, b) => a.at - b.at)
    .map(p => {
      const c = costOf(p, R), m = p.material || {};
      const pr = p.project_id != null ? P[String(p.project_id)] : null, cl = pr && pr.client_id != null ? C[String(pr.client_id)] : null;
      const pieces = num(p.pieces) > 0 ? p.pieces : 1;
      return { id: p.id, date: stamp(p.at, tz), printer: p.printer || "", type: p.type || "", file: p.file || "", project: pr ? pr.name : "", client: cl ? cl.name : "",
        outcome: p.outcome || "", counted: p.counted !== false, pieces, hours: c.hours, time_source: c.time_source || "",
        grams: c.material.grams, grams_source: c.material.grams_source || "", material: m.material || "", material_cost: c.material.cost, material_source: c.material.source || "",
        machine_cost: c.machine ? c.machine.cost : null, energy_kwh: c.energy ? c.energy.kwh : null, energy_cost: c.energy ? c.energy.cost : null,
        total: c.direct, per_piece: c.direct != null ? r2(c.direct / pieces) : null, blanks: (c.blanks || []).join("; ") };
    });
}

const safeText = v => { const s = String(v == null ? "" : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
const csvCell = v => { if (v == null) return ""; if (typeof v === "number" || typeof v === "boolean") return String(v); const s = safeText(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function jobsCsv(jobs) {
  return [COLS.map(c => c[0]).join(",")].concat((jobs || []).map(j => COLS.map(([, k]) => csvCell(j[k])).join(","))).join("\r\n") + "\r\n";
}

const xesc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
const numCell = (ref, v) => "<c r=\"" + ref + "\"><v>" + v + "</v></c>";
// An inline string is never evaluated, so text is stored exactly as written (no ' guard: Excel would show it).
const strCell = (ref, v) => "<c r=\"" + ref + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" + xesc(String(v)) + "</t></is></c>";
const fCell = (ref, f, cached) => "<c r=\"" + ref + "\"><f>" + xesc(f) + "</f>" + (cached != null ? "<v>" + cached + "</v>" : "") + "</c>";
const valCell = (ref, v) => (v == null || v === "" ? "" : (typeof v === "number" && Number.isFinite(v) ? numCell(ref, v) : strCell(ref, typeof v === "boolean" ? (v ? "yes" : "no") : v)));
const sheetXml = rowsXml => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>' + rowsXml.join("") + "</sheetData></worksheet>";

function jobsXlsx(jobs, rates) {
  const J = jobs || [], out = [];
  out.push("<row r=\"1\">" + COLS.map(([h, , c]) => strCell(c + "1", h)).join("") + "</row>");
  J.forEach((j, i) => {
    const n = i + 2;
    const cells = COLS.map(([, k, c]) => {
      const ref = c + n;
      if (k === "total") return fCell(ref, "IF(COUNT(" + L.material_cost + n + "," + L.machine_cost + n + "," + L.energy_cost + n + ")=0,\"\",SUM(" + L.material_cost + n + "," + L.machine_cost + n + "," + L.energy_cost + n + "))", j.total);
      if (k === "per_piece") return fCell(ref, "IF(OR(" + L.total + n + "=\"\"," + L.pieces + n + "=0),\"\"," + L.total + n + "/" + L.pieces + n + ")", j.per_piece);
      return valCell(ref, j[k]);
    });
    out.push("<row r=\"" + n + "\">" + cells.join("") + "</row>");
  });
  const t = J.length + 2, last = J.length + 1;
  // Counted jobs only (counted = "yes"), like the cost report and projectSummary: an uncounted
  // calibration or test print is listed but not added in. Editing a job's counted cell re-totals.
  const counted = J.filter(j => j.counted);
  const totals = [strCell("A" + t, "TOTAL (counted)")].concat(J.length ? SUMMED.map(k => fCell(L[k] + t, "SUMIF(" + L.counted + "2:" + L.counted + last + ",\"yes\"," + L[k] + "2:" + L[k] + last + ")",
    r2(counted.reduce((a, j) => a + (num(j[k]) || 0), 0)))) : []);
  out.push("<row r=\"" + t + "\">" + totals.join("") + "</row>");
  const R = rates || {}, rr = ["<row r=\"1\">" + strCell("A1", "rate") + strCell("B1", "value") + "</row>"];
  const flat = [];
  for (const [k, v] of Object.entries(R)) {
    if (v != null && typeof v === "object") { for (const [k2, v2] of Object.entries(v)) if (v2 == null || typeof v2 !== "object") flat.push([k + "." + k2, v2]); else for (const [k3, v3] of Object.entries(v2)) if (v3 == null || typeof v3 !== "object") flat.push([k + "." + k2 + "." + k3, v3]); }
    else flat.push([k, v]);
  }
  flat.forEach(([k, v], i) => rr.push("<row r=\"" + (i + 2) + "\">" + strCell("A" + (i + 2), k) + valCell("B" + (i + 2), v) + "</row>"));
  const ns = "http://schemas.openxmlformats.org/";
  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="' + ns + 'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + ns + 'package/2006/relationships"><Relationship Id="rId1" Type="' + ns + 'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="' + ns + 'spreadsheetml/2006/main" xmlns:r="' + ns + 'officeDocument/2006/relationships"><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/><sheet name="Rates" sheetId="2" r:id="rId2"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + ns + 'package/2006/relationships"><Relationship Id="rId1" Type="' + ns + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + ns + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", sheetXml(out)],
    ["xl/worksheets/sheet2.xml", sheetXml(rr)]
  ];
  return zipWrite(parts.map(([n, s]) => makeEntry(n, Buffer.from(s, "utf8"))));
}

// Every field of every ledger row in range, flattened to dot paths (material.grams,
// multiace.swaps …; lists as JSON), then project, client and the computed costs.
// Columns are the union over the rows, so a field one row lacks is a blank cell.
const COST_COLS = ["project", "client", "material_cost", "material_source", "machine_cost", "energy_kwh", "energy_cost", "total", "per_piece", "blanks"];
function flatten(o, prefix, out) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix + k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) flatten(v, key + ".", out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
function jobsFullCsv(rows, projects, clients, rates, opts) {
  const o = opts || {}, from = num(o.from), to = num(o.to);
  const sel = (rows || []).filter(r => r && num(r.at) != null && (from == null || r.at >= from) && (to == null || r.at < to)).slice().sort((a, b) => a.at - b.at);
  const jobs = jobRows(sel, projects, clients, rates, { tz_offset_min: o.tz_offset_min });
  const flat = sel.map(r => flatten(r, "", {}));
  const keys = [...new Set(flat.flatMap(f => Object.keys(f)))].filter(k => k !== "id").sort();
  const head = ["id", "date"].concat(keys, COST_COLS);
  const lines = [head.join(",")];
  flat.forEach((f, i) => { const j = jobs[i]; lines.push([j.id, j.date].concat(keys.map(k => f[k]), COST_COLS.map(k => j[k])).map(csvCell).join(",")); });
  return lines.join("\r\n") + "\r\n";
}

function exportAll(o) {
  const { costOf, projectSummary } = costing();
  const R = o.rates || {}, prints = o.prints || [];
  const projects = Object.values(indexBy(o.projects)), clients = Object.values(indexBy(o.clients));
  return {
    exported_at: new Date(o.now).toISOString(), fork: "ryvin/u1hub", rates: R, clients,
    projects: projects.map(pr => ({ ...pr, summary: projectSummary(pr, prints.filter(p => String(p.project_id) === String(pr.id)), R) })),
    pending: o.pending || {},
    prints: prints.map(p => ({ ...p, cost: costOf(p, R) }))
  };
}

module.exports = { jobRows, jobsCsv, jobsFullCsv, jobsXlsx, exportAll, COLS };
