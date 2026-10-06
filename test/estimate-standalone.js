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
// ---- fixtures ----
// 12 triangles of an axis-aligned cube [0,s]^3, wound outward (inward when flip)
function cubeTris(s, flip) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return f.map(t => (flip ? [t[0], t[2], t[1]] : t).map(i => v[i]));
}
function binStl(tris) { const b = Buffer.alloc(84 + tris.length * 50); b.writeUInt32LE(tris.length, 80); tris.forEach((t, i) => { let o = 84 + i * 50 + 12; for (const p of t) for (const c of p) { b.writeFloatLE(c, o); o += 4; } }); return b; }
function asciiStl(tris) { return Buffer.from("solid t\n" + tris.map(t => " facet normal 0 0 0\n  outer loop\n" + t.map(p => "   vertex " + p.join(" ") + "\n").join("") + "  endloop\n endfacet\n").join("") + "endsolid t\n"); }

async function stopHub() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }

async function main() {
  // ---- pure units ----
  const STL = require("../modules/estimate/stl.js");
  {
    console.log("\n-- STL --");
    const fb = await STL.factsStl(binStl(cubeTris(20)));
    const want = FALSIFY ? 8.001 : 8;
    ok(fb.ok && fb.volume_cm3 === want && fb.area_cm2 === 24 && fb.size_mm.join() === "20,20,20" && fb.triangles === 12, "binary 20 mm cube: 8.000 cm3, 24.0 cm2, 20x20x20, 12 triangles" + (FALSIFY ? " [FALSIFIED]" : ""), fb);
    const fa = await STL.factsStl(asciiStl(cubeTris(20)));
    ok(fa.volume_cm3 === 8 && fa.area_cm2 === 24, "ASCII cube measures the same", fa);
    const fi = await STL.factsStl(binStl(cubeTris(20, true)));
    ok(fi.volume_cm3 === 8, "an inward-wound cube still reports +8 cm3 (abs)", fi.volume_cm3);
    ok(fb.overhang.steep_pct === 0 && fb.overhang.flat_unsupported_pct === 0 && fb.overhang.bed_contact_cm2 === 4, "the cube's bottom is bed contact (4 cm2), nothing overhangs", fb.overhang);
    const lifted = cubeTris(20).map(t => t.map(p => [p[0], p[1], p[2] + 10]));
    const fl = await STL.factsStl(binStl(lifted.concat(cubeTris(5))));
    ok(fl.overhang.flat_unsupported_pct > 0, "a part floating above the bed shows an unsupported underside", fl.overhang);
    let e = null; try { STL.parseStl(binStl(cubeTris(20)).subarray(0, 300)); } catch (x) { e = x; }
    ok(e && /truncated/i.test(e.message), "a truncated binary STL is refused with a reason", e && e.message);
    e = null; try { STL.parseStl(Buffer.from("solid empty\nendsolid empty\n")); } catch (x) { e = x; }
    ok(e && /no triangles/i.test(e.message), "an STL with no triangles is refused", e && e.message);
  }
  const GEO = require("../modules/estimate/geometry.js");
  {
    console.log("\n-- geometry grams --");
    const cube = await STL.factsStl(binStl(cubeTris(20)));
    // By hand: shell = 24.0 cm2 x (2 x 0.42 mm = 0.084 cm) = 2.016 cm3; interior 8 - 2.016 = 5.984 x 15 % = 0.8976;
    // 2.9136 cm3 x 1.24 g/cm3 = 3.6129 -> 3.61 g. No overhang -> supports "no", 0 g.
    const g = GEO.gramsFrom(cube, { preset: "standard", material: "PLA" });
    ok(g.grams === 3.61 && g.supports_needed === "no" && g.supports_g === 0 && g.density === 1.24, "20 mm cube, Standard, PLA: 3.61 g (hand), no supports", g);
    ok(GEO.gramsFrom(cube, { preset: "standard", infill: 1, material: "PLA" }).grams === 9.92, "100 % infill = the solid: 8 cm3 x 1.24 = 9.92 g");
    const petg = GEO.gramsFrom(cube, { preset: "standard", material: "PETG" });
    ok(petg.density !== 1.24 && petg.grams > g.grams, "PETG uses its own density", petg);
    ok(GEO.gramsFrom(cube, { preset: "standard", material: "PLA", k: 1.5 }).grams === 5.42, "calibration k scales the model grams: 2.9136 x 1.5 x 1.24 = 5.42");
    const over = { ...cube, overhang: { ...cube.overhang, steep_pct: 8, flat_unsupported_pct: 2 } };
    const sup = GEO.gramsFrom(over, { preset: "standard", material: "PLA" });
    // supports: 10 % of 24.0 cm2 = 2.4 cm2 x (20 mm / 2 = 1.0 cm) x 0.15 = 0.36 cm3 x 1.24 = 0.4464 -> 0.45 g; 3.61 + 0.45 = 4.06
    ok(sup.supports_needed === "yes" && sup.supports_g === 0.45 && sup.supports_included === true && sup.grams === 4.06, "10 % overhang -> supports 'yes', +0.45 g (hand), included in auto", sup);
    ok(GEO.gramsFrom(over, { preset: "standard", material: "PLA", supports: "off" }).grams === 3.61, "supports off -> model grams only");
    ok(Object.keys(GEO.PRESETS).join() === "standard,strong,hueforge,flexi", "four presets", Object.keys(GEO.PRESETS));
  }

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
