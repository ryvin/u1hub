// modules/multiace.js — "Print via multiACE": send a >4-colour (or any
// not-loaded-colour) job to a Snapmaker U1 that multiACE (decay71/multiACE)
// feeds from Anycubic ACE units. Fork module (ryvin/u1hub), not part of
// upstream dlgambill/u1hub. Design and the read-only research behind it:
// docs/multiace.md.
//
// The Hub never rewrites gcode and never re-implements the engine. It drives
// multiACE's OWN preflight API on the printer (upstream multiace/docs/
// ENGINE_API.md, LOADOUT_API.md, SEND_TO_MULTIACE.md; web backend main.py):
//
//   1. probe   GET <printer>/multiace/api/version 200  AND  objects/query?ace
//              carries api_version with major 1  -> the printer "is multiACE"
//              (cached PROBE_TTL_MS; every other printer is left exactly as is)
//   2. check   POST <printer>/multiace/api/preflight (the ORIGINAL file,
//              streamed as multipart) -> the engine's report: file colours,
//              live slots, three plans (slicer = as sliced against what is
//              loaded; optimize / layer = a PROPOSED loadout) with their
//              mapping rows, tiers and swap counts
//   3. show    the Hub adds, per plan: est. added time = swaps x swap_seconds,
//              est. purge top-up along the plan's swap sequence from the file's
//              own flush matrix (the engine's stamp formula, below), a CIEDE2000
//              dE per row (advisory; the engine's tier is the truth) and the
//              spool MOVES a proposed plan needs. Moves are suggested, never
//              made: the Hub touches no slot, spool or label.
//   4. print   SET_PRINT_EXTRUDER_MAP i->i (0..3) + SET_PRINT_USED_EXTRUDERS
//              over Moonraker (the engine relies on synthetic T % 4 == head
//              and stock's identity table; a stale non-identity table from an
//              earlier Hub-mapped print would fight it), then
//              POST /multiace/api/preflight/print {token, mode, remap} -> the
//              engine rewrites, uploads and STARTS the print; the Hub polls
//              /preflight/print/status and records what it sent for costing.
//   5. too big 413 from /api/preflight (the U1 analyses on its own CPU; the
//              cap is MULTIACE_PREFLIGHT_MAX_MB, 110 by default) -> the same
//              file goes to POST /api/preflight/inbox and the answer carries
//              the link to <printer>/multiace/, where the browser analyses it.
//
// Refusals (409 state, 400 file) before anything is uploaded: printer
// printing/paused/offline, a swap in progress, ACE not ready, Air Print
// Detection on (multiACE's README: must be off - reported, never changed),
// a manual head (livedata 409), mode not multi, api_version major != 1, a
// Full Spectrum file, a file multiACE already processed, no tool-change or
// layer markers, a needed material that no slot holds, TPU/TPE, nozzle
// diameters that disagree between the file and the heads.
//
// Purge formula (post_process_virtual_toolheads.py 1546-1558, 1666-1677):
//   mm = clamp(0.45 * matrix[from][to] / 2.405, 40, 150), int-rounded; a pair
//   the engine cannot name (first use of a head) gets no stamp, so the engine
//   default applies (swap_purge_length 0 = stock 80 mm). Grams = mm x 2.405
//   mm3/mm x density / 1000 (density from the file, 1.24 when absent).
//
// State: multiace.json beside config.json (what was sent via this route),
// gitignored. Provides multiace.jobinfo(idx, file) for the costing ledger and
// multiace.loadout(idx) for the SME's printer brief, both from caches.

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");
const readline = require("readline");
const { Transform } = require("stream");
const { parseGcodeMap, estMinutes } = require("../parser.js");

const FORK = "ryvin/u1hub";
const API_MAJOR = 1;                              // ENGINE_API.md s6: gate on the major
const PROBE_TTL_MS = Math.max(1000, Number(process.env.U1HUB_MULTIACE_PROBE_MS) || 10 * 60 * 1000);
const PROBE_FAIL_TTL_MS = Math.min(PROBE_TTL_MS, 2 * 60 * 1000);
const LOADOUT_TTL_MS = Math.max(0, Number(process.env.U1HUB_MULTIACE_LOADOUT_MS ?? 15000));
const REPORT_TTL_MS = 30 * 60 * 1000;             // a preflight token lives 24 h on the printer; the Hub forgets sooner
const JOB_TTL_MS = 10 * 60 * 1000;
const ENGINE_POLL_MS = Math.max(50, Number(process.env.U1HUB_MULTIACE_POLL_MS) || 1000);
const ENGINE_WAIT_MS = 15 * 60 * 1000;            // a 20 MB rewrite on the U1 can take minutes
const TIMEOUT_MS = 3500;
const HEAD_BYTES = 512 * 1024;                    // pp.py detect_processed / _sniff_print_gcode_loads read the first 512 KB
const TAIL_BYTES = 512 * 1024;                    // the slicer's config block (colours, types, flush matrix) is at the tail
const PROCESSED_MARKERS = Object.freeze(["; multiACE processed:", "; multiACE auto-load:"]);
const PLANS = Object.freeze(["slicer", "optimize", "layer"]);
const DEFAULTS = Object.freeze({ swap_seconds: 150, default_plan: "optimize", identity_map: true });
const SWAP_SECONDS = Object.freeze([30, 600]);    // README "a single colour swap at up to 3 minutes"; 150 s is the middle of 90-180
const FILAMENT_MM3_PER_MM = 2.405;
const PURGE_TOPUP_FRAC = 0.45;
const PURGE_MIN_MM = 40, PURGE_MAX_MM = 150;
const ENGINE_DEFAULT_PURGE_MM = 80;               // ACE_SET_PURGE LENGTH=0 = stock default (ENGINE_API.md)
const DENSITY_DEFAULT = 1.24;
const SLOT_MATCH_DE = 5;                          // a planned slot "is loaded" when material matches and the colour is within this dE
const SENT_MAX = 500;
const JOBINFO_WINDOW_MS = 72 * 3600 * 1000;
const NO_MATERIAL = /^(TPU|TPE)/i;                // README: TPU/TPE go through Normal Mode or a manual head, never an ACE swap

const num = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = v => Math.round(v * 100) / 100;
const lc = s => String(s == null ? "" : s).trim().toLowerCase();
const hexOf = s => { const m = /^#?([0-9a-f]{6})/i.exec(String(s || "").trim()); return m ? "#" + m[1].toLowerCase() : ""; };

// ---- pure: colour difference (CIEDE2000) -------------------------------------------------
function hexToLab(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin((n >> 16) & 255), G = lin((n >> 8) & 255), B = lin(n & 255);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
// Sharma, Wu & Dalal 2005, the reference implementation's steps; pinned in
// the suite against their published test pairs.
function deltaE2000Lab(A, B) {
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI, p7 = v => Math.pow(v, 7), P25 = Math.pow(25, 7);
  const C1 = Math.hypot(A.a, A.b), C2 = Math.hypot(B.a, B.b), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(p7(Cm) / (p7(Cm) + P25)));
  const a1 = (1 + G) * A.a, a2 = (1 + G) * B.a;
  const C1p = Math.hypot(a1, A.b), C2p = Math.hypot(a2, B.b);
  const hue = (a, b) => { if (a === 0 && b === 0) return 0; const x = deg(Math.atan2(b, a)); return x < 0 ? x + 360 : x; };
  const h1 = hue(a1, A.b), h2 = hue(a2, B.b);
  const dL = B.L - A.L, dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lm = (A.L + B.L) / 2, Cmp = (C1p + C2p) / 2;
  let hm;
  if (C1p * C2p === 0) hm = h1 + h2;
  else { hm = (h1 + h2) / 2; if (Math.abs(h1 - h2) > 180) hm += (h1 + h2 < 360) ? 180 : -180; }
  const T = 1 - 0.17 * Math.cos(rad(hm - 30)) + 0.24 * Math.cos(rad(2 * hm)) + 0.32 * Math.cos(rad(3 * hm + 6)) - 0.20 * Math.cos(rad(4 * hm - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hm - 275) / 25, 2));
  const RC = 2 * Math.sqrt(p7(Cmp) / (p7(Cmp) + P25));
  const SL = 1 + 0.015 * Math.pow(Lm - 50, 2) / Math.sqrt(20 + Math.pow(Lm - 50, 2)), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  return Math.sqrt(Math.pow(dL / SL, 2) + Math.pow(dC / SC, 2) + Math.pow(dH / SH, 2) + RT * (dC / SC) * (dH / SH));
}
function deltaE2000(hexA, hexB) {
  const A = hexToLab(hexA), B = hexToLab(hexB);
  return A && B ? deltaE2000Lab(A, B) : null;
}

// ---- pure: the flush matrix and the purge top-up ------------------------------------------
// "; flush_volumes_matrix = 0,500,..." (mm3, row-major NxN, row = from-tool) and
// "; flush_multiplier = 1". The engine's stamps use the RAW matrix with the
// multiplier inherited upward only (max(1, mult)): the tower slider must not
// scale the melt-zone top-up down. Last occurrence wins. null when absent.
function parseFlushMatrix(text) {
  let raw = null, mult = 1;
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    let m = /^;?\s*flush_volumes_matrix\s*=\s*([0-9.,\s]+)$/.exec(t);
    if (m) { raw = m[1]; continue; }
    m = /^;?\s*flush_multiplier\s*=\s*([0-9.]+)/.exec(t);
    if (m) { const v = parseFloat(m[1]); if (Number.isFinite(v)) mult = v; }
  }
  if (raw == null) return null;
  const vals = raw.split(",").map(s => parseFloat(s.trim())).filter(v => Number.isFinite(v));
  const n = Math.round(Math.sqrt(vals.length));
  if (n < 1 || n * n !== vals.length) return null;
  const k = Math.max(1, mult > 0 ? mult : 1);
  const matrix = [];
  for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < n; j++) row.push(vals[i * n + j] * k); matrix.push(row); }
  return matrix;
}
// -> int mm, or null for an unknown / identity pair (then the engine stamps nothing).
function purgeTopupMm(matrix, from, to) {
  if (!matrix || from == null || to == null || from === to) return null;
  if (!(from >= 0 && from < matrix.length && to >= 0 && to < matrix.length)) return null;
  const mm = matrix[from][to] / FILAMENT_MM3_PER_MM * PURGE_TOPUP_FRAC;
  return Math.round(Math.max(PURGE_MIN_MM, Math.min(PURGE_MAX_MM, mm)));
}
const purgeGrams = (mm, density) => r2(mm * FILAMENT_MM3_PER_MM * (num(density) > 0 ? density : DENSITY_DEFAULT) / 1000);

// Walk the toolchange sequence the way preflight_core._real_swap_count does
// and sum the purge top-up of each swap: the pair (previous colour on that
// head -> this colour) when known, else the engine default. A toolchange whose
// slot differs from what the head holds is a swap. mapping rows: { t, slot:{ace,slot} }.
// `start` ({ head: "ace,slot" }, from startFromHeadSource) is what each head
// is fed from right now. Without it every head is taken to start on ACE 0's
// same-numbered slot, which is what the engine's own count assumes - and why
// it over-counts when the heads already hold the job's spools (davinci,
// history 000131: the engine said 5 as-sliced swaps; 1 happened, the other
// toolchanges logged "Swap: HEAD n already on ACE 1 / Slot n - skipping").
function simulateSwaps(events, mapping, matrix, start) {
  const byT = new Map((mapping || []).filter(m => m && m.slot).map(m => [m.t, m.slot]));
  const cur = { 0: "0,0", 1: "0,1", 2: "0,2", 3: "0,3", ...(start || {}) }, held = {};
  let swaps = 0, purge_mm = 0, known = 0, defaulted = 0;
  const pairs = [];
  for (const t of events || []) {
    const s = byT.get(t); if (!s) continue;
    const h = s.slot, key = s.ace + "," + s.slot;
    if (cur[h] !== key) {
      swaps++;
      const from = held[h] == null ? null : held[h];
      const mm = purgeTopupMm(matrix, from, t);
      if (mm == null) { purge_mm += ENGINE_DEFAULT_PURGE_MM; defaulted++; } else { purge_mm += mm; known++; }
      pairs.push({ head: h, from, to: t, ace: s.ace, mm: mm == null ? ENGINE_DEFAULT_PURGE_MM : mm, stamped: mm != null });
      cur[h] = key;
    }
    held[h] = t;
  }
  return { swaps, purge_mm, pairs, known, defaulted };
}
// The `ace` object's head_source ({ "0": { ace_index, slot, ... }, ... }) ->
// { head: "ace,slot" } for simulateSwaps; null when it names no head. A head
// it leaves out is fed by nothing ("none"), so its first use counts as a swap.
function startFromHeadSource(hs) {
  if (!hs || typeof hs !== "object") return null;
  const out = {};
  let any = false;
  for (let h = 0; h < 4; h++) {
    const src = hs[h] != null ? hs[h] : hs[String(h)];
    const a = src ? num(src.ace_index) : null, sl = src ? num(src.slot) : null;
    if (a != null && sl != null && Number.isInteger(a) && Number.isInteger(sl)) { out[h] = a + "," + sl; any = true; }
    else out[h] = "none";
  }
  return any ? out : null;
}
// One plan's numbers. With the heads' live sources (`start`) the swap count is
// the Hub's walk from what is loaded (basis "loaded"); without them it is the
// engine's own count (basis "engine"), which assumes ACE 0. Purge always comes
// from the Hub's walk. engine_swaps keeps the engine's figure either way.
function estimatePlan(plan, events, matrix, swapSeconds, density, start) {
  if (!plan || !plan.feasible) return { feasible: false, swaps: 0, sim_swaps: 0, est_added_sec: 0, purge_mm: 0, purge_g: 0, pairs_known: 0, pairs_default: 0, reason: (plan && plan.reason) || "not feasible" };
  const sim = simulateSwaps(events, plan.mapping, matrix, start);
  const engine = Number.isInteger(plan.swaps) ? plan.swaps : null;
  const loaded = !!start;
  const swaps = loaded ? sim.swaps : (engine != null ? engine : sim.swaps);
  const sec = num(swapSeconds) > 0 ? swapSeconds : DEFAULTS.swap_seconds;
  return { feasible: true, swaps, sim_swaps: sim.swaps, engine_swaps: engine, basis: loaded ? "loaded" : "engine", tool_changes: plan.tool_changes || 0, est_added_sec: swaps * sec,
           purge_mm: sim.purge_mm, purge_g: purgeGrams(sim.purge_mm, density), pairs_known: sim.known, pairs_default: sim.defaulted, swap_seconds: sec };
}

// ---- pure: proposed loadouts -> the moves they need ----------------------------------------
// A live slot satisfies a planned row when the material matches and the colour
// is the same hex or within SLOT_MATCH_DE (the engine itself matches as-sliced
// colours fuzzily, RGB distance 30).
function slotHolds(live, hex, material) {
  if (!live) return false;
  if (lc(live.material) !== lc(material)) return false;
  const a = hexOf(live.color), b = hexOf(hex);
  if (!a || !b) return false;
  if (a === b) return true;
  const d = deltaE2000(a, b);
  return d != null && d <= SLOT_MATCH_DE;
}
// -> [{ t, hex, material, from:{ace,slot}|null, to:{ace,slot}, displaces:{color,material}|null }]
// for optimize / layer; [] for the slicer plan (it prints with what is loaded).
function movesFor(report, mode, liveSlots) {
  const plan = report && report.plans && report.plans[mode];
  if (!plan || mode === "slicer" || !plan.feasible) return [];
  const live = liveSlots || report.live_slots || [];
  const colors = new Map((report.slicer_colors || []).map(c => [c.t, c]));
  const moves = [];
  for (const m of plan.mapping || []) {
    if (!m || !m.slot) continue;
    const c = colors.get(m.t) || {};
    const hex = hexOf(m.slot.color || c.hex), material = m.slot.material || c.material || "";
    const want = { ace: m.slot.ace, slot: m.slot.slot };
    const there = live.find(s => s.ace === want.ace && s.slot === want.slot) || null;
    if (slotHolds(there, hex, material)) continue;
    const now = live.find(s => slotHolds(s, hex, material)) || null;
    moves.push({ t: m.t, hex, material, from: now ? { ace: now.ace, slot: now.slot } : null, to: want,
                 displaces: there ? { color: hexOf(there.color), material: there.material } : null });
  }
  return moves;
}

// ---- pure: the enriched report the card renders --------------------------------------------
function rowsFor(report, mapping) {
  return (mapping || []).map(m => {
    const c = (report.slicer_colors || []).find(x => x.t === m.t) || {};
    const slotHex = m.slot ? hexOf(m.slot.color) : "";
    return { t: m.t, hex: hexOf(c.hex), name: c.name || "", material: c.material || "", tier: m.tier,
             ace: m.slot ? m.slot.ace : null, slot: m.slot ? m.slot.slot : null, slot_hex: slotHex, slot_material: m.slot ? m.slot.material : "",
             dE: slotHex && c.hex ? r2(deltaE2000(c.hex, slotHex)) : null };
  });
}
// opts: { matrix, swap_seconds, density, start } - start from startFromHeadSource.
function enrichReport(report, o) {
  const opts = o || {};
  const events = Array.isArray(report.events) ? report.events : [];
  const estimates = {}, moves = {}, rows = {};
  for (const mode of PLANS) {
    const plan = (report.plans || {})[mode];
    estimates[mode] = estimatePlan(plan, events, opts.matrix, opts.swap_seconds, opts.density, opts.start);
    moves[mode] = movesFor(report, mode);
    rows[mode] = !plan ? [] : rowsFor(report, plan.mapping);
  }
  const colors = report.slicer_colors || [];
  const needed = [...new Set(colors.map(c => lc(c.material)).filter(Boolean))];
  return { ...report, estimates, moves, rows,
           hub: { swap_seconds: estimates.slicer.swap_seconds || opts.swap_seconds || DEFAULTS.swap_seconds, density: opts.density || DENSITY_DEFAULT,
                  matrix_n: opts.matrix ? opts.matrix.length : 0, colours: colors.length, materials: needed, events: events.length,
                  slots: (report.live_slots || []).length, aces: report.num_aces || 0, start: opts.start || null } };
}

// ---- pure: a hand-picked slot per colour for the as-sliced plan ------------------------------
// overrides: { slicerT: ace*4+slot } from the card. The engine takes `remap`
// as a FULL replacement of its own colour matching (preflight_core.py: with a
// remap_override it never calls match_colors_to_slots), so the Hub sends every
// colour's slot: the override where there is one, the engine's match elsewhere.
// -> { mapping, remap, errors[] }; mapping rows carry tier "manual" when picked.
function applyRemap(report, overrides, liveSlots) {
  const base = ((report && report.plans && report.plans.slicer) || {}).mapping || [];
  const live = liveSlots || (report && report.live_slots) || [];
  const colours = new Map(((report && report.slicer_colors) || []).map(c => [c.t, c]));
  const errors = [], mapping = [], remap = {};
  const ov = overrides && typeof overrides === "object" ? overrides : {};
  for (const k of Object.keys(ov)) {
    const t = Number(k);
    if (!Number.isInteger(t) || !base.some(m => m && m.t === t)) errors.push("P" + (Number.isInteger(t) ? t + 1 : k) + " is not a colour of this file");
  }
  for (const m of base) {
    if (!m) continue;
    let slot = m.slot, tier = m.tier;
    if (Object.prototype.hasOwnProperty.call(ov, String(m.t))) {
      const v = Number(ov[String(m.t)]);
      if (!Number.isInteger(v) || v < 0 || v > 15) { errors.push("P" + (m.t + 1) + ": slot index must be 0-15"); continue; }
      const want = { ace: Math.floor(v / 4), slot: v % 4 };
      const there = live.find(s => s.ace === want.ace && s.slot === want.slot);
      const c = colours.get(m.t) || {};
      if (!there) { errors.push("P" + (m.t + 1) + ": ACE " + want.ace + " slot " + want.slot + " is empty or unlabelled"); continue; }
      if (c.material && there.material && lc(c.material) !== lc(there.material)) { errors.push("P" + (m.t + 1) + " is " + c.material + ", ACE " + want.ace + " slot " + want.slot + " holds " + there.material); continue; }
      slot = { ace: there.ace, slot: there.slot, material: there.material, color: there.color };
      tier = "manual";
    } else if (slot) {
      // Not picked, but it goes out in the full map all the same and the engine
      // will not re-match it: the slot must still hold what it held at check
      // time (a spool changed since then is a 400, re-check first).
      const there = live.find(s => s.ace === slot.ace && s.slot === slot.slot);
      if (!slotHolds(there, slot.color, slot.material)) { errors.push("P" + (m.t + 1) + ": ACE " + slot.ace + " slot " + slot.slot + " no longer holds " + (slot.material || "") + " " + hexOf(slot.color) + " - re-check the loadout"); continue; }
    }
    mapping.push({ ...m, slot, tier });
    if (slot) remap[String(m.t)] = slot.ace * 4 + slot.slot;
  }
  return { mapping, remap, errors };
}

// ---- pure: the gate and the refusal matrix --------------------------------------------------
// version: the JSON of GET /multiace/api/version (or null); ace: the `ace`
// status object (or null). -> { multiace, reason, web, api_version, mode, device_count }
function gate(version, ace) {
  const web = version && typeof version === "object" ? String(version.web || "") : "";
  if (!version || typeof version !== "object") return { multiace: false, reason: "no multiACE web API", web: "", api_version: null, mode: null, device_count: 0 };
  if (!ace || typeof ace !== "object") return { multiace: false, reason: "no `ace` status object (multiACE not running in Klipper)", web, api_version: null, mode: null, device_count: 0 };
  const v = num(ace.api_version);
  const out = { web, api_version: v, mode: ace.mode || null, device_count: num(ace.device_count) || 0 };
  if (v == null) return { multiace: false, reason: "ace object has no api_version", ...out };
  if (Math.floor(v) !== API_MAJOR) return { multiace: false, reason: "engine api_version " + v + " (this Hub speaks " + API_MAJOR + ".x)", ...out };
  return { multiace: true, reason: "", ...out };
}
// snap: { online, state, ace:{status,swap_in_progress,airprint_detection,mode,api_version}, manual, live_slots, head_nozzles }
// facts: { isFS, processed, markers, usedTypes[], nozzles[], usedCount } (null = state checks only)
function checks(snap, facts) {
  const r = [];
  const s = snap || {}, a = s.ace || {};
  if (!s.online) r.push({ code: "offline", text: "the printer is offline" });
  else if (s.state === "printing" || s.state === "paused") r.push({ code: "busy", text: "the printer is " + s.state + " - nothing is sent while a print is on the bed" });
  if (a.swap_in_progress) r.push({ code: "swapping", text: "a filament swap is in progress" });
  if (a.status && a.status !== "ready") r.push({ code: "ace_" + a.status, text: "the ACE reports '" + a.status + "', not ready" });
  if (a.airprint_detection) r.push({ code: "airprint", text: "Air Print Detection is ON; multiACE needs it off (switch it off on the touchscreen - the Hub never changes it)" });
  if (a.mode && a.mode !== "multi") r.push({ code: "mode", text: "multiACE is in '" + a.mode + "' mode; the Hub flow is built for 'multi' (slot N feeds head N)" });
  if (s.manual) r.push({ code: "manual_head", text: "a head is in manual bypass, so multiACE cannot place colours (livedata 409)" });
  if (!facts) return r;
  if (facts.isFS) r.push({ code: "fs", text: "a Full Spectrum file blends fixed physical heads; multiACE swaps would break the mix" });
  if (facts.processed) r.push({ code: "processed", text: "this file was already processed by multiACE - send it with the normal Print button (identity mapping), never through the preflight twice" });
  if (!facts.markers) r.push({ code: "no_markers", text: "no '; Change Tool' or '; LAYER_CHANGE' markers - the engine cannot place swaps (check the filament/printer profile's tool-change gcode, re-slice)" });
  const loaded = new Set((s.live_slots || []).map(x => lc(x.material)).filter(Boolean));
  for (const t of facts.usedTypes || []) {
    if (NO_MATERIAL.test(t)) r.push({ code: "material_" + lc(t), text: t + " cannot go through an ACE swap (multiACE: Normal Mode or a manual head)" });
    else if (s.live_slots && !loaded.has(lc(t))) r.push({ code: "missing_" + lc(t), text: "no loaded slot holds " + t });
  }
  const fileNoz = [...new Set((facts.nozzles || []).filter(v => v > 0))], headNoz = [...new Set(Object.values(s.head_nozzles || {}).filter(v => v > 0))];
  if (fileNoz.length > 1 || headNoz.length > 1 || (fileNoz.length === 1 && headNoz.length === 1 && Math.abs(fileNoz[0] - headNoz[0]) > 0.001))
    r.push({ code: "nozzle", text: "nozzle diameters differ (file " + (fileNoz.join("/") || "?") + " mm, heads " + (headNoz.join("/") || "?") + " mm); the Hub flow only sends uniform-nozzle jobs" });
  return r;
}

// ---- file facts (bounded reads: 512 KB head + 512 KB tail, then a streamed marker scan) ----
async function scanForMarkers(fp) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: fs.createReadStream(fp) });
    let hit = false;
    rl.on("line", l => { if (!hit && (/^; Change Tool\d+ -> Tool\d+/.test(l) || /^;\s*LAYER_CHANGE/.test(l))) { hit = true; rl.close(); } });
    rl.on("close", () => resolve(hit));
    rl.on("error", () => resolve(hit));
  });
}
async function fileFacts(fp) {
  const st = await fsp.stat(fp);
  const fd = await fsp.open(fp, "r");
  let head, tail;
  try {
    const hl = Math.min(HEAD_BYTES, st.size); head = Buffer.alloc(hl); await fd.read(head, 0, hl, 0);
    const tl = Math.min(TAIL_BYTES, st.size); tail = Buffer.alloc(tl); await fd.read(tail, 0, tl, st.size - tl);
  } finally { await fd.close(); }
  const headText = head.toString("utf8"), tailText = tail.toString("utf8");
  const processed = PROCESSED_MARKERS.some(m => headText.includes(m));
  let markers = /^; Change Tool\d+ -> Tool\d+/m.test(headText) || /^;\s*LAYER_CHANGE/m.test(headText);
  if (!markers) markers = await scanForMarkers(fp);
  const map = parseGcodeMap(tailText);
  const used = (map.palette || []).filter(p => p.used);
  const dens = (map.amounts && map.amounts.slots || []).map(s => s.density).find(d => d > 0) || null;
  const nozzles = String((/^;\s*nozzle_diameter\s*=\s*([^\r\n]*)/m.exec(tailText) || [])[1] || "").split(/[;,]/).map(s => parseFloat(s)).filter(v => Number.isFinite(v));
  return { name: path.basename(fp), size: st.size, processed, markers, isFS: !!map.isFS, usedCount: used.length,
           usedTypes: [...new Set(used.map(p => String(p.type || "").trim()).filter(Boolean))], nozzles,
           matrix: parseFlushMatrix(tailText), density: dens, est_minutes: estMinutes(map.estTime), palette: map.palette || [] };
}

// ---- transport ----------------------------------------------------------------------------
async function jget(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } finally { clearTimeout(to); }
}
async function jpost(url, body, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: ctrl.signal });
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  } finally { clearTimeout(to); }
}
// Stream a library file as multipart/form-data (field "file") to a multiACE
// endpoint, counting bytes into job.sent / job.total for the progress bar.
// Resolves { status, body } whatever the status: the engine's 409/413 carry a
// `detail` the caller shows. The backend reads the whole body before it
// answers, so the response waits for the analysis too (up to `waitMs`).
function uploadMultipart(target, fp, name, job, waitMs) {
  return new Promise((resolve, reject) => {
    const boundary = "----u1hubmace" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(name).replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = fs.statSync(fp).size;
    job.total = pre.length + size + post.length; job.sent = 0;
    const u = new URL(target);
    const req = http.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total } }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => { let body = null; try { body = JSON.parse(b); } catch { body = { detail: b.slice(0, 300) }; } resolve({ status: res.statusCode, body }); });
    });
    req.setTimeout(waitMs || ENGINE_WAIT_MS, () => { req.destroy(new Error("the printer did not answer within " + Math.round((waitMs || ENGINE_WAIT_MS) / 1000) + " s")); });
    req.on("error", e => { if (e && e.code === "EPIPE") return; reject(e); });   // an early 413 closes the socket under us; the response still arrives
    req.write(pre); job.sent += pre.length;
    const src = fs.createReadStream(fp);
    const counter = new Transform({ transform(chunk, _e, cb) { job.sent += chunk.length; cb(null, chunk); } });
    src.on("error", reject); counter.on("error", reject);
    counter.on("data", chunk => { if (!req.write(chunk)) { counter.pause(); req.once("drain", () => counter.resume()); } });
    counter.on("end", () => { req.write(post); job.sent += post.length; req.end(); });
    src.pipe(counter);
  });
}

// ---- the module -----------------------------------------------------------------------------
function register(ctx) {
  const STATE_FILE = path.join(ctx.baseDir, "multiace.json");
  const PROBE = new Map();     // idx -> { at, ttl, ...gate(), url, error }
  const LIVE = new Map();      // idx -> { at, status, live_slots, head_ctx, manual, error }
  const ACE = new Map();       // idx -> { at, ace }
  const REPORTS = new Map();   // token -> { idx, file, fp, name, slug, report, facts, at }
  const JOBS = new Map();      // hub job id -> { kind, phase, sent, total, done, error, result, ts, ... }
  let S = { sent: [] };
  try { S = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || S; if (!Array.isArray(S.sent)) S.sent = []; } catch {}
  let saving = Promise.resolve();
  const save = () => { saving = saving.then(() => fsp.writeFile(STATE_FILE, JSON.stringify(S, null, 2))).catch(e => ctx.hublog("warn", "multiace: state write failed - " + e.message)); return saving; };

  const printers = () => ctx.printers || [];
  const baseOf = idx => { const p = printers()[idx]; return p && p.url ? String(p.url).replace(/\/+$/, "") : null; };
  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.multiace === "object" && ctx.cfg.multiace) || {};
    const sec = num(c.swap_seconds);
    return { swap_seconds: sec != null && sec >= SWAP_SECONDS[0] && sec <= SWAP_SECONDS[1] ? sec : DEFAULTS.swap_seconds,
             default_plan: PLANS.includes(c.default_plan) ? c.default_plan : DEFAULTS.default_plan,
             identity_map: c.identity_map !== false };
  };
  const newJobId = () => "ma" + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
  const pruneJobs = () => { const now = Date.now(); for (const [k, j] of JOBS) if (j.done && now - j.ts > JOB_TTL_MS) JOBS.delete(k); for (const [k, r] of REPORTS) if (now - r.at > REPORT_TTL_MS) REPORTS.delete(k); };

  // ---- probe (cached; one small GET to the web API, one objects/query) ----
  async function aceObject(idx) {
    const base = baseOf(idx); if (!base) return null;
    const r = await jget(base + "/printer/objects/query?ace");
    const ace = r.status === 200 && r.body && r.body.result && r.body.result.status ? r.body.result.status.ace || null : null;
    ACE.set(idx, { at: Date.now(), ace });
    return ace;
  }
  async function probe(idx, force) {
    const p = printers()[idx], base = baseOf(idx);
    if (!p || !base) return null;
    const hit = PROBE.get(idx);
    if (hit && !force && Date.now() - hit.at < hit.ttl) return hit;
    let version = null, ace = null, error = null;
    try {
      const v = await jget(base + "/multiace/api/version");
      version = v.status === 200 && v.body && typeof v.body === "object" ? v.body : null;
      if (version) ace = await aceObject(idx);
    } catch (e) { error = e.message; }
    const g = gate(version, ace);
    const rec = { at: Date.now(), ttl: g.multiace ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS, ...g, error, url: base };
    const prev = PROBE.get(idx);
    PROBE.set(idx, rec);
    if (!prev || prev.multiace !== rec.multiace) ctx.hublog("info", "multiace[" + (p.name || idx) + "]: " + (rec.multiace ? "multiACE web " + rec.web + ", engine api_version " + rec.api_version + ", mode " + rec.mode + ", " + rec.device_count + " ACE(s)" : "not multiACE (" + rec.reason + ")"));
    return rec;
  }
  async function livedata(idx, force) {
    const base = baseOf(idx); if (!base) return null;
    const hit = LIVE.get(idx);
    if (hit && !force && Date.now() - hit.at < LOADOUT_TTL_MS) return hit;
    let rec;
    try {
      const r = await jget(base + "/multiace/api/preflight/livedata");
      if (r.status === 200 && r.body) rec = { at: Date.now(), status: 200, live_slots: Array.isArray(r.body.live_slots) ? r.body.live_slots : [], head_ctx: r.body.head_ctx || {}, manual: false, error: null };
      else if (r.status === 409) rec = { at: Date.now(), status: 409, live_slots: [], head_ctx: {}, manual: true, error: (r.body && r.body.detail) || "a head is manual" };
      else rec = { at: Date.now(), status: r.status, live_slots: [], head_ctx: {}, manual: false, error: "livedata HTTP " + r.status };
    } catch (e) { rec = { at: Date.now(), status: 0, live_slots: [], head_ctx: {}, manual: false, error: e.message }; }
    LIVE.set(idx, rec);
    return rec;
  }
  // Everything the checks and the card need about one printer, right now.
  async function snapshot(idx, force) {
    const pr = await probe(idx, force);
    if (!pr || !pr.multiace) return { multiace: false, probe: pr };
    const [ld, ace, fleet] = await Promise.all([livedata(idx, force), force ? aceObject(idx) : Promise.resolve((ACE.get(idx) || {}).ace || null), ctx.fleet().catch(() => [])]);
    const fe = (fleet || []).find(x => x && x.id === idx) || null;
    const a = ace || {};
    return { multiace: true, probe: pr, online: !!(fe && fe.online), state: fe ? fe.state : "unknown", fleet: fe,
             ace: { status: a.status || null, swap_in_progress: !!a.swap_in_progress, airprint_detection: !!a.airprint_detection, mode: a.mode || pr.mode, api_version: a.api_version, device_count: a.device_count || pr.device_count, swap_phase: a.swap_phase || null },
             head_source: a.head_source || {}, head_manual: a.head_manual || {},
             manual: !!ld.manual, live_slots: ld.live_slots, head_ctx: ld.head_ctx, head_nozzles: (ld.head_ctx || {}).head_nozzles || {}, livedata_error: ld.error };
  }
  const loadoutView = (idx, s) => ({ printer: idx, name: (printers()[idx] || {}).name, multiace: true, web: s.probe.web, api_version: s.ace.api_version, mode: s.ace.mode, device_count: s.ace.device_count,
    status: s.ace.status, swap_in_progress: s.ace.swap_in_progress, swap_phase: s.ace.swap_phase, airprint_detection: s.ace.airprint_detection, manual: s.manual,
    live_slots: s.live_slots, head_ctx: s.head_ctx, head_source: s.head_source, head_manual: s.head_manual, online: s.online, state: s.state, link: s.probe.url + "/multiace/" });

  // ---- what costing and the SME read, from caches only ----
  ctx.provide("multiace.jobinfo", (idx, file) => {
    const name = path.basename(String(file || "")), now = Date.now();
    for (let i = S.sent.length - 1; i >= 0; i--) { const r = S.sent[i]; if (r.printer_id === Number(idx) && r.file === name && now - r.ts < JOBINFO_WINDOW_MS) return { ...r }; }
    return null;
  });
  ctx.provide("multiace.loadout", idx => {
    const pr = PROBE.get(Number(idx)); if (!pr || !pr.multiace) return null;
    const ld = LIVE.get(Number(idx)) || {}, a = ((ACE.get(Number(idx)) || {}).ace) || {};
    return { web: pr.web, api_version: pr.api_version, mode: a.mode || pr.mode, device_count: a.device_count || pr.device_count, live_slots: ld.live_slots || [], manual: !!ld.manual,
             head_source: a.head_source || {}, airprint_detection: !!a.airprint_detection, at: ld.at || pr.at };
  });

  // ---- routes ----
  const bad = (res, code, error, extra) => res.status(code).json({ error, ...(extra || {}) });
  const printerOf = req => { const idx = Number((req.body || {}).printer ?? (req.query || {}).printer); return Number.isInteger(idx) && printers()[idx] ? idx : null; };
  const fileOf = (req) => {
    const b = req.body || {};
    const slug = String(b.type || "u1"), name = path.basename(String(b.file || ""));
    if (!name || name !== b.file) return null;
    const fp = path.resolve(ctx.gcodeFolderFor(slug), name);
    return { slug, name, fp };
  };

  ctx.app.get("/api/multiace", async (req, res) => {
    const force = String(req.query.refresh || "") === "1";
    const list = await Promise.all(printers().map((p, i) => probe(i, force).then(pr => ({ id: i, name: p.name, type: p.type || "u1", multiace: !!(pr && pr.multiace), reason: pr ? pr.reason : "no url",
      web: pr ? pr.web : "", api_version: pr ? pr.api_version : null, mode: pr ? pr.mode : null, device_count: pr ? pr.device_count : 0, probed_at: pr ? pr.at : null, link: pr && pr.multiace ? pr.url + "/multiace/" : null }))));
    res.json({ enabled: true, fork: FORK, settings: conf(), plans: PLANS, printers: list, sent: S.sent.length });
  });
  ctx.app.post("/api/multiace/settings", (req, res) => {
    const b = req.body || {}, cur = conf(), next = { ...cur };
    if (b.swap_seconds !== undefined) { const v = num(b.swap_seconds); if (v == null || v < SWAP_SECONDS[0] || v > SWAP_SECONDS[1]) return bad(res, 400, "swap_seconds must be " + SWAP_SECONDS[0] + "-" + SWAP_SECONDS[1]); next.swap_seconds = v; }
    if (b.default_plan !== undefined) { if (!PLANS.includes(b.default_plan)) return bad(res, 400, "default_plan must be one of " + PLANS.join(", ")); next.default_plan = b.default_plan; }
    if (b.identity_map !== undefined) next.identity_map = b.identity_map !== false && b.identity_map !== "false";
    ctx.cfg.multiace = next; ctx.saveConfig();
    res.json(conf());
  });
  ctx.app.get("/api/multiace/loadout", async (req, res) => {
    const idx = printerOf(req); if (idx == null) return bad(res, 400, "Unknown printer");
    const s = await snapshot(idx, String(req.query.refresh || "") === "1");
    if (!s.multiace) return res.status(404).json({ error: "not a multiACE printer", printer: idx, multiace: false, reason: s.probe ? s.probe.reason : "no url" });
    res.json(loadoutView(idx, s));
  });

  // The dry run: the engine analyses, writes only a temp file under its
  // preflight dir, prints nothing. -> { jobId }; poll /api/multiace/job.
  ctx.app.post("/api/multiace/preflight", async (req, res) => {
    pruneJobs();
    const idx = printerOf(req); if (idx == null) return bad(res, 400, "Unknown printer");
    const f = fileOf(req); if (!f) return bad(res, 400, "Bad file name");
    try { await fsp.access(f.fp); } catch { return bad(res, 404, "File not found"); }
    const p = printers()[idx];
    if ((p.type || "u1") !== f.slug) return bad(res, 400, p.name + " belongs to a different printer type ('" + (p.type || "u1") + "')");
    const s = await snapshot(idx, true);
    if (!s.multiace) return bad(res, 400, p.name + " is not a multiACE printer (" + (s.probe ? s.probe.reason : "unreachable") + ")", { multiace: false });
    let facts;
    try { facts = await fileFacts(f.fp); } catch (e) { return bad(res, 500, "Could not read the file: " + e.message); }
    const reasons = checks(s, facts);
    if (reasons.length) return res.status(reasons.some(r => ["offline", "busy", "swapping", "airprint", "manual_head", "mode"].includes(r.code) || /^ace_/.test(r.code)) ? 409 : 400).json({ error: reasons.map(r => r.text).join("; "), reasons, multiace: true });
    const jobId = newJobId();
    const job = { kind: "preflight", printer: idx, file: f.name, phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
    JOBS.set(jobId, job);
    res.json({ jobId, size: facts.size, link: s.probe.url + "/multiace/" });
    (async () => {
      try {
        const base = s.probe.url;
        const r = await uploadMultipart(base + "/multiace/api/preflight", f.fp, f.name, job, ENGINE_WAIT_MS);
        const detail = r.body && (r.body.detail || r.body.error) ? String(r.body.detail || r.body.error) : "HTTP " + r.status;
        if (r.status === 413) {
          job.phase = "inbox";
          let inbox = null, inboxError = null;
          try { const ib = await uploadMultipart(base + "/multiace/api/preflight/inbox", f.fp, f.name, { sent: 0, total: 0 }, ENGINE_WAIT_MS); if (ib.status === 200) inbox = ib.body; else inboxError = (ib.body && ib.body.detail) || "HTTP " + ib.status; }
          catch (e) { inboxError = e.message; }
          job.result = { tooBig: true, detail, inbox, inboxError, link: base + "/multiace/" };
          job.error = inbox ? null : "too big for the printer's preflight and the inbox refused: " + inboxError;
          job.phase = "done"; job.done = true;
          ctx.hublog("info", "multiace[" + p.name + "]: " + f.name + " too big for on-printer preflight (" + detail.slice(0, 80) + "); " + (inbox ? "sent to the inbox" : "inbox failed: " + inboxError));
          return;
        }
        if (r.status !== 200 || !r.body || !r.body.token) throw new Error(detail);
        const report = enrichReport(r.body, { matrix: facts.matrix, swap_seconds: conf().swap_seconds, density: facts.density, start: startFromHeadSource(s.head_source) });
        REPORTS.set(report.token, { idx, file: f.name, fp: f.fp, name: f.name, slug: f.slug, report, facts, at: Date.now() });
        job.result = { report, facts: { size: facts.size, est_minutes: facts.est_minutes, density: facts.density, matrix_n: facts.matrix ? facts.matrix.length : 0, used: facts.usedCount, types: facts.usedTypes }, link: base + "/multiace/", default_plan: conf().default_plan };
        job.phase = "done"; job.done = true;
        const pl = report.plans || {};
        ctx.hublog("info", "multiace[" + p.name + "]: preflight " + f.name + " -> " + (report.slicer_colors || []).length + " colours, " + (report.live_slots || []).length + " slots; swaps slicer " + (pl.slicer ? pl.slicer.swaps : "-") + " / optimize " + (pl.optimize ? pl.optimize.swaps : "-") + " / layer " + (pl.layer ? pl.layer.swaps : "-") + (report.missing_materials && report.missing_materials.length ? "; missing " + report.missing_materials.join(",") : ""));
      } catch (e) { job.error = e.message; job.phase = "error"; job.done = true; }
    })();
  });

  // Re-read the live loadout for a cached report (after the person moved
  // spools) and recompute the moves and the estimates from what the heads hold
  // now. The as-sliced plan was matched against the slots at upload time, so
  // it is flagged stale when they changed. `remap` ({slicerT: ace*4+slot}, the
  // card's slot picker) re-plans the as-sliced rows and estimate around the
  // picked slots; a pick that names an empty slot or another material is 400.
  ctx.app.post("/api/multiace/recheck", async (req, res) => {
    const b = req.body || {};
    const rec = REPORTS.get(String(b.token || "")); if (!rec) return bad(res, 404, "No such preflight (run the check again)");
    const s = await snapshot(rec.idx, true);
    if (!s.multiace) return bad(res, 409, "the printer no longer answers as multiACE");
    const before = JSON.stringify((rec.report.live_slots || []).map(x => [x.ace, x.slot, lc(x.material), hexOf(x.color)]));
    const after = JSON.stringify((s.live_slots || []).map(x => [x.ace, x.slot, lc(x.material), hexOf(x.color)]));
    const moves = {}; for (const m of PLANS) moves[m] = movesFor(rec.report, m, s.live_slots);
    const start = startFromHeadSource(s.head_source), events = rec.report.events || [];
    const est = p => estimatePlan(p, events, rec.facts.matrix, conf().swap_seconds, rec.facts.density, start);
    const estimates = {}; for (const m of PLANS) estimates[m] = est((rec.report.plans || {})[m]);
    let rows = null, remap = null;
    if (b.remap && typeof b.remap === "object" && Object.keys(b.remap).length) {
      const ar = applyRemap(rec.report, b.remap, s.live_slots);
      if (ar.errors.length) return bad(res, 400, ar.errors.join("; "), { remap_errors: ar.errors });
      // engine_swaps is the engine's count for ITS match, not for the picked one
      estimates.slicer = { ...est({ ...(rec.report.plans || {}).slicer, mapping: ar.mapping }), engine_swaps: null };
      rows = { slicer: rowsFor(rec.report, ar.mapping) };
      remap = ar.remap;
    }
    res.json({ token: rec.report.token, live_slots: s.live_slots, moves, estimates, rows, remap, start, stale_slicer: before !== after, reasons: checks(s, null) });
  });

  // Always a start (the engine uploads with print=true). -> { jobId }; the
  // Hub job polls the engine itself so the ledger note is written even if
  // the browser goes away.
  ctx.app.post("/api/multiace/print", async (req, res) => {
    pruneJobs();
    const b = req.body || {};
    const rec = REPORTS.get(String(b.token || "")); if (!rec) return bad(res, 404, "No such preflight (run the check again)");
    const idx = printerOf(req); if (idx == null || idx !== rec.idx) return bad(res, 400, "That preflight was for a different printer");
    const mode = PLANS.includes(b.mode) ? b.mode : null; if (!mode) return bad(res, 400, "mode must be one of " + PLANS.join(", "));
    const p = printers()[idx], report = rec.report, plan = (report.plans || {})[mode];
    if (!plan || !plan.feasible) return bad(res, 400, "the " + mode + " plan is not feasible" + (plan && plan.reason ? ": " + plan.reason : ""));
    let picks = null;
    if (mode === "slicer" && b.remap && typeof b.remap === "object" && Object.keys(b.remap).length) {
      picks = {};
      for (const [k, v] of Object.entries(b.remap)) { const t = Number(k), s = Number(v); if (!Number.isInteger(t) || !Number.isInteger(s) || t < 0 || t > 15 || s < 0 || s > 15) return bad(res, 400, "remap must be {slicerT: ace*4+slot}"); picks[String(t)] = s; }
    }
    const s = await snapshot(idx, true);
    if (!s.multiace) return bad(res, 409, p.name + " no longer answers as multiACE");
    const reasons = checks(s, rec.facts);
    if (reasons.length) return res.status(409).json({ error: reasons.map(r => r.text).join("; "), reasons });
    const moves = movesFor(report, mode, s.live_slots);
    if (moves.length) return res.status(409).json({ error: "the " + mode + " plan needs " + moves.length + " spool move" + (moves.length === 1 ? "" : "s") + " first (move the spool, then update its slot label in multiACE / FilamentHub, then re-check)", needsMoves: true, moves });
    // The engine replaces its own matching with `remap` wholesale, so a pick
    // goes out as the FULL as-sliced map (applyRemap); no pick sends none.
    let mapping = plan.mapping || [], remap = null;
    if (picks) {
      const ar = applyRemap(report, picks, s.live_slots);
      if (ar.errors.length) return bad(res, 400, ar.errors.join("; "), { remap_errors: ar.errors });
      mapping = ar.mapping; remap = ar.remap;
    }
    // Estimated against what the heads hold NOW, not at check time.
    const est = estimatePlan({ ...plan, mapping }, report.events, rec.facts.matrix, conf().swap_seconds, rec.facts.density, startFromHeadSource(s.head_source));
    const heads = [...new Set(mapping.filter(m => m && m.slot).map(m => Number(m.slot.slot)))].sort((a, c) => a - c);
    // What each colour printed from, with the file's grams, for the costing row.
    const pal = new Map((rec.facts.palette || []).map(x => [x.i, x]));
    const colours = mapping.filter(m => m && m.slot).map(m => { const c = (report.slicer_colors || []).find(x => x.t === m.t) || {}, pg = pal.get(m.t) || {};
      return { t: m.t, hex: hexOf(c.hex), material: c.material || m.slot.material || "", ace: m.slot.ace, slot: m.slot.slot, slot_hex: hexOf(m.slot.color), grams: num(pg.grams) }; });
    const jobId = newJobId();
    const job = { kind: "print", printer: idx, file: rec.name, mode, phase: "identity", sent: 0, total: 0, done: false, error: null, result: null, engine: null, ts: Date.now() };
    JOBS.set(jobId, job);
    const sent = { id: jobId, printer_id: idx, printer: p.name, file: rec.name, type: rec.slug, plan: mode, swaps: est.swaps, tool_changes: est.tool_changes || 0, est_added_sec: est.est_added_sec,
                   purge_mm: est.purge_mm, purge_g: est.purge_g, swap_seconds: est.swap_seconds, swaps_basis: est.basis, engine_swaps: est.engine_swaps, heads, colours, remap: picks ? Object.keys(picks).length : 0, identity_map: conf().identity_map, ts: Date.now(), started: false, engine_job: null, error: null };
    S.sent.push(sent); if (S.sent.length > SENT_MAX) S.sent.splice(0, S.sent.length - SENT_MAX);
    save();
    res.json({ jobId, mode, swaps: est.swaps, est_added_sec: est.est_added_sec, purge_g: est.purge_g, heads });
    (async () => {
      const base = s.probe.url;
      try {
        if (conf().identity_map) {
          const lines = [0, 1, 2, 3].map(i => "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=" + i + " MAP_EXTRUDER=" + i);
          lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + (heads.length ? heads : [0, 1, 2, 3]).join(","));
          const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(lines.join("\n")), { method: "POST" });
          if (!r.ok) throw new Error("identity extruder map refused (" + r.status + "): " + (await r.text()).slice(0, 160));
        }
        job.phase = "engine";
        const body = { token: report.token, mode, bed_mesh: !!b.bed_mesh, camera: !!b.camera, flow_cal: !!b.flow_cal };
        if (remap) body.remap = remap;
        const r = await jpost(base + "/multiace/api/preflight/print", body, 30000);
        if (r.status !== 200 || !r.body || !r.body.job_id) throw new Error("multiACE refused the print (" + r.status + "): " + ((r.body && (r.body.detail || r.body.error)) || ""));
        sent.engine_job = r.body.job_id; save();
        const t0 = Date.now();
        for (;;) {
          await new Promise(w => setTimeout(w, ENGINE_POLL_MS));
          const st = await jget(base + "/multiace/api/preflight/print/status?job_id=" + encodeURIComponent(r.body.job_id), 10000).catch(() => null);
          if (st && st.status === 200 && st.body) {
            job.engine = { stage: st.body.stage, percent: st.body.percent, error: st.body.error };
            if (st.body.done) { if (st.body.error) throw new Error("multiACE: " + st.body.error); break; }
          }
          if (Date.now() - t0 > ENGINE_WAIT_MS) throw new Error("multiACE did not finish within " + Math.round(ENGINE_WAIT_MS / 60000) + " min");
        }
        sent.started = true; save();
        job.result = { printer: p.name, started: true, mode, swaps: est.swaps, est_added_sec: est.est_added_sec, purge_g: est.purge_g, engine_job: r.body.job_id };
        job.phase = "done"; job.done = true;
        ctx.hublog("info", "multiace[" + p.name + "]: started " + rec.name + " via multiACE (" + mode + ", " + est.swaps + " swaps, ~+" + Math.round(est.est_added_sec / 60) + " min, ~" + est.purge_g + " g purge top-up)");
      } catch (e) {
        job.error = e.message; job.phase = "error"; job.done = true; sent.error = e.message; save();
        ctx.hublog("warn", "multiace[" + p.name + "]: " + rec.name + " - " + e.message);
      }
    })();
  });

  ctx.app.post("/api/multiace/inbox", async (req, res) => {
    pruneJobs();
    const idx = printerOf(req); if (idx == null) return bad(res, 400, "Unknown printer");
    const f = fileOf(req); if (!f) return bad(res, 400, "Bad file name");
    try { await fsp.access(f.fp); } catch { return bad(res, 404, "File not found"); }
    const pr = await probe(idx, false);
    if (!pr || !pr.multiace) return bad(res, 400, printers()[idx].name + " is not a multiACE printer");
    const jobId = newJobId();
    const job = { kind: "inbox", printer: idx, file: f.name, phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
    JOBS.set(jobId, job);
    res.json({ jobId, link: pr.url + "/multiace/" });
    (async () => {
      try {
        const r = await uploadMultipart(pr.url + "/multiace/api/preflight/inbox", f.fp, f.name, job, ENGINE_WAIT_MS);
        if (r.status !== 200) throw new Error((r.body && r.body.detail) || "HTTP " + r.status);
        job.result = { ...r.body, link: pr.url + "/multiace/" }; job.phase = "done"; job.done = true;
      } catch (e) { job.error = e.message; job.phase = "error"; job.done = true; }
    })();
  });

  ctx.app.get("/api/multiace/job", (req, res) => {
    const job = JOBS.get(String(req.query.job || ""));
    if (!job) return bad(res, 404, "No such job");
    res.json({ kind: job.kind, printer: job.printer, file: job.file, mode: job.mode || null, phase: job.phase, sent: job.sent, total: job.total, done: job.done, error: job.error, result: job.result, engine: job.engine || null });
  });
  ctx.app.get("/api/multiace/sent", (req, res) => res.json({ sent: S.sent.slice(-100).reverse() }));

  ctx.hublog("info", "multiace (" + FORK + " fork module) armed: swap_seconds " + conf().swap_seconds + ", default plan " + conf().default_plan + "; printers probe on first use");
}

module.exports = { register, gate, checks, parseFlushMatrix, purgeTopupMm, purgeGrams, simulateSwaps, startFromHeadSource, estimatePlan, applyRemap, rowsFor, deltaE2000, deltaE2000Lab, hexToLab, slotHolds, movesFor, enrichReport, fileFacts,
                   DEFAULTS, PLANS, FILAMENT_MM3_PER_MM, PURGE_TOPUP_FRAC, PURGE_MIN_MM, PURGE_MAX_MM, ENGINE_DEFAULT_PURGE_MM, SLOT_MATCH_DE };
