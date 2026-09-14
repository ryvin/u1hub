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
//      takes its final name; a short or long copy is deleted, not kept.
//   5. Files in printer subfolders are ignored, the same as the transfer
//      route: the library is flat.
//
// Provides nothing. GET /api/printer-sync reports what it has done;
// POST /api/printer-sync/run runs one pass now and answers when it is done
// (the harness drives it this way rather than waiting on the timer).

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const SYNC_MS = Math.max(5000, parseInt(process.env.U1HUB_SYNC_MS, 10) || 60000);
const PAUSE_MS = Math.max(0, parseInt(process.env.U1HUB_SYNC_PAUSE_MS, 10) || 2000);
const LIST_TIMEOUT_MS = 2500;      // same ceiling core/library.js gives a listing
const FILE_TIMEOUT_MS = 10 * 60 * 1000;
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

// Stream one printer file to `dest`, resolving with the byte count written.
function download(base, name, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + "/server/files/gcodes/" + encPath(name));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      let bytes = 0;
      res.on("data", c => { bytes += c.length; });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve(bytes));
      res.pipe(out);
    });
    req.setTimeout(FILE_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function register(ctx) {
  const S = { lastRun: 0, running: null, fleet: [], synced: [], errors: [], skipped: {} };
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
      .map(f => ({ name: f.path, size: f.size || 0 }));
  }

  // { size } when the library has the file, null when it does not. The
  // library snapshot answers when it can; the disk answers when there is no
  // snapshot yet (boot) or the snapshot predates a copy this pass just made.
  function localState(name, slug, dir) {
    const snap = ctx.fileStat(name, slug);
    if (snap) return snap;
    try { const st = fs.statSync(path.join(dir, name)); return { size: st.size, mtime: st.mtimeMs }; }
    catch { return null; }
  }

  async function pullOne(p, f, dir) {
    const base = String(p.url).replace(/\/+$/, "");
    const dest = path.join(dir, f.name), part = dest + ".part";
    try {
      const got = await download(base, f.name, part);
      if (got !== f.size) throw new Error("size " + got + " != listed " + f.size);
      if (fs.existsSync(dest)) throw new Error("appeared locally mid-copy");
      fs.renameSync(part, dest);
      S.synced.push({ name: f.name, printer: p.name, size: got, at: Date.now() });
      if (S.synced.length > KEEP) S.synced.splice(0, S.synced.length - KEEP);
      ctx.hublog("info", "printer-sync: copied '" + f.name + "' from " + p.name + " (" + got + " bytes)");
      return true;
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      S.errors.push({ name: f.name, printer: p.name, error: String(e.message || e), at: Date.now() });
      if (S.errors.length > KEEP) S.errors.splice(0, S.errors.length - KEEP);
      ctx.hublog("warn", "printer-sync: '" + f.name + "' from " + p.name + " failed - " + String(e.message || e));
      return false;
    }
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
        const have = localState(f.name, slug, dir);
        if (have) {
          if (have.size !== f.size && !S.skipped[f.name]) {
            S.skipped[f.name] = { printer: p.name, reason: "library has a different file with this name (" + have.size + " vs " + f.size + " bytes)", at: Date.now() };
            out.skipped.push(f.name);
          }
          continue;
        }
        if (await pullOne(p, f, dir)) out.copied.push(f.name);
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
    res.json({ enabled: true, intervalMs: SYNC_MS, pauseMs: PAUSE_MS, lastRun: S.lastRun, running: !!S.running,
      synced: S.synced.slice(-50), errors: S.errors.slice(-20), skipped: S.skipped });
  });
  ctx.app.post("/api/printer-sync/run", async (req, res) => {
    try { res.json({ ok: true, ...(await run()) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  const t0 = setTimeout(() => run().catch(() => {}), 8000); if (t0.unref) t0.unref();
  const tick = setInterval(() => run().catch(() => {}), SYNC_MS); if (tick.unref) tick.unref();
}

module.exports = { register };
