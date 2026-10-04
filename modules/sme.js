// modules/sme.js — the 3D-printing SME: a review store, a lessons store and a
// context builder for a reviewer that runs OUTSIDE the Hub. Fork module
// (ryvin/u1hub), not part of upstream dlgambill/u1hub. Design, privacy and
// the schedule: docs/sme.md.
//
// What it is NOT: it never calls a model, never spends anything, never writes
// a file it does not own. The reviewer is `scripts/sme-runner.js`, a scheduled
// task on the Hub PC that runs Claude Code headless on the person's own
// subscription; it asks this module what to review next (the queue), what the
// reviewer needs to know (the context), and hands back the review. Every
// review is advice with DRAFT changes a person applies by hand in Orca or
// Klipper; nothing here touches a printer, the print queue, a file or
// config.json beyond its own token.
//
// Targets are identified by CONTENT, not path (sme-identity below): two copies
// of a 3MF, or a gcode present in two type folders, are one target with one
// review and a list of paths. A content id is a bounded sample, cached by
// path+size+mtime so a queue build never re-reads a file:
//   * gcode: sha1(size, first 64 KB, last 256 KB) - the header (slicer, date,
//     filament, estimate, thumbnail) and the whole Orca config block, the same
//     bytes advisor.js and costing.js already read; two slices that agree on
//     all of that are the same slice.
//   * 3MF: sha1(size, the zip's central directory) - a per-entry manifest of
//     CRC32 + sizes, so it changes with any byte of any entry and is identical
//     for a re-download or a renamed copy. One tail read (models.js reads the
//     same bytes for a thumbnail); a 222 GB shelf is never hashed in full.
//
// Gcode variants of one model ("..._PLA_6h16m" / "..._9h21m" / "v3") are a
// FAMILY, reviewed once as an iteration history (scripts/sme-family.js): the
// settings that changed between consecutive variants and how the outcomes
// moved, so the review says which change helped, which hurt, which variant is
// best and the one next thing to try. A family is re-reviewed when a member
// appears or new outcomes land, never on a timer. Confirmed improvements and
// regressions become lessons by themselves.
//
// LESSONS (scripts/sme-lessons.js, sme-lessons.json) are condition -> fix pairs
// a review found once: matched before every review and handed to the reviewer
// as KNOWN SOLUTIONS; a target whose every issue is covered by well-confirmed
// lessons is answered from them without a model call. Later prints of a file
// whose review applied a lesson raise or lower that lesson's confidence from
// the ledger's outcomes.
//
// Provides nothing. Uses costing.prints (the ledger), models.index / models.open
// / models.info (the shelf) at call time, so a module that is off degrades to
// "no history" / "no 3MFs", never an error.

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const ADV = require("./advisor.js");
const { facts3mf, platesFromModelSettings } = require("./mesh3mf.js");
const MODELS = require("./models.js");
const { parseConfig } = require("../parser.js");
// The SME core (sme/core/, project-agnostic, no Hub dependency): the review
// schema, the tier router, the lessons rules and the family analysis. This
// module is u1hub's ADAPTER around it; the runner (scripts/sme-runner.js)
// drives the core's pipeline and syncs the shared lessons back here.
const SCHEMA = require("../sme/core/schema.js");
const TIERS = require("../sme/core/tiers.js");
const LESSONS = require("../sme/core/lessons.js");
const FAM = require("../sme/core/family.js");

const { KINDS, VERDICTS, IMPACTS, CONFIDENCE, TUNING_AREAS, EFFECTS, REVIEW_MAX_BYTES, validateReview } = SCHEMA;
const CONTEXT_MAX = 30000;             // chars of context text, hard cap
const FEEDBACK_KEEP = 500;
const HEAD_BYTES = 64 * 1024, TAIL_BYTES = 256 * 1024;   // the same ends advisor.js reads
const ZIP_TAIL = 65536 + 22;
const KLIPPER_TTL_MS = Math.max(0, Number(process.env.U1HUB_SME_KLIPPER_TTL_MS ?? 10 * 60 * 1000));
const KLIPPER_TIMEOUT_MS = 4000;
const KLIPPER_MAX_CHARS = 8000;
const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_DEPTH = Math.min(12, Math.max(1, Number(process.env.U1HUB_SME_MODELS_DEPTH) || 8));   // upstream's shelf walks 4; the SME looks deeper (docs/sme.md)
const MODELS_MAX = 60000;
const SKIP_DIR = /^[._]|^(node_modules|manifests|tool|_consumed|_stage|_reports)$/i;
const QUEUE_CACHE_MS = 15 * 1000;
const QUEUE_WAIT_MS = Math.max(0, Number(process.env.U1HUB_SME_QUEUE_WAIT_MS ?? 20000));
const HASH_CONCURRENCY = 4;
const ERROR_BACKOFF_MS = Math.max(0, Number(process.env.U1HUB_SME_ERROR_BACKOFF_MS ?? 6 * 60 * 60 * 1000));
const RUNS_KEEP = 50;
const GCODE_RE = /\.(gcode|gco|g)$/i;
const FAMILY_MIN = 2;

const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, " ").trim().slice(0, n || 200);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const r2 = v => Math.round(v * 100) / 100;

// ---- pure: content identity ---------------------------------------------------------------------
// Both take the bytes a caller already read; the I/O is below (readEnds / zipTail).
function gcodeContentId(size, head, tail) { return sha1("gcode-ends:" + size + ":" + sha1(head) + ":" + sha1(tail)); }
// tail: the last ZIP_TAIL bytes (or the whole file when smaller). -> { cid, cdOff, cdSize } or null when not a zip.
function zipDirectoryId(size, tail, cd) {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
  const tailStart = size - tail.length;
  const dir = cd || (cdOff >= tailStart ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize) : null);
  if (!dir) return { cid: null, cdOff, cdSize };
  return { cid: sha1("3mf-cd:" + size + ":" + sha1(dir)), cdOff, cdSize };
}

// ---- pure: the Klipper settings summary ---------------------------------------------
// settings: the `configfile.settings` object Klipper returns (section -> keys).
// Only the sections and keys a tuning review reads; gcode macros, pins and
// the hundred keys that never change stay out. -> lines "section.key = value".
const SECTION_RE = /^(printer|extruder\d*|input_shaper|firmware_retraction|heater_bed|bed_mesh|stepper_[xyz]\d?|tmc\d{4} (stepper_[xyz]\d?|extruder\d*)|fan|heater_fan [\w ]+|controller_fan [\w ]+|probe|bltouch|safe_z_home|z_tilt|quad_gantry_level|gcode_arcs|skew_correction|resonance_tester|adxl345( [\w]+)?|print_task_config|filament_switch_sensor [\w ]+|filament_motion_sensor [\w ]+|exclude_object|idle_timeout|retraction)$/i;
const KEY_RE = {
  printer: /^(kinematics|max_velocity|max_accel|max_accel_to_decel|minimum_cruise_ratio|square_corner_velocity|max_z_velocity|max_z_accel)$/,
  extruder: /^(nozzle_diameter|filament_diameter|pressure_advance|pressure_advance_smooth_time|max_extrude_only_velocity|max_extrude_only_accel|max_extrude_only_distance|max_extrude_cross_section|instantaneous_corner_velocity|min_temp|max_temp|min_extrude_temp|rotation_distance|microsteps|gear_ratio|control|pid_kp|pid_ki|pid_kd|full_steps_per_rotation)$/,
  heater_bed: /^(min_temp|max_temp|control|pid_kp|pid_ki|pid_kd)$/,
  bed_mesh: /^(probe_count|mesh_min|mesh_max|algorithm|fade_start|fade_end|horizontal_move_z|speed|mesh_pps)$/,
  stepper: /^(rotation_distance|microsteps|position_max|position_min|homing_speed|full_steps_per_rotation)$/,
  tmc: /^(run_current|hold_current|stealthchop_threshold|interpolate|driver_sgthrs)$/,
  fan: /^(max_power|kick_start_time|off_below|fan_speed|cycle_time)$/
};
function klipperSummary(settings) {
  const lines = [], values = {};
  if (!settings || typeof settings !== "object") return { lines, values, sections: 0 };
  let sections = 0;
  for (const sec of Object.keys(settings).sort()) {
    if (!SECTION_RE.test(sec)) continue;
    const v = settings[sec];
    if (!v || typeof v !== "object") continue;
    const re = /^printer$/.test(sec) ? KEY_RE.printer : /^extruder/.test(sec) ? KEY_RE.extruder : /^heater_bed$/.test(sec) ? KEY_RE.heater_bed
      : /^bed_mesh$/.test(sec) ? KEY_RE.bed_mesh : /^stepper_/.test(sec) ? KEY_RE.stepper : /^tmc/.test(sec) ? KEY_RE.tmc : /fan/.test(sec) ? KEY_RE.fan : null;
    let n = 0;
    for (const k of Object.keys(v).sort()) {
      if (re && !re.test(k)) continue;
      if (/^(pin|dir_pin|step_pin|enable_pin|uart_pin|cs_pin|sensor_pin|heater_pin|spi_bus|i2c_|serial|baud|gcode|.*_gcode)/i.test(k)) continue;
      let val = v[k];
      if (Array.isArray(val)) val = val.map(x => typeof x === "number" ? round4(x) : String(x)).join(", ");
      else if (typeof val === "number") val = round4(val);
      else if (typeof val === "object" && val !== null) val = JSON.stringify(val).slice(0, 120);
      else val = String(val);
      if (val.length > 120) val = val.slice(0, 117) + "...";
      lines.push(sec + "." + k + " = " + val);
      values[sec + "." + k] = typeof v[k] === "number" ? round4(v[k]) : String(val);
      if (++n >= 40) break;
    }
    if (n) sections++;
    if (lines.length >= 200) break;
  }
  return { lines, values, sections };
}
function round4(x) { return Math.round(x * 10000) / 10000; }

// ---- module ------------------------------------------------------------------------------------
function register(ctx) {
  const FILE = path.join(ctx.baseDir, "sme.json");
  const LFILE = path.join(ctx.baseDir, "sme-lessons.json");
  let R = { reviews: {}, hashes: {}, errors: {}, runs: [], feedback: [], paused_until: null, last_error: null };
  let LS = {};
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); if (j && typeof j === "object") R = { reviews: j.reviews || {}, hashes: j.hashes || {}, errors: j.errors || {}, runs: j.runs || [], feedback: j.feedback || [], paused_until: j.paused_until || null, last_error: j.last_error || null }; } catch {}
  try { const j = JSON.parse(fs.readFileSync(LFILE, "utf8")); if (j && typeof j === "object" && j.lessons) LS = j.lessons; } catch {}
  // Same shape as modules/dispatch.js save(): tmp+rename where the filesystem
  // allows it, a direct write where it refuses rename-over-existing.
  let SAVE_FALLBACK = false;
  function writeState(file, obj) {
    const data = JSON.stringify(obj, null, 1), tmp = file + ".tmp";
    if (!SAVE_FALLBACK) {
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); return; }
      catch (e) { SAVE_FALLBACK = true; ctx.hublog("warn", "sme: atomic save failed (" + e.code + " " + e.message + ") - direct writes for the rest of this run"); }
    }
    try { fs.writeFileSync(file, data); } catch (e) { ctx.hublog("warn", "sme: save failed - " + e.message); }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  const save = () => writeState(FILE, R);
  const saveLessons = () => writeState(LFILE, { lessons: LS, saved: Date.now() });
  const tkey = (kind, id) => kind + "|" + id;

  // The runner's token: generated once, kept in config.json under `sme` (which
  // /api/config never echoes - publicCfg is a fixed field list), shown in
  // Settings behind the Hub login, sent back as X-SME-Token.
  function token() {
    try {
      const c = (ctx.cfg.sme && typeof ctx.cfg.sme === "object") ? ctx.cfg.sme : {};
      if (c.token) return String(c.token);
      const t = crypto.randomBytes(24).toString("hex");
      ctx.cfg.sme = { ...c, token: t };
      ctx.saveConfig();
      return t;
    } catch (e) { ctx.hublog("warn", "sme: could not persist a token - " + e.message); return null; }
  }
  const TOKEN = token();
  const tokenOk = req => !!TOKEN && String(req.headers["x-sme-token"] || "") === TOKEN;
  const printers = () => ctx.printers || [];
  const ledger = () => { const g = ctx.use("costing.prints"); try { return typeof g === "function" ? (g() || []) : []; } catch { return []; } };

  // ---- file facts + content ids, cached by path+size+mtime ----------------------------------------
  let HASHES_DIRTY = false;
  const HASHING = { done: 0, total: 0, busy: false };
  async function readEnds(fp) {
    const st = await fsp.stat(fp);
    if (st.size <= HEAD_BYTES + TAIL_BYTES) { const b = await fsp.readFile(fp); return { head: b, tail: b, text: b.toString("utf8"), size: st.size, mtime: st.mtimeMs }; }
    const fh = await fsp.open(fp, "r");
    try {
      const h = Buffer.alloc(HEAD_BYTES); await fh.read(h, 0, HEAD_BYTES, 0);
      const t = Buffer.alloc(TAIL_BYTES); await fh.read(t, 0, TAIL_BYTES, st.size - TAIL_BYTES);
      return { head: h, tail: t, text: h.toString("utf8") + "\n" + t.toString("utf8"), size: st.size, mtime: st.mtimeMs };
    } finally { await fh.close(); }
  }
  function gcodeFacts(text, name) {
    const fb = ADV.briefFromText(text, name);
    const { cfg } = parseConfig(text);
    const settings = {};
    for (const k of ADV.SETTING_KEYS) if (k in cfg) settings[k] = String(cfg[k]).slice(0, 120);
    const mats = fb.lines.filter(l => /^  T\d+: /.test(l)).map(l => (/^  T\d+: (\S+)/.exec(l) || [])[1]).filter(m => m && m !== "?");
    const fileLines = fb.lines.slice(0, Math.max(0, fb.lines.findIndex(l => /^SLICER SETTINGS:/.test(l))));
    const tc = /(\d+) tool changes/.exec(fileLines.join(" "));
    return { settings, materials: [...new Set(mats)], multi_color: fb.meta.palette > 1 || (tc ? Number(tc[1]) > 0 : false), est_minutes: fb.meta.estTime ? require("../parser.js").estMinutes(fb.meta.estTime) : null, grams: fb.meta.total_g != null ? Math.round(fb.meta.total_g) : null };
  }
  // -> { cid, facts } for a gcode path, from the cache when size+mtime agree.
  async function gcodeEntry(fp, st, name) {
    const k = "gcode|" + fp, hit = R.hashes[k];
    if (hit && hit.size === st.size && hit.mtime === st.mtime && hit.cid) return hit;
    const e = await readEnds(fp);
    const rec = { size: e.size, mtime: e.mtime, cid: gcodeContentId(e.size, e.head, e.tail), facts: gcodeFacts(e.text, name), at: Date.now() };
    R.hashes[k] = rec; HASHES_DIRTY = true;
    return rec;
  }
  async function zipTail(fp, size) {
    const fh = await fsp.open(fp, "r");
    try {
      const n = Math.min(size, ZIP_TAIL);
      const tail = Buffer.alloc(n); await fh.read(tail, 0, n, size - n);
      let r = zipDirectoryId(size, tail, null);
      if (r && !r.cid && r.cdSize > 0 && r.cdSize < 8 * 1024 * 1024) { const cd = Buffer.alloc(r.cdSize); await fh.read(cd, 0, r.cdSize, r.cdOff); r = zipDirectoryId(size, tail, cd); }
      return r;
    } finally { await fh.close(); }
  }
  async function modelEntry(fp, st) {
    const k = "3mf|" + fp, hit = R.hashes[k];
    if (hit && hit.size === st.size && hit.mtime === st.mtime && hit.cid) return hit;
    let r = null;
    try { r = await zipTail(fp, st.size); } catch {}
    const rec = { size: st.size, mtime: st.mtime, cid: (r && r.cid) || sha1("3mf-raw:" + st.size + ":" + Math.round(st.mtime) + ":" + fp), zip: !!(r && r.cid), at: Date.now() };
    R.hashes[k] = rec; HASHES_DIRTY = true;
    return rec;
  }
  async function pool(items, fn) {
    HASHING.total += items.length; HASHING.busy = true;
    let i = 0;
    const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch {} HASHING.done++; } };
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, items.length) }, worker));
    HASHING.busy = false;
  }

  // ---- gcode targets --------------------------------------------------------------------------
  async function libraryFiles() {
    const out = [];
    for (const t of (ctx.types || [])) {
      let dir; try { dir = ctx.gcodeFolderFor(t.slug); } catch { continue; }
      let names = [];
      try { names = (await fsp.readdir(dir)).filter(n => GCODE_RE.test(n)); } catch { continue; }
      // A real stat per file, not the library snapshot: identity must follow
      // the file as it is NOW (a re-slice under the same name is new content),
      // and the snapshot refreshes on its own schedule. One async stat per
      // file per catalogue build, which the queue caches for QUEUE_CACHE_MS.
      for (const name of names) {
        let st; try { const s = await fsp.stat(path.join(dir, name)); st = { size: s.size, mtime: s.mtimeMs }; } catch { continue; }
        out.push({ type: t.slug, name, fp: path.join(dir, name), size: st.size, mtime: st.mtime });
      }
    }
    return out;
  }
  const gcodeKey = (slug, name) => slug + ":" + name;
  function parseGcodeKey(key) {
    const i = String(key).indexOf(":");
    if (i <= 0) return null;
    const slug = key.slice(0, i), name = path.basename(key.slice(i + 1));
    if (!name || !(ctx.types || []).some(t => t.slug === slug)) return null;
    return { slug, name, fp: path.join(ctx.gcodeFolderFor(slug), name) };
  }
  function rowsFor(slug, name) { return ledger().filter(r => r && r.file === name && (r.type || "u1") === slug); }
  function outcomeStats(rows) {
    const s = { done: 0, cancelled: 0, error: 0, printers: {}, actual_s: [], ratios: [], first_at: 0, last_at: 0, grams: null };
    const gs = [];
    for (const r of rows) {
      s[r.outcome === "done" ? "done" : r.outcome === "cancelled" ? "cancelled" : "error"]++;
      const pn = r.printer || ("printer " + (r.printer_id + 1));
      s.printers[pn] = s.printers[pn] || { done: 0, failed: 0, type: r.type || "u1", idx: r.printer_id };
      if (r.outcome === "done") s.printers[pn].done++; else s.printers[pn].failed++;
      if (r.outcome === "done" && num(r.seconds) > 0) { s.actual_s.push(r.seconds); if (num(r.est_minutes) > 0) s.ratios.push(r.seconds / (r.est_minutes * 60)); }
      if (r.outcome === "done" && r.material && num(r.material.grams) != null) gs.push(r.material.grams);
      if (!s.first_at || r.at < s.first_at) s.first_at = r.at;
      if (r.at > s.last_at) s.last_at = r.at;
    }
    s.time_ratio = s.ratios.length ? r2(median(s.ratios)) : null;
    s.grams = gs.length ? r2(median(gs)) : null;
    return s;
  }

  // ---- 3MF targets: the SME's own walk of the shelf --------------------------------------------
  // Upstream's index stops four folders down (modules/models.js MAX_DEPTH); a
  // real shelf measured 2026-10-04 keeps 487 of 2,256 files deeper than that.
  // The SME walks to MODELS_DEPTH so those are reviewed too (their review
  // shows on the SME tab; a card only exists for files the Models tab lists).
  function modelsFolder() {
    const ix = ctx.use("models.index");
    try { const i = typeof ix === "function" ? ix() : null; if (i && i.folder) return i.folder; } catch {}
    const c = (ctx.cfg && typeof ctx.cfg.models === "object" && ctx.cfg.models) || {};
    const sl = (ctx.cfg && typeof ctx.cfg.slicer === "object" && ctx.cfg.slicer) || {};
    return path.resolve(String(c.folder || sl.srcFolder || path.join(ctx.baseDir, "models")));
  }
  let MWALK = { at: 0, folder: null, items: [], wrap: new Set(), missing: false };
  let MWALKING = null;
  async function walkModels() {
    const folder = modelsFolder();
    const items = [];
    async function rec(dir, rel, depth) {
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of ents) {
        if (items.length >= MODELS_MAX) return;
        if (it.isDirectory()) { if (!SKIP_DIR.test(it.name) && depth < MODELS_DEPTH) await rec(path.join(dir, it.name), rel + it.name + "/", depth + 1); continue; }
        if (!/\.3mf$/i.test(it.name)) continue;
        let st; try { st = await fsp.stat(path.join(dir, it.name)); } catch { continue; }
        items.push({ rel: rel + it.name, fp: path.join(dir, it.name), size: st.size, mtime: st.mtimeMs, depth: depth + 1 });
      }
    }
    let missing = false;
    try { await fsp.stat(folder); } catch { missing = true; }
    if (!missing) await rec(folder, "", 0);
    const wrappers = (ctx.cfg && ctx.cfg.models && Array.isArray(ctx.cfg.models.wrappers)) ? ctx.cfg.models.wrappers : [];
    const wrap = MODELS.detectWrappers(items.map(i => i.rel), wrappers);
    for (let i = 0; i < items.length; i++) items[i] = { ...items[i], ...MODELS.split(items[i].rel, wrap) };
    MWALK = { at: Date.now(), folder, items, wrap, missing };
    return MWALK;
  }
  async function models(force) {
    if (!force && MWALK.at && Date.now() - MWALK.at < MODELS_TTL_MS && MWALK.folder === modelsFolder()) return MWALK;
    if (!MWALKING) MWALKING = walkModels().finally(() => { MWALKING = null; });
    return MWALKING;
  }
  function modelPath(rel) { const p = path.resolve(modelsFolder(), String(rel || "").replace(/\//g, path.sep)); return p.startsWith(modelsFolder() + path.sep) && /\.3mf$/i.test(p) ? p : null; }
  function links() { try { return JSON.parse(fs.readFileSync(path.join(ctx.baseDir, "models-links.json"), "utf8")).links || {}; } catch { return {}; } }
  // Completed prints per 3MF, by the same name matching the Models tab's
  // "most printed" order uses, fed from the ledger instead of a printer read.
  function modelPrints(items) {
    const jobs = ledger().map(r => ({ filename: r.file, status: r.outcome === "done" ? "completed" : String(r.outcome || "") }));
    try { return MODELS.printCounts(items, jobs, links()).counts; } catch { return new Map(); }
  }

  // ---- printer targets: a whitelisted Klipper settings summary, cached -------------------------
  const KL = new Map();   // idx -> { at, lines, values, sections, ok, error }
  async function klipperFor(idx, force) {
    const p = printers()[idx];
    const base = p && String(p.url || "").replace(/\/+$/, "");
    if (!base) return { ok: false, error: "no url", lines: [], values: {} };
    const hit = KL.get(idx);
    if (!force && hit && Date.now() - hit.at < KLIPPER_TTL_MS) return hit;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), KLIPPER_TIMEOUT_MS);
    let rec;
    try {
      const r = await fetch(base + "/printer/objects/query?configfile=settings", { signal: ac.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const settings = (((j || {}).result || {}).status || {}).configfile;
      const s = klipperSummary(settings && settings.settings);
      let text = s.lines.join("\n");
      if (text.length > KLIPPER_MAX_CHARS) text = text.slice(0, KLIPPER_MAX_CHARS - 20) + "\n[truncated]";
      rec = { at: Date.now(), ok: s.lines.length > 0, lines: text ? text.split("\n") : [], values: s.values, sections: s.sections, error: s.lines.length ? null : "printer answered with no configfile settings", firmware: await firmwareFor(base) };
    } catch (e) {
      rec = { at: Date.now(), ok: false, lines: [], values: {}, sections: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e), firmware: null };
    } finally { clearTimeout(t); }
    KL.set(idx, rec);
    return rec;
  }
  // Two more tiny read-only GETs, cached with the summary above: the Klipper
  // software version (/printer/info) and the config root listing, which says
  // whether paxx12's Snapmaker U1 Extended Firmware overlays (config/extended/
  // klipper/*.cfg, moonraker/*.cfg, extended2.cfg) and its multiACE files are
  // present. A draft for such a printer targets the overlay files, never
  // printer.cfg; a recommendation that needs a newer Snapmaker base must say so.
  async function firmwareFor(base) {
    const get = async p => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), KLIPPER_TIMEOUT_MS); try { const r = await fetch(base + p, { signal: ac.signal }); if (!r.ok) return null; return ((await r.json()) || {}).result || null; } catch { return null; } finally { clearTimeout(t); } };
    const info = await get("/printer/info");
    const list = await get("/server/files/list?root=config");
    const paths = Array.isArray(list) ? list.map(f => String(f.path || "")).filter(Boolean) : [];
    const ext = paths.filter(p => /^extended\//i.test(p));
    const multiace = paths.filter(p => /multiace|(^|\/)ace\.cfg$/i.test(p));
    const sv = info && (info.software_version || info.version) ? String(info.software_version || info.version).slice(0, 80) : null;
    const base_m = sv ? /(\d+\.\d+\.\d+)/.exec(sv) : null;
    return { software_version: sv, hostname: info && info.hostname ? String(info.hostname).slice(0, 60) : null, base_version: base_m ? base_m[1] : null,
             extended: ext.length > 0, extended_files: ext.slice(0, 40), multiace: multiace.length > 0, multiace_files: multiace.slice(0, 10), config_files: paths.length, known: !!(info || Array.isArray(list)) };
  }
  const printerHash = (p, kl) => sha1("printer:" + (p.type || "u1") + ":" + (kl.lines || []).join("\n"));
  function printerIdx(key) { const i = printers().findIndex(p => p && p.name === key); return i >= 0 ? i : null; }

  // ---- the catalogue: unique targets, families, paths -------------------------------------------
  // Built with the queue and kept (CAT) so a path can be resolved to its
  // target afterwards (reviews by path, feedback from the ledger).
  let CAT = { at: 0, gcode: new Map(), models: new Map(), families: new Map(), byPath: new Map() };
  async function buildCatalogue(force) {
    const files = await libraryFiles();
    const gcode = new Map();   // cid -> target
    const byPath = new Map();
    await pool(files, async f => {
      const e = await gcodeEntry(f.fp, f, f.name);
      const key = gcodeKey(f.type, f.name);
      byPath.set("gcode|" + key, e.cid);
      let t = gcode.get(e.cid);
      if (!t) { t = { kind: "gcode", cid: e.cid, paths: [], facts: e.facts, rows: [] }; gcode.set(e.cid, t); }
      t.paths.push({ key, type: f.type, name: f.name, mtime: f.mtime, size: f.size, rows: rowsFor(f.type, f.name).length });
    });
    for (const t of gcode.values()) {
      t.paths.sort((a, b) => b.rows - a.rows || String(a.key).localeCompare(String(b.key)));
      t.rows = [].concat(...t.paths.map(p => rowsFor(p.type, p.name)));
      t.stats = outcomeStats(t.rows);
      t.key = t.paths[0].key; t.name = t.paths[0].name; t.type = t.paths[0].type; t.mtime = Math.max(...t.paths.map(p => p.mtime));
      t.content_hash = t.cid;
    }
    // families: gcode variants of one model, by normalised name
    const fams = new Map();
    for (const t of gcode.values()) {
      const fn = FAM.familyName(t.name);
      if (!fn) continue;
      if (!fams.has(fn)) fams.set(fn, { kind: "family", name: fn, key: "gcode:" + fn, members: [] });
      fams.get(fn).members.push(t);
    }
    const families = new Map();
    for (const [fn, fam] of fams) {
      if (fam.members.length < FAMILY_MIN) continue;
      for (const m of fam.members) m.family = fn;
      const members = fam.members.map(m => ({ cid: m.cid, key: m.key, name: m.name, paths: m.paths.map(p => p.key), settings: (m.facts && m.facts.settings) || {}, mtime: m.mtime, stats: { ...m.stats, est_minutes: m.facts ? m.facts.est_minutes : null, grams: m.stats.grams != null ? m.stats.grams : (m.facts ? m.facts.grams : null) } }));
      const table = FAM.familyTable(members);
      const prints = members.reduce((n, m) => n + (m.stats.done || 0), 0), failed = table.failed;
      const hash = sha1("family:" + table.ordered.map(m => m.cid + ":" + (m.stats.done || 0) + "/" + (m.stats.cancelled || 0) + "/" + (m.stats.error || 0)).join(","));
      families.set(fn, { ...fam, members, table, prints, failed, content_hash: hash, mtime: Math.max(...members.map(m => m.mtime || 0)), types: [...new Set(fam.members.map(m => m.type))] });
    }
    const mw = await models(force);
    const modelsMap = new Map();
    const counts = modelPrints(mw.items);
    await pool(mw.items, async it => {
      const e = await modelEntry(it.fp, it);
      byPath.set("3mf|" + it.rel, e.cid);
      let t = modelsMap.get(e.cid);
      if (!t) { t = { kind: "3mf", cid: e.cid, paths: [], prints: 0, zip: e.zip }; modelsMap.set(e.cid, t); }
      t.paths.push({ key: it.rel, name: it.name, mtime: it.mtime, size: it.size, depth: it.depth, prints: counts.get(it.rel) || 0 });
    });
    for (const t of modelsMap.values()) {
      t.paths.sort((a, b) => b.prints - a.prints || a.depth - b.depth || String(a.key).localeCompare(String(b.key)));
      t.prints = t.paths.reduce((n, p) => n + p.prints, 0);
      t.key = t.paths[0].key; t.name = t.paths[0].name; t.mtime = Math.max(...t.paths.map(p => p.mtime)); t.deep = t.paths.every(p => p.depth > 4); t.content_hash = t.cid;
    }
    if (HASHES_DIRTY) { HASHES_DIRTY = false; save(); }
    CAT = { at: Date.now(), gcode, models: modelsMap, families, byPath, models_folder: mw.folder, models_missing: mw.missing, paths: files.length + mw.items.length };
    return CAT;
  }
  const familyOf = cid => { for (const f of CAT.families.values()) if (f.members.some(m => m.cid === cid)) return f; return null; };
  const familyKey = key => String(key).replace(/^gcode:/, "");

  // ---- the queue ----------------------------------------------------------------------------------
  let QCACHE = null, QBUILD = null;
  async function buildQueue(force) {
    const cat = await buildCatalogue(force);
    const now = Date.now();
    const recentError = k => { const e = R.errors[k]; return !!(e && now - e.at < ERROR_BACKOFF_MS); };
    const stateOf = (kind, id, hash) => { const r = R.reviews[tkey(kind, id)]; return r ? (r.content_hash === hash ? "current" : "changed") : "new"; };
    const groups = { printed: [], models: [], printers: [], fresh: [], changed: [] };
    const totals = { gcode: { reviewed: 0, total: 0 }, family: { reviewed: 0, total: 0 }, "3mf": { reviewed: 0, total: 0 }, printer: { reviewed: 0, total: 0 } };
    let skippedErrors = 0, unreachable = 0;
    const put = (kind, id, hash, item, newGroup) => {
      totals[kind].total++;
      const state = stateOf(kind, id, hash);
      if (state === "current") { totals[kind].reviewed++; return; }
      if (recentError(tkey(kind, id))) { skippedErrors++; return; }
      const it = { kind, content_hash: hash, state, ...item };
      (state === "changed" ? groups.changed : newGroup).push(it);
    };
    for (const t of cat.gcode.values()) {
      if (t.family) continue;   // reviewed as part of its family
      put("gcode", t.cid, t.cid, { key: t.key, name: t.name, type: t.type, paths: t.paths.map(p => p.key), prints: t.stats.done, failed: t.stats.cancelled + t.stats.error, mtime: t.mtime }, t.stats.done > 0 ? groups.printed : groups.fresh);
    }
    for (const f of cat.families.values())
      put("family", f.name, f.content_hash, { key: f.key, name: f.name, types: f.types, members: f.members.map(m => ({ cid: m.cid, key: m.key, name: m.name })), paths: [].concat(...f.members.map(m => m.paths)), prints: f.prints, failed: f.failed, mtime: f.mtime, best: f.table.best_name }, f.prints > 0 ? groups.printed : groups.fresh);
    for (const t of cat.models.values())
      put("3mf", t.cid, t.cid, { key: t.key, name: t.name, paths: t.paths.map(p => p.key), prints: t.prints, mtime: t.mtime, deep: t.deep }, t.prints > 0 ? groups.models : groups.fresh);
    for (let i = 0; i < printers().length; i++) {
      const p = printers()[i]; if (!p || !p.url || !p.name) continue;
      const kl = await klipperFor(i, false);
      if (!kl.ok) { unreachable++; totals.printer.total++; continue; }
      put("printer", p.name, printerHash(p, kl), { key: p.name, name: p.name, type: p.type || "u1", printer_id: i, paths: [p.name] }, groups.printers);
    }
    const byPrints = (a, b) => (b.prints || 0) - (a.prints || 0) || (b.mtime || 0) - (a.mtime || 0) || String(a.key).localeCompare(String(b.key));
    groups.printed.sort(byPrints); groups.models.sort(byPrints);
    const kindRank = k => k === "gcode" ? 0 : k === "family" ? 1 : 2;
    groups.fresh.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (b.mtime || 0) - (a.mtime || 0) || String(a.key).localeCompare(String(b.key)));
    groups.changed.sort((a, b) => ((R.reviews[tkey(a.kind, a.kind === "family" ? familyKey(a.key) : a.kind === "printer" ? a.key : a.content_hash)] || {}).reviewed_at || 0) - ((R.reviews[tkey(b.kind, b.kind === "family" ? familyKey(b.key) : b.kind === "printer" ? b.key : b.content_hash)] || {}).reviewed_at || 0));
    const items = [].concat(
      groups.printed.map(x => ({ ...x, reason: (x.kind === "family" ? "family printed " : "printed ") + x.prints + "x" })),
      groups.models.map(x => ({ ...x, reason: "model printed " + x.prints + "x" })),
      groups.printers.map(x => ({ ...x, reason: "printer tuning" })),
      groups.fresh.map(x => ({ ...x, reason: "new, never printed" })),
      groups.changed.map(x => ({ ...x, reason: x.kind === "family" ? "new variant or new outcomes" : "changed since its review" })));
    const q = { generated_at: now, items, totals, unique_targets: Object.values(totals).reduce((n, t) => n + t.total, 0), paths: cat.paths,
                excluded: { errors: skippedErrors, printers_unreachable: unreachable }, models_folder: cat.models_folder, models_missing: cat.models_missing };
    QCACHE = { at: now, q };
    return q;
  }
  function queue(force) {
    if (!force && QCACHE && Date.now() - QCACHE.at < QUEUE_CACHE_MS) return Promise.resolve(QCACHE.q);
    if (!QBUILD) QBUILD = buildQueue(force).finally(() => { QBUILD = null; });
    return QBUILD;
  }

  // ---- the context ----------------------------------------------------------------------------------
  async function fleetSafe() { try { return (await ctx.fleet()) || []; } catch { return []; } }
  function loadoutLines(idx, fleet) {
    const p = printers()[idx]; if (!p) return [];
    const fe = fleet.find(x => x && x.id === idx) || null;
    return ADV.printerBrief(p, idx, ctx.loadout ? (ctx.loadout(idx) || []) : [], fe, null).filter(l => !/^COLOR MAPPING/.test(l));
  }
  function outcomeLines(s, rows, label) {
    const L = [(label || "OUTCOME HISTORY") + " (the Hub's print ledger): done " + s.done + ", cancelled " + s.cancelled + ", error " + s.error + (s.last_at ? ", last " + new Date(s.last_at).toISOString().slice(0, 10) : "")];
    if (s.actual_s.length) {
      const mins = v => Math.round(v / 60);
      L.push("  actual print time (done): median " + mins(median(s.actual_s)) + " min, min " + mins(Math.min(...s.actual_s)) + ", max " + mins(Math.max(...s.actual_s)) + (s.time_ratio != null ? "; actual / slicer estimate = " + s.time_ratio : ""));
    }
    for (const [pn, v] of Object.entries(s.printers)) L.push("  on " + pn + " (" + v.type + "): " + v.done + " done, " + v.failed + " failed");
    for (const r of rows.filter(r => r.outcome !== "done").slice(-5)) L.push("  " + r.outcome + " on " + r.printer + " " + new Date(r.at).toISOString().slice(0, 16).replace("T", " ") + (num(r.seconds) > 0 ? " after " + Math.round(r.seconds / 60) + " min" : "") + (r.note ? " - " + str(r.note, 120) : ""));
    return L;
  }
  function klipperLines(name, kl) {
    if (!kl.ok) return ["KLIPPER SETTINGS for " + name + ": not readable (" + (kl.error || "unknown") + ")"];
    return ["KLIPPER SETTINGS for " + name + " (read-only, configfile.settings, " + kl.sections + " sections):", ...kl.lines.map(l => "  " + l)];
  }
  function cap(sections, budget) {
    const out = {};
    for (const [k, lines] of Object.entries(sections)) {
      let t = lines.join("\n");
      const b = budget[k] || 4000;
      if (t.length > b) t = t.slice(0, b - 40) + "\n[truncated " + (t.length - b + 40) + " chars]";
      out[k] = t;
    }
    return out;
  }
  function assemble(sections, order) {
    let text = order.map(k => sections[k]).filter(Boolean).join("\n\n");
    if (text.length > CONTEXT_MAX) text = text.slice(0, CONTEXT_MAX - 60) + "\n[truncated: context capped at " + CONTEXT_MAX + " chars]";
    return text;
  }
  // Lessons for a target, and the lines the reviewer reads about them.
  function lessonsFor(facts, settings) {
    const tags = LESSONS.tagsFor(facts);
    const matches = LESSONS.matchLessons({ facts: { ...facts, tags }, settings: settings || {} }, LS);
    const cov = LESSONS.coverage({ ...facts, tags }, matches);
    const lines = matches.length ? ["KNOWN SOLUTIONS (lessons this farm already confirmed; apply and cite by id, do not re-derive):"] : ["KNOWN SOLUTIONS: none match this target yet"];
    for (const m of matches.slice(0, 8)) {
      const L = m.lesson, ch = L.change || {};
      lines.push("  [" + L.id + "] " + (m.exact ? "exact" : "partial") + " match, confirmed " + (L.times_confirmed || 0) + "x, confidence " + (L.confidence || 0) + " (outcomes after use: " + ((L.evidence.outcomes || {}).done || 0) + " done / " + ((L.evidence.outcomes || {}).failed || 0) + " failed): " + L.finding +
                 (ch.text ? " -> " + ch.text : "") + (ch.orca ? " Orca " + JSON.stringify(ch.orca) : ""));
    }
    return { tags, matches, cov, lines, brief: matches.slice(0, 8).map(m => ({ id: m.lesson.id, exact: m.exact, confirmed: m.confirmed, finding: m.lesson.finding, change: m.lesson.change, confidence: m.lesson.confidence, times_confirmed: m.lesson.times_confirmed })) };
  }
  function finish(c, settings) {
    const ls = lessonsFor(c.facts, settings);
    c.facts = { ...c.facts, tags: ls.tags, lessons_cover_all: ls.cov.all_covered };
    c.sections.lessons = ls.lines.join("\n");
    c.order = c.order.concat(["lessons"]);
    c.lessons = ls.brief;
    c.lesson_only = ls.cov.lesson_only;
    c.lesson_review = ls.cov.lesson_only ? LESSONS.lessonReview({ facts: c.facts, settings }, ls.matches, ls.cov) : null;
    c.settings = settings;
    c.tier = TIERS.pickTier(c.facts);
    return c;
  }

  async function gcodeContext(key) {
    const t = parseGcodeKey(key); if (!t) return null;
    let st; try { st = await fsp.stat(t.fp); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    const e = await gcodeEntry(t.fp, { size: st.size, mtime: st.mtimeMs }, t.name);
    const target = CAT.gcode.get(e.cid);
    const paths = target ? target.paths : [{ key, type: t.slug, name: t.name }];
    const ends = await readEnds(t.fp);
    const fb = ADV.briefFromText(ends.text, t.name);
    const iSet = fb.lines.findIndex(l => /^SLICER SETTINGS:/.test(l));
    const fileLines = iSet >= 0 ? fb.lines.slice(0, iSet) : fb.lines, setLines = iSet >= 0 ? fb.lines.slice(iSet) : [];
    if (paths.length > 1) fileLines.push("ALSO AT (identical content): " + paths.filter(p => p.key !== key).map(p => p.key).join(", "));
    const rows = [].concat(...paths.map(p => rowsFor(p.type, p.name))), s = outcomeStats(rows);
    const fleet = await fleetSafe();
    const ranOn = new Set(rows.map(r => r.printer_id).filter(i => Number.isInteger(i)));
    const typeIdx = printers().map((p, i) => i).filter(i => (printers()[i].type || "u1") === t.slug);
    const idxs = [...(ranOn.size ? ranOn : new Set(typeIdx))].filter(i => printers()[i]).slice(0, 4);
    const loadout = ["PRINTERS OF THIS TYPE (" + t.slug + ") AND WHAT IS LOADED NOW" + (ranOn.size ? " (the ones this file ran on first)" : "") + ":"];
    const klip = [];
    for (const i of idxs) { loadout.push(...loadoutLines(i, fleet)); klip.push(...klipperLines(printers()[i].name, await klipperFor(i, false))); }
    const sections = cap({ file: fileLines, settings: setLines, outcome: outcomeLines(s, rows), loadout, klipper: klip }, { file: 3000, settings: 12000, outcome: 3000, loadout: 3000, klipper: 8000 });
    const facts = { kind: "gcode", materials: e.facts.materials, multi_color: !!e.facts.multi_color, prints: { done: s.done, cancelled: s.cancelled, error: s.error }, time_ratio: s.time_ratio, geometry: null, conflicting: false,
                    printer_types: [t.slug], covers: ["settings", "outcome_history", "loadout", ...(klip.some(l => /\(read-only/.test(l)) ? ["klipper"] : [])] };
    return finish({ kind: "gcode", key, content_hash: e.cid, cid: e.cid, name: t.name, paths: paths.map(p => p.key), family: target && target.family ? "gcode:" + target.family : null, sections, order: ["file", "settings", "outcome", "loadout", "klipper"], facts }, e.facts.settings);
  }

  async function familyContext(key) {
    if (!CAT.at) await buildCatalogue(false);
    const f = CAT.families.get(familyKey(key)); if (!f) return null;
    const best = f.table.ordered.find(m => m.cid === f.table.best) || f.table.ordered[f.table.ordered.length - 1];
    const bt = CAT.gcode.get(best.cid);
    const fam = FAM.familyLines({ name: f.name }, f.table);
    const settings = ["SLICER SETTINGS OF THE BEST-BY-THE-NUMBERS VARIANT (" + best.name + "), Orca keys:"];
    for (const [k, v] of Object.entries(best.settings || {})) settings.push("  " + k + " = " + v);
    const outcome = [];
    for (const m of f.table.ordered) { const t = CAT.gcode.get(m.cid); if (t) outcome.push(...outcomeLines(t.stats, t.rows, "OUTCOMES OF " + m.name)); }
    const fleet = await fleetSafe();
    const ranOn = new Set([].concat(...f.members.map(m => (CAT.gcode.get(m.cid) || { rows: [] }).rows.map(r => r.printer_id))).filter(i => Number.isInteger(i)));
    const loadout = ["PRINTERS THIS FAMILY RAN ON AND WHAT IS LOADED NOW:"];
    for (const i of [...ranOn].slice(0, 4)) if (printers()[i]) loadout.push(...loadoutLines(i, fleet));
    const sections = cap({ family: fam, settings, outcome, loadout }, { family: 8000, settings: 10000, outcome: 6000, loadout: 3000 });
    const mats = [...new Set([].concat(...f.members.map(m => (CAT.gcode.get(m.cid) || { facts: {} }).facts.materials || [])))];
    const done = f.members.reduce((n, m) => n + (m.stats.done || 0), 0), cancelled = f.members.reduce((n, m) => n + (m.stats.cancelled || 0), 0), error = f.members.reduce((n, m) => n + (m.stats.error || 0), 0);
    const facts = { kind: "family", materials: mats, multi_color: f.members.some(m => (CAT.gcode.get(m.cid) || { facts: {} }).facts.multi_color), prints: { done, cancelled, error }, time_ratio: bt ? bt.stats.time_ratio : null, geometry: null,
                    conflicting: f.table.conflicting, printer_types: f.types, covers: ["iterations", "settings", "outcome_history", "loadout"], members: f.members.length };
    return finish({ kind: "family", key: f.key, content_hash: f.content_hash, name: f.name, paths: [].concat(...f.members.map(m => m.paths)),
                    members: f.table.ordered.map((m, i) => ({ v: i + 1, cid: m.cid, key: m.key, name: m.name, paths: m.paths, stats: { done: m.stats.done, cancelled: m.stats.cancelled, error: m.stats.error, time_ratio: m.stats.time_ratio } })),
                    iterations: f.table.iterations, best: f.table.best_name, sections, order: ["family", "settings", "outcome", "loadout"], facts }, best.settings || {});
  }

  async function modelContext(rel) {
    const open = ctx.use("models.open");
    if (!open) throw Object.assign(new Error("the Models module is off"), { status: 503 });
    const fp = modelPath(rel); if (!fp) return null;
    let st; try { st = await fsp.stat(fp); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    const e = await modelEntry(fp, { size: st.size, mtime: st.mtimeMs });
    const target = CAT.models.get(e.cid);
    const paths = target ? target.paths.map(p => p.key) : [rel];
    let g;
    try {
      g = await open(rel, async (z, meta) => {
        const ent = n => z.entries.find(x => x.name === n);
        const ps = ent("Metadata/project_settings.config"), ms = ent("Metadata/model_settings.config");
        const psBuf = ps ? await z.content(ps) : null, msBuf = ms ? await z.content(ms) : null;
        const info = ctx.use("models.info") ? ctx.use("models.info")(psBuf, msBuf) : null;
        const pl = platesFromModelSettings(msBuf ? msBuf.toString("utf8") : "");
        const only = pl.plates.length > 1 && pl.plates[0].objects.length ? new Set(pl.plates[0].objects) : null;
        let facts; try { facts = await facts3mf(z, { only, names: pl.names }); } catch (err) { facts = { ok: false, reason: err.message }; }
        const thumb = ADV.pickVisionThumb(z.entries);
        let proj = {};
        try { const j = JSON.parse(psBuf.toString("utf8")); for (const k of ADV.PROJECT_KEYS) if (k in j) proj[k] = Array.isArray(j[k]) ? j[k].map(String).join(";") : String(j[k]); } catch {}
        return { facts, info, project: psBuf ? ADV.projectLines(psBuf) : [], proj, plate: { n: pl.plates.length ? pl.plates[0].id : 1, of: pl.plates.length || 1 }, thumb: thumb ? thumb.name : null, size: meta.size, mtime: meta.mtime };
      });
    } catch (err) { if (err && err.code === "ENOENT") return null; throw err; }
    const name = rel.split("/").pop();
    const lines = ADV.modelBriefLines(name, g.facts, g.info, g.project, g.plate);
    const iProj = lines.findIndex(l => /^DESIGNER'S PROJECT SETTINGS/.test(l));
    const model = iProj >= 0 ? lines.slice(0, iProj) : lines, project = iProj >= 0 ? lines.slice(iProj) : [];
    if (paths.length > 1) model.push("ALSO AT (identical content): " + paths.filter(p => p !== rel).slice(0, 6).join(", "));
    const n = target ? target.prints : 0;
    const linked = Object.entries(links()).filter(([, v]) => paths.includes(v)).map(([k]) => k);
    const prints = ["PRINT HISTORY: " + n + " completed print" + (n === 1 ? "" : "s") + " of gcode sliced from this file (ledger, matched by name" + (linked.length ? " and by link" : "") + ")" + (linked.length ? "; linked gcode: " + linked.slice(0, 6).join(", ") : "")];
    for (const gname of linked.slice(0, 3)) {
      const rows = ledger().filter(r => r.file === gname);
      if (rows.length) prints.push(...outcomeLines(outcomeStats(rows), rows).map(l => "  [" + gname + "] " + l));
    }
    const image = [g.thumb ? "PLATE IMAGE: " + g.thumb + " inside the file (not included in this text; the Hub serves it at /api/models/thumb?file=" + encodeURIComponent(rel) + ")" : "PLATE IMAGE: none in the file"];
    const fleet = await fleetSafe();
    const loadout = ["PRINTERS AND WHAT IS LOADED NOW:"];
    for (let i = 0; i < Math.min(printers().length, 4); i++) if (printers()[i] && printers()[i].name) loadout.push(...loadoutLines(i, fleet));
    const sections = cap({ model, project, prints, image, loadout }, { model: 6000, project: 8000, prints: 3000, image: 500, loadout: 4000 });
    const fx = g.facts && g.facts.ok ? g.facts : null;
    const mats = g.proj.filament_type ? [...new Set(String(g.proj.filament_type).split(";").map(x => x.trim()).filter(Boolean))] : [];
    const facts = { kind: "3mf", materials: mats, multi_color: !!(g.info && g.info.colors && g.info.colors.length > 1), prints: { done: n, cancelled: 0, error: 0 }, time_ratio: null, conflicting: false,
                    geometry: fx ? { steep_pct: fx.overhang.steep_pct, flat_unsupported_pct: fx.overhang.flat_unsupported_pct, bed_contact_pct: fx.overhang.bed_contact_pct_of_footprint, floating: fx.overhang.floating_instances } : null,
                    printer_types: [...new Set(printers().map(p => p && p.type || "u1"))], covers: [...(fx ? ["geometry"] : []), ...(project.length > 1 ? ["project_settings"] : []), "loadout", "print_history"] };
    return finish({ kind: "3mf", key: rel, content_hash: e.cid, cid: e.cid, name, paths, sections, order: ["model", "project", "prints", "image", "loadout"], facts, deep: target ? target.deep : false }, g.proj);
  }

  async function printerContext(key) {
    const idx = printerIdx(key); if (idx == null) return null;
    const p = printers()[idx];
    const kl = await klipperFor(idx, false);
    const fleet = await fleetSafe();
    const fe = fleet.find(x => x && x.id === idx) || null;
    let caps = null; try { caps = await ctx.detectCaps(idx); } catch {}
    const head = ["PRINTER: " + p.name + " (type " + (p.type || "u1") + ")" + (fe ? ", " + (fe.online ? (fe.state || "unknown") : "offline") : "") + (caps ? "; " + caps.heads + " head" + (caps.heads === 1 ? "" : "s") + (caps.multiColor ? ", Snapmaker multi-color API" : ", generic Klipper/Moonraker") : ""),
                  "  (the Hub never writes printer config - every change below is a DRAFT for a person)"];
    const fw = kl.firmware || null;
    if (fw && fw.known) {
      head.push("FIRMWARE: Klipper software_version " + (fw.software_version || "unknown") + (fw.base_version ? " (base " + fw.base_version + ")" : "") + (fw.hostname ? ", host " + fw.hostname : "") + "; config root has " + fw.config_files + " files");
      if (fw.extended) head.push("  paxx12 Snapmaker U1 Extended Firmware overlays PRESENT (config/extended/): " + fw.extended_files.slice(0, 12).join(", ") + (fw.extended_files.length > 12 ? ", ..." : "") + " - a Klipper draft for this printer goes in config/extended/klipper/*.cfg, never printer.cfg");
      else head.push("  no config/extended/ folder (stock config layout)");
      if (fw.multiace) head.push("  multiACE PRESENT (Anycubic ACE feeding this U1): " + fw.multiace_files.join(", "));
    } else head.push("FIRMWARE: not readable right now");
    const rows = ledger().filter(r => r && r.printer_id === idx);
    const now = Date.now(), d30 = rows.filter(r => now - r.at < 30 * 86400000);
    const stat = rs => { const s = { done: 0, cancelled: 0, error: 0 }; for (const r of rs) s[r.outcome === "done" ? "done" : r.outcome === "cancelled" ? "cancelled" : "error"]++; return s; };
    const all = stat(rows), m = stat(d30);
    const ratios = rows.filter(r => r.outcome === "done" && num(r.seconds) > 0 && num(r.est_minutes) > 0).map(r => r.seconds / (r.est_minutes * 60));
    const failFiles = {};
    for (const r of rows) if (r.outcome !== "done") failFiles[r.file] = (failFiles[r.file] || 0) + 1;
    const topFail = Object.entries(failFiles).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const failures = ["FAILURE STATS (ledger): all time done " + all.done + ", cancelled " + all.cancelled + ", error " + all.error + "; last 30 days done " + m.done + ", cancelled " + m.cancelled + ", error " + m.error +
                      (ratios.length ? "; median actual/estimate time ratio " + r2(median(ratios)) + " over " + ratios.length + " prints" : "")];
    if (topFail.length) failures.push("  most failed files: " + topFail.map(([f, n]) => f + " (" + n + ")").join(", "));
    const mats = {};
    for (const r of rows) { const mt = r.material && r.material.material; if (mt) mats[mt] = (mats[mt] || 0) + 1; }
    if (Object.keys(mats).length) failures.push("  materials printed: " + Object.entries(mats).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " x" + v).join(", "));
    const sections = cap({ printer: head, loadout: loadoutLines(idx, fleet), klipper: klipperLines(p.name, kl), failures }, { printer: 1000, loadout: 3000, klipper: 9000, failures: 3000 });
    const facts = { kind: "printer", materials: Object.keys(mats), multi_color: !!(caps && caps.multiColor), prints: { done: all.done, cancelled: all.cancelled, error: all.error }, time_ratio: ratios.length ? r2(median(ratios)) : null,
                    geometry: null, conflicting: false, printer_types: [p.type || "u1"], covers: [...(kl.ok ? ["klipper"] : []), "loadout", "failure_stats", ...(fw && fw.known ? ["firmware"] : [])],
                    firmware: fw ? { software_version: fw.software_version, base_version: fw.base_version, extended: fw.extended, multiace: fw.multiace } : null };
    return finish({ kind: "printer", key, content_hash: printerHash(p, kl), name: p.name, paths: [p.name], printer_id: idx, klipper_ok: kl.ok, firmware: fw, sections, order: ["printer", "loadout", "klipper", "failures"], facts }, kl.values || {});
  }

  async function contextFor(kind, key) {
    if (kind === "gcode") return gcodeContext(key);
    if (kind === "3mf") return modelContext(key);
    if (kind === "printer") return printerContext(key);
    if (kind === "family") return familyContext(key);
    return null;
  }
  // The id a review is stored under, and the hash that must still hold.
  // RESOLVE_WHY carries the reason for a null, for the 404 that follows.
  let RESOLVE_WHY = "";
  async function resolve(kind, key) {
    RESOLVE_WHY = "";
    try {
      if (kind === "gcode") { const t = parseGcodeKey(key); if (!t) { RESOLVE_WHY = "not a <type>:<file> key of a known type"; return null; } const st = await fsp.stat(t.fp); const e = await gcodeEntry(t.fp, { size: st.size, mtime: st.mtimeMs }, t.name); return { id: e.cid, hash: e.cid }; }
      if (kind === "3mf") { const fp = modelPath(key); if (!fp) { RESOLVE_WHY = "not a .3mf under the models folder"; return null; } const st = await fsp.stat(fp); const e = await modelEntry(fp, { size: st.size, mtime: st.mtimeMs }); return { id: e.cid, hash: e.cid }; }
      if (kind === "printer") { const i = printerIdx(key); if (i == null) { RESOLVE_WHY = "no printer of that name"; return null; } const kl = await klipperFor(i, false); if (!kl.ok) RESOLVE_WHY = "its Klipper settings are not readable: " + (kl.error || "unknown"); return kl.ok ? { id: key, hash: printerHash(printers()[i], kl) } : null; }
      if (kind === "family") { if (!CAT.at) await buildCatalogue(false); const f = CAT.families.get(familyKey(key)); if (!f) RESOLVE_WHY = "no family of that name in the catalogue"; return f ? { id: f.name, hash: f.content_hash } : null; }
    } catch (e) { RESOLVE_WHY = String(e && e.message || e); return null; }
    return null;
  }
  // A review for a path: its own, else its family's (with this member's line).
  function reviewForPath(kind, key) {
    if (kind === "printer") return { review: R.reviews[tkey("printer", key)] || null };
    if (kind === "family") return { review: R.reviews[tkey("family", familyKey(key))] || null };
    const cid = CAT.byPath.get(kind + "|" + key);
    if (!cid) return { review: null, unknown: true };
    const own = R.reviews[tkey(kind, cid)] || null;
    const fam = kind === "gcode" ? familyOf(cid) : null;
    const fr = fam ? R.reviews[tkey("family", fam.name)] || null : null;
    const ms = fam ? FAM.memberStatus(fam.table, fr).find(x => x.member === cid) || null : null;
    return { review: own, family_review: fr, member: ms, family: fam ? fam.key : null, cid, stale: own ? own.content_hash !== cid : null };
  }

  // ---- outcome feedback from the ledger ------------------------------------------------------------
  // The lessons store of record is the SME core's SME_HOME/lessons.json on
  // the host (sme/core/store.js); LS here is a MIRROR for the UI and for the
  // context's lesson matching, replaced by the runner on every sync. A print
  // outcome for a file whose review applied lessons is applied to the mirror
  // at once (so the tab moves) and queued for the runner, which applies it to
  // the store of record and syncs the mirror back.
  function onOutcome(ev, outcome) {
    try {
      const idx = Number(ev.id), name = path.basename(String(ev.filename || ""));
      const p = printers()[idx]; if (!p || !name) return;
      const key = gcodeKey(p.type || "u1", name);
      const cid = CAT.byPath.get("gcode|" + key); if (!cid) return;
      const own = R.reviews[tkey("gcode", cid)];
      const fam = familyOf(cid), fr = fam ? R.reviews[tkey("family", fam.name)] : null;
      const ids = new Set();
      for (const rv of [own, fr]) if (rv && rv.reviewed_at < Date.now()) for (const id of [...(rv.lessons_used || []), ...(rv.lessons_created || [])]) ids.add(id);
      if (!ids.size) return;
      const r = LESSONS.feedback(LS, [...ids], outcome, { now: Date.now() });
      LS = r.store; saveLessons();
      R.feedback.push({ at: Date.now(), ids: [...ids], outcome, file: name, printer: p.name, synced: false });
      if (R.feedback.length > FEEDBACK_KEEP) R.feedback.splice(0, R.feedback.length - FEEDBACK_KEEP);
      save();
      ctx.hublog("info", "sme: " + outcome + " print of " + name + " -> " + r.touched.length + " lesson(s) " + (outcome === "done" ? "confirmed" : "doubted") + " (queued for the shared store)");
    } catch (e) { ctx.hublog("warn", "sme: outcome feedback failed - " + e.message); }
  }
  if (ctx.events) {
    ctx.events.on("print.done", ev => onOutcome(ev, "done"));
    ctx.events.on("print.cancelled", ev => onOutcome(ev, "cancelled"));
    ctx.events.on("print.error", ev => onOutcome(ev, "error"));
  }

  // ---- routes -------------------------------------------------------------------------------------------
  const bad = (res, code, msg) => res.status(code).json({ error: msg });
  ctx.app.get("/api/sme/queue", async (req, res) => {
    try {
      const p = queue(String(req.query.refresh || "") === "1");
      const q = await Promise.race([p, new Promise(r => setTimeout(() => r(null), QUEUE_WAIT_MS))]);
      if (!q) return res.json({ fork: "ryvin/u1hub", building: true, progress: { ...HASHING }, items: [], pending: null, paused_until: R.paused_until });
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 20));
      res.json({ fork: "ryvin/u1hub", building: false, ...q, pending: q.items.length, items: q.items.slice(0, limit), limit, paused_until: R.paused_until });
    } catch (e) { bad(res, 500, "queue failed - " + e.message); }
  });
  ctx.app.get("/api/sme/context", async (req, res) => {
    const kind = String(req.query.kind || ""), key = String(req.query.key || "");
    if (!KINDS.includes(kind) || !key) return bad(res, 400, "kind must be one of " + KINDS.join(", ") + " and key is required");
    try {
      if (!CAT.at) await buildCatalogue(false);
      const c = await contextFor(kind, key);
      if (!c) return bad(res, 404, "no such " + kind + ": " + key);
      const text = assemble(c.sections, c.order);
      res.json({ ...c, text, chars: text.length, context_max: CONTEXT_MAX, generated_at: Date.now() });
    } catch (e) { bad(res, e.status || 500, "context failed - " + e.message); }
  });
  const briefOf = r => ({ id: r.id, kind: r.kind, key: r.key, name: r.name, paths: r.paths, members: r.members || null, verdict: r.verdict, summary: r.summary, confidence: r.confidence, reviewed_at: r.reviewed_at, reviewer: r.reviewer, model: r.model, tier: r.tier,
                          escalated: !!r.escalated, from_lessons: !!r.from_lessons, content_hash: r.content_hash, settings: (r.settings || []).length, has_drafts: !!((r.drafts || {}).orca || (r.drafts || {}).klipper),
                          lessons_used: r.lessons_used || [], family: r.family ? { best: r.family.best, next_experiment: r.family.next_experiment, member_status: r.family.member_status } : null, member_lines: r.member_lines || null });
  ctx.app.get("/api/sme/reviews", async (req, res) => {
    const q = req.query || {};
    if (q.key) {
      const kind = String(q.kind || "");
      if (!KINDS.includes(kind)) return bad(res, 400, "kind must be one of " + KINDS.join(", "));
      if (!CAT.at) { try { await buildCatalogue(false); } catch {} }
      const r = reviewForPath(kind, String(q.key));
      if (!r.review && !r.family_review) return bad(res, 404, "no review for that target");
      return res.json(r);
    }
    let list = Object.values(R.reviews);
    if (q.kind) list = list.filter(r => r.kind === q.kind);
    if (q.verdict) list = list.filter(r => r.verdict === String(q.verdict).toUpperCase());
    list.sort((a, b) => b.reviewed_at - a.reviewed_at);
    const limit = Math.min(10000, Math.max(1, parseInt(q.limit, 10) || 200)), offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const page = list.slice(offset, offset + limit);
    res.json({ total: list.length, offset, limit, reviews: String(q.brief || "") === "1" ? page.map(briefOf) : page });
  });
  ctx.app.post("/api/sme/reviews", async (req, res) => {
    if (!tokenOk(req)) return bad(res, 401, "bad or missing X-SME-Token (Settings -> 3D-printing SME shows it)");
    const b = req.body || {};
    const kind = String(b.kind || ""), key = str(b.key, 512);
    if (!KINDS.includes(kind) || !key) return bad(res, 400, "kind must be one of " + KINDS.join(", ") + " and key is required");
    if (!/^[a-f0-9]{40}$/.test(String(b.content_hash || ""))) return bad(res, 400, "content_hash must be the sha1 the context carried");
    const v = validateReview(b.review, kind);
    if (!v.ok) return bad(res, 400, "review rejected: " + v.error);
    if (!CAT.at) { try { await buildCatalogue(false); } catch {} }
    const cur = await resolve(kind, key);
    if (!cur) return bad(res, 404, "no such " + kind + " (or it is unreadable right now): " + key + (RESOLVE_WHY ? " - " + RESOLVE_WHY : ""));
    if (cur.hash !== b.content_hash) return res.status(409).json({ error: "the target changed since this context was built; ask for the queue again", current_hash: cur.hash });
    const usage = (b.usage && typeof b.usage === "object") ? { input_tokens: num(b.usage.input_tokens), output_tokens: num(b.usage.output_tokens), cost_usd: num(b.usage.cost_usd) } : null;
    const paths = kind === "gcode" ? ((CAT.gcode.get(cur.id) || { paths: [{ key }] }).paths.map(p => p.key)) : kind === "3mf" ? ((CAT.models.get(cur.id) || { paths: [{ key }] }).paths.map(p => p.key)) : kind === "family" ? [].concat(...((CAT.families.get(cur.id) || { members: [] }).members.map(m => m.paths))) : [key];
    const prev = R.reviews[tkey(kind, cur.id)];
    // the same id the core used as lesson evidence (review_id in the runner):
    // kind + the first ten hex of the content hash
    const rec = { id: "rv_" + kind + "_" + String(b.content_hash).slice(0, 10), kind, key, name: str(b.name, 200) || key.split("/").pop(), content_hash: b.content_hash, paths, ...v.review,
                  reviewer: str(b.reviewer, 80) || "unknown", model: str(b.model, 80) || null, tier: [1, 2, 3].includes(Number(b.tier)) ? Number(b.tier) : null, from_lessons: b.from_lessons === true,
                  escalated: b.escalated === true, escalated_from: b.escalated === true ? str(b.escalated_from, 80) || null : null, usage,
                  reviewed_at: Date.now(), runtime_ms: num(b.runtime_ms), context_chars: num(b.context_chars), prompt_chars: num(b.prompt_chars), knowledge_sections: Array.isArray(b.knowledge_sections) ? b.knowledge_sections.slice(0, 20).map(s => str(s, 80)) : [],
                  revision: prev ? (prev.revision || 1) + 1 : 1 };
    if (kind === "family") { const f = CAT.families.get(cur.id); rec.members = f ? f.table.ordered.map((m, i) => ({ v: i + 1, cid: m.cid, key: m.key, name: m.name, paths: m.paths })) : []; rec.member_lines = f ? FAM.memberStatus(f.table, rec) : []; }
    // lessons were merged into the shared store by the core before this
    // POST; the runner tells us which ids that produced, and syncs the mirror
    rec.lessons_created = Array.isArray(b.lessons_created) ? [...new Set(b.lessons_created.slice(0, 20).map(x => str(x, 40)).filter(Boolean))] : [];
    rec.lessons_matched = Array.isArray(b.lessons_matched) ? [...new Set(b.lessons_matched.slice(0, 20).map(x => str(x, 40)).filter(Boolean))] : [];
    rec.from_cache = b.from_cache === true;
    R.reviews[tkey(kind, cur.id)] = rec;
    delete R.errors[tkey(kind, cur.id)];
    QCACHE = null;
    save();
    ctx.hublog("info", "sme: " + kind + " " + key + " -> " + rec.verdict + " (" + (rec.from_lessons ? "from lessons" : rec.from_cache ? "from the shared cache" : (rec.model || rec.reviewer) + ", tier " + (rec.tier || "?") + (rec.escalated ? ", escalated" : "")) + ")" +
               (rec.lessons_created.length ? "; lessons +" + rec.lessons_created.length : ""));
    res.json({ ok: true, review: rec });
  });
  // The lessons mirror: the runner replaces it from SME_HOME/lessons.json
  // after applying the feedback queued below; nothing else writes it.
  ctx.app.get("/api/sme/lessons/feedback", (req, res) => {
    const after = num(req.query.after) || 0;
    res.json({ feedback: R.feedback.filter(f => f.at > after && !f.synced), total: R.feedback.length });
  });
  ctx.app.post("/api/sme/lessons/sync", (req, res) => {
    if (!tokenOk(req)) return bad(res, 401, "bad or missing X-SME-Token");
    const b = req.body || {};
    if (!b.lessons || typeof b.lessons !== "object" || Array.isArray(b.lessons)) return bad(res, 400, "lessons must be the { id: lesson } map");
    const next = {};
    for (const [id, L] of Object.entries(b.lessons).slice(0, 5000)) { if (L && typeof L === "object" && L.signature) next[str(id, 40)] = { ...L, id: str(id, 40), signature: LESSONS.normSignature(L.signature) }; }
    LS = next; saveLessons();
    const through = num(b.feedback_through) || 0;
    let acked = 0;
    for (const f of R.feedback) if (!f.synced && f.at <= through) { f.synced = true; acked++; }
    if (acked) save();
    QCACHE = null;
    res.json({ ok: true, lessons: Object.keys(LS).length, feedback_acked: acked });
  });
  ctx.app.post("/api/sme/errors", async (req, res) => {
    if (!tokenOk(req)) return bad(res, 401, "bad or missing X-SME-Token");
    const b = req.body || {};
    const kind = String(b.kind || ""), key = str(b.key, 512);
    if (!KINDS.includes(kind) || !key) return bad(res, 400, "kind and key are required");
    const cur = await resolve(kind, key);
    const id = cur ? cur.id : key;
    const k = tkey(kind, id), prev = R.errors[k];
    R.errors[k] = { at: Date.now(), key, error: str(b.error, 500) || "unknown", attempts: (prev ? prev.attempts : 0) + 1, content_hash: str(b.content_hash, 40) || null };
    R.last_error = { at: Date.now(), kind, key, error: R.errors[k].error };
    QCACHE = null;
    save();
    ctx.hublog("warn", "sme: " + kind + " " + key + " failed - " + R.errors[k].error);
    res.json({ ok: true, error: R.errors[k], backoff_ms: ERROR_BACKOFF_MS });
  });
  ctx.app.post("/api/sme/runs", (req, res) => {
    if (!tokenOk(req)) return bad(res, 401, "bad or missing X-SME-Token");
    const b = req.body || {};
    const run = { at: num(b.started_at) || Date.now(), finished_at: num(b.finished_at) || Date.now(), reviewed: num(b.reviewed) || 0, from_lessons: num(b.from_lessons) || 0, escalated: num(b.escalated) || 0, errors: num(b.errors) || 0,
                  mode: str(b.mode, 40) || "review", note: str(b.note, 300), models: (b.models && typeof b.models === "object") ? Object.fromEntries(Object.entries(b.models).slice(0, 10).map(([k, v]) => [str(k, 40), num(v) || 0])) : {},
                  paused_until: num(b.paused_until) || null, knowledge: (b.knowledge && typeof b.knowledge === "object") ? { updated: str(b.knowledge.updated, 40) || null, bytes: num(b.knowledge.bytes), sections: num(b.knowledge.sections) } : null,
                  cost_usd: num(b.cost_usd), host: str(b.host, 80) };
    R.runs.push(run); if (R.runs.length > RUNS_KEEP) R.runs.splice(0, R.runs.length - RUNS_KEEP);
    if ("paused_until" in b) R.paused_until = num(b.paused_until) || null;
    if (b.last_error) R.last_error = { at: Date.now(), error: str(b.last_error, 500) };
    save();
    res.json({ ok: true, run });
  });
  ctx.app.get("/api/sme/lessons", (req, res) => {
    const q = req.query || {};
    let list = Object.values(LS);
    if (q.type) list = list.filter(L => L.signature.printer_type === String(q.type).toLowerCase() || L.signature.printer_type === "*");
    if (q.material) list = list.filter(L => L.signature.material === String(q.material).toUpperCase() || L.signature.material === "*");
    if (q.tag) list = list.filter(L => L.signature.tag === String(q.tag).toLowerCase() || L.signature.geometry_flags.includes(String(q.tag).toLowerCase()));
    list.sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.times_confirmed || 0) - (a.times_confirmed || 0) || (b.last_seen || 0) - (a.last_seen || 0));
    const byId = Object.fromEntries(Object.values(R.reviews).map(r => [r.id, { kind: r.kind, key: r.key, name: r.name }]));
    res.json({ total: list.length, lessons: list.slice(0, 500).map(L => ({ ...L, source_reviews: ((L.evidence || {}).reviews || []).map(id => ({ id, ...(byId[id] || {}) })) })), tags: LESSONS.TAGS, mirror_of: "SME_HOME/lessons.json (sme/core/store.js)", feedback_pending: R.feedback.filter(f => !f.synced).length });
  });
  ctx.app.get("/api/sme/status", async (req, res) => {
    let totals = QCACHE ? QCACHE.q.totals : null, pending = QCACHE ? QCACHE.q.items.length : null, unique = QCACHE ? QCACHE.q.unique_targets : null, paths = QCACHE ? QCACHE.q.paths : null;
    if (!QCACHE && String(req.query.totals || "") !== "0") { try { const q = await Promise.race([queue(false), new Promise(r => setTimeout(() => r(null), QUEUE_WAIT_MS))]); if (q) { totals = q.totals; pending = q.items.length; unique = q.unique_targets; paths = q.paths; } } catch {} }
    const last = R.runs.length ? R.runs[R.runs.length - 1] : null;
    const paused = R.paused_until && R.paused_until > Date.now() ? R.paused_until : null;
    res.json({ fork: "ryvin/u1hub", enabled: true, reviews: Object.keys(R.reviews).length, lessons: Object.keys(LS).length, errors: Object.keys(R.errors).length, totals, pending, unique_targets: unique, paths, building: !!QBUILD && !QCACHE, hashing: { ...HASHING },
               last_run: last, runs: R.runs.slice(-10).reverse(), last_error: R.last_error, paused_until: paused, token_set: !!TOKEN, context_max: CONTEXT_MAX, error_backoff_ms: ERROR_BACKOFF_MS, models_depth: MODELS_DEPTH,
               tiers: { thresholds: TIERS.THRESHOLDS, defaults: TIERS.DEFAULT_MODELS }, lessons_rules: { confirmed_min: LESSONS.CONFIRMED_MIN, lesson_only_confirms: LESSONS.LESSON_ONLY_CONFIRMS, lesson_only_confidence: LESSONS.LESSON_ONLY_CONFIDENCE },
               schedule: { install: "powershell -ExecutionPolicy Bypass -File scripts\\sme-schedule-install.ps1", hourly: "node scripts/sme-runner.js", monthly: "node scripts/sme-runner.js --refresh-knowledge" } });
  });
  // The token, for Settings (behind the Hub login like every other route) and
  // for a runner on the same PC that was not given SME_TOKEN.
  ctx.app.get("/api/sme/token", (req, res) => res.json({ token: TOKEN || null, header: "X-SME-Token", url: req.protocol + "://" + req.get("host") }));

  ctx.hublog("info", "sme (ryvin/u1hub fork module) armed: " + Object.keys(R.reviews).length + " reviews, " + Object.keys(LS).length + " lessons, models walked to depth " + MODELS_DEPTH);
}

module.exports = { register, validateReview, klipperSummary, gcodeContentId, zipDirectoryId, KINDS, VERDICTS, IMPACTS, CONFIDENCE, TUNING_AREAS, EFFECTS, CONTEXT_MAX, REVIEW_MAX_BYTES };
