// modules/estimate/quote-backend.js — the Hub side of the public quote page
// (u1-quote, quote/). /api/quote-backend/* answers only with X-Quote-Key =
// config.json estimate.quote_key; a quote is an estimate with public:true and
// a 128-bit token, priced by the same compute() as the Estimate tab, and every
// answer is customerView()'s allow-list. The owner's routes are in mountOwner().
// Fork module estimate (ryvin/u1hub). Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md
"use strict";
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const QUOTE = require("./quote.js"), RB = require("./readyby.js"), PRICE = require("./price.js");
const QUOTE_MAX_MB = Math.max(0.001, Number(process.env.U1HUB_QUOTE_MAX_MB) || 100);
const DAY = 24 * 3600 * 1000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

function mount(ctx, H) {
  const conf = () => (ctx.cfg.estimate = ctx.cfg.estimate || {});
  const settings = () => { const s = conf().quote || {}; return { ...QUOTE.QUOTE_DEFAULTS, ...s, hours: { ...QUOTE.QUOTE_DEFAULTS.hours, ...(s.hours || {}) }, palette: s.palette || [] }; };
  const TOKENS = new Map();
  for (const e of Object.values(H.S.estimates)) if (e.public && e.token) TOKENS.set(e.token, e.id);
  const byToken = t => { const id = TOKENS.get(String(t || "")); const e = id ? H.get(id) : null; return e && e.public ? e : null; };
  const bad = (res, code, error, extra) => res.status(code).json({ error, ...(extra || {}) });
  const guard = (req, res, next) => (QUOTE.keyOk(req.get("X-Quote-Key"), conf().quote_key) ? next() : bad(res, 401, "bad quote key"));
  const paused = res => bad(res, 503, "Quotes are paused - try again soon", { paused: true });

  function applyOptions(est) {
    const S = settings(), multicolour = !!est.multicolour;
    const I = QUOTE.inputsFor(est.options || {}, S, multicolour);
    est.inputs = { ...H.DEFAULT_INPUTS, ...(est.inputs || {}), qty: I.qty, material: I.material, preset: I.preset, rush: I.rush };
    return I;
  }
  async function schedule(v, S) {
    const printers = ctx.printers || [], fitting = new Set(v.fits || []);
    let fleet = []; try { fleet = (await ctx.fleet()) || []; } catch {}
    const P = printers.map((p, i) => { const f = fleet[i] || {}; return { name: p.name, type: p.type || "u1", fits: fitting.has(p.name),
      free_in_min: f.state === "printing" || f.state === "paused" ? Math.round((f.etaSec || 0) / 60) : 0 }; });
    const jobs = (H.use("dispatch.jobs", () => [])() || []).filter(j => j.state === "queued");
    const queue = jobs.map(j => ({ type: j.type || "u1", minutes: Number(j.est_minutes) || 0, plates: Number(j.remaining) || 0 }));
    return RB.readyBy({ now: Date.now(), printers: P, queue, job: { minutes: v.print.minutes || 0, plates: v.inputs.qty }, hours: S.hours, post_days: S.post_days, rush: v.inputs.rush > 1 });
  }
  async function publicView(est) {
    const S = settings();
    const job = [...H.JOBS.values()].find(j => j.id === est.id && !j.done);
    const base = { status: est.status, files_deleted: !!est.files_deleted, notes_from_owner: est.owner_note || "", final_price: est.final_price != null ? est.final_price : undefined,
                   valid_until: isoDay(est.created + S.valid_days * DAY),
                   limits: { qty_max: S.qty_max, qualities: ["standard", "strong"], rush_multiplier: S.rush_multiplier, palette: S.palette.map(p => ({ id: p.id, material: p.material, colour: p.colour, hex: p.hex, in_stock: p.in_stock })) } };
    if (job) return QUOTE.customerView({ ...base, phase: "analysing" });
    if ((est.files || []).length && est.files.every(f => f.error)) return QUOTE.customerView({ ...base, phase: "done", error: "We couldn't read this file as a 3D model." });
    const I = applyOptions(est);
    const v = await H.view(est);
    est.multicolour = !!v.print.multicolour;
    const confidence = QUOTE.confidenceOf(v);
    const b = QUOTE.bandsFor(confidence, v);
    const rates = H.use("costing.rates", () => ({}))() || {};
    const pid = v.printer_id, ptype = ((ctx.printers || [])[pid] || {}).type || "u1";
    const priceAt = (g, m) => PRICE.priceEstimate({ grams: g, minutes: m, qty: v.inputs.qty, printer_id: pid, type: ptype, material: v.inputs.material, rush: v.inputs.rush,
      failure_rate: null, name: "quote" }, rates, (ctx.cfg && ctx.cfg.margin) || {}).recommended.price;
    const fits = v.fits == null ? null : v.fits.length > 0;
    const range = fits === false || v.print.grams == null ? null
      : QUOTE.priceRange({ grams: v.print.grams, minutes: v.print.minutes, confidence, g: b.g, t: b.t, firm: S.firm_prices, round_to: S.round_to, min_fee: rates.min_fee != null ? Number(rates.min_fee) : null }, priceAt);
    const sched = fits === false ? null : await schedule(v, S).catch(() => null);
    const each = range ? (range.price != null ? +(range.price / v.inputs.qty).toFixed(2) : undefined) : undefined;
    return QUOTE.customerView({ ...base, phase: "done", confidence, ...(range || {}), each, qty: v.inputs.qty, material: v.inputs.material, colour: v.print.multicolour ? "multi" : I.colour_name,
      colour_changed: I.colour_changed || undefined, quality: v.inputs.preset, rush: v.inputs.rush > 1, ready_by: est.ready_final || (sched ? sched.ready_by : null), multicolour: !!v.print.multicolour, fits });
  }
  const send = (res, est) => publicView(est).then(v => res.json(v)).catch(e => bad(res, 500, "quote failed: " + e.message));

  ctx.app.get("/api/quote-backend/ping", guard, (req, res) => { const S = settings(); res.json({ ok: true, enabled: !!S.enabled, max_mb: QUOTE_MAX_MB }); });
  ctx.app.post("/api/quote-backend/upload", guard, (req, res) => {
    if (!settings().enabled) { req.resume(); return paused(res); }
    const token = crypto.randomBytes(16).toString("hex");
    H.receive(req, res, { cap: QUOTE_MAX_MB * 1048576, capMb: QUOTE_MAX_MB, existing: null,
      make: id => ({ ...H.newEstimate(id), public: true, token, status: "quote", options: { qty: 1, quality: "standard", rush: false }, contact: null, owner_note: "", final_price: null }),
      after: (est) => { TOKENS.set(token, est.id); H.save(); res.json({ token }); },
      analysed: est => { const p = QUOTE.pickPublicSource(est); if (p) { est.source = p.source; est.candidate_key = p.candidate_key; H.save(); } } });
  });
  ctx.app.get("/api/quote-backend/quote/:token", guard, (req, res) => { const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired"); send(res, est); });
  ctx.app.post("/api/quote-backend/quote/:token/options", guard, (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    if (est.status !== "quote") return bad(res, 409, "this quote has been requested; the options are fixed");
    const c = QUOTE.checkOptions(req.body || {}, settings(), !!est.multicolour); if (c.error) return bad(res, 400, c.error);
    est.options = { ...(est.options || {}), ...c.options }; H.save(); send(res, est);
  });
  ctx.app.post("/api/quote-backend/quote/:token/request", guard, async (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    if (est.status !== "quote") return bad(res, 409, "this quote has already been requested");
    const c = QUOTE.checkContact(req.body || {}); if (c.error) return bad(res, 400, c.error);
    est.contact = c.contact; est.status = "new"; est.requested_at = Date.now(); H.save();
    const v = await publicView(est).catch(() => ({}));
    const price = v.price != null ? "$" + v.price : v.price_low != null ? "$" + v.price_low + "-$" + v.price_high : "to be priced";
    try { const n = H.use("notify.send", null); if (n) await n({ title: "New quote request", body: c.contact.name + " <" + c.contact.email + ">: " + v.qty + " x, " + price + (v.ready_by ? ", ready " + v.ready_by : ""), priority: 4, tags: "moneybag" }); } catch {}
    res.json(v);
  });
  ctx.app.post("/api/quote-backend/quote/:token/delete", guard, (req, res) => {
    const est = byToken(req.params.token); if (!est) return bad(res, 404, "This quote has expired");
    fs.rm(path.join(H.DIR, est.id), { recursive: true, force: true }, () => {});
    if (est.status === "quote") { delete H.S.estimates[est.id]; TOKENS.delete(est.token); }
    else { est.files_deleted = true; }
    H.save(); res.json({ ok: true });
  });
  return { publicView, settings, TOKENS, byToken };
}
module.exports = { mount, QUOTE_MAX_MB };
