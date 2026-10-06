// modules/estimate/price.js — an estimate priced by costing's own code: one
// synthetic ledger row (the estimate's grams and minutes, qty pieces) through
// projectSummary() and pricing(), so the quote and the Projects tab can never
// disagree. Pure. Fork module estimate (ryvin/u1hub).
"use strict";
const { projectSummary, pricing } = require("../costing.js");
const { quote } = require("../margin.js");
const r2 = x => Math.round(x * 100) / 100;
function priceEstimate(e, rates, marginRates) {
  const R = rates || {}, qty = Math.max(1, Math.round(Number(e.qty) || 1));
  const row = { id: "est", printer_id: e.printer_id, type: e.type || "u1", outcome: "done", est_minutes: e.minutes != null ? e.minutes * qty : null, est_source: "estimate",
                pieces: qty, counted: true, material: { grams: e.grams != null ? r2(e.grams * qty) : null, source: "slicer", grams_source: "estimate", material: e.material || "PLA" } };
  // A matched earlier print's own success rate replaces the general failure allowance.
  const Rf = e.failure_rate != null ? { ...R, failure_pct: Math.round((1 - e.failure_rate) * 100) } : R;
  const items = Number(e.labor_minutes) > 0 ? [{ kind: "labor", minutes: Number(e.labor_minutes) }] : [];
  const s = projectSummary({ items }, [row], Rf);
  const m = marginRates || {};
  const fl = row.material.grams != null ? quote({ grams: row.material.grams, minutes: row.est_minutes, name: e.name || "", sell_per_g: m.sell_per_g, cost_per_g: m.cost_per_g }) : null;
  const p = pricing(s, Rf, fl ? fl.min_plate : null);
  const cands = p ? p.methods.filter(x => (x.key === "markup" || x.key === "per_gram") && x.price != null) : [];
  const best = cands.sort((a, b) => b.price - a.price)[0] || null;
  const rush = Number(e.rush) > 0 ? Number(e.rush) : 1;
  const price = best ? r2(best.price * rush) : null;
  return { cost: s, pricing: p, recommended: { price, each: price != null ? r2(price / qty) : null, method: best ? best.key : null, rush },
           blanks: (s.blanks || []).concat(p ? [] : ["no cost to price (set rates in Settings)"]) };
}
module.exports = { priceEstimate };
