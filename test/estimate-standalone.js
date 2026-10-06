"use strict";
// test/estimate-standalone.js — fork module (ryvin/u1hub): the Estimate tab.
// Pure units first (STL measure, geometry grams, slice info, calibration fit,
// matching, pricing, reports), then the booted Hub (upload -> estimate ->
// inputs -> source -> save -> reports). Rule 6: U1HUB_ESTIMATE_FALSIFY=1 flips
// the cube-volume expectation; the run must go red.
//
// Run: node test/estimate-standalone.js   (part of npm run test:standalone)
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { createMock } = require("./mock-moonraker.js");
const REPO = path.join(__dirname, "..");
const PORT = 45993, HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_ESTIMATE_FALSIFY === "1";
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 600) : "")); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(p) { const r = await fetch(HUB + p); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function jpost(p, b) { const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
let CHILD = null, LOG = "";
async function startHub(dir, extraEnv) {
  LOG = "";
  CHILD = spawn(process.execPath, ["server.js"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_POLL_MS: "400", U1HUB_EVENTS_POLL_MS: "3600000", U1HUB_SYNC_MS: "3600000",
           U1HUB_COSTING_BACKFILL_BOOT_MS: "0", U1HUB_COSTING_IMPORT_BOOT_MS: "0", U1HUB_COSTING_IMPORT_MS: "0", U1HUB_ESTIMATE_CALIBRATE_BOOT_MS: "0",
           SME_HOME: path.join(dir, "sme-home"), U1HUB_PROFILE: "", ...(extraEnv || {}) } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  for (let i = 0; i < 100; i++) { try { const r = await fetch(HUB + "/api/config"); if (r.ok) return; } catch {} await sleep(150); }
  throw new Error("hub did not start:\n" + LOG.slice(-2000));
}
async function stopHub() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }

async function main() {
  // ---- pure units ----

  // ---- the booted Hub ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-estimate-"));
  const gdir = path.join(tmp, "gcode"); fs.mkdirSync(gdir);
  const moon = createMock("u1"); const port = await moon.listen(0);
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: gdir, port: PORT, printers: [{ name: "U1-mock", url: "http://127.0.0.1:" + port }] }, null, 2));
  try {
    await startHub(tmp);
    console.log("\n-- the module boots --");
    const cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features.estimate === true, "estimate ships on", cfg.features);
    const page = await (await fetch(HUB + "/")).text();
    ok(page.includes("/modules/estimate-ui.js"), "the client module script is injected");
    const info = await jget("/api/estimate/info");
    ok(info.status === 200 && info.body && info.body.fork === "ryvin/u1hub" && info.body.max_mb === 200, "GET /api/estimate/info: fork, 200 MB cap", info.body);
    // ---- booted sections ----
  } finally { await stopHub(); await moon.close(); }
  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_ESTIMATE_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await stopHub(); process.exit(1); });
