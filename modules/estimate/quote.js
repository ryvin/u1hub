// modules/estimate/quote.js — the public quote's numbers and its guards, pure:
// confidence from the estimate's source, a price range priced at both ends by
// costing's own chain (priceAt), the visitor's options and contact checks, the
// owner's settings checks, the customer allow-list, and retention.
// Fork module estimate (ryvin/u1hub). Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md
"use strict";
const crypto = require("crypto");
const DAY = 24 * 3600 * 1000;
const UNREQUESTED_MS = 7 * DAY, CLOSED_MS = 30 * DAY;
const EXACT_BAND = 0.05, GEO_G_DEFAULT = 0.30, GEO_G_MIN = 0.15;
const QUALITIES = ["standard", "strong"];
const QUOTE_DEFAULTS = Object.freeze({ enabled: false, firm_prices: false, round_to: 0.5, valid_days: 14, rush_multiplier: 1.5, qty_max: 100, post_days: 1,
  hours: Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: "09:00", end: "17:00", tz: "UTC" }), palette: Object.freeze([]) });
const VIEW_FIELDS = Object.freeze(["status", "phase", "error", "confidence", "price", "price_low", "price_high", "each", "qty", "material", "colour", "colour_changed", "quality", "rush",
  "ready_by", "valid_until", "multicolour", "fits", "notes_from_owner", "final_price", "limits", "files_deleted"]);
const r2 = x => Math.round(x * 100) / 100;
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

function keyOk(given, want) {
  if (typeof want !== "string" || want.length < 32 || typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const chosen = v => (v.candidates || []).find(c => c.key === v.candidate_key) || (v.candidates || [])[0] || null;
function pickPublicSource(est) {
  const c = (est.candidates || []).find(x => x.size_check === "same" && x.done >= 1 && x.actual_minutes != null);
  return c ? { source: "printed", candidate_key: c.key } : null;
}
function confidenceOf(v) {
  const band = v.print ? v.print.band_pct : null;
  if (v.source === "printed") { const c = chosen(v); return c && c.size_check === "same" && c.done >= 1 && band === 0 ? "exact" : "rough"; }
  if (v.source === "sliced") return band === 0 ? "exact" : "good";
  if (v.source === "geometry") return "rough";
  return null;
}
function bandsFor(confidence, v) {
  const t = Math.max(0, Number(v.print && v.print.band_pct) || 0) / 100;
  if (confidence === "exact") return { g: 0, t: 0 };
  if (confidence === "good") return { g: 0, t };
  const k = v.print && v.print.k_err;
  return { g: k == null ? GEO_G_DEFAULT : Math.max(GEO_G_MIN, k), t };
}
function priceRange(o, priceAt) {
  const step = o.round_to > 0 ? o.round_to : 0.5;
  const down = x => r2(Math.floor(x / step + 1e-9) * step), up = x => r2(Math.ceil(x / step - 1e-9) * step), near = x => r2(Math.round(x / step) * step);
  const floor = x => (o.min_fee != null && x < o.min_fee ? o.min_fee : x);
  if (o.confidence === "exact") {
    const p = priceAt(o.grams, o.minutes);
    if (p == null) return null;
    return o.firm ? { price: floor(near(p)) } : { price_low: floor(down(p * (1 - EXACT_BAND))), price_high: floor(up(p * (1 + EXACT_BAND))) };
  }
  const lo = priceAt(o.grams * (1 - o.g), o.minutes == null ? null : o.minutes * (1 - o.t));
  const hi = priceAt(o.grams * (1 + o.g), o.minutes == null ? null : o.minutes * (1 + o.t));
  if (lo == null || hi == null) return null;
  return { price_low: floor(down(lo)), price_high: floor(up(hi)) };
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function checkOptions(b, S, multicolour) {
  const out = {};
  if (own(b, "qty")) { const q = Number(b.qty); if (!Number.isInteger(q) || q < 1 || q > S.qty_max) return { error: "qty must be 1-" + S.qty_max }; out.qty = q; }
  if (own(b, "palette_id") && !multicolour) {
    const p = (S.palette || []).find(x => x.id === String(b.palette_id));
    if (!p || !p.in_stock) return { error: "that colour is not available" };
    out.palette_id = p.id;
  }
  if (own(b, "quality")) { if (!QUALITIES.includes(b.quality)) return { error: "quality must be standard or strong" }; out.quality = b.quality; }
  if (own(b, "rush")) out.rush = b.rush === true;
  return { options: out };
}
function inputsFor(o, S, multicolour) {
  const stock = (S.palette || []).filter(p => p.in_stock);
  const want = (S.palette || []).find(p => p.id === o.palette_id);
  const pick = multicolour ? null : (want && want.in_stock ? want : stock[0] || null);
  return { qty: o.qty || 1, preset: QUALITIES.includes(o.quality) ? o.quality : "standard", rush: o.rush ? S.rush_multiplier : 1,
           material: pick ? pick.material : "PLA", colour_name: pick ? pick.colour : null, palette_id: pick ? pick.id : null,
           colour_changed: !multicolour && !!o.palette_id && (!pick || pick.id !== o.palette_id) };
}
function checkContact(b) {
  const name = clean(b.name, 80), email = clean(b.email, 200), notes = String(b.notes == null ? "" : b.notes);
  if (!name) return { error: "please give your name" };
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return { error: "please give a valid email" };
  if (notes.length > 2000) return { error: "notes are limited to 2000 characters" };
  return { contact: { name, email, notes: notes.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim() } };
}
function checkPalette(list) {
  if (!Array.isArray(list) || list.length > 60) return { error: "palette must be a list of at most 60 colours" };
  const out = [], ids = new Set();
  for (const e of list) {
    const material = clean(e && e.material, 20).toUpperCase(), colour = clean(e && e.colour, 40), hex = String((e && e.hex) || "");
    if (!material || !colour) return { error: "each colour needs a material and a name" };
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { error: "colour " + colour + ": hex must be #rrggbb" };
    let id = clean(e.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, "") || (material + "-" + colour).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    while (ids.has(id)) id += "-2";
    ids.add(id);
    out.push({ id, material, colour, hex: hex.toLowerCase(), in_stock: e.in_stock !== false });
  }
  return { palette: out };
}
function tzOk(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
function checkSettings(b, cur) {
  const S = { ...QUOTE_DEFAULTS, ...(cur || {}), hours: { ...QUOTE_DEFAULTS.hours, ...((cur || {}).hours || {}) } };
  const numIn = (k, lo, hi) => { if (!own(b, k)) return null; const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) return k + " must be " + lo + "-" + hi; S[k] = v; return null; };
  for (const [k, lo, hi] of [["round_to", 0.01, 100], ["valid_days", 1, 90], ["rush_multiplier", 1, 5], ["qty_max", 1, 1000], ["post_days", 0, 30]]) { const e = numIn(k, lo, hi); if (e) return { error: e }; }
  for (const k of ["enabled", "firm_prices"]) if (own(b, k)) S[k] = b[k] === true;
  if (own(b, "hours")) {
    const h = b.hours || {}, H = { ...S.hours };
    if (own(h, "days")) { if (!Array.isArray(h.days) || !h.days.length || !h.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: "working days are 0 (Sun) to 6 (Sat)" }; H.days = [...new Set(h.days)].sort(); }
    for (const k of ["start", "end"]) if (own(h, k)) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h[k]))) return { error: "hours " + k + " must be HH:MM" }; H[k] = h[k]; }
    if (own(h, "tz")) { if (!tzOk(h.tz)) return { error: "unknown timezone " + String(h.tz).slice(0, 40) }; H.tz = h.tz; }
    if (H.start >= H.end) return { error: "working hours must start before they end" };
    S.hours = H;
  }
  if (own(b, "palette")) { const p = checkPalette(b.palette); if (p.error) return p; S.palette = p.palette; }
  return { settings: S };
}
function customerView(q) {
  const out = {};
  for (const k of VIEW_FIELDS) if (q[k] !== undefined) out[k] = q[k];
  return out;
}
function expired(est, now) {
  if (!est || !est.public) return false;
  if (est.status === "quote") return now - est.created > UNREQUESTED_MS;
  if (est.status === "closed" || est.status === "declined") return est.closed_at != null && now - est.closed_at > CLOSED_MS;
  return false;
}
const INTERNAL_MS = 30 * DAY;
// The estimate module's one prune rule: public quotes by expired(); internal ones unsaved > 30 days.
function dropOnPrune(est, now) { return est.public ? expired(est, now) : (!est.saved && now - est.created > INTERNAL_MS); }
module.exports = { dropOnPrune, QUOTE_DEFAULTS, VIEW_FIELDS, UNREQUESTED_MS, CLOSED_MS, EXACT_BAND, keyOk, pickPublicSource, confidenceOf, bandsFor, priceRange,
                   checkOptions, inputsFor, checkContact, checkPalette, checkSettings, customerView, expired };
