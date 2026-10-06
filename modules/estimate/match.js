// modules/estimate/match.js — "was this printed before?" Files group by a
// family key: the SME's familyName() (variants of one print are attempts at
// the same model) plus what an upload's name carries that a gcode's does not
// (the mesh extension, a trailing colour word like "_pink", MakerWorld /
// bl2u1's "0.4NOZZLE_AMS_5COLORS_..._U1" wrapper). One candidate per family:
// its ledger runs and library gcode folded together, an exact key ranked
// above a containment match ("dragon dynasty" inside "dragon dynasty front
// 100x400", two words or more), and the gcode's max_z_height compared with
// the model's height so a same-name, different model is flagged instead of
// trusted. Pure. Fork module estimate (ryvin/u1hub).
"use strict";
const { familyName } = require("../../sme/core/family.js");
const HEIGHT_TOL = 0.02;
const COLOUR_WORDS = new Set(["pink", "red", "blue", "green", "black", "white", "silver", "grey", "gray", "gold", "orange", "yellow", "purple", "clear"]);
const num = v => { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; };

function famKey(name) {
  const base = String(name || "").replace(/\.(stl|obj|step|stp)$/i, "");
  let k = familyName(base).replace(/^0 \d+nozzle( ams)?( \d+colou?rs?)?\s*/, "").replace(/\s+u1$/, "");
  const t = k.split(" ").filter(Boolean);
  while (t.length > 1 && COLOUR_WORDS.has(t[t.length - 1])) t.pop();
  return t.join(" ");
}
// "exact" | "contains" | null between an upload key and a file key.
function relation(a, b) {
  if (!a || !b) return null;
  if (a === b) return "exact";
  const ta = a.split(" "), tb = b.split(" ");
  const [s, l] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return s.length >= 2 && s.every(x => l.has(x)) ? "contains" : null;
}
function heightCheck(model, gcode) {
  if (!(num(model) > 0) || !(num(gcode) > 0)) return "unchecked";
  return Math.abs(model - gcode) / Math.max(model, gcode) <= HEIGHT_TOL ? "same" : "different";
}
function candidateOf(key, match, runs, libs, height) {
  const byAt = (a, b) => (b.at || 0) - (a.at || 0);
  const done = runs.filter(r => r.outcome === "done");
  const secs = done.map(r => num(r.seconds)).filter(v => v > 0);
  const lib = libs.find(l => num(l.max_z) > 0) || libs[0] || null;
  const last = runs.slice().sort(byAt)[0] || null, lastDone = done.slice().sort(byAt)[0] || null;
  const maxZ = lib ? num(lib.max_z) : null;
  const gDone = lastDone && lastDone.material ? num(lastDone.material.grams) : null;
  return {
    key, match, file: (lastDone || last || {}).file || (lib && lib.name), printer: last ? last.printer : null, printer_id: last ? last.printer_id : null, type: lib ? lib.type : null,
    times_printed: runs.length, done: done.length, success_rate: runs.length ? Math.round(done.length / runs.length * 100) / 100 : null,
    last_at: last ? last.at : null, actual_minutes: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length / 60) : null,
    grams: gDone != null ? gDone : (lib ? num(lib.grams) : null), slicer_minutes: lib ? num(lib.minutes) : null,
    max_z: maxZ, size_check: heightCheck(height, maxZ), kind: runs.length ? "printed" : "library"
  };
}
// o: { name, height_mm, ledger: [costing rows], library: [{ name, type, grams, minutes, max_z }], limit }
function candidates(o) {
  const me = famKey(o.name);
  if (!me) return [];
  const groups = new Map();   // file key -> { match, runs, libs }
  const add = (fileName, kind, item) => {
    const k = famKey(fileName), rel = relation(me, k);
    if (!rel) return;
    const g = groups.get(k) || { match: rel, runs: [], libs: [] };
    g[kind].push(item); groups.set(k, g);
  };
  for (const r of o.ledger || []) if (r && r.file) add(r.file, "runs", r);
  for (const l of o.library || []) if (l && l.name) add(l.name, "libs", l);
  return [...groups.entries()].map(([k, g]) => candidateOf(k, g.match, g.runs, g.libs, o.height_mm))
    .sort((a, b) => (a.match === "exact" ? 0 : 1) - (b.match === "exact" ? 0 : 1) || b.times_printed - a.times_printed)
    .slice(0, o.limit || 5);
}
// Library 3MFs that are byte-for-byte the upload: equal size first (cheap),
// then the hash. hashOf(item) -> Promise<string>. -> [names]
async function sameFileNames(size, hash, items, hashOf) {
  const out = [];
  for (const it of items || []) {
    if (!it || it.size !== size) continue;
    try { if ((await hashOf(it)) === hash) out.push(it.name); } catch {}
  }
  return out;
}
module.exports = { candidates, heightCheck, famKey, relation, sameFileNames, HEIGHT_TOL };
