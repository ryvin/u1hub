// test/mock-multiace.js — a multiACE web backend (decay71/multiACE, FastAPI
// under nginx's /multiace/ prefix) for the fork's multiace suite. Fork
// (ryvin/u1hub), not part of upstream dlgambill/u1hub.
//
// It answers under the SAME host as mock-moonraker (the real one sits beside
// Moonraker on the printer's port 80), so mock-moonraker delegates every
// /multiace/* request to `handler` when a test sets state.multiace.
//
// Shapes follow upstream's main.py / preflight_core.py (1.20b-pre) and the
// live reads of davinci on 2026-10-04 (docs/multiace.md "Contract"):
//   GET  /multiace/api/version               {web, printer:{...}}
//   GET  /multiace/api/preflight/livedata    {live_slots, head_ctx} | 409 (manual head)
//   POST /multiace/api/preflight             multipart "file" -> the report | 413 | 409 processed
//   POST /multiace/api/preflight/print       {token, mode, remap, ...} -> {job_id, filename, mode}
//   GET  /multiace/api/preflight/print/status?job_id= -> {stage, percent, done, error, ...}
//   POST /multiace/api/preflight/inbox       multipart -> {ok, name, size} | 409 | 413
//   GET  /multiace/api/preflight/inbox       {pending, name, size, ts}
//
// The report is NOT the engine: the mapping is exact-hex / same-material
// fallback, the plans are a deterministic toy layout, and the swap counts
// use the same walk as preflight_core._real_swap_count. The point is a
// faithful SHAPE with numbers a test can predict, never a re-port of the
// post-processor (its own header warns a port "silently drifts").

"use strict";

const PROCESSED_MARKERS = ["; multiACE processed:", "; multiACE auto-load:"];

function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/.exec(contentType || "");
  if (!m) return null;
  const boundary = Buffer.from("--" + m[1].trim());
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const hdrEnd = buf.indexOf("\r\n\r\n", start);
  if (hdrEnd < 0) return null;
  const head = buf.slice(start, hdrEnd).toString("latin1");
  const fm = /filename="([^"]*)"/.exec(head);
  const bodyStart = hdrEnd + 4;
  const end = buf.indexOf(Buffer.from("\r\n--" + m[1].trim()), bodyStart);
  return { filename: fm ? fm[1] : "", data: buf.slice(bodyStart, end < 0 ? buf.length : end) };
}

const cfgLine = (text, key) => { const r = new RegExp("^;\\s*" + key + "\\s*=\\s*(.*)$", "m").exec(text); return r ? r[1].trim() : null; };

// preflight_core._real_swap_count, verbatim in spirit: every head starts on
// ACE 0's same-numbered slot, a toolchange whose slot differs is a swap.
function realSwapCount(events, mapping) {
  const byT = new Map(mapping.filter(m => m.slot).map(m => [m.t, m.slot]));
  const cur = { 0: "0,0", 1: "0,1", 2: "0,2", 3: "0,3" };
  let swaps = 0;
  for (const t of events) {
    const s = byT.get(t); if (!s) continue;
    const key = s.ace + "," + s.slot;
    if (cur[s.slot] !== key) { swaps++; cur[s.slot] = key; }
  }
  return swaps;
}

function createMultiaceMock(opts) {
  const o = opts || {};
  const state = {
    web: o.web || "1.00.1b+mock",
    maxBytes: 110 * 1024 * 1024,          // _PREFLIGHT_MAX_SIZE (MULTIACE_PREFLIGHT_MAX_MB=110)
    inboxMaxBytes: 256 * 1024 * 1024,     // [ace] inbox_max_mb default
    manual: false,                        // a head in manual bypass -> livedata 409
    live_slots: o.live_slots || [
      { ace: 0, slot: 0, material: "PLA", color: "#fc8200" }, { ace: 0, slot: 1, material: "PLA", color: "#ffb282" },
      { ace: 0, slot: 2, material: "PLA", color: "#0f6b2e" }, { ace: 0, slot: 3, material: "PLA", color: "#1436c8" },
      { ace: 1, slot: 0, material: "PLA", color: "#f55a7c" }, { ace: 1, slot: 1, material: "PLA", color: "#631313" },
      { ace: 1, slot: 2, material: "PLA", color: "#000000" }, { ace: 1, slot: 3, material: "PLA", color: "#ffffff" }
    ],
    head_ctx: { mode: "multi", ace_head: 3, ace_heads: [0, 1, 2, 3], head_ace: { 0: 0, 1: 1, 2: 2, 3: 3 }, feeders: [],
                head_nozzles: { 0: 0.4, 1: 0.4, 2: 0.4, 3: 0.4 }, head_nozzle_types: { 0: "standard", 1: "standard", 2: "standard", 3: "standard" },
                pickup_cleaning: false, bg_available: true, bg_heads: [] },
    jobMs: 60,                            // how long the fake rewrite+upload takes
    preflights: [],                       // { filename, size, at, token }
    prints: [],                           // { token, mode, remap, body, at, scriptsSeen, job_id }
    inbox: null,                          // { name, size, ts }
    inboxPuts: [],
    tokens: {},                           // token -> { filename, report }
    jobs: {},                             // job_id -> status
    moon: o.moon || null,                 // the mock-moonraker state, so a print lands as "printing" and command order is visible
    onPrintStart: o.onPrintStart || null
  };
  let seq = 0;
  const token = () => (Date.now().toString(16) + (seq++).toString(16).padStart(6, "0") + "0".repeat(32)).slice(0, 32);

  function buildReport(text, filename, size, tok) {
    const colors = (cfgLine(text, "filament_colou?r") || "").split(";").map(s => s.trim().toLowerCase()).filter(Boolean);
    const types = (cfgLine(text, "filament_type") || "").split(";").map(s => s.trim());
    const events = [];
    for (const m of text.matchAll(/^; Change Tool(\d+) -> Tool(\d+)/gm)) events.push(Number(m[2]));
    const used = [...new Set(events)].sort((a, b) => a - b);
    const slicer_colors = used.map(t => ({ t, hex: colors[t] || "", name: "", material: types[t] || "" }));
    const live = state.live_slots.slice().sort((a, b) => a.ace - b.ace || a.slot - b.slot);
    const needed = new Set(used.map(t => (types[t] || "").toLowerCase()).filter(Boolean));
    const loaded = new Set(live.map(s => (s.material || "").toLowerCase()));
    const missing = [...needed].filter(m => !loaded.has(m)).sort();
    const out = { token: tok, filename, size, num_aces: Math.max(1, ...live.map(s => s.ace + 1)),
      slicer_colors, live_slots: live.map(s => ({ ...s, name: "" })), missing_materials: missing, plans: {},
      slicer: "Snapmaker Orca", forca: false, nozzles: {}, head_nozzles: { ...state.head_ctx.head_nozzles }, nozzles_mixed: false };
    if (missing.length) return out;
    // slicer plan: tier-major exact_hex, then same-material fallback, then duplicate
    const claimed = new Set(), info = {};
    const slot = s => ({ ace: s.ace, slot: s.slot, material: s.material, color: s.color });
    for (const t of used) { const s = live.find(x => !claimed.has(x.ace + "," + x.slot) && x.color === colors[t] && x.material.toLowerCase() === (types[t] || "").toLowerCase()); if (s) { claimed.add(s.ace + "," + s.slot); info[t] = { tier: "exact_hex", slot: slot(s) }; } }
    for (const t of used) { if (info[t]) continue; const s = live.find(x => !claimed.has(x.ace + "," + x.slot) && x.material.toLowerCase() === (types[t] || "").toLowerCase()); if (s) { claimed.add(s.ace + "," + s.slot); info[t] = { tier: "fallback", slot: slot(s) }; } }
    for (const t of used) { if (info[t]) continue; const s = live.find(x => x.material.toLowerCase() === (types[t] || "").toLowerCase()); info[t] = s ? { tier: "duplicate", slot: slot(s) } : { tier: "no_slot", slot: null }; }
    const mapping = used.map(t => ({ t, slot: info[t].slot, tier: info[t].tier, loose_mat: false }));
    const tool_changes = Math.max(0, events.length - 1);
    out.events = events;
    out.plans.slicer = { feasible: true, swaps: realSwapCount(events, mapping), tool_changes, mapping };
    // optimize / layer: a proposed loadout. Head by first appearance round-robin,
    // ACE index first-come per head (the multi-mode rule in rewrite_pipeline).
    const order = []; for (const t of events) if (!order.includes(t)) order.push(t);
    const perHead = [0, 0, 0, 0], planned = [];
    order.forEach((t, i) => { const h = i % 4; planned.push({ t, slot: { ace: perHead[h], slot: h, material: types[t] || "", color: colors[t] || "" }, tier: "planned", loose_mat: false }); perHead[h]++; });
    planned.sort((a, b) => a.slot.ace - b.slot.ace || a.slot.slot - b.slot.slot || a.t - b.t);
    const optSwaps = realSwapCount(events, planned);
    out.plans.optimize = { feasible: true, swaps: optSwaps, tool_changes, mapping: planned };
    out.plans.layer = state.layerInfeasible
      ? { feasible: false, swaps: 0, tool_changes, mapping: [], reason: ">4 colors in some layer" }
      : { feasible: true, swaps: optSwaps + 1, tool_changes, mapping: planned.map(m => ({ ...m, slot: { ...m.slot } })), reason: "" };
    return out;
  }

  function readBody(req) { return new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); }); }

  async function handler(req, res, u) {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const p = u.pathname;
    if (p === "/multiace/api/version" && req.method === "GET")
      return send(200, { web: state.web, moonraker_url: "http://127.0.0.1:7125", config_path: "/home/lava/printer_data/config/extended/ace.cfg",
        frontend_dir: "/home/lava/multiace_web/frontend", printer: { device_name: "U1-mock", machine_type: "Snapmaker U1", firmware_version: "1.5.2" } });
    if (p === "/multiace/api/preflight/livedata" && req.method === "GET") {
      if (state.manual) return send(409, { detail: "a head is in manual mode; slot matching is unavailable" });
      return send(200, { live_slots: state.live_slots.slice().sort((a, b) => a.ace - b.ace || a.slot - b.slot), head_ctx: state.head_ctx });
    }
    if (p === "/multiace/api/preflight" && req.method === "POST") {
      const body = await readBody(req);
      const part = parseMultipart(body, req.headers["content-type"]);
      if (!part || !part.filename) return send(400, { detail: "invalid filename" });
      if (!/\.(gcode|gco|g)$/i.test(part.filename)) return send(400, { detail: "not a g-code file" });
      if (!part.data.length) return send(400, { detail: "empty file" });
      if (part.data.length > state.maxBytes)
        return send(413, { detail: "This g-code is too large for in-printer preflight (" + Math.floor(part.data.length / 1048576) + " MB > " + Math.floor(state.maxBytes / 1048576) + " MB limit). The Snapmaker U1 is too slow to analyse files this large." });
      const text = part.data.toString("utf8");
      if (PROCESSED_MARKERS.some(mk => text.slice(0, 512 * 1024).includes(mk)))
        return send(409, { detail: "This file has already been processed by multiACE (format 4), so it is ready to print as it is - upload it in Fluidd." });
      if (state.manual) return send(409, { detail: "no slots are loaded on the printer" });
      const tok = token();
      const report = buildReport(text, part.filename, part.data.length, tok);
      state.tokens[tok] = { filename: part.filename, report };
      state.preflights.push({ filename: part.filename, size: part.data.length, at: Date.now(), token: tok });
      return send(200, report);
    }
    if (p === "/multiace/api/preflight/print" && req.method === "POST") {
      let b = {}; try { b = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch { return send(422, { detail: "bad json" }); }
      if (!["slicer", "optimize", "layer", "head"].includes(b.mode)) return send(400, { detail: "invalid mode" });
      if (!/^[0-9a-f]{32}$/.test(String(b.token || ""))) return send(400, { detail: "invalid token" });
      const t = state.tokens[b.token];
      if (!t) return send(404, { detail: "preflight token expired or unknown" });
      const job_id = token();
      state.jobs[job_id] = { job_id, stage: "queued", percent: 0, done: false, error: null, filename: t.filename, mode: b.mode };
      state.prints.push({ token: b.token, mode: b.mode, remap: b.remap || null, body: b, at: Date.now(), job_id,
                          scriptsSeen: state.moon ? state.moon.gcodeScripts.length : null });
      const j = state.jobs[job_id];
      setTimeout(() => { j.stage = "rewrite"; j.percent = 45; }, Math.max(1, state.jobMs / 3));
      setTimeout(() => { j.stage = "upload"; j.percent = 90; }, Math.max(2, state.jobMs * 2 / 3));
      setTimeout(() => {
        if (state.failPrint) { j.error = String(state.failPrint); j.stage = "error"; j.done = true; return; }
        j.stage = "done"; j.percent = 100; j.done = true;
        if (state.moon) { state.moon.printState = "printing"; state.moon.filename = t.filename; state.moon.files.push({ name: t.filename, size: t.report.size }); }
        if (state.onPrintStart) state.onPrintStart(t.filename, b);
      }, Math.max(3, state.jobMs));
      return send(200, { job_id, filename: t.filename, mode: b.mode });
    }
    if (p === "/multiace/api/preflight/print/status" && req.method === "GET") {
      const j = state.jobs[u.searchParams.get("job_id") || ""];
      if (!j) return send(404, { detail: "job not found" });
      return send(200, { ...j });
    }
    if (p === "/multiace/api/preflight/inbox" && req.method === "POST") {
      const body = await readBody(req);
      const part = parseMultipart(body, req.headers["content-type"]);
      if (!part || !part.filename) return send(400, { detail: "invalid filename" });
      if (!/\.(gcode|gco|g)$/i.test(part.filename)) return send(400, { detail: "not a g-code file" });
      const first = part.data.slice(0, 1048576).toString("latin1");
      if (PROCESSED_MARKERS.some(mk => first.includes(mk))) return send(409, { detail: "this file is already multiACE-processed - send the ORIGINAL slicer export, never a processed one (double-processing corrupts the swaps)" });
      if (part.data.length > state.inboxMaxBytes) return send(413, { detail: "file too large for the inbox (> " + Math.floor(state.inboxMaxBytes / 1048576) + " MB; raise via [ace] inbox_max_mb in ace.cfg)" });
      if (!part.data.length) return send(400, { detail: "empty file" });
      state.inbox = { name: part.filename, size: part.data.length, ts: Date.now() / 1000 };
      state.inboxPuts.push({ ...state.inbox });
      return send(200, { ok: true, name: part.filename, size: part.data.length });
    }
    if (p === "/multiace/api/preflight/inbox" && req.method === "GET")
      return send(200, state.inbox ? { pending: true, ...state.inbox } : { pending: false, name: "", size: 0, ts: 0 });
    if (p === "/multiace/api/preflight/inbox" && req.method === "DELETE") { state.inbox = null; return send(200, { ok: true }); }
    send(404, { detail: "mock-multiace: no route " + p });
  }

  return { state, handler, realSwapCount };
}

module.exports = { createMultiaceMock, realSwapCount };
