// modules/estimate.js — the Estimate tab: upload an STL or 3MF, get grams,
// time, the cost layers, what to charge and whether it was printed before,
// as a page and as PDF / CSV / XLSX. Fork module (ryvin/u1hub), not part of
// upstream dlgambill/u1hub. Design: docs/superpowers/specs/2026-10-06-estimate-design.md.
"use strict";
const FORK = "ryvin/u1hub";
const MAX_MB = Math.max(0.001, Number(process.env.U1HUB_ESTIMATE_MAX_MB) || 200);
function register(ctx) {
  ctx.app.get("/api/estimate/info", (req, res) => res.json({ enabled: true, fork: FORK, max_mb: MAX_MB, presets: [], materials: [] }));
  ctx.hublog("info", "estimate (" + FORK + " fork module) armed: uploads up to " + MAX_MB + " MB");
}
module.exports = { register, MAX_MB };
