// modules/estimate.js — the Estimate tab: upload an STL or 3MF, get grams,
// time, the cost layers, what to charge and whether it was printed before,
// as a page and as PDF / CSV / XLSX. Fork module (ryvin/u1hub), not part of
// upstream dlgambill/u1hub. Design: docs/superpowers/specs/2026-10-06-estimate-design.md,
// docs/estimate.md.
//
// The numbers, by source (every one labelled on the page and in the reports):
//   geometry   the mesh measured (mesh3mf / estimate/stl.js) -> grams from the
//              preset's walls and infill x the calibrated k (estimate/geometry.js),
//              minutes from the per-profile-family fit (estimate/calibrate.js)
//   sliced     the 3MF's own slice: Metadata/plate_N.gcode = exact; slice_info
//              = the designer's grams (their time is their printer's, so the
//              minutes come from our fit)
//   printed    an earlier print of the same family (estimate/match.js): the
//              ledger's actual minutes and grams, and its success rate as the
//              failure allowance
// Cost and price come from costing's own projectSummary() / pricing() on one
// synthetic ledger row (estimate/price.js), so a quote can never disagree with
// the Projects tab.
//
// Uploads: one raw-body POST per file (Content-Type application/octet-stream,
// X-File-Name), streamed to <baseDir>/estimates/<id>/<file_id>.<ext> under a
// byte cap; the uploaded name is only ever displayed (escaped). State:
// estimates.json and estimate-calibration.json beside config.json (gitignored).
"use strict";
const fs = require("fs"), fsp = fs.promises, path = require("path"), crypto = require("crypto");
const { facts3mf } = require("./mesh3mf.js");
const { zipOpen } = require("./models.js");
const { parseGcodeMap, estMinutes } = require("../parser.js");
const STL = require("./estimate/stl.js"), GEO = require("./estimate/geometry.js"), SL = require("./estimate/sliced.js");
const ZC = require("./estimate/zipcap.js");
const CAL = require("./estimate/calibrate.js"), MATCH = require("./estimate/match.js"), PRICE = require("./estimate/price.js"), REP = require("./estimate/report.js");
const QUOTE = require("./estimate/quote.js");

const FORK = "ryvin/u1hub";
const MAX_MB = Math.max(0.001, Number(process.env.U1HUB_ESTIMATE_MAX_MB) || 200);
const PRUNE_EVERY_MS = 6 * 3600 * 1000, JOB_TTL_MS = 10 * 60 * 1000, VALID_DAYS = 14;
const LIB_TTL_MS = process.env.U1HUB_ESTIMATE_LIB_TTL_MS != null ? Math.max(0, Number(process.env.U1HUB_ESTIMATE_LIB_TTL_MS) || 0) : 5 * 60 * 1000;
// One zip entry of an uploaded 3MF may inflate to at most this (mesh XML; a plate gcode is streamed instead).
const ENTRY_MAX_BYTES = 256 * 1048576;
const CAL_BOOT_MS = process.env.U1HUB_ESTIMATE_CALIBRATE_BOOT_MS != null ? Number(process.env.U1HUB_ESTIMATE_CALIBRATE_BOOT_MS) : 60000;
const CAL_EVERY_MS = 24 * 3600 * 1000, CAL_MAX_3MF = 60;
const HEAD_BYTES = 8192, TAIL_BYTES = 524288;
// mesh3mf's own budget (160 MB of mesh XML) unless overridden; past it a 3MF
// with slice info is still estimated from that slice (the live Dragon Dynasty
// 3MF is 48 MB zipped and past the budget unzipped).
const MESH_MAX_BYTES = Number(process.env.U1HUB_ESTIMATE_MESH_MAX_MB) > 0 ? Number(process.env.U1HUB_ESTIMATE_MESH_MAX_MB) * 1048576 : undefined;
// Build volumes (mm) by printer type, from the makers' spec pages (checked 2026-10-06):
// https://www.snapmaker.com/en-US/snapmaker-u1 (270 x 270 x 270),
// https://store.anycubic.com/products/kobra-s1 (250 x 250 x 250).
// A type not listed is "size unchecked", never "fits".
const BEDS = { u1: [270, 270, 270], "kobra-s1": [250, 250, 250] };
const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PC"];
const DEFAULT_INPUTS = Object.freeze({ qty: 1, material: "PLA", preset: "standard", walls: null, infill: null, supports: "auto", labor_minutes: 0, rush: 1, printer_id: null, colours: null });
const LIMITS = { qty: [1, 10000], walls: [1, 10], infill: [0, 1], labor_minutes: [0, 6000], rush: [0.5, 5], colours: [1, 16] };
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const newId = p => p + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const r2 = x => Math.round(x * 100) / 100;
const num = v => { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; };
const fitsBed = (size, bed) => { const a = size.slice().sort((x, y) => x - y), b = bed.slice().sort((x, y) => x - y); return a.every((v, i) => v <= b[i]); };
const tick = () => new Promise(r => setImmediate(r));

// A library gcode's facts from its head (max_z_height) and tail (grams, time, profile).
async function gcodeFacts(fp) {
  const st = await fsp.stat(fp);
  const fh = await fsp.open(fp, "r");
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size)); await fh.read(head, 0, head.length, 0);
    const tl = Math.min(TAIL_BYTES, st.size), tail = Buffer.alloc(tl); await fh.read(tail, 0, tl, st.size - tl);
    const ht = head.toString("utf8"), tt = tail.toString("utf8");
    const zm = /;\s*max_z_height:\s*([\d.]+)/.exec(ht);
    const pm = /;\s*print_settings_id = ([^\r\n]*)/.exec(tt);
    const m = parseGcodeMap(tt);
    const used = (m.palette || []).filter(p => p.used);
    const grams = used.reduce((a, p) => a + (p.grams || 0), 0);
    return { grams: grams > 0 ? r2(grams) : null, minutes: estMinutes(m.estTime), max_z: zm ? Number(zm[1]) : null, family: CAL.familyOf(pm ? pm[1] : ""), multi: used.length > 1 };
  } finally { await fh.close(); }
}
function sha1File(fp) {
  return new Promise((resolve, reject) => { const h = crypto.createHash("sha1"); fs.createReadStream(fp).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject); });
}

function register(ctx) {
  const STATE = path.join(ctx.baseDir, "estimates.json"), CALF = path.join(ctx.baseDir, "estimate-calibration.json");
  const DIR = path.join(ctx.baseDir, "estimates");
  // Prototype-free, and looked up by own keys only: "__proto__" or "constructor" is no estimate (final review).
  let S = { estimates: Object.create(null) };
  try { const j = JSON.parse(fs.readFileSync(STATE, "utf8")); if (j && j.estimates) S = { ...j, estimates: Object.assign(Object.create(null), j.estimates) }; } catch {}
  let CALS = { fits: {}, k: null, at: null };
  try { const j = JSON.parse(fs.readFileSync(CALF, "utf8")); if (j && j.fits) CALS = j; } catch {}
  const JOBS = new Map();
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => fsp.writeFile(STATE, JSON.stringify(S, null, 2))).catch(e => ctx.hublog("warn", "estimate: state write failed - " + e.message)));
  const pruneJobs = () => { const now = Date.now(); for (const [k, j] of JOBS) if (j.done && now - j.ts > JOB_TTL_MS) JOBS.delete(k); };
  const fileOf = (est, f) => path.join(DIR, est.id, f.file_id + "." + f.kind);
  const use = (key, dflt) => { const fn = ctx.use(key); return typeof fn === "function" ? fn : dflt; };

  // ---- the library's gcode, for matching and calibration (cached) ----
  // A gcode's facts are read once per (size, mtime): a rescan only stats, and
  // only a new or changed file costs the 8 KB + 512 KB read (final review: the
  // library is ~530 files on a share; re-reading all of them per upload was
  // ~275 MB). LIB_STATS.reads counts the reads (GET /api/estimate/info).
  let LIB = { at: 0, list: [] }, libBusy = null;
  const FACTS = new Map();   // "slug/name" -> { size, mtime, facts }
  const LIB_STATS = { files: 0, reads: 0 };
  async function libraryList() {
    if (Date.now() - LIB.at < LIB_TTL_MS) return LIB.list;
    if (libBusy) return libBusy;
    libBusy = (async () => {
      const out = [], seen = new Set();
      for (const t of ctx.types || []) {
        let dir; try { dir = ctx.gcodeFolderFor(t.slug); } catch { continue; }
        let names = []; try { names = (await fsp.readdir(dir)).filter(n => /\.gcode$/i.test(n)); } catch { continue; }
        for (const name of names) {
          const key = t.slug + "/" + name; seen.add(key);
          try {
            const st = await fsp.stat(path.join(dir, name));
            let hit = FACTS.get(key);
            if (!hit || hit.size !== st.size || hit.mtime !== st.mtimeMs) {
              hit = { size: st.size, mtime: st.mtimeMs, facts: await gcodeFacts(path.join(dir, name)) };
              FACTS.set(key, hit); LIB_STATS.reads++;
              await tick();
            }
            out.push({ name, type: t.slug, ...hit.facts });
          } catch {}
        }
      }
      for (const k of [...FACTS.keys()]) if (!seen.has(k)) FACTS.delete(k);
      LIB_STATS.files = out.length;
      LIB = { at: Date.now(), list: out };
      return out;
    })().finally(() => { libBusy = null; });
    return libBusy;
  }

  // ---- analysis ----
  async function analyse(est, f, job) {
    const fp = fileOf(est, f);
    try {
      job.phase = "measure";
      if (f.kind === "stl") f.facts = await STL.factsStl(await fsp.readFile(fp), f.name);
      else {
        // An upload is untrusted: every entry is inflated asynchronously under a cap (estimate/zipcap.js).
        const z = await ZC.openCapped(fp, { cap: ENTRY_MAX_BYTES });
        try {
          try { f.facts = await facts3mf(z, MESH_MAX_BYTES ? { maxBytes: MESH_MAX_BYTES } : undefined); } catch (e) { f.facts = { ok: false, reason: e.message }; }
          if (f.facts && f.facts.ok !== false && !(f.facts.volume_cm3 > 0)) f.facts = { ok: false, reason: "not a closed solid (the mesh has no volume)" };
          try { f.sliced = await SL.slicedFrom(z); } catch (e) { f.sliced = null; }
        } finally { await z.close().catch(() => {}); }
        if (!f.facts || f.facts.ok === false) {
          const why = (f.facts && f.facts.reason) || "no printable mesh in the 3MF";
          if (!f.sliced) throw new Error(why);
          f.warning = why + " - estimated from the file's own slice";
        }
      }
      job.phase = "match";
      const names = [f.name];
      try {
        const idx = use("models.index", () => null)();
        if (idx && Array.isArray(idx.items)) {
          const size = (await fsp.stat(fp)).size, hash = await sha1File(fp);
          const items = idx.items.filter(it => it && it.size === size).map(it => ({ ...it, name: path.basename(it.rel) }));
          names.push(...await MATCH.sameFileNames(size, hash, items, it => sha1File(path.join(idx.folder, it.rel))));
        }
      } catch {}
      const measured = f.facts && f.facts.ok !== false;
      const height = !measured ? null : (f.facts.tallest ? f.facts.tallest.height_mm : f.facts.height_mm);
      const ledger = use("costing.prints", () => [])() || [];
      const library = await libraryList();
      const seen = new Set((est.candidates || []).map(c => c.key));
      for (const n of names) for (const c of MATCH.candidates({ name: n, height_mm: height, ledger, library })) {
        if (seen.has(c.key)) continue;
        seen.add(c.key); est.candidates = (est.candidates || []).concat([{ ...c, same_file: n !== f.name }]);
      }
      f.error = null;
      job.phase = "done";
    } catch (e) {
      f.error = e.message; job.error = e.message; job.phase = "error";
    }
    job.done = true;
    save();
  }

  // ---- the numbers ----
  async function compute(est) {
    const I = { ...DEFAULT_INPUTS, ...(est.inputs || {}) };
    const usable = (est.files || []).filter(f => !f.error && ((f.facts && f.facts.ok !== false) || f.sliced));
    const files = usable.filter(f => f.facts && f.facts.ok !== false);   // measured meshes
    const size = [0, 0, 0];
    let volume = 0, painted = 0, filaments = 0, tallest = null, plates = 0;
    for (const f of files) {
      (f.facts.size_mm || []).forEach((v, i) => { size[i] = Math.max(size[i], v); });
      volume += f.facts.volume_cm3 || 0;
      painted = Math.max(painted, (f.facts.paint && f.facts.paint.colors) || 0);
      if (f.facts.tallest && (!tallest || f.facts.tallest.height_mm > tallest.height_mm)) tallest = f.facts.tallest;
    }
    for (const f of usable) { filaments = Math.max(filaments, f.sliced ? f.sliced.filaments.length : 0); plates += f.sliced ? f.sliced.plates : 1; }
    const colours = num(I.colours) || Math.max(painted, filaments, 1);
    const mode = colours > 1 ? "multi" : "single";
    const k = CALS.k && CALS.k[mode] && CALS.k[mode].k ? CALS.k[mode].k : 1;
    const geo = files.map(f => GEO.gramsFrom(f.facts, { preset: I.preset, walls: I.walls, infill: I.infill, material: I.material, supports: I.supports, k }));
    const order = { no: 0, maybe: 1, yes: 2 };
    const supports_needed = geo.reduce((w, g) => order[g.supports_needed] > order[w] ? g.supports_needed : w, "no");
    const geoGrams = r2(geo.reduce((a, g) => a + g.grams, 0));
    const fit = CAL.fitFor(CALS.fits, (GEO.PRESETS[I.preset] || GEO.PRESETS.standard).family, mode);
    const band = Math.round((fit.err || 0) * 100);
    const sources = [];
    if (usable.length && files.length === usable.length) sources.push("geometry");
    if (usable.length && usable.every(f => f.sliced)) sources.push("sliced");
    const cands = est.candidates || [];
    if (cands.length) sources.push("printed");
    // The chosen source when it is still available, else the first measurable one.
    // The chosen source when it is still available; otherwise the file's own slice when every file has one
    // (it beats a geometry guess), else geometry.
    let source = sources.includes(est.source) ? est.source : (sources.includes("sliced") ? "sliced" : (sources.find(x => x !== "printed") || "none"));
    let grams = null, minutes = null, band_pct = null, failure_rate = null, label = "nothing measurable";
    if (source === "geometry") { grams = geoGrams; minutes = CAL.minutesFrom(geoGrams, fit); band_pct = band; label = "geometry ±" + band + " %" + (fit.source === "fallback" ? " (time: fallback fit)" : ""); }
    let designer_minutes = null;
    if (source === "sliced") {
      grams = r2(usable.reduce((a, f) => a + f.sliced.grams, 0));
      designer_minutes = usable.reduce((a, f) => a + (f.sliced.designer_minutes || 0), 0) || null;
      if (usable.every(f => f.sliced.source === "plate-gcode")) { minutes = usable.reduce((a, f) => a + (f.sliced.minutes || 0), 0); band_pct = 0; label = "exact (sliced 3MF)"; }
      else { minutes = CAL.minutesFrom(grams, fit); band_pct = band; label = "grams from the file's slice, time estimated ±" + band + " %"; }
    } else if (source === "printed") {
      const c = cands.find(x => x.key === est.candidate_key) || cands[0];
      grams = c.grams != null ? c.grams : (files.length ? geoGrams : null);
      minutes = c.actual_minutes != null ? c.actual_minutes : (c.slicer_minutes != null ? c.slicer_minutes : CAL.minutesFrom(grams, fit));
      band_pct = c.actual_minutes != null ? 0 : band;
      failure_rate = c.success_rate;
      label = "exact (printed before: " + c.file + ")" + (c.size_check === "different" ? ", different size!" : c.size_check === "unchecked" ? ", size not checked" : "");
    }
    const printers = ctx.printers || [];
    const fits = [], fits_unchecked = [];
    printers.forEach((p, i) => { const bed = BEDS[p.type || "u1"]; if (!bed) fits_unchecked.push(p.name); else if (files.length && fitsBed(size, bed)) fits.push({ i, name: p.name, type: p.type || "u1" }); });
    let schedule = [];
    try { schedule = ((await ctx.fleet()) || []).map(p => ({ name: p.name, state: p.state, free_in_min: p.state === "printing" || p.state === "paused" ? Math.round((p.etaSec || 0) / 60) : 0 })); } catch {}
    const pid = num(I.printer_id) != null && printers[I.printer_id] ? I.printer_id : (fits[0] ? fits[0].i : 0);
    const ptype = printers[pid] ? (printers[pid].type || "u1") : "u1";
    const price = PRICE.priceEstimate({ grams, minutes, qty: I.qty, printer_id: pid, type: ptype, material: I.material, labor_minutes: I.labor_minutes, rush: I.rush, failure_rate, name: (est.files || []).map(f => f.name).join(", ") },
                                      use("costing.rates", () => ({}))() || {}, (ctx.cfg && ctx.cfg.margin) || {});
    return {
      inputs: I, source, sources_available: sources, source_label: label,
      print: { grams, minutes, plates: plates || files.length, supports_needed, supports_g: r2(geo.reduce((a, g) => a + g.supports_g, 0)), colours, band_pct, designer_minutes,
               brim: !!(tallest && tallest.aspect > 3), multiace: colours > 4,
               k_err: CALS.k && CALS.k[mode] && CALS.k[mode].err != null ? CALS.k[mode].err : null, multicolour: colours > 1 },
      model: { size_mm: files.length ? size : null, volume_cm3: files.length ? r2(volume) : null, measured: files.length === usable.length && usable.length > 0 }, fits: files.length ? fits.map(f => f.name) : null, fits_unchecked, schedule, printer_id: pid,
      cost: price.cost, pricing: price.pricing, recommended: price.recommended, blanks: price.blanks,
      fit: { key: fit.key, source: fit.source, n: fit.n }, calibration_k: k
    };
  }
  async function view(est) {
    const c = await compute(est);
    let actual = null;
    if (est.project_id) { try { const s = use("costing.projectSummary", () => null)(est.project_id); actual = s ? s.cost : null; } catch {} }
    return { ...est, ...c, name: (est.files || []).map(f => f.name).join(", "), qty: c.inputs.qty, material: c.inputs.material, preset: c.inputs.preset, valid_days: VALID_DAYS, actual };
  }
  function checkInputs(b) {
    const out = {};
    for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
      if (!(key in b)) continue;
      if (b[key] === null || b[key] === "") { out[key] = null; continue; }
      const v = num(b[key]);
      if (v == null || v < lo || v > hi) return { error: key + " must be " + lo + "-" + hi };
      out[key] = key === "qty" || key === "walls" || key === "colours" ? Math.round(v) : v;
    }
    if ("preset" in b) { if (!Object.prototype.hasOwnProperty.call(GEO.PRESETS, b.preset)) return { error: "preset must be one of " + Object.keys(GEO.PRESETS).join(", ") }; out.preset = b.preset; }
    if ("supports" in b) { if (!["auto", "on", "off"].includes(b.supports)) return { error: "supports must be auto, on or off" }; out.supports = b.supports; }
    if ("material" in b) { const m = String(b.material || "").trim().toUpperCase(); if (!m || m.length > 20) return { error: "material must be 1-20 characters" }; out.material = m; }
    if ("printer_id" in b) {
      if (b.printer_id === null || b.printer_id === "") out.printer_id = null;
      else { const i = Number(b.printer_id); if (!Number.isInteger(i) || !(ctx.printers || [])[i]) return { error: "printer_id is not a printer" }; out.printer_id = i; }
    }
    return { inputs: out };
  }
  const get = id => { const k = String(id || ""); return Object.prototype.hasOwnProperty.call(S.estimates, k) ? S.estimates[k] : null; };
  const bad = (res, code, error, extra) => res.status(code).json({ error, ...(extra || {}) });

  const newEstimate = id => ({ id, created: Date.now(), files: [], candidates: [], inputs: { ...DEFAULT_INPUTS }, source: null, candidate_key: null, saved: false, project_id: null, client_id: null, note: "" });
  // The public quote backend and the owner's quote routes (estimate/quote-backend.js), mounted before /:id.
  const H = { S, get, save: () => save(), compute, view, receive, newEstimate, JOBS, DIR, fileOf, use, checkInputs, DEFAULT_INPUTS, pruneAt };
  try { require("./estimate/quote-backend.js").mount(ctx, H); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }

  // ---- routes (fixed paths before /:id) ----
  ctx.app.get("/api/estimate/info", (req, res) => res.json({ enabled: true, fork: FORK, max_mb: MAX_MB, library: { ...LIB_STATS }, presets: Object.entries(GEO.PRESETS).map(([key, p]) => ({ key, label: p.label })), materials: MATERIALS,
    calibration: { at: CALS.at, fits: CALS.fits, k: CALS.k } }));
  ctx.app.get("/api/estimate/job", (req, res) => {
    pruneJobs();
    const j = JOBS.get(String(req.query.job || ""));
    if (!j) return bad(res, 404, "no such job");
    res.json({ phase: j.phase, done: j.done, error: j.error, id: j.id, file_id: j.file_id });
  });
  // One raw-body upload, streamed under a byte cap. Shared by the Estimate tab and the public
  // quote backend (estimate/quote-backend.js): opts = { cap, capMb, existing, make(id), after?, analysed? }.
  function receive(req, res, opts) {
    let name = "";
    try { name = path.basename(decodeURIComponent(String(req.get("X-File-Name") || ""))); } catch { name = ""; }
    const m = /\.(stl|3mf)$/i.exec(name);
    if (!m) { req.resume(); return bad(res, 400, "only .stl and .3mf files can be estimated"); }
    const kind = m[1].toLowerCase();
    const existing = opts.existing || null;
    const id = existing ? existing.id : newId("est_"), file_id = newId("f_");
    const dir = path.join(DIR, id), fp = path.join(dir, file_id + "." + kind);
    const cap = opts.cap;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { req.resume(); return bad(res, 500, "could not store the upload: " + e.message); }
    const ws = fs.createWriteStream(fp);
    let bytes = 0, over = false, finished = false;
    // Synchronous on purpose: by the time the refusal is answered, nothing of the upload is left.
    const cleanup = () => { try { ws.destroy(); } catch {} try { fs.rmSync(fp, { force: true }); if (!existing) fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    req.on("data", chunk => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > cap) { over = true; cleanup(); res.set("Connection", "close"); bad(res, 413, "over the " + opts.capMb + " MB limit"); return; }
      if (!ws.write(chunk)) { req.pause(); ws.once("drain", () => req.resume()); }
    });
    req.on("aborted", () => { if (!finished && !over) { over = true; cleanup(); } });
    req.on("end", () => {
      if (over) return;
      ws.end(() => {
        finished = true;
        if (!bytes) { cleanup(); return bad(res, 400, "the file is empty"); }
        const est = existing || opts.make(id);
        S.estimates[id] = est;
        const f = { file_id, name, kind, bytes, facts: null, sliced: null, error: null };
        est.files.push(f);
        save();
        const jobId = newId("j_");
        const job = { id, file_id, phase: "queued", done: false, error: null, ts: Date.now() };
        JOBS.set(jobId, job);
        if (opts.after) opts.after(est, f, job, jobId); else res.json({ id, file_id, jobId });
        analyse(est, f, job).then(() => opts.analysed && opts.analysed(est)).catch(e => { job.error = e.message; job.done = true; });
      });
    });
    ws.on("error", e => { if (!over) { over = true; cleanup(); bad(res, 500, "could not store the upload: " + e.message); } });
  }
  ctx.app.post("/api/estimate/upload", (req, res) => receive(req, res, { cap: MAX_MB * 1048576, capMb: MAX_MB, existing: get(req.query.id), make: newEstimate }));
  ctx.app.get("/api/estimate", (req, res) => {
    const list = Object.values(S.estimates).filter(e => e.saved).sort((a, b) => b.created - a.created);
    Promise.all(list.map(e => view(e).then(v => ({ id: e.id, name: v.name, created: e.created, recommended: v.recommended, project_id: e.project_id, client_id: e.client_id, note: e.note, actual: v.actual })).catch(() => null)))
      .then(saved => res.json({ saved: saved.filter(Boolean) }));
  });
  ctx.app.get("/api/estimate/:id", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    res.json(await view(est));
  });
  ctx.app.post("/api/estimate/:id/inputs", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    const c = checkInputs(req.body || {}); if (c.error) return bad(res, 400, c.error);
    est.inputs = { ...DEFAULT_INPUTS, ...(est.inputs || {}), ...c.inputs }; save();
    res.json(await view(est));
  });
  ctx.app.post("/api/estimate/:id/source", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    const b = req.body || {}, cur = await compute(est);
    if (!cur.sources_available.includes(b.source)) return bad(res, 400, "source '" + String(b.source) + "' is not available for this estimate (" + cur.sources_available.join(", ") + ")");
    if (b.source === "printed") {
      const c = (est.candidates || []).find(x => x.key === b.key);
      if (!c) return bad(res, 400, "no such earlier print");
      est.candidate_key = c.key;
    }
    est.source = b.source; save();
    res.json(await view(est));
  });
  ctx.app.post("/api/estimate/:id/save", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    const b = req.body || {};
    est.saved = true;
    if ("project_id" in b) est.project_id = b.project_id ? String(b.project_id).slice(0, 80) : null;
    if ("client_id" in b) est.client_id = b.client_id ? String(b.client_id).slice(0, 80) : null;
    if ("note" in b) est.note = String(b.note || "").slice(0, 500);
    save();
    res.json(await view(est));
  });
  ctx.app.get("/api/estimate/:id/report", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    const V = await view(est), vw = req.query.view === "internal" ? "internal" : "quote", fmt = String(req.query.format || "pdf");
    const base = "estimate-" + est.id + (vw === "internal" ? "-internal" : "-quote");
    if (fmt === "pdf") return res.type("html").set("Content-Disposition", 'inline; filename="' + base + '.html"').send(REP.html(V, vw));
    if (fmt === "csv") return res.type("text/csv; charset=utf-8").set("Content-Disposition", 'attachment; filename="' + base + '.csv"').send(REP.csv(V));
    if (fmt === "xlsx") return res.type(MIME_XLSX).set("Content-Disposition", 'attachment; filename="' + base + '.xlsx"').send(REP.xlsx(V));
    bad(res, 400, "format must be pdf, csv or xlsx");
  });
  ctx.app.get("/api/estimate/:id/thumb", async (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    const f = (est.files || []).find(x => x.file_id === String(req.query.file_id || ""));
    if (!f || f.kind !== "3mf") return bad(res, 404, "no thumbnail");
    let z = null;
    try {
      z = await zipOpen(fileOf(est, f));
      const e = z.entries.find(x => /^\/?Metadata\/plate_1\.png$/i.test(x.name)) || z.entries.find(x => /^\/?(Metadata|Auxiliaries\/\.thumbnails)\/[^/]*\.png$/i.test(x.name));
      if (!e) return bad(res, 404, "no thumbnail");
      res.type("png").send(await z.content(e));
    } catch (e) { bad(res, 404, "no thumbnail"); }
    finally { if (z) await z.close().catch(() => {}); }
  });
  ctx.app.delete("/api/estimate/:id", (req, res) => {
    const est = get(req.params.id); if (!est) return bad(res, 404, "no such estimate");
    delete S.estimates[est.id]; save();
    fs.rm(path.join(DIR, est.id), { recursive: true, force: true }, () => {});
    res.json({ ok: true });
  });

  // ---- housekeeping ----
  // One rule (estimate/quote.js dropOnPrune): public quotes by their retention, internal estimates unsaved > 30 days.
  function pruneAt(now) {
    for (const est of Object.values(S.estimates)) if (QUOTE.dropOnPrune(est, now)) { delete S.estimates[est.id]; fs.rm(path.join(DIR, est.id), { recursive: true, force: true }, () => {}); }
    save();
  }
  const prune = () => pruneAt(Date.now());
  prune();
  const tp = setInterval(prune, PRUNE_EVERY_MS); if (tp.unref) tp.unref();

  async function calibrate() {
    const groups = {};
    for (const g of await libraryList()) if (g.grams > 0 && g.minutes > 0) (groups[g.family + "-" + (g.multi ? "multi" : "single")] = groups[g.family + "-" + (g.multi ? "multi" : "single")] || []).push([g.grams, g.minutes]);
    const fits = {};
    for (const [key, pts] of Object.entries(groups)) { const f = CAL.fitPower(pts); if (f) fits[key] = f; }
    const pairs = { single: [], multi: [] };
    const idx = use("models.index", () => null)(), open = use("models.open", null);
    if (idx && Array.isArray(idx.items) && open) {
      let n = 0;
      for (const it of idx.items) {
        if (n >= CAL_MAX_3MF) break;
        if (!/\.3mf$/i.test(it.rel || "")) continue;
        try {
          // Slice info first (a few KB); the mesh is measured only for a file that has it.
          const r = await open(it.rel, async z => { const sl = await SL.slicedFrom(z); return sl && sl.source === "slice-info" ? { sliced: sl, facts: await facts3mf(z) } : { sliced: sl, facts: null }; });
          if (r.facts && r.facts.ok && r.sliced && r.sliced.source === "slice-info" && r.sliced.grams > 0) {
            n++;
            pairs[r.sliced.filaments.length > 1 ? "multi" : "single"].push([GEO.gramsFrom(r.facts, { preset: "standard" }).model_g, r.sliced.grams]);
          }
        } catch {}
        await tick();
      }
    }
    CALS = { fits, k: { single: CAL.fitK(pairs.single), multi: CAL.fitK(pairs.multi) }, at: Date.now() };
    await fsp.writeFile(CALF, JSON.stringify(CALS, null, 2)).catch(() => {});
    ctx.hublog("info", "estimate: calibrated - time " + Object.entries(fits).map(([k, f]) => k + " n" + f.n + " ±" + Math.round(f.err * 100) + "%").join(", ")
      + "; grams k " + ["single", "multi"].map(m => m + (CALS.k[m] ? " " + CALS.k[m].k + " (n" + CALS.k[m].n + " ±" + Math.round(CALS.k[m].err * 100) + "%)" : " none")).join(", "));
  }
  if (CAL_BOOT_MS > 0) {
    const run = () => calibrate().catch(e => ctx.hublog("warn", "estimate: calibration failed - " + e.message));
    const t0 = setTimeout(run, CAL_BOOT_MS); if (t0.unref) t0.unref();
    const t1 = setInterval(run, CAL_EVERY_MS); if (t1.unref) t1.unref();
  }

  ctx.hublog("info", "estimate (" + FORK + " fork module) armed: uploads up to " + MAX_MB + " MB, calibration " + (CALS.at ? "from " + new Date(CALS.at).toISOString() : "not yet run"));
}
module.exports = { register, MAX_MB, BEDS, fitsBed };
