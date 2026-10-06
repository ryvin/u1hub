// modules/estimate/sliced.js — what a 3MF already knows about its own slice.
// Metadata/plate_N.gcode (a "sliced" 3MF) = exact; Metadata/slice_info.config
// = the designer's slice: its grams are the model's, its time is THEIR
// printer's (bl2u1 rewrites printer_model_id, not prediction), so the time
// comes back as designer_minutes and the caller estimates its own. Pure.
// Fork module estimate (ryvin/u1hub).
"use strict";
const { parseGcodeMap, estMinutes } = require("../../parser.js");
const r2 = x => Math.round(x * 100) / 100;
const attr = (tag, k) => { const m = new RegExp("\\b" + k + "=\"([^\"]*)\"").exec(tag); return m ? m[1] : null; };
const meta = (block, key) => { const m = new RegExp("<metadata key=\"" + key + "\" value=\"([^\"]*)\"").exec(block); return m ? m[1] : null; };

async function slicedFrom(z) {
  const plateG = z.entries.filter(e => /^\/?Metadata\/plate_\d+\.gcode$/i.test(e.name));
  if (plateG.length) {
    let grams = 0, minutes = 0; const fil = new Map();
    for (const e of plateG) {
      const text = (await z.content(e)).toString("utf8");
      const m = parseGcodeMap(text.length > 1048576 ? text.slice(-1048576) : text);
      const used = (m.palette || []).filter(p => p.used);
      for (const p of used) { const f = fil.get(p.i) || { id: p.i + 1, type: p.type || "", color: String(p.hex || "").toLowerCase(), grams: 0 }; f.grams = r2(f.grams + (p.grams || 0)); fil.set(p.i, f); }
      grams += used.reduce((a, p) => a + (p.grams || 0), 0);
      minutes += estMinutes(m.estTime) || 0;
    }
    return { source: "plate-gcode", plates: plateG.length, grams: r2(grams), minutes: Math.round(minutes), designer_minutes: null, filaments: [...fil.values()], support_used: null, printer_model: null };
  }
  const si = z.entries.find(e => /^\/?Metadata\/slice_info\.config$/i.test(e.name));
  if (!si) return null;
  const xml = (await z.content(si)).toString("utf8");
  const plates = [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map(m => m[1]).filter(b => meta(b, "weight") != null);
  if (!plates.length) return null;
  let grams = 0, secs = 0, support = false, model = null; const fil = new Map();
  for (const b of plates) {
    grams += Number(meta(b, "weight")) || 0;
    secs += Number(meta(b, "prediction")) || 0;
    if (meta(b, "support_used") === "true") support = true;
    model = model || meta(b, "printer_model_id");
    for (const t of b.match(/<filament [^>]*>/g) || []) {
      const id = Number(attr(t, "id"));
      const f = fil.get(id) || { id, type: attr(t, "type") || "", color: String(attr(t, "color") || "").toLowerCase(), grams: 0 };
      f.grams = r2(f.grams + (Number(attr(t, "used_g")) || 0)); fil.set(id, f);
    }
  }
  return { source: "slice-info", plates: plates.length, grams: r2(grams), minutes: null, designer_minutes: secs ? Math.round(secs / 60) : null,
           filaments: [...fil.values()].sort((a, b) => a.id - b.id), support_used: support, printer_model: model };
}
module.exports = { slicedFrom };
