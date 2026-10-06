// modules/estimate/report.js — the estimate as a printable page (the browser
// prints it to PDF), a CSV and an XLSX workbook (Quote + Breakdown sheets),
// written with the Hub's own zip writer: no dependency. Pure.
// Fork module estimate (ryvin/u1hub).
"use strict";
const { zipWrite, makeEntry } = require("../slicing.js");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const xesc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const usd = v => v == null ? "—" : "$" + Number(v).toFixed(2);
const hm = m => m == null ? "—" : Math.floor(m / 60) + " h " + String(Math.round(m % 60)).padStart(2, "0") + " min";
// A cell a spreadsheet would read as a formula gets a leading quote.
function cell(v) { const s = String(v == null ? "" : v); return /^[=+\-@]/.test(s) ? "'" + s : s; }
const csvQ = v => { const s = cell(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const MONEY = new Set(["Cost", "Price", "Price method", "Quantity break"]);

function rows(V, internal) {
  const P = V.print || {};
  const R = [["Model", "File", V.name], ["Model", "Size (mm)", ((V.model && V.model.size_mm) || []).join(" x ")], ["Model", "Quantity", V.qty],
             ["Print", "Material", V.material], ["Print", "Estimate source", V.source_label], ["Print", "Grams (total)", P.grams],
             ["Print", "Print time", hm(P.minutes)], ["Print", "Supports", P.supports_needed], ["Print", "Fits", (V.fits || []).join(", ") || "no printer"]];
  if (internal) {
    const c = V.cost || {};
    R.push(["Cost", "Material", c.material], ["Cost", "Machine", c.machine], ["Cost", "Electricity", c.energy], ["Cost", "Labour", c.labor && c.labor.cost],
           ["Cost", "Failure allowance", c.failure], ["Cost", "Overhead", c.overhead], ["Cost", "Total cost", c.cost]);
    for (const m of (V.pricing && V.pricing.methods) || []) R.push(["Price method", m.label, m.price]);
    for (const b of c.blanks || []) R.push(["Blank", b, ""]);
  }
  R.push(["Price", "Recommended", V.recommended && V.recommended.price], ["Price", "Each", V.recommended && V.recommended.each]);
  for (const b of (V.pricing && V.pricing.breaks) || []) R.push(["Quantity break", "x" + b.qty + " each", b.each]);
  return R;
}
function html(V, view) {
  const internal = view === "internal";
  const tr = rows(V, internal).map(r => "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td><td class=n>" + esc(MONEY.has(r[0]) ? usd(r[2]) : r[2]) + "</td></tr>").join("");
  const rec = V.recommended || {};
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>" + esc(internal ? "Estimate" : "Quote") + " - " + esc(V.name) + "</title>"
    + "<style>body{font:14px system-ui,sans-serif;margin:32px;color:#111;background:#fff}h1{font-size:20px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:6px 8px}td.n{text-align:right}.big{font-size:28px;font-weight:700;margin:12px 0}@media print{body{margin:0}}</style></head><body>"
    + "<h1>" + esc(internal ? "Estimate (internal)" : "Quote") + "</h1><div>" + esc(V.name) + " · " + esc(new Date(V.created).toISOString().slice(0, 10)) + "</div>"
    + "<div class=big>" + esc(usd(rec.price)) + (V.qty > 1 ? " <small>(" + esc(usd(rec.each)) + " each × " + esc(V.qty) + ")</small>" : "") + "</div>"
    + "<table>" + tr + "</table>" + (internal ? "" : "<p>This quote is valid for " + esc(V.valid_days) + " days. Print time is an estimate.</p>") + "</body></html>";
}
function csv(V) { return ["section,item,value"].concat(rows(V, true).map(r => r.map(csvQ).join(","))).join("\r\n") + "\r\n"; }
function sheet(R) {
  const col = i => String.fromCharCode(65 + i);
  const body = R.map((r, i) => "<row r=\"" + (i + 1) + "\">" + r.map((v, j) => typeof v === "number" && Number.isFinite(v)
    ? "<c r=\"" + col(j) + (i + 1) + "\"><v>" + v + "</v></c>"
    : "<c r=\"" + col(j) + (i + 1) + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" + xesc(cell(v)) + "</t></is></c>").join("") + "</row>").join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + "</sheetData></worksheet>";
}
function xlsx(V) {
  const head = [["Section", "Item", "Value"]];
  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Quote" sheetId="1" r:id="rId1"/><sheet name="Breakdown" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", sheet(head.concat(rows(V, false)))],
    ["xl/worksheets/sheet2.xml", sheet(head.concat(rows(V, true)))]
  ];
  return zipWrite(parts.map(([n, s]) => makeEntry(n, Buffer.from(s, "utf8"))));
}
module.exports = { html, csv, xlsx, cell, rows };
