// modules/estimate/geometry.js — mesh facts -> grams. Pure. The shell is the
// whole surface times the wall thickness (top/bottom skins folded into the
// calibrated k), the rest of the solid is filled at the infill fraction,
// supports are an allowance from the downward-facing share of the surface.
// Fork module estimate (ryvin/u1hub).
"use strict";
const { densityOf } = require("../costing.js");
const LINE_MM = 0.42;              // 0.4 nozzle line width (Orca default)
const SUPPORT_FILL = 0.15;         // support volume share of the column it fills
const SUPPORTS_YES_PCT = 5, SUPPORTS_MAYBE_PCT = 1;
const PRESETS = Object.freeze({
  standard: { label: "Standard (2 walls, 15 %)", walls: 2, infill: 0.15, family: "standard" },
  strong:   { label: "Strong (4 walls, 30 %)",   walls: 4, infill: 0.30, family: "standard" },
  hueforge: { label: "HueForge (solid)",         walls: 2, infill: 1.00, family: "hueforge" },
  flexi:    { label: "Flexi (2 walls, 15 %)",    walls: 2, infill: 0.15, family: "flexi" }
});
const r2 = x => Math.round(x * 100) / 100;
const num = v => { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; };

function gramsFrom(facts, o) {
  const opt = o || {};
  const key = Object.prototype.hasOwnProperty.call(PRESETS, opt.preset) ? opt.preset : "standard";
  const p = PRESETS[key];
  const walls = num(opt.walls) != null ? opt.walls : p.walls;
  const infill = num(opt.infill) != null ? Math.min(1, Math.max(0, opt.infill)) : p.infill;
  const k = num(opt.k) > 0 ? opt.k : 1;
  const d = densityOf(opt.material || "PLA");
  const vol = facts.volume_cm3, area = facts.area_cm2;
  const shell = area * walls * LINE_MM / 10;
  const interior = Math.max(0, vol - shell);
  const model_cm3 = Math.min(vol, shell + infill * interior);
  const ov = facts.overhang || {};
  const downPct = (ov.steep_pct || 0) + (ov.flat_unsupported_pct || 0);
  const need = downPct >= SUPPORTS_YES_PCT ? "yes" : downPct >= SUPPORTS_MAYBE_PCT ? "maybe" : "no";
  const supports_cm3 = area * downPct / 100 * (facts.height_mm / 10) / 2 * SUPPORT_FILL;
  const include = opt.supports === "on" || (opt.supports !== "off" && need === "yes");
  const model_g = r2(model_cm3 * k * d.density), supports_g = r2(supports_cm3 * d.density);
  return { grams: r2(model_g + (include ? supports_g : 0)), model_g, supports_g, supports_needed: need, supports_included: include,
           density: d.density, material: d.material, density_assumed: d.assumed, shell_cm3: r2(shell), infill_cm3: r2(infill * interior),
           walls, infill, k, preset: key, family: p.family };
}
module.exports = { gramsFrom, PRESETS, LINE_MM, SUPPORT_FILL };
