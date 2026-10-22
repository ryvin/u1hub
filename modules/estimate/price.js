// modules/estimate/price.js — an estimate priced by costing's own code: one
// synthetic ledger row (the estimate's grams and minutes, qty pieces) through
// projectSummary() and pricing(), so the quote and the Projects tab can never
// disagree. Pure. Fork module estimate (ryvin/u1hub).
//
// The recommended price is costing's: the owner's minimum (break-even with
// failure allowance, sales tax and card fee, whole dollars per piece) or any
// method the owner has set, whichever is higher; then x rush. The per-gram
// method counts only when a sell floor was set on purpose (rates.sell_per_g
// from costing's conf(), else an explicit marginRates.sell_per_g), never
// margin.js's built-in $0.12/g.
"use strict";
const { projectSummary, pricing } = require("../costing.js");
const r2 = x => Math.round(x * 100) / 100;
function priceEstimate(e, rates, marginRates) {
  const R = rates || {}, qty = Math.max(1, Math.round(Number(e.qty) || 1));
  const row = { id: "est", printer_id: e.printer_id, type: e.type || "u1", outcome: "done", est_minutes: e.minutes != null ? e.minutes * qty : null, est_source: "estimate",
                pieces: qty, counted: true, material: { grams: e.grams != null ? r2(e.grams * qty) : null, source: "slicer", grams_source: "estimate", material: e.material || "PLA" } };
  // A matched earlier print's own success rate (match.js success_rate: done / runs)
  // replaces the general failure allowance: 0.9 done -> a 10 % allowance.
  const sr = e.success_rate != null && Number.isFinite(Number(e.success_rate)) ? Math.min(1, Math.max(0, Number(e.success_rate))) : null;
  const Rf = sr != null ? { ...R, failure_pct: Math.round((1 - sr) * 100), failure_label: "this file's own record: " + Math.round(sr * 100) + " % done" } : R;
  const items = Number(e.labor_minutes) > 0 ? [{ kind: "labor", minutes: Number(e.labor_minutes) }] : [];
  const s = projectSummary({ items }, [row], Rf);
  const m = marginRates || {};
  const sell = Number(R.sell_per_g) > 0 ? Number(R.sell_per_g) : (Number(m.sell_per_g) > 0 ? Number(m.sell_per_g) : null);
  const floor = sell != null && row.material.grams > 0 ? r2(row.material.grams * sell) : null;
  const p = pricing(s, Rf, floor);
  const best = p && p.recommended ? p.recommended : null;
  const rush = Number(e.rush) > 0 ? Number(e.rush) : 1;
  // 0 g (an unmeasured or empty model) is not a price, whatever the rates say.
  const priced = Number(e.grams) > 0;
  const price = best && priced ? r2(best.price * rush) : null;
  return { cost: s, pricing: p, recommended: { price, each: price != null ? r2(price / qty) : null, method: best && priced ? best.method : null, label: best && priced ? best.label : null, rush },
           blanks: (s.blanks || []).concat(p ? [] : ["no cost to price (set rates in Settings)"]).concat(priced ? [] : ["no grams: nothing to price"]) };
}
module.exports = { priceEstimate };
