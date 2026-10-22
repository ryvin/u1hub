// modules/printer-sync.js — keep the library in step with what lands on the
// printers.
//
// A file that reaches a printer some other way (Orca sending straight to the
// machine, a USB stick, another tool) shows up in the Hub only as a "printer
// only" row, which can be managed but never selected as a job. This module
// closes that gap: every SYNC_MS it compares each printer's own file listing
// with the library and copies anything the library does not have.
//
// Rules, in the order they were paid for (MISTAKES.md / LESSONS 2026-09-14 —
// a bulk pull of ~250 files through Moonraker's HTTP API grew its memory until
// the kernel killed it on a 961 MB U1, twelve minutes into someone's print):
//
//   1. One file at a time, with a pause between files. Never a burst.
//   2. Never while that printer is printing or paused. Unknown state counts as
//      busy — a printer whose state the fleet poller has not seen is skipped
//      until it has.
//   3. Never overwrite. A library file with the same name but different bytes
//      is left alone and listed under `skipped` with the reason, once.
//   4. Verify the byte count against the printer's listing before the file
//      takes its final name; a short or long copy is deleted, not kept. After
//      SIZE_FAIL_MAX such failures for one (printer, file, listed size,
//      modified) it is skipped, listed under `skipped`, until that listing
//      changes (in memory only; a restart tries it twice more).
//   5. Files in printer subfolders are ignored, the same as the transfer
//      route: the library is flat.
//   6. The printer is asked again, directly (print_stats, no cache), before
//      EVERY file, and watched while a file streams: a printer that starts
//      printing mid-pass gets no further request, and a copy in flight is
//      abandoned (connection closed, .part deleted) within WATCH_MS. A pass can
//      run for tens of minutes on 100+ MB files; the state at its start says
//      nothing about the state at its end.
//   7. No synchronous fs calls. The pass runs off a timer, and upstream's
//      2026-09-26 finding (CLAUDE.md "feels dead") was a timer doing statSync
//      on a share: every disk touch here is fs.promises.
//
// Fork module (ryvin/u1hub), not part of upstream dlgambill/u1hub. Ships OFF
// in MODULE_DEFAULTS until its live hardware gate is recorded (docs/FORK.md).
//
// Provides nothing. GET /api/printer-sync reports what it has done;
// POST /api/printer-sync/run runs one pass now and answers when it is done
// (the harness drives it this way rather than waiting on the timer).

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const https = require("https");

const SYNC_MS = Math.max(5000, parseInt(process.env.U1HUB_SYNC_MS, 10) || 60000);
const PAUSE_MS = Math.max(0, parseInt(process.env.U1HUB_SYNC_PAUSE_MS, 10) || 2000);
const LIST_TIMEOUT_MS = 2500;      // same ceiling core/library.js gives a listing
const FILE_TIMEOUT_MS = 10 * 60 * 1000;
const WATCH_MS = Math.max(100, parseInt(process.env.U1HUB_SYNC_WATCH_MS, 10) || 5000);   // print-state check while a file streams
const SIZE_FAIL_MAX = 2;            // size-verified failures before a file is skipped until its listing changes
const KEEP = 200;                  // synced/error history kept for /api/printer-sync
const GCODE_RE = /\.(gcode|gco|g)$/i;
const BUSY_STATES = new Set(["printing", "paused", "unknown"]);

function encPath(name) { return String(name).split("/").map(encodeURIComponent).join("/"); }

function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .finally(() => clearTimeout(to));
}

// The printer's own print_stats.state, uncached; "unknown" when it does not
// answer within LIST_TIMEOUT_MS.
async function livePrintState(base) {
  try {
    const d = await fetchJson(base + "/printer/objects/query?print_stats", LIST_TIMEOUT_MS);
    const ps = d && d.result && d.result.status ? d.result.status.print_stats : null;
    return ps && ps.state ? String(ps.state) : "unknown";
  } catch { return "unknown"; }
}

// Stream one printer file to `dest`, resolving with the byte count written
// once the file is closed. `ctl.abort(err)` (set here) closes the connection
// and the file and rejects with `err`; every failure path closes the file
// before rejecting, so the caller can delete the .part straight away.
function download(base, name, dest, ctl) {
  return new Promise((resolve, reject) => {
    let out = null, settled = false, finished = false, bytes = 0, req = null;
    const fail = e => {
      if (settled) return;
      settled = true;
      try { if (req) req.destroy(); } catch {}
      if (out && !out.closed) { out.once("close", () => reject(e)); out.destroy(); }
      else reject(e);
    };
    const u = new URL(base + "/server/files/gcodes/" + encPath(name));
    const mod = u.protocol === "https:" ? https : http;
    req = mod.get(u, res => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error("HTTP " + res.statusCode)); }
      out = fs.createWriteStream(dest);
      res.on("data", c => { bytes += c.length; });
      res.on("error", fail);
      out.on("error", fail);
      out.on("finish", () => { finished = true; });
      out.on("close", () => { if (finished && !settled) { settled = true; resolve(bytes); } });
      res.pipe(out);
    });
    req.setTimeout(FILE_TIMEOUT_MS, () => fail(new Error("timeout")));
    req.on("error", fail);
    if (ctl) ctl.abort = fail;
  });
}

function register(ctx) {
  const S = { lastRun: 0, running: null, fleet: [], synced: [], errors: [], skipped: {}, sizeFails: new Map() };   // sizeFails: in memory only
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function fleetRec(idx) { return (S.fleet || []).find(p => p && p.id === idx) || null; }
  function busy(idx) {
    const rec = fleetRec(idx);
    if (!rec || !rec.online) return true;                 // unknown or offline: do not pull
    return BUSY_STATES.has(String(rec.state || "unknown"));
  }

  async function listOnboard(p) {
    const base = String(p.url).replace(/\/+$/, "");
    const d = await fetchJson(base + "/server/files/list?root=gcodes", LIST_TIMEOUT_MS);
    return (d.result || [])
      .filter(f => GCODE_RE.test(f.path || "") && !String(f.path).includes("/"))
      .map(f => ({ name: f.path, size: f.size || 0, modified: f.modified || 0 }));
  }

  // { size } when the library has the file, null when it does not. The
  // library snapshot answers when it can; the disk answers when there is no
  // snapshot yet (boot) or the snapshot predates a copy this pass just made.
  async function localState(name, slug, dir) {
    const snap = ctx.fileStat(name, slug);
    if (snap) return snap;
    try { const st = await fsp.stat(path.join(dir, name)); return { size: st.size, mtime: st.mtimeMs }; }
    catch { return null; }
  }
  async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

  // Before every file: a fresh fleet snapshot AND the printer's own answer.
  async function busyNow(idx, p) {
    try { S.fleet = await ctx.fleet(); } catch { S.fleet = []; }
    if (busy(idx)) return true;
    return BUSY_STATES.has(await livePrintState(String(p.url).replace(/\/+$/, "")));
  }

  // -> "ok" | "failed" | "busy" (the printer started printing; copy abandoned)
  async function pullOne(p, f, dir) {
    const base = String(p.url).replace(/\/+$/, "");
    const dest = path.join(dir, f.name), part = dest + ".part";
    const ctl = {};
    let startedPrinting = false, checking = false;
    // Only a definite printing/paused aborts: a status query that times out
    // while the printer is busy serving this very file is no reason to drop it.
    const watch = setInterval(async () => {
      if (checking || startedPrinting) return;
      checking = true;
      try {
        const st = await livePrintState(base);
        if ((st === "printing" || st === "paused") && ctl.abort) { startedPrinting = true; ctl.abort(new Error("printer started printing (" + st + ") - copy abandoned")); }
      } finally { checking = false; }
    }, WATCH_MS);
    try {
      const got = await download(base, f.name, part, ctl);
      if (got !== f.size) { const e = new Error("size " + got + " != listed " + f.size); e.sizeMismatch = true; throw e; }
      if (await exists(dest)) throw new Error("appeared locally mid-copy");
      await fsp.rename(part, dest);
      S.synced.push({ name: f.name, printer: p.name, size: got, at: Date.now() });
      if (S.synced.length > KEEP) S.synced.splice(0, S.synced.length - KEEP);
      ctx.hublog("info", "printer-sync: copied '" + f.name + "' from " + p.name + " (" + got + " bytes)");
      return "ok";
    } catch (e) {
      try { await fsp.unlink(part); } catch {}
      S.errors.push({ name: f.name, printer: p.name, error: String(e.message || e), at: Date.now() });
      if (S.errors.length > KEEP) S.errors.splice(0, S.errors.length - KEEP);
      ctx.hublog("warn", "printer-sync: '" + f.name + "' from " + p.name + " failed - " + String(e.message || e));
      return startedPrinting ? "busy" : (e && e.sizeMismatch ? "size" : "failed");
    } finally { clearInterval(watch); }
  }

  async function pass() {
    try { S.fleet = await ctx.fleet(); } catch { S.fleet = []; }
    const out = { copied: [], skipped: [], busy: [], offline: [] };
    for (let idx = 0; idx < ctx.printers.length; idx++) {
      const p = ctx.printers[idx];
      if (!p || !p.url) continue;
      const rec = fleetRec(idx);
      if (!rec || !rec.online) { out.offline.push(p.name); continue; }
      if (busy(idx)) { out.busy.push(p.name); continue; }
      const slug = p.type || "u1";
      const dir = ctx.gcodeFolderFor(slug);
      let files;
      try { files = await listOnboard(p); } catch { out.offline.push(p.name); continue; }
      for (const f of files) {
        const have = await localState(f.name, slug, dir);
        if (have) {
          if (have.size !== f.size && !S.skipped[f.name]) {
            S.skipped[f.name] = { printer: p.name, reason: "library has a different file with this name (" + have.size + " vs " + f.size + " bytes)", at: Date.now() };
            out.skipped.push(f.name);
          }
          continue;
        }
        // a file whose download never matches its listed size is tried
        // SIZE_FAIL_MAX times, then left alone until the printer's listing
        // for it (size or modified time) changes
        const fk = idx + "\u0000" + p.name + "\u0000" + f.name;
        let sf = S.sizeFails.get(fk);
        if (sf && (sf.size !== f.size || sf.modified !== f.modified)) {
          S.sizeFails.delete(fk); sf = null;
          if (S.skipped[f.name] && S.skipped[f.name].sizeNeverMatches) delete S.skipped[f.name];
        }
        if (sf && sf.n >= SIZE_FAIL_MAX) {
          if (!S.skipped[f.name]) {
            S.skipped[f.name] = { printer: p.name, reason: "size never matches listing (" + sf.n + " attempts)", sizeNeverMatches: true, at: Date.now() };
            out.skipped.push(f.name);
          }
          continue;
        }
        if (await busyNow(idx, p)) {
          out.busy.push(p.name);
          ctx.hublog("info", "printer-sync: " + p.name + " is busy now - no more files from it this pass (next was '" + f.name + "')");
          break;
        }
        const got = await pullOne(p, f, dir);
        if (got === "size") S.sizeFails.set(fk, { size: f.size, modified: f.modified, n: (sf ? sf.n : 0) + 1 });
        else if (got === "ok") S.sizeFails.delete(fk);
        if (got === "ok") out.copied.push(f.name);
        if (got === "busy") { out.busy.push(p.name); break; }
        await sleep(PAUSE_MS);
      }
    }
    S.lastRun = Date.now();
    return out;
  }

  function run() {
    if (S.running) return S.running;
    S.running = pass().finally(() => { S.running = null; });
    return S.running;
  }

  ctx.app.get("/api/printer-sync", (req, res) => {
    res.json({ enabled: true, fork: "ryvin/u1hub", intervalMs: SYNC_MS, pauseMs: PAUSE_MS, lastRun: S.lastRun, running: !!S.running,
      synced: S.synced.slice(-50), errors: S.errors.slice(-20), skipped: S.skipped });
  });
  ctx.app.post("/api/printer-sync/run", async (req, res) => {
    try { res.json({ ok: true, ...(await run()) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  ctx.hublog("info", "printer-sync (ryvin/u1hub fork module) armed: every " + SYNC_MS + " ms, " + PAUSE_MS + " ms between files");
  const t0 = setTimeout(() => run().catch(() => {}), 8000); if (t0.unref) t0.unref();
  const tick = setInterval(() => run().catch(() => {}), SYNC_MS); if (tick.unref) tick.unref();
}

module.exports = { register };
