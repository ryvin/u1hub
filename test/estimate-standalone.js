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
  // waits for the Hub to answer (observable state); a cold boot over /mnt/e measured 15 s on 2026-10-06
  for (let i = 0; i < 400; i++) { try { const r = await fetch(HUB + "/api/config"); if (r.ok) return; } catch {} await sleep(150); }
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

const ZIP = require("../modules/slicing.js");
// zIndex: the { entries, content(e) } shape models.js zipOpen returns, from an in-memory zip.
const zIndex = buf => { const z = ZIP.zipRead(buf); const entries = Array.isArray(z) ? z : z.entries; return { entries, content: async e => ZIP.zipEntryContent(e) }; };
const SI2 = '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="Snapmaker U1"/><metadata key="prediction" value="10557"/><metadata key="weight" value="17.17"/><metadata key="support_used" value="false"/>'
  + '<filament id="1" type="PLA" color="#000000" used_m="3.68" used_g="10.98"/><filament id="2" type="PLA" color="#494949" used_m="1.16" used_g="3.47"/></plate>'
  + '<plate><metadata key="index" value="2"/><metadata key="prediction" value="600"/><metadata key="weight" value="2.83"/><metadata key="support_used" value="true"/><filament id="1" type="PLA" color="#000000" used_m="0.9" used_g="2.83"/></plate></config>';
const GC = "; HEADER_BLOCK_START\n; max_z_height: 12.00\n; HEADER_BLOCK_END\nG1 X1\n; filament used [g] = 4.50\n; total filament used [g] = 4.50\n; estimated printing time (normal mode) = 1h 2m 3s\n; CONFIG_BLOCK_START\n; filament_type = PLA\n; filament_colour = #FF0000\n; CONFIG_BLOCK_END\n";

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
  const SL = require("../modules/estimate/sliced.js");
  {
    console.log("\n-- slice info --");
    const z = zIndex(ZIP.zipWrite([ZIP.makeEntry("3D/3dmodel.model", Buffer.from("<model/>")), ZIP.makeEntry("Metadata/slice_info.config", Buffer.from(SI2))]));
    const s = await SL.slicedFrom(z);
    ok(s && s.source === "slice-info" && s.plates === 2 && s.grams === 20 && s.designer_minutes === 186 && s.minutes === null, "two plates summed: 17.17 + 2.83 = 20.00 g, designer time (10557 + 600) s = 186 min, no exact time", s);
    ok(s && s.filaments.length === 2 && s.filaments[0].grams === 13.81 && s.filaments[0].color === "#000000" && s.support_used === true, "filament 1 summed across plates (10.98 + 2.83), supports used on a plate", s && s.filaments);
    ok(await SL.slicedFrom(zIndex(ZIP.zipWrite([ZIP.makeEntry("3D/3dmodel.model", Buffer.from("<model/>"))]))) === null, "no slice info -> null");
    const zp = zIndex(ZIP.zipWrite([ZIP.makeEntry("3D/3dmodel.model", Buffer.from("<model/>")), ZIP.makeEntry("Metadata/plate_1.gcode", Buffer.from(GC)), ZIP.makeEntry("Metadata/slice_info.config", Buffer.from(SI2))]));
    const sp = await SL.slicedFrom(zp);
    // parser.estMinutes("1h 2m 3s") = 63 (it rounds the seconds up; measured 2026-10-06)
    ok(sp && sp.source === "plate-gcode" && sp.grams === 4.5 && sp.minutes === 63 && sp.plates === 1, "embedded plate gcode wins: exact 4.50 g, 63 min (parser rounds 1h 2m 3s up)", sp);
  }
  const CAL = require("../modules/estimate/calibrate.js");
  {
    console.log("\n-- time model / calibration --");
    const pts = [5, 10, 20, 40, 80, 160, 320].map(g => [g, 5 * Math.pow(g, 0.8)]);
    const f = CAL.fitPower(pts);
    ok(f && Math.abs(f.a - 5) < 1e-6 && Math.abs(f.b - 0.8) < 1e-6 && f.err < 1e-9 && f.n === 7, "log-log fit recovers minutes = 5 g^0.8", f);
    ok(CAL.fitPower([[10, 2000]].concat(pts)).n === 7, "a point outside 0.3-30 min/g is trimmed before fitting");
    ok(CAL.familyOf("0.20 Standard @Snapmaker U1 - HueForge") === "hueforge" && CAL.familyOf("... - Flexi-tuned") === "flexi" && CAL.familyOf("DisplayBoxes") === "display" && CAL.familyOf("") === "standard", "profile families from print_settings_id");
    const ff = CAL.fitFor({}, "flexi", "single");
    ok(ff.source === "fallback" && ff.a === CAL.DEFAULT_FITS["standard-single"].a, "an unknown family/mode falls back to standard of the same mode, labelled", ff);
    ok(CAL.fitFor({}, "hueforge", "multi").source === "default", "a measured default is used when no live fit exists");
    ok(CAL.fitFor({ "standard-single": { a: 9, b: 0.5, n: 19, err: 0.1 } }, "standard", "single").source === "default", "a live fit with n < 20 is not trusted");
    ok(CAL.fitFor({ "standard-single": { a: 9, b: 0.5, n: 20, err: 0.1 } }, "standard", "single").a === 9, "a live fit with n >= 20 is used");
    ok(CAL.minutesFrom(100, { a: 5, b: 0.8 }) === Math.round(5 * Math.pow(100, 0.8)), "minutesFrom applies the fit");
    const kk = CAL.fitK([[10, 12], [20, 24], [5, 6], [40, 48]]);
    ok(kk && kk.k === 1.2 && kk.err === 0 && kk.n === 4, "grams k = median(actual/predicted) = 1.2", kk);
  }
  const MATCH = require("../modules/estimate/match.js");
  {
    console.log("\n-- printed before? --");
    const ledger = [
      { file: "Dragon Dynasty_Front_100x400_PLA_3h1m_pink.gcode", printer: "davinci", printer_id: 1, outcome: "done", seconds: 11416, at: 2000, material: { grams: 15.86 } },
      { file: "Dragon Dynasty_Front_100x400_PLA_3h1m.gcode", printer: "davinci", printer_id: 1, outcome: "cancelled", seconds: 600, at: 1000, material: { grams: 2 } },
      { file: "Dragon Egg_PLA_1h.gcode", printer: "snapdragon", printer_id: 0, outcome: "done", seconds: 3600, at: 1500, material: { grams: 20 } }
    ];
    const library = [{ name: "Dragon Dynasty_Front_100x400_PLA_3h1m_pink.gcode", type: "u1", grams: 15.86, minutes: 182, max_z: 1.6 }];
    ok(MATCH.famKey("Dragon Dynasty_Front_100x400_PLA_3h1m_pink.gcode") === MATCH.famKey("Dragon Dynasty_Front_100x400.3mf") && MATCH.famKey("cube.stl") === MATCH.famKey("cube_PLA_10m.gcode") && MATCH.famKey("0.4NOZZLE_AMS_5COLORS_Dragon+Dynasty_U1.3mf") === "dragon dynasty", "famKey folds a colour suffix, the mesh extension and the MakerWorld/bl2u1 wrapper", [MATCH.famKey("Dragon Dynasty_Front_100x400_PLA_3h1m_pink.gcode"), MATCH.famKey("cube.stl"), MATCH.famKey("0.4NOZZLE_AMS_5COLORS_Dragon+Dynasty_U1.3mf")]);
    const c = MATCH.candidates({ name: "Dragon Dynasty_Front_100x400.3mf", height_mm: 1.6, ledger, library });
    ok(c.length === 1 && c[0].times_printed === 2 && c[0].done === 1 && c[0].success_rate === 0.5 && c[0].actual_minutes === 190 && c[0].size_check === "same" && c[0].kind === "printed" && c[0].grams === 15.86 && c[0].match === "exact", "one family: printed twice, 1 done (50 %), actual 190 min (11416 s) from the done run, size matches", c);
    ok(!c.some(x => /Egg/.test(x.file)), "'Dragon Egg' is a different family");
    const cw = MATCH.candidates({ name: "0.4NOZZLE_AMS_5COLORS_Dragon+Dynasty_U1.3mf", height_mm: 1.6, ledger, library });
    ok(cw.length === 1 && cw[0].match === "contains" && cw[0].times_printed === 2, "the MakerWorld-named 3MF finds the same family by containment ('dragon dynasty' in 'dragon dynasty front 100x400')", cw);
    ok(MATCH.candidates({ name: "Dragon.stl", height_mm: 1.6, ledger, library }).length === 0, "a one-word name never matches by containment");
    const c2 = MATCH.candidates({ name: "Dragon Dynasty_Front_100x400.3mf", height_mm: 40, ledger, library });
    ok(c2[0].size_check === "different", "same name, 40 mm tall vs a 1.6 mm print -> 'different', never 'same'", c2[0]);
    ok(MATCH.heightCheck(10, 10.15) === "same" && MATCH.heightCheck(10, 10.3) === "different" && MATCH.heightCheck(10, null) === "unchecked", "2 % height tolerance; no gcode height -> unchecked");
    ok(MATCH.candidates({ name: "Totally New Thing.stl", height_mm: 5, ledger, library }).length === 0, "nothing in the family -> no candidates");
    const items = [{ rel: "a/Same.3mf", name: "Same", size: 100 }, { rel: "b/Other.3mf", name: "Other", size: 100 }, { rel: "c/Big.3mf", name: "Big", size: 999 }];
    const hashes = { "a/Same.3mf": "h1", "b/Other.3mf": "h2", "c/Big.3mf": "h1" };
    const same = await MATCH.sameFileNames(100, "h1", items, async it => hashes[it.rel]);
    ok(JSON.stringify(same) === JSON.stringify(["Same"]), "same file: only the equal-size item with the same hash (a different hash or a different size is not)", same);
  }
  const PRICE = require("../modules/estimate/price.js");
  const COST = require("../modules/costing.js");
  {
    console.log("\n-- pricing --");
    const R = { kwh_rate: 0.16, cost_per_g: 0.02, markup_pct: 100, overhead_pct: 10, labor_rate: 30, failure_pct: 5,
                printers: { "0": { purchase: 1099, life_hours: 5000, maint_per_hour: 0.10, avg_watts: 250 } } };
    const base = { grams: 100, minutes: 120, qty: 1, printer_id: 0, type: "u1", material: "PLA", labor_minutes: 10, rush: 1, name: "x.stl" };
    const est = PRICE.priceEstimate(base, R, { sell_per_g: 0.12, cost_per_g: 0.02 });
    const row = { id: "est", printer_id: 0, type: "u1", outcome: "done", est_minutes: 120, est_source: "estimate", pieces: 1, counted: true, material: { grams: 100, source: "slicer", grams_source: "estimate", material: "PLA" } };
    const direct = COST.projectSummary({ items: [{ kind: "labor", minutes: 10 }] }, [row], R);
    ok(est.cost.cost === direct.cost && est.cost.cost != null, "the estimate's cost IS costing's projectSummary for the same row", { est: est.cost.cost, direct: direct.cost });
    const mk = est.pricing.methods.find(m => m.key === "markup");
    ok(mk.price === Math.round(direct.cost * 2 * 100) / 100, "markup 100 % doubles the cost", mk);
    ok(est.recommended.price === Math.max(mk.price, 12), "recommended = max(per-gram floor 100 g x $0.12 = 12.00, markup)", est.recommended);
    const rush = PRICE.priceEstimate({ ...base, rush: 1.5 }, R, { sell_per_g: 0.12, cost_per_g: 0.02 });
    ok(rush.recommended.price === Math.round(est.recommended.price * 1.5 * 100) / 100, "rush 1.5x multiplies the recommended price", rush.recommended);
    const q = PRICE.priceEstimate({ ...base, qty: 10, labor_minutes: 0 }, R, { sell_per_g: 0.12 });
    ok(q.cost.pieces === 10 && q.cost.grams === 1000, "quantity 10 = ten pieces, 1000 g", { pieces: q.cost.pieces, grams: q.cost.grams });
    const fr = PRICE.priceEstimate({ ...base, labor_minutes: 0, failure_rate: 0.5 }, R, {});
    ok(fr.cost.failure === Math.round(fr.cost.direct * 0.5 * 100) / 100, "a candidate's 50 % success rate becomes a 50 % failure allowance", fr.cost);
    const bare = PRICE.priceEstimate({ ...base, labor_minutes: 0 }, {}, {});
    const bm = bare.pricing ? bare.pricing.methods.find(m => m.key === "markup") : null;
    ok(bare.blanks.length > 0 && (!bm || (bm.price === null && /Settings/.test(bm.note))), "no rates: blanks named, markup says 'set a markup % in Settings'", bare);
  }
  const REP = require("../modules/estimate/report.js");
  {
    console.log("\n-- reports --");
    const V = { name: "=cmd|' /C calc'!A0 <b>.stl", created: Date.UTC(2026, 9, 6), source_label: "geometry ±33 %", qty: 2, material: "PLA", preset: "standard",
                print: { grams: 7.22, minutes: 25, plates: 1, supports_needed: "no", colours: 1, band_pct: 33 }, model: { size_mm: [20, 20, 20], volume_cm3: 8 },
                cost: { cost: 1.5, material: 0.14, machine: 0.1, energy: 0.02, labor: { cost: 1, minutes: 2 }, failure: 0.01, overhead: 0.2, blanks: [] },
                pricing: { methods: [{ key: "markup", label: "Cost + markup", price: 3, per_piece: 1.5, gross: 3.3, note: "100% on cost" }], breaks: [{ qty: 1, each: 3 }, { qty: 10, each: 2.5 }] },
                recommended: { price: 3, each: 1.5, method: "markup", rush: 1 }, fits: ["snapdragon"], valid_days: 14 };
    const q = REP.html(V, "quote"), i = REP.html(V, "internal");
    ok(!/<b>\.stl/.test(q) && q.includes("&lt;b&gt;") && !/<script/i.test(q), "names are escaped, no scripts");
    ok(!/Overhead|Machine|Electricity/.test(q) && /Overhead/.test(i) && /Machine/.test(i), "the quote hides internal cost layers; the internal view shows them");
    ok(/\$3\.00/.test(q) && /valid for 14 days/i.test(q), "the quote shows the price and how long it is valid");
    const c = REP.csv(V);
    ok(c.split("\r\n")[0] === "section,item,value" && c.includes("'=cmd"), "CSV header, and a formula-looking cell is neutralised with a leading quote", c.slice(0, 300));
    const zx = zIndex(REP.xlsx(V)), names = zx.entries.map(e => e.name);
    ok(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"].every(n => names.includes(n)), "XLSX holds the workbook and two sheets", names);
    const part = async n => (await zx.content(zx.entries.find(e => e.name === n))).toString();
    ok(/name="Quote"/.test(await part("xl/workbook.xml")) && /name="Breakdown"/.test(await part("xl/workbook.xml")), "sheets are named Quote and Breakdown");
    const s1 = await part("xl/worksheets/sheet1.xml");
    ok(s1.includes("&apos;=cmd") && !/Overhead/.test(s1) && /Overhead/.test(await part("xl/worksheets/sheet2.xml")), "XLSX: the formula cell is neutralised; the Quote sheet hides internals, Breakdown has them");
  }

  // ---- the booted Hub ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-estimate-"));
  const gdir = path.join(tmp, "gcode"); fs.mkdirSync(gdir);
  const moon = createMock("u1"); const port = await moon.listen(0);
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: gdir, port: PORT, printers: [{ name: "U1-mock", url: "http://127.0.0.1:" + port }] }, null, 2));
  // one earlier print of a cube, and its gcode in the library, so "printed before" has something to find
  fs.writeFileSync(path.join(tmp, "prints.json"), JSON.stringify({ prints: [{ id: "p1", at: 1, printer_id: 0, printer: "U1-mock", type: "u1", file: "cube_PLA_10m.gcode", outcome: "done", seconds: 600, seconds_source: "actual", material: { grams: 4, source: "slicer", grams_source: "slicer" }, counted: true, pieces: 1 }] }));
  fs.writeFileSync(path.join(gdir, "cube_PLA_10m.gcode"), "; HEADER_BLOCK_START\n; max_z_height: 20.00\n; HEADER_BLOCK_END\nG1 X1\n; filament used [g] = 4.00\n; total filament used [g] = 4.00\n; estimated printing time (normal mode) = 10m 0s\n; CONFIG_BLOCK_START\n; filament_type = PLA\n; filament_colour = #FF0000\n; print_settings_id = 0.20 Standard\n; CONFIG_BLOCK_END\n");
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
    const up = async (name, buf, id) => { const r = await fetch(HUB + "/api/estimate/upload" + (id ? "?id=" + id : ""), { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: buf }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; };
    const waitJob = async j => { for (let i = 0; i < 400; i++) { const r = await jget("/api/estimate/job?job=" + j); if (r.body && r.body.done) return r.body; await sleep(50); } return { error: "timeout" }; };
    console.log("\n-- upload -> estimate --");
    let r = await up("cube.stl", binStl(cubeTris(20)));
    ok(r.status === 200 && r.body && r.body.id && r.body.jobId, "upload an STL -> estimate id and job", r.body);
    const ID = r.body && r.body.id;
    const j1 = r.body && r.body.jobId ? await waitJob(r.body.jobId) : { error: "no job" };
    ok(!j1.error, "analysis job finishes", j1);
    let v = (await jget("/api/estimate/" + ID)).body || {};
    ok(v.files && v.files.length === 1 && v.files[0].facts.volume_cm3 === 8 && v.print.grams === 3.61 && v.source === "geometry" && /geometry/.test(v.source_label), "the cube estimate: 3.61 g from geometry, labelled", v.print);
    ok(v.print && v.print.minutes === Math.round(4.81 * Math.pow(3.61, 0.836)) && v.print.band_pct === 33, "time from the standard-single default fit, with its ±33 % band", v.print);
    ok(Array.isArray(v.fits) && v.fits.includes("U1-mock"), "a 20 mm cube fits the U1", v.fits);
    ok(ID && fs.readdirSync(path.join(tmp, "estimates", ID)).every(n => !/cube/.test(n)), "files are stored by id, never by the uploaded name", ID && fs.readdirSync(path.join(tmp, "estimates", ID)));
    ok(v.candidates && v.candidates.length === 1 && v.candidates[0].kind === "printed" && v.candidates[0].size_check === "same" && v.candidates[0].actual_minutes === 10 && v.sources_available.includes("printed"), "printed before: the cube family, 20 mm in the gcode too, actual 10 min", v.candidates);
    r = await jpost("/api/estimate/" + ID + "/source", { source: "printed", key: v.candidates && v.candidates[0] && v.candidates[0].key });
    ok(r.status === 200 && r.body.source === "printed" && r.body.print.minutes === 10 && r.body.print.grams === 4 && /printed before/.test(r.body.source_label), "use the earlier print: 10 min, 4 g, labelled", r.body && r.body.print);
    r = await jpost("/api/estimate/" + ID + "/source", { source: "geometry" });
    r = await jpost("/api/estimate/" + ID + "/inputs", { qty: 4, infill: 1 });
    ok(r.status === 200 && r.body.print.grams === 9.92 && r.body.inputs.qty === 4 && r.body.cost.grams === 39.68, "inputs recompute without a re-upload: solid 9.92 g each, qty 4 = 39.68 g", r.body && { print: r.body.print, cost_g: r.body.cost && r.body.cost.grams });
    r = await jpost("/api/estimate/" + ID + "/inputs", { qty: 0 });
    ok(r.status === 400 && /qty/.test(r.body.error), "a bad input is refused and named", r.body);
    r = await jpost("/api/estimate/" + ID + "/source", { source: "sliced" });
    ok(r.status === 400, "an STL has no slice info: source 'sliced' is refused", r.status);
    r = await up("evil.exe", Buffer.from("MZ"));
    ok(r.status === 400 && /stl|3mf/i.test(r.body.error), "a non-STL/3MF upload is refused", r.body);
    r = await up("bad.stl", Buffer.from("solid x\nendsolid x\n"));
    const bj = r.body && r.body.jobId ? await waitJob(r.body.jobId) : { error: "no job" };
    ok(/no triangles/i.test(bj.error || ""), "an empty STL ends its job with the reason", bj);
    const vb = (await jget("/api/estimate/" + (r.body && r.body.id))).body || {};
    ok(vb.print && vb.print.grams === null && vb.print.minutes === null && vb.recommended && vb.recommended.price === null && vb.files[0].error, "an estimate with nothing measurable shows blanks, never $0 / 0 g", vb.print && { print: vb.print, rec: vb.recommended });
    console.log("\n-- 3MF with slice info --");
    const tmf = ZIP.zipWrite([ZIP.makeEntry("3D/3dmodel.model", Buffer.from('<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>'
      + [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]].map(p => '<vertex x="' + p[0] + '" y="' + p[1] + '" z="' + p[2] + '"/>').join("")
      + '</vertices><triangles>' + [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(t => '<triangle v1="' + t[0] + '" v2="' + t[1] + '" v3="' + t[2] + '"/>').join("")
      + '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>')), ZIP.makeEntry("Metadata/slice_info.config", Buffer.from(SI2))]);
    r = await up("box.3mf", tmf);
    const j3 = r.body && r.body.jobId ? await waitJob(r.body.jobId) : { error: "no job" };
    v = (await jget("/api/estimate/" + (r.body && r.body.id))).body || {};
    ok(!j3.error && v.files && v.files[0].facts.volume_cm3 === 8 && v.files[0].sliced.grams === 20 && v.sources_available.includes("sliced"), "the 3MF is measured and its slice info read", { j3, f: v.files && v.files[0] });
    r = await jpost("/api/estimate/" + v.id + "/source", { source: "sliced" });
    ok(r.status === 200 && r.body.print.grams === 20 && /file's slice/.test(r.body.source_label) && r.body.print.minutes === Math.round(6.403 * Math.pow(20, 0.840)), "slice-info source: 20 g from the file, time from the standard-multi fit (2 filaments)", r.body && r.body.print);
    console.log("\n-- save / list / reports --");
    r = await jpost("/api/estimate/" + ID + "/save", { note: "test" });
    ok(r.status === 200 && r.body.saved === true, "save");
    r = await jget("/api/estimate");
    ok(r.body && r.body.saved.some(s => s.id === ID), "the saved list carries it", r.body);
    for (const [fmt, ct] of [["pdf", "text/html"], ["csv", "text/csv"], ["xlsx", "spreadsheetml"]]) {
      const rr = await fetch(HUB + "/api/estimate/" + ID + "/report?format=" + fmt + "&view=internal");
      ok(rr.ok && (rr.headers.get("content-type") || "").includes(ct) && new RegExp("estimate-" + ID).test(rr.headers.get("content-disposition") || ""), "report " + fmt + " (" + ct + ", named by id)", [rr.status, rr.headers.get("content-type"), rr.headers.get("content-disposition")]);
    }
    console.log("\n-- size cap / restart --");
    await stopHub(); await startHub(tmp, { U1HUB_ESTIMATE_MAX_MB: "0.001" });
    const before = fs.readdirSync(path.join(tmp, "estimates")).length;
    r = await up("big.stl", Buffer.alloc(5000, 32));
    ok(r.status === 413, "over the cap -> 413", r.status);
    ok(fs.readdirSync(path.join(tmp, "estimates")).length === before, "the refused upload left no directory behind");
    ok(((await jget("/api/estimate/" + ID)).body || {}).saved === true, "the saved estimate survives a restart");
    console.log("\n-- a 3MF too big to measure, with slice info (the live Dragon Dynasty 3MF: 48 MB, meshes past the 160 MB budget) --");
    await stopHub(); await startHub(tmp, { U1HUB_ESTIMATE_MESH_MAX_MB: "0.0001" });
    r = await up("box.3mf", tmf);
    const jb = r.body && r.body.jobId ? await waitJob(r.body.jobId) : { error: "no job" };
    v = (await jget("/api/estimate/" + (r.body && r.body.id))).body || {};
    ok(!jb.error && v.files && /estimated from the file.s own slice/.test(v.files[0].warning || "") && !v.files[0].error && v.files[0].sliced.grams === 20, "the mesh is past the budget: a warning, not an error, and the slice info is kept", { jb, f: v.files && v.files[0] });
    ok(v.source === "sliced" && !v.sources_available.includes("geometry") && v.print.grams === 20 && /file's slice/.test(v.source_label), "with no measurable mesh the estimate uses the file's own slice (20 g), and geometry is not offered", v.print && { src: v.source, avail: v.sources_available });
  } finally { await stopHub(); await moon.close(); }
  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_ESTIMATE_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await stopHub(); process.exit(1); });
