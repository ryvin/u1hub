// test/mock-moonraker.js — simulated Moonraker printers for harness testing.
//
// Two profiles, matching the two printer classes 2.9 must handle:
//   "u1"      — Snapmaker U1-style: print_task_config present (4 heads, colors,
//               the port-80 quirk is irrelevant here — the Hub reads the port
//               from the printer URL either way).
//   "generic" — stock Klipper/Moonraker (Sovol SV06 Plus ACE profile): serves
//               on :7125 in real life, NO print_task_config, single extruder.
//
// This mock exists so Workstream A's plumbing (type routing, upload routing,
// capability detection, class guard) can be harness-verified BEFORE the real
// SV06 Plus ACE lands. Per Rule #1 the live check still gates the release —
// this file makes sure the only thing left to verify on hardware is hardware.

"use strict";

const http = require("http");

function createMock(profile) {
  const state = {
    profile,                       // "u1" | "generic"
    printState: "standby",
    filename: "",
    uploads: [],                   // { filename, bytes }
    gcodeScripts: [],              // raw scripts received
    files: [],                     // onboard listing
    dropColorWrites: false,        // v2.10: simulate firmware silently refusing a
                                   // color write, so the Hub's read-back-verify
                                   // honesty can be proven (it must 502, not lie)
    dropTypeWrites: false,         // v2.22.1: same knob for the material write
    history: [],                   // v2.33: Moonraker job history, newest first:
                                   // { filename, status, start_time, print_duration }
    camGrabs: 0,                   // v2.35: monitor.jpg fetches seen (issue #4: one per grab, not per viewer)
    camDelayMs: 600,               // how long the "camera" takes to answer
    metadata: null,                // fork (ryvin/u1hub): { [filename]: metadata } for /server/files/metadata; null = upstream's blank answer
    metaRequests: [],              // fork (ryvin/u1hub): every metadata GET, { filename, at }
    historyRequests: [],           // fork (ryvin/u1hub): every /server/history/list GET, { limit, start, order, at }
    configfile: null,              // fork (ryvin/u1hub): Klipper configfile.settings the SME reads; null = empty
    configRequests: [],            // fork (ryvin/u1hub): every objects/query that asked for configfile, { at }
    ace: null,                     // fork (ryvin/u1hub): multiACE's `ace` status object (objects/query?ace); null = no multiACE
    multiace: null                 // fork (ryvin/u1hub): (req, res, url) handler for /multiace/* (test/mock-multiace.js); null = 404
  };

  const objectsList = profile === "u1"
    ? ["print_stats", "display_status", "virtual_sdcard", "heater_bed", "exclude_object", "print_task_config", "extruder", "extruder1", "extruder2", "extruder3"]
    : ["print_stats", "display_status", "virtual_sdcard", "heater_bed", "exclude_object", "extruder"];

  const ptc = { // U1-only object
    filament_exist: [true, true, false, false],
    filament_color_rgba: ["FF0000FF", "00FF00FF", null, null],
    filament_type: ["PLA", "PLA", null, null],
    filament_sub_type: ["NONE", "SnapSpeed", null, null],
    filament_official: [false, true, false, false],
    filament_vendor: ["NONE", "Snapmaker", null, null],
    filament_sku: [null, 900002, null, null],
    filament_edit: [true, false, true, true]
  };
  state.ptc = ptc;                 // v2.10: let the harness inspect/verify live

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (u.pathname === "/printer/objects/list")
      return send(200, { result: { objects: objectsList } });

    if (u.pathname === "/printer/objects/query") {
      const want = [...u.searchParams.keys()];
      const status = {};
      if (want.some(k => k.startsWith("print_stats"))) {
        status.print_stats = { state: state.printState, filename: state.filename, message: state.printMessage || "",
          print_duration: state.printDuration || 0 };
        // v2.23: Snapmaker's fork reports detector pauses here, not in .message
        // (shape captured live from U2, 2026-09-08).
        if (state.exception) status.print_stats.exception = state.exception;
      }
      if (want.some(k => k.startsWith("print_task_config")) && profile === "u1")
        status.print_task_config = ptc;
      if (want.some(k => k.startsWith("display_status"))) status.display_status = { progress: 0 };
      if (want.some(k => k.startsWith("virtual_sdcard"))) status.virtual_sdcard = { progress: 0 };
      if (want.some(k => k.startsWith("heater_bed"))) status.heater_bed = { temperature: 25, target: 0 };
      if (want.some(k => k.startsWith("exclude_object"))) status.exclude_object = {};
      // Fork (ryvin/u1hub): Klipper's configfile.settings, when a test stores
      // some (state.configfile = { printer: {...}, extruder: {...} }), for the
      // SME's read-only tuning summary. Logged so pacing/caching can be asserted.
      if (want.some(k => k.startsWith("configfile"))) { state.configRequests.push({ at: Date.now() }); status.configfile = { settings: state.configfile || {} }; }
      if (want.some(k => k === "ace" || k.startsWith("ace=")) && state.ace) status.ace = state.ace;   // fork (ryvin/u1hub): multiACE
      return send(200, { result: { status } });
    }

    // Fork (ryvin/u1hub): the multiACE web backend lives beside Moonraker on
    // the printer's port 80 under /multiace/; a test that sets state.multiace
    // (test/mock-multiace.js) gets it here, every other test gets the 404.
    if (u.pathname.startsWith("/multiace/") && state.multiace) return state.multiace(req, res, u);

    // Fork (ryvin/u1hub): the config root (state.configFiles = ["printer.cfg",
    // "extended/klipper/x.cfg", ...]) for the SME's firmware/overlay check,
    // and /printer/info with state.softwareVersion. Upstream's gcodes listing
    // below is unchanged for every other root.
    if (u.pathname === "/server/files/list" && u.searchParams.get("root") === "config")
      return send(200, { result: (state.configFiles || []).map(p => ({ path: p, size: 100, modified: Date.now() / 1000, permissions: "rw" })) });
    if (u.pathname === "/printer/info")
      return send(200, { result: { state: "ready", software_version: state.softwareVersion || "v0.12.0-mock", hostname: profile + "-mock", cpu_info: "mock" } });

    if (u.pathname === "/server/files/list")
      return send(200, { result: state.files.map(f => ({ path: f.name, size: f.size, modified: Date.now() / 1000, permissions: "rw" })) });

    // Fork (ryvin/u1hub): serve a stored file's bytes, the way Moonraker does
    // for the printer-sync pull. Files pushed by upload carry no body (only a
    // byte count), so a test that wants a downloadable file sets `data` itself.
    if (u.pathname.startsWith("/server/files/gcodes/") && req.method === "GET") {
      const name = decodeURIComponent(u.pathname.slice("/server/files/gcodes/".length));
      const f = state.files.find(x => x.name === name);
      if (!f) return send(404, { error: "mock: no such file " + name });
      const body = Buffer.isBuffer(f.data) ? f.data : Buffer.alloc(f.size || 0, 0x20);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      return res.end(body);
    }

    if (u.pathname === "/server/files/upload" && req.method === "POST") {
      let bytes = 0;
      let head = Buffer.alloc(0);
      req.on("data", c => { bytes += c.length; if (head.length < 4096) head = Buffer.concat([head, c]).slice(0, 4096); });
      req.on("end", () => {
        const m = /filename="([^"]+)"/.exec(head.toString("latin1"));
        const filename = m ? m[1] : "unknown";
        state.uploads.push({ filename, bytes });
        state.files.push({ name: filename, size: bytes });
        send(201, { result: { item: { path: filename } } });
      });
      return;
    }

    if (u.pathname === "/printer/gcode/script" && req.method === "POST") {
      const script = u.searchParams.get("script") || "";
      state.gcodeScripts.push(script);
      // v2.10: apply color writes to print_task_config the way the firmware
      // does — empty trays and official (color-locked) spools silently refuse,
      // and the dropColorWrites knob refuses everything. The Hub must catch
      // every refusal via its read-back, never by trusting the write.
      if (profile === "u1" && /SET_PRINT_FILAMENT_CONFIG/.test(script)) {
        const im = /CONFIG_EXTRUDER='?(\d)'?/.exec(script);
        const cm = /FILAMENT_COLOR_RGBA='?([0-9A-Fa-f]{8})'?/.exec(script);
        if (im && cm && !state.dropColorWrites) {
          const i = Number(im[1]);
          if (ptc.filament_exist[i] && ptc.filament_edit[i] !== false)
            ptc.filament_color_rgba[i] = cm[1].toUpperCase();
        }
        // v2.22.1: the material write, same rules. dropTypeWrites models a
        // firmware that silently ignores FILAMENT_TYPE — the Hub must report
        // that honestly from the read-back, never from the 200 on the write.
        const tm = /FILAMENT_TYPE=('?)([A-Za-z+]+)\1/.exec(script);
        const sm = /FILAMENT_SUBTYPE=('?)([^' ]*)\1/.exec(script);
        // Hardware truth (U6, 2026-09-02): a type write WITHOUT VENDOR= is
        // refused — "[print_task_config] filament_config, incomplete
        // parameters" — and it raises a System Anomaly on the touchscreen.
        // Model the refusal so the harness catches any drift back to it.
        if (im && tm && !/(^|\s)VENDOR=/.test(script))
          return send(400, { error: { code: 400, message: "!! [print_task_config] filament_config, incomplete parameters" } });
        if (im && tm && !state.dropTypeWrites) {
          const i = Number(im[1]);
          if (ptc.filament_exist[i] && ptc.filament_edit[i] !== false) {
            ptc.filament_type[i] = tm[2].toUpperCase();
            if (sm) ptc.filament_sub_type[i] = sm[2] || "NONE";
          }
        }
      }
      if (/^SDCARD_PRINT_FILE/.test(script)) {
        state.printState = "printing";
        const fm = /FILENAME="([^"]+)"/.exec(script);
        state.filename = fm ? fm[1] : "";
      }
      return send(200, { result: "ok" });
    }

    if (u.pathname === "/machine/system_info")
      return send(200, { result: { system_info: { product_info: { device_name: profile === "u1" ? "U1-mock" : "SV06-mock", machine_type: profile, serial_number: "MOCK" + profile }, network: {} } } });

    // Fork (ryvin/u1hub): per-file metadata the way Moonraker answers it when
    // a test has stored some (state.metadata[filename] = { estimated_time,
    // filament_weight_total, filament_total, filament_type, slicer }); 404 for a
    // file it has none for, as Moonraker does. Every request is logged with its
    // time so the costing backfill's pacing can be measured. Upstream's blanket
    // answer below stays for every test that never sets state.metadata.
    if (u.pathname === "/server/files/metadata" && state.metadata) {
      const fn = u.searchParams.get("filename") || "";
      state.metaRequests.push({ filename: fn, at: Date.now() });
      const m = state.metadata[fn];
      if (!m) return send(404, { error: { code: 404, message: "mock: no metadata for " + fn } });
      return send(200, { result: { filename: fn, ...m } });
    }

    if (u.pathname === "/server/files/metadata")
      return send(200, { result: {} });

    // v2.35: the chamber camera's frame, as Snapmaker's plugin writes it. A
    // minimal JPEG (SOI ... EOI) after a delay, counted, so the harness can
    // prove the Hub asks once per grab however many viewers are waiting.
    if (u.pathname === "/server/files/camera/monitor.jpg" && profile === "u1") {
      state.camGrabs++;
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
      setTimeout(() => { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(jpg); }, state.camDelayMs);
      return;
    }

    // v2.37: lifetime totals, which the logbook reads print hours from.
    if (u.pathname === "/server/history/totals")
      return send(200, { result: { job_totals: { total_jobs: state.history.length, total_time: state.totalPrintTime || 0,
        total_print_time: state.totalPrintTime || 0, total_filament_used: 0, longest_job: 0 } } });

    // v2.33: the job history the Models tab's "most printed" order counts
    // from. Shape as Moonraker answers it: { result: { count, jobs } }.
    if (u.pathname === "/server/history/list") {
      const limit = Number(u.searchParams.get("limit")) || 50;
      // Fork (ryvin/u1hub): `start` (offset), `order` (asc|desc), `since` and
      // `before` (epoch seconds, on start_time) as Moonraker reads them, so the
      // costing import's paging can be exercised. Every request is logged.
      // Without those parameters the answer is upstream's: the stored list
      // (newest first) cut to `limit`.
      const start = Math.max(0, Number(u.searchParams.get("start")) || 0);
      const order = String(u.searchParams.get("order") || "desc").toLowerCase();
      const since = u.searchParams.has("since") ? Number(u.searchParams.get("since")) : null;
      const before = u.searchParams.has("before") ? Number(u.searchParams.get("before")) : null;
      let jobs = state.history.slice();
      if (Number.isFinite(since)) jobs = jobs.filter(j => (j.start_time || 0) >= since);
      if (Number.isFinite(before)) jobs = jobs.filter(j => (j.start_time || 0) <= before);
      if (order === "asc") jobs.reverse();
      state.historyRequests.push({ limit, start, order, at: Date.now() });
      return send(200, { result: { count: jobs.length, jobs: jobs.slice(start, start + limit) } });
    }

    // v2.21 fixture, for the Klipper reverse proxy only: reflect what actually
    // arrived. The proxy relays a raw stream, and the failure it must rule out
    // is core's express.json() having already drained the body — a defect that
    // is invisible from status codes alone, because an empty POST still
    // succeeds. Echoing method, content-type and the exact bytes makes it
    // visible. Deliberately not a Moonraker route: nothing but the proxy test
    // may depend on it.
    if (u.pathname === "/__echo") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => send(200, {
        method: req.method,
        contentType: req.headers["content-type"] || "",
        host: req.headers.host || "",
        cookie: req.headers.cookie || "",
        query: u.search || "",
        bytes: Buffer.byteLength(body),
        body
      }));
      return;
    }

    send(404, { error: "mock: no route " + u.pathname });
  });

  return {
    state,
    listen: port => new Promise(r => server.listen(port, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise(r => server.close(r))
  };
}

module.exports = { createMock };
