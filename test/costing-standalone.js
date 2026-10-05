// test/costing-standalone.js — fork module (ryvin/u1hub): project costing,
// kept out of run-tests.js so the fork's diff against upstream stays table
// lines (docs/FORK.md).
//
// Two halves. The pure half requires modules/costing.js and checks costOf,
// projectSummary, the pricing helper, the CSV and the quote page against
// hand-computed numbers, including the known-bad inputs (an unpriced roll, no
// watts, no rates at all). The live half boots the real server.js against one
// mock U1 with an isolated U1HUB_DIR, drives a print through
// standby -> printing -> complete and printing -> cancelled by flipping the
// mock and calling POST /api/fleet-events/check, and reads the ledger back.
// Every wait is on an observable (the fleet reporting the state, the ledger
// row appearing), never a fixed sleep (CLAUDE.md rule 7).
//
// The import half (a second, non-U1 mock printer and a third that is
// offline) seeds Moonraker job histories with explicit timestamps and drives
// POST /api/costing/import, so paging, pacing, idempotency, the dedupe
// against a row the Hub watched, the status mapping, the ledger cap and the
// offline skip are all asserted against what the run returned.
//
// Run: node test/costing-standalone.js   (part of npm run test:standalone)
// Rule 6 evidence: U1HUB_COSTING_FALSIFY=1 flips the actual-seconds
// expectation on the ledger row, the printer-metadata grams expectation, the
// "second import brings nothing" expectation and one report total; the run
// must then go red.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMock } = require("./mock-moonraker.js");

const REPO = path.join(__dirname, "..");
const PORT = 45985;
const HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_COSTING_FALSIFY === "1";
const PAUSE_MS = 300;        // backfill pacing under test (production default 1000)

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 600) : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
async function jget(p) { const r = await fetch(HUB + p); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function jpost(p, b) {
  const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
}

let CHILD = null, LOG = "";
async function startHub(dir, extraEnv) {
  LOG = "";
  CHILD = spawn(process.execPath, ["server.js"], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_POLL_MS: "400", U1HUB_EVENTS_POLL_MS: "3600000",
           U1HUB_SYNC_MS: "3600000", U1HUB_PROFILE: "",
           // The boot backfill is OFF unless a section turns it on: every
           // Moonraker GET in this suite follows a call the test made (rule 7).
           U1HUB_COSTING_BACKFILL_BOOT_MS: "0", U1HUB_COSTING_BACKFILL_PAUSE_MS: String(PAUSE_MS),
           // The job-history import likewise: no boot run, no hourly run, and
           // three jobs a page so a seven-job history takes three pages.
           U1HUB_COSTING_IMPORT_BOOT_MS: "0", U1HUB_COSTING_IMPORT_MS: "0", U1HUB_COSTING_IMPORT_PAGE: "3", U1HUB_COSTING_IMPORT_SETTLE_MS: "5000", ...(extraEnv || {}) }
  });
  CHILD.stdout.on("data", d => LOG += d);
  CHILD.stderr.on("data", d => LOG += d);
  for (let i = 0; i < 480; i++) {   // up to 120 s: a boot from a /mnt Windows mount measured 12.9 s, and 21 s with the host at load 16 (2026-10-03); the require phase is synchronous, so nothing is logged until it ends
    await sleep(250);
    try { const r = await fetch(HUB + "/api/version"); if (r.ok) return; } catch {}
    if (CHILD.exitCode !== null) throw new Error("hub exited early:\n" + LOG);
  }
  throw new Error("hub never came up:\n" + LOG);
}
async function stopHub() {
  if (!CHILD) return;
  CHILD.kill("SIGTERM");
  await new Promise(r => { CHILD.on("exit", r); setTimeout(r, 2000); });
  CHILD = null;
}
function writeConfig(dir, gcode, portU1, features) {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    gcodeFolder: gcode, port: PORT,
    printers: [{ name: "U1-mock", url: "http://127.0.0.1:" + portU1 }],
    ...(features ? { features } : {})
  }, null, 2));
}

// ---- pure half -----------------------------------------------------------------------------
function pureChecks() {
  const C = require(path.join(REPO, "modules", "costing.js"));
  console.log("\n== PURE: costOf, one print at a time ==");
  const R = { kwh_rate: 0.16, cost_per_g: 0.02, printers: { "0": { purchase: 1099, life_hours: 5000, maint_per_hour: 0.10, avg_watts: 250 }, "1": { purchase: 1099, life_hours: 5000 } } };
  const A = { id: "A", printer_id: 0, outcome: "done", seconds: 3600, est_minutes: 62, pieces: 10, material: { grams: 25.7, cost: 0.64, source: "deduction", partial: true } };
  let c = C.costOf(A, R);
  ok(c.material.cost === 0.64 && c.material.source === "deduction" && c.material.partial === true, "deduction row: the priced grams at the loaded rolls' prices, flagged partial (one head had no roll)", c.material);
  ok(c.hours === 1 && c.time_source === "actual", "actual seconds win over the slicer estimate", { hours: c.hours, src: c.time_source });
  ok(c.machine && c.machine.per_hour === 0.32 && c.machine.cost === 0.32 && c.machine.basis === "depreciation+maintenance" && c.machine.source === "typed", "machine: 1099/5000 + 0.10 = $0.32/h over 1 h, typed rates", c.machine);
  ok(c.energy && c.energy.kwh === 0.25 && c.energy.cost === 0.04 && c.energy.source === "watts", "energy: 250 W x 1 h = 0.25 kWh at $0.16", c.energy);
  ok(c.direct === 1.00 && c.blanks.length === 0, "direct = 0.64 + 0.32 + 0.04 = $1.00, nothing blank", { direct: c.direct, blanks: c.blanks });
  const B = { id: "B", printer_id: 0, outcome: "done", seconds: null, est_minutes: 120, material: { grams: 100, source: "slicer" } };
  c = C.costOf(B, R);
  ok(c.material.cost === 2 && c.material.source === "flat" && c.hours === 2 && c.time_source === "slicer", "no deduction: slicer grams x the flat $/g, slicer minutes for time", c);
  ok(c.machine.cost === 0.64 && c.energy.kwh === 0.5 && c.energy.cost === 0.08 && c.direct === 2.72, "…machine 0.64, energy 0.08, direct 2.72", c);
  const Cu = { id: "C", printer_id: 0, outcome: "done", seconds: 1800, material: { grams: 10, cost: null, source: "deduction", partial: true } };
  c = C.costOf(Cu, R);
  ok(c.material.cost === null && c.material.partial === true && c.material.source === "deduction", "KNOWN-BAD unpriced roll: material cost is null and partial, never the flat rate in disguise", c.material);
  ok(c.blanks.some(b => /roll has no price/.test(b)) && c.direct === r2(c.machine.cost + c.energy.cost), "…and the blank is named; direct sums only what is known", c);
  c = C.costOf({ ...B, printer_id: 1 }, R);
  ok(c.energy === null && c.blanks.some(b => /energy \(no watts\)/.test(b)), "KNOWN-BAD no watts for the printer: energy is null, not zero", c);
  ok(c.machine && c.machine.basis === "depreciation" && c.machine.per_hour === 0.22, "…depreciation alone when no maintenance reserve is set", c.machine);
  c = C.costOf(B, {});
  ok(c.material.cost === null && c.machine === null && c.energy === null && c.direct === null && c.blanks.length === 3, "no rates at all (and no suggestions): every line blank, direct null, three blanks named", c);
  c = C.costOf({ material: { grams: 10, source: "slicer", slicer_cost: 0.5 } }, {});
  ok(c.material.cost === 0.5 && c.material.source === "slicer", "the slicer's own filament cost is the last fallback", c.material);
  c = C.costOf({ printer_id: 0, seconds: 3600, energy: { kwh: 0.8, source: "metered" } }, R);
  ok(c.energy.kwh === 0.8 && c.energy.cost === 0.13 && c.energy.source === "metered", "a metered kWh on the row beats the typed watts (the v2 hook)", c.energy);

  console.log("\n== PURE: Moonraker status -> outcome (Rinkhals calls finished prints cancelled) ==");
  ok(C.outcomeOf("cancelled", { filament_used: 12000, metadata: { filament_total: 12000 } }) === "done" && C.outcomeOf("cancelled", { filament_used: 11900, metadata: { filament_total: 12000 } }) === "done",
    "a 'cancelled' job that used >= 99% of the file's own filament total finished (kobrakai 2026-10-04: 37 such jobs, 0 'completed' in 127)", null);
  ok(C.outcomeOf("cancelled", { filament_used: 3000, metadata: { filament_total: 12000 } }) === "cancelled" && C.outcomeOf("cancelled", { filament_used: 500, metadata: {} }) === "cancelled" && C.outcomeOf("cancelled", { filament_used: 500 }) === "cancelled",
    "a real stop (25%) or a job with no filament total stays cancelled", null);
  ok(C.outcomeOf("completed", {}) === "done" && C.outcomeOf("klippy_shutdown", { filament_used: 9, metadata: { filament_total: 9 } }) === "error" && C.outcomeOf("in_progress", {}) === null && C.outcomeOf("weird", {}) === "error",
    "completed -> done, a shutdown stays an error even at 100%, in_progress -> skipped, unknown -> error", null);

  console.log("\n== PURE: filament length -> grams (Moonraker filament_used / filament_total are millimetres) ==");
  let gg = C.mmToGrams(40361.57, "PLA;PLA;PLA;PLA");
  ok(gg && gg.grams === 120.38 && gg.density === 1.24 && gg.material === "PLA" && gg.assumed === false, "40361.57 mm of 1.75 mm PLA = 120.38 g, the figure Moonraker itself reports as filament_weight_total for that file", gg);
  gg = C.mmToGrams(10000, "PETG");
  ok(gg && gg.grams === 30.55 && gg.density === 1.27, "10 m of PETG: pi x 0.0875^2 x 1000 cm = 24.05 cm3 x 1.27 = 30.55 g", gg);
  ok(C.mmToGrams(1000, "ABS").density === 1.04 && C.mmToGrams(1000, "ASA").density === 1.07 && C.mmToGrams(1000, "TPU").density === 1.21 && C.mmToGrams(1000, "PETG-CF").density === 1.27, "ABS 1.04, ASA 1.07, TPU 1.21; a variant (PETG-CF) takes its family's density", null);
  gg = C.mmToGrams(1000, "WOOD");
  ok(gg && gg.density === 1.24 && gg.assumed === true, "KNOWN-BAD unknown material: PLA's density, flagged assumed rather than silently", gg);
  ok(C.mmToGrams(0, "PLA") === null && C.mmToGrams("abc", "PLA") === null, "KNOWN-BAD zero or non-numeric length: null, never 0 g", null);
  ok(C.materialOf("PLA;PETG;PLA;PLA") === "PLA" && C.materialOf(";ABS") === "ABS" && C.materialOf("") === null, "materialOf takes the first listed tool's type", null);

  console.log("\n== PURE: suggested rates fill only what is unset, and say so ==");
  const SG = C.SUGGESTED;
  ok(SG.kwh_rate === 0.183 && SG.printers.purchase === 849 && SG.printers.life_hours === 5000 && SG.printers.maint_per_hour === 0.10 && SG.printers.avg_watts === 150 && SG.applies_to === "u1", "the cited numbers (docs/costing.md): $0.183/kWh, $849, 5000 h, $0.10/h, 150 W, for a U1", SG);
  ok(Object.keys(C.SUGGESTED_NOTES).length === 5 && /EIA/.test(C.SUGGESTED_NOTES.kwh_rate) && /ESTIMATE/.test(C.SUGGESTED_NOTES.avg_watts) && /ESTIMATE/.test(C.SUGGESTED_NOTES.maint_per_hour), "every suggestion carries a note; the two derived ones are labelled ESTIMATE", C.SUGGESTED_NOTES);
  const RSug = { cost_per_g: 0.02, suggested: SG };
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 3600, material: { grams: 100, source: "slicer" } }, RSug);
  ok(c.machine && c.machine.per_hour === 0.27 && c.machine.cost === 0.27 && c.machine.source === "suggested" && c.machine.basis === "depreciation+maintenance", "no typed printer rates: machine 849/5000 + 0.10 = $0.27/h, labelled suggested", c.machine);
  ok(c.energy && c.energy.kwh === 0.15 && c.energy.cost === 0.03 && c.energy.source === "suggested" && c.energy.watts === 150, "no typed watts or $/kWh: 150 W x 1 h = 0.15 kWh at $0.183 = $0.03, labelled suggested", c.energy);
  ok(c.direct === 2.3 && c.blanks.length === 0, "direct 2.00 + 0.27 + 0.03 = $2.30, no blanks", c);
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 3600, material: { grams: 100, source: "slicer" } }, { ...RSug, kwh_rate: 0.16, printers: { "0": { avg_watts: 250, purchase: 1099, life_hours: 5000, maint_per_hour: 0.1 } } });
  ok(c.energy.source === "watts" && c.energy.cost === 0.04 && c.energy.watts === 250 && c.machine.source === "typed" && c.machine.per_hour === 0.32, "typed rates win over the suggestions on every line", c);
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 3600, material: { grams: 100, source: "slicer" } }, { ...RSug, printers: { "0": { avg_watts: 250 } } });
  ok(c.energy.source === "suggested" && c.energy.watts_source === "typed" && c.energy.rate_source === "suggested" && c.energy.cost === 0.05, "typed watts with a suggested $/kWh: the line is still labelled suggested (250 W x 1 h x 0.183 = $0.05)", c.energy);
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 3600, material: { grams: 100, source: "slicer" } }, { ...RSug, printers: { "0": { purchase: 1099 } } });
  ok(c.machine.source === "typed+suggested" && c.machine.per_hour === 0.32, "a typed purchase with suggested life hours and maintenance: 1099/5000 + 0.10, labelled typed+suggested", c.machine);
  c = C.costOf({ printer_id: 0, type: "generic", seconds: 3600, material: { grams: 100, source: "slicer" } }, RSug);
  ok(c.machine === null && c.energy === null && c.blanks.length === 2 && /no printer rates/.test(c.blanks[0]), "KNOWN-BAD a generic Klipper printer gets no U1 suggestion: machine and energy blank and named", c);
  c = C.costOf({ printer_id: 0, type: "u1", material: { grams: 100, source: "slicer" } }, RSug);
  ok(c.machine === null && c.energy === null && c.blanks.some(b => /no time/.test(b)), "KNOWN-BAD no time at all: suggestions cannot invent hours", c.blanks);
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 3600, material: { grams: 120.38, source: "printer-meta", grams_source: "printer-meta", material: "PLA" } }, RSug);
  ok(c.material.grams_source === "printer-meta" && c.material.source === "flat" && c.material.cost === 2.41, "grams from the printer's metadata are priced at the flat $/g and say where the grams came from", c.material);
  c = C.costOf({ printer_id: 0, type: "u1", seconds: 4800, seconds_source: "history", material: { grams: 30.55, source: "history", grams_source: "history", density_assumed: true } }, RSug);
  ok(c.time_source === "history" && c.material.grams_source === "history" && c.material.density_assumed === true, "history-sourced time and grams keep their labels; an assumed density is flagged through", c);
  const ss = C.projectSummary({ items: [] }, [{ id: "S1", printer_id: 0, type: "u1", outcome: "done", seconds: 3600, material: { grams: 100, source: "slicer" } }], RSug);
  ok(ss.sources.machine.suggested === 1 && ss.sources.energy.suggested === 1 && ss.sources.grams.slicer === 1 && ss.blanks.length === 0, "the summary tallies suggested lines apart from typed ones", ss.sources);

  console.log("\n== PURE: projectSummary on three prints (done, cancelled, uncounted) ==");
  const E = { id: "E", printer_id: 0, outcome: "cancelled", seconds: 600, material: { grams: 5, source: "slicer", partial: true } };
  const F = { id: "F", printer_id: 0, outcome: "done", seconds: 36000, counted: false, pieces: 4, material: { grams: 200, source: "slicer" } };
  const RS = { ...R, labor_rate: 30, overhead_pct: 10, failure_pct: 5 };
  const proj = { charged: 40, items: [{ id: "i1", kind: "labor", label: "support removal", minutes: 30 }, { id: "i2", kind: "hardware", label: "M3 inserts x40", cost: 6.2 }] };
  let s = C.projectSummary(proj, [A, E, F], RS);
  ok(s.prints === 3 && s.counted === 2 && s.uncounted === 1 && s.failed === 1, "3 rows: 2 counted, 1 not, 1 failed", s);
  ok(s.pieces === 10, "pieces count finished, counted prints only (the cancelled one made nothing)", s.pieces);
  ok(s.material === 0.74 && s.machine === 0.37 && s.energy === 0.05 && s.direct === 1.16, "material 0.64+0.10, machine 0.32+0.05, energy 0.04+0.01, direct 1.16", s);
  ok(s.labor.minutes === 30 && s.labor.cost === 15 && s.extras === 6.2, "labour 30 min at $30/h = $15; extras $6.20", s.labor);
  ok(s.subtotal === 22.36 && s.failure === 0 && s.overhead === 2.24 && s.cost === 24.6, "subtotal 22.36; no failure allowance once a failed row exists; overhead 10% = 2.24; cost 24.60", s);
  ok(s.charged === 40 && s.margin === 15.4 && s.margin_pct === 39, "charged 40 -> margin 15.40 (39%)", s);
  ok(s.sources.material.deduction === 1 && s.sources.material.flat === 1 && s.sources.material_partial === 2 && s.sources.time.actual === 2, "every line says where its numbers came from", s.sources);
  s = C.projectSummary(proj, [A, F], RS);
  ok(s.failed === 0 && s.failure === 0.05, "with no failed rows the 5% allowance applies to print cost: 0.05", s);
  s = C.projectSummary({ items: [{ kind: "labor", label: "x", minutes: 60 }] }, [B], { ...R, setup_minutes: 15 });
  ok(s.labor.minutes === 75 && s.labor.cost === null && s.blanks.some(b => /no labour rate/.test(b)), "setup minutes add per counted print; no labour rate leaves labour blank and says so", s);
  s = C.projectSummary({ items: [] }, [], {});
  ok(s.cost === null && s.prints === 0, "an empty project costs null, not zero", s);

  console.log("\n== PURE: the pricing helper vs hand-computed numbers ==");
  const RP = { ...RS, markup_pct: 200, margin_pct: 40, hour_rate: 3, min_fee: 10, platform_fee_pct: 9.5, platform_fee_fixed: 0.45 };
  s = C.projectSummary(proj, [A, E, F], RP);
  const pz = C.pricing(s, RP, 3.68);
  const m = k => pz.methods.find(x => x.key === k);
  ok(pz.cost === 24.6 && pz.pieces === 10, "priced from the summary's cost and pieces", pz);
  ok(m("markup").price === 73.8 && m("markup").per_piece === 7.38 && m("markup").gross === 82.04, "markup 200%: 73.80, 7.38 each, listed 82.04 after (p+0.45)/(1-9.5%)", m("markup"));
  ok(m("margin").price === 41 && m("margin").gross === 45.8, "target margin 40%: 24.6/0.6 = 41.00, listed 45.80", m("margin"));
  ok(s.hours === 1.17 && m("machine_hour").price === 25.45, "machine-hour: 1.17 h x $3 + 0.74 + 15 + 6.2 = 25.45", { hours: s.hours, m: m("machine_hour") });
  ok(m("per_gram").raw === 3.68 && m("per_gram").price === 10 && m("per_gram").per_piece === 1, "per-gram floor 3.68 lifted to the $10 minimum fee", m("per_gram"));
  ok(pz.breaks[0].each === 70.34 && pz.breaks[1].each === 7.38 && pz.breaks[2].each === 1.78, "quantity breaks at 1/10/50 amortise labour+extras: 70.34, 7.38, 1.78 each", pz.breaks);
  ok(pz.breaks[1].cost_each === 2.46 && pz.breaks[2].cost_each === 0.59, "…and show the cost each: 2.46, 0.59", pz.breaks);
  const g = C.grossUp(50, RP);
  ok(Math.abs(g - 55.74585635) < 1e-6 && Math.abs(C.netOf(g, RP) - 50) < 1e-9, "gross-up round trip: net(gross(50)) == 50 exactly", { g, net: C.netOf(g, RP) });
  ok(C.grossUp(50, {}) === 50 && C.netOf(50, {}) === 50, "no platform fee: gross == net", null);
  ok(C.pricing({ cost: null }, RP, null) === null, "nothing to price when the cost is blank", null);
  const pn = C.pricing(s, {}, null);
  ok(pn && pn.methods.every(x => x.price === null) && pn.breaks.every(b => b.each === null), "no pricing rates: every method blank with a note, none invented", pn);

  console.log("\n== PURE: CSV and the quote page ==");
  const csv = C.projectCsv(proj, [A, E, F], RS);
  const lines = csv.split("\r\n").filter(Boolean);
  ok(lines[0] === "kind,id,at,printer,file,outcome,counted,pieces,seconds,hours,time_source,grams,material_cost,material_source,material_partial,machine_cost,energy_kwh,energy_cost,direct,label,minutes,item_cost", "CSV header names every column", lines[0]);
  ok(lines.length === 1 + 3 + 2, "one line per print and per item", lines.length);
  ok(/^print,A,.*,done,yes,10,3600,1,actual,25\.7,0\.64,deduction,yes,0\.32,0\.25,0\.04,1,,,$/.test(lines[1]), "the done row carries seconds, sources and the four costs", lines[1]);
  ok(/^labor,i1,.*,support removal,30,$/.test(lines[4]) && /^hardware,i2,.*,M3 inserts x40,,6\.2$/.test(lines[5]), "item rows carry minutes or cost", [lines[4], lines[5]]);
  const html = C.quoteHtml({ project: { name: "Acme <script>alert(1)</script>", state: "open", notes: "\"quoted\" & <b>bold</b>", items: proj.items, charged: 40 }, client: { name: "Bob & Co", email: "" }, summary: s, pricing: pz, prints: [A, E, F], rates: RP });
  ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script>"), "the quote page escapes the project name", null);
  ok(html.includes("&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;") && html.includes("Bob &amp; Co"), "…and the notes and client name", null);
  ok(html.includes("$24.60") && html.includes("$73.80") && html.includes("(not charged)"), "…and carries the cost, the prices and the uncounted marker", null);

  console.log("\n== PURE: suggested rates are keyed by printer type ==");
  ok(C.SUGGESTED.by_type.u1.purchase === 849 && C.SUGGESTED.by_type["kobra-s1"].purchase === 401 && C.SUGGESTED.by_type["kobra-s1"].life_hours === 5000 && C.SUGGESTED.by_type["kobra-s1"].avg_watts === undefined && C.SUGGESTED.by_type["kobra-s1"].maint_per_hour === undefined,
    "a Kobra S1 gets its cited price ($401) and the generic life hours, and NO watts or maintenance reserve (nothing citable)", C.SUGGESTED.by_type);
  ok(/store\.anycubic\.com/.test(C.SUGGESTED_TYPE_NOTES["kobra-s1"].purchase) && /no suggestion/.test(C.SUGGESTED_TYPE_NOTES["kobra-s1"].avg_watts), "…with the source named and the gaps explained", C.SUGGESTED_TYPE_NOTES);
  c = C.costOf({ printer_id: 2, type: "kobra-s1", seconds: 3600, material: { grams: 100, source: "slicer" } }, RSug);
  ok(c.machine && c.machine.per_hour === 0.08 && c.machine.basis === "depreciation" && c.machine.source === "suggested" && c.energy === null && c.blanks.some(b => /no watts/.test(b)), "Kobra S1 row: machine 401/5000 = $0.08/h (depreciation only, suggested); energy blank, named", c);
  c = C.costOf({ printer_id: 2, type: "kobra-s1", seconds: 3600, material: { grams: 100, source: "slicer" } }, { ...RSug, printers: { "2": { avg_watts: 180 } } });
  ok(c.energy && c.energy.watts === 180 && c.energy.watts_source === "typed" && c.energy.cost === 0.03, "…a typed 180 W fills it: 0.18 kWh x $0.183 = $0.03", c.energy);

  console.log("\n== PURE: report() by every grouping vs hand-computed numbers (explicit timestamps, UTC) ==");
  const T = s => Date.parse(s);
  const RR = { kwh_rate: 0.16, cost_per_g: 0.02, labor_rate: 30, overhead_pct: 10, printers: { "0": { purchase: 1099, life_hours: 5000, maint_per_hour: 0.10, avg_watts: 250 } } };
  const rows = [
    { id: "r1", at: T("2026-01-10T10:00:00Z"), printer_id: 0, printer: "U1-mock", type: "u1", outcome: "done", seconds: 3600, seconds_source: "actual", project_id: "pA", material: { grams: 100, source: "slicer", grams_source: "slicer", material: "PLA" } },
    { id: "r2", at: T("2026-01-31T23:30:00Z"), printer_id: 0, printer: "U1-mock", type: "u1", outcome: "cancelled", seconds: 1800, seconds_source: "actual", project_id: "pA", material: { grams: 50, source: "slicer", grams_source: "slicer", material: "PLA", partial: true } },
    { id: "r3", at: T("2026-02-01T00:00:00Z"), printer_id: 1, printer: "Kobra-mock", type: "kobra-s1", outcome: "done", seconds: 3600, seconds_source: "history", project_id: "pB", source: "history", material: { grams: 100, source: "history", grams_source: "history", material: "PETG" } },
    { id: "r4", at: T("2026-02-14T12:00:00Z"), printer_id: 0, printer: "U1-mock", type: "u1", outcome: "done", seconds: 3600, seconds_source: "actual", project_id: "pC", material: { grams: 100, cost: 0.64, source: "deduction", grams_source: "deduction", material: "PLA" } },
    { id: "r5", at: T("2026-02-20T12:00:00Z"), printer_id: 0, printer: "U1-mock", type: "u1", outcome: "done", seconds: 3600, seconds_source: "actual", project_id: null, counted: false, material: { grams: 100, source: "slicer", grams_source: "slicer" } },
    { id: "r6", at: T("2026-03-01T00:00:00Z"), printer_id: 0, printer: "U1-mock", type: "u1", outcome: "error", seconds: null, est_minutes: 60, est_source: "slicer", project_id: null, material: { grams: null, material: "PLA" } }
  ];
  const projects = { pA: { id: "pA", name: "Spring <order>", client_id: "cX", charged: 20, created: T("2026-01-01T00:00:00Z"), items: [{ id: "i1", kind: "labor", label: "support", minutes: 30, created: T("2026-01-15T00:00:00Z") }, { id: "i2", kind: "hardware", label: "inserts", cost: 6.2, created: T("2026-02-05T00:00:00Z") }] },
                     pB: { id: "pB", name: "Signs", client_id: "cX", charged: null, created: T("2026-01-20T00:00:00Z"), items: [] },
                     pC: { id: "pC", name: "Loose", client_id: null, charged: 5, created: T("2026-02-10T00:00:00Z"), items: [] } };
  const clients = { cX: { id: "cX", name: "Acme & Co" } };
  let rep = C.report(rows, projects, clients, RR, { groupBy: "client" });
  const GR = (r, label) => r.groups.find(g => g.label === label);
  ok(rep.group_by === "client" && rep.aligned === true && rep.rows === 6 && rep.groups.map(g => g.label).join("|") === "Acme & Co|(no client)|(no project)", "by client, all time: three groups, biggest cost first", rep.groups.map(g => g.label + ":" + g.cost));
  let grp = GR(rep, "Acme & Co");
  ok(grp.prints === 3 && grp.done === 2 && grp.failed === 1 && grp.counted === 3 && grp.projects === 2 && grp.hours === 2.5 && grp.grams === 250, "Acme: 3 prints (1 failed) over 2 projects, 2.5 h, 250 g", grp);
  ok(grp.material === 5 && grp.machine === 0.48 && grp.energy === 0.06 && grp.direct === 5.54, "Acme direct: material 2+1+2, machine 0.32+0.16 (the Kobra has no rates), energy 0.04+0.02 = 5.54", grp);
  ok(grp.failure_cost === 1.18 && grp.failure_share === 21.3, "Acme failed prints cost 1.18 = 21.3% of its print cost", { fc: grp.failure_cost, fs: grp.failure_share });
  ok(grp.labor === 15 && grp.labor_minutes === 30 && grp.extras === 6.2 && grp.overhead === 2.67 && grp.failure === 0 && grp.cost === 29.41, "Acme cost: pA 3.54 + 15 labour + 6.2 extras + 2.47 overhead = 27.21, pB 2.00 + 0.20 = 2.20; together 29.41", grp);
  ok(grp.charged === 20 && grp.margin === -9.41 && grp.margin_pct === -47, "Acme charged 20 (pA, whose newest print is in range) -> margin -9.41 (-47%)", grp);
  ok(grp.coverage.time.actual === 3 && grp.coverage.grams.actual === 1 && grp.coverage.grams.estimated === 2 && grp.coverage.material.actual === 0 && grp.coverage.machine.actual === 2 && grp.coverage.machine.blank === 1 && grp.coverage.grams.actual_pct === 33,
    "Acme coverage: time 3/3 actual; grams 1 actual (history) 2 estimated (33%); material none actual; machine 2 typed 1 blank", g.coverage);
  grp = GR(rep, "(no client)");
  ok(grp.prints === 1 && grp.direct === 1 && grp.material === 0.64 && grp.coverage.material.actual === 1 && grp.cost === 1.1 && grp.charged === 5 && grp.margin === 3.9 && grp.margin_pct === 78, "(no client) = pC: the deduction-priced print, 1.00 + 10% overhead = 1.10, charged 5, margin 3.90 (78%)", grp);
  grp = GR(rep, "(no project)");
  ok(grp.prints === 2 && grp.counted === 1 && grp.uncounted === 1 && grp.failed === 1 && grp.hours === 1 && grp.grams === null && grp.material === null && grp.direct === 0.36 && grp.failure_cost === 0.36 && grp.failure_share === 100 && grp.labor === null && grp.cost === 0.36 && grp.charged === null,
    "(no project): the uncounted print is counted in prints only; the error print costs 0.36 of machine+energy on its slicer hour, grams blank, no labour/extras possible", g);
  ok(grp.coverage.time.estimated === 1 && grp.coverage.grams.blank === 1 && grp.coverage.material.blank === 1, "…and its coverage says estimated time, blank grams, blank material", grp.coverage);
  const tot = rep.totals;
  const wantCost = FALSIFY ? 30.88 : 30.87;
  ok(tot.prints === 6 && tot.done === 4 && tot.failed === 2 && tot.counted === 5 && tot.uncounted === 1 && tot.hours === 4.5 && tot.grams === 350, "totals: 6 prints, 4 done, 2 failed, 5 counted, 4.5 h, 350 g", tot);
  ok(tot.material === 5.64 && tot.machine === 1.12 && tot.energy === 0.14 && tot.direct === 6.9 && tot.failure_cost === 1.54 && tot.failure_share === 22.3, "totals direct: 5.64 + 1.12 + 0.14 = 6.90; failed 1.54 (22.3%)", tot);
  ok(tot.labor === 15 && tot.extras === 6.2 && tot.overhead === 2.77 && tot.cost === wantCost && tot.charged === 25 && tot.margin === -5.87 && tot.margin_pct === -23, "totals cost 29.41 + 1.10 + 0.36 = " + wantCost + "; charged 25; margin -5.87 (-23%)" + (FALSIFY ? " [FALSIFIED]" : ""), tot);
  ok(tot.coverage.time.actual_pct === 80 && tot.coverage.grams.actual_pct === 40 && tot.coverage.material.actual_pct === 20 && tot.coverage.machine.actual_pct === 80 && tot.coverage.energy.actual_pct === 80, "totals coverage: time 80%, grams 40%, material 20%, machine 80%, energy 80% actual", tot.coverage);
  // a date range with both edges: Feb 2026. r3 sits exactly on the start (in), r6 exactly on the end (out), r2 is 30 min before the start (out).
  rep = C.report(rows, projects, clients, RR, { groupBy: "project", from: T("2026-02-01T00:00:00Z"), to: T("2026-03-01T00:00:00Z") });
  ok(rep.rows === 3 && rep.groups.map(g2 => g2.label).join("|") === "Spring <order>|Signs|Loose|(no project)", "by project, February: 3 rows (the start edge is in, the end edge is out); pA joins with no prints because an item was created inside the range", rep.groups.map(g2 => g2.label + ":" + g2.prints + ":" + g2.cost));
  grp = GR(rep, "Spring <order>");
  ok(grp.prints === 0 && grp.labor === 0 && grp.extras === 6.2 && grp.overhead === 0.62 && grp.cost === 6.82 && grp.charged === null, "pA in February: no prints, the hardware item (6.20) + 10% = 6.82; its charge is NOT here (its newest print is January)", grp);
  ok(GR(rep, "Signs").cost === 2.2 && GR(rep, "Signs").charged === null && GR(rep, "Loose").cost === 1.1 && GR(rep, "Loose").charged === 5 && GR(rep, "(no project)").counted === 0 && GR(rep, "(no project)").cost === null, "pB 2.20 uncharged, pC 1.10 charged 5, the uncounted print's group costs null", rep.groups);
  ok(rep.totals.prints === 3 && rep.totals.cost === 10.12 && rep.totals.charged === 5 && rep.totals.margin === -5.12, "February totals: 3 prints, cost 10.12, charged 5, margin -5.12", rep.totals);
  rep = C.report(rows, projects, clients, RR, { groupBy: "month" });
  ok(rep.aligned === false && rep.groups.map(g2 => g2.label).join("|") === "2026-01|2026-02|2026-03" && rep.groups.map(g2 => g2.direct).join("|") === "3.54|3|0.36" && rep.groups.every(g2 => g2.labor === null && g2.charged === null && g2.cost === g2.direct),
    "by month (UTC): Jan 3.54, Feb 3.00, Mar 0.36 in order; labour and charges are not attributable, cost = print cost", rep.groups.map(g2 => g2.label + ":" + g2.direct));
  rep = C.report(rows, projects, clients, RR, { groupBy: "month", tz_offset_min: 60 });
  ok(rep.groups.map(g2 => g2.label + ":" + g2.direct).join("|") === "2026-01:5.54|2026-02:1.36", "…an hour west of UTC, the two midnight-UTC prints (Feb 1, Mar 1) belong to the month before: Jan 5.54, Feb 1.36, no March", rep.groups.map(g2 => g2.label + ":" + g2.direct));
  ok(C.monthKey(T("2026-02-01T00:00:00Z"), 0) === "2026-02" && C.monthKey(T("2026-02-01T00:00:00Z"), 60) === "2026-01" && C.monthKey(T("2026-02-01T00:00:00Z"), -60) === "2026-02", "monthKey honours the offset in both directions", null);
  rep = C.report(rows, projects, clients, RR, { groupBy: "printer" });
  ok(rep.groups.map(g2 => g2.label + ":" + g2.prints).join("|") === "U1-mock:5|Kobra-mock:1" && GR(rep, "Kobra-mock").machine === null && GR(rep, "Kobra-mock").direct === 2, "by printer: U1-mock 5 prints, Kobra-mock 1 (material only, no rates typed)", rep.groups.map(g2 => g2.label + ":" + g2.prints));
  rep = C.report(rows, projects, clients, RR, { groupBy: "type" });
  ok(rep.groups.map(g2 => g2.label + ":" + g2.prints).join("|") === "u1:5|kobra-s1:1", "by printer type: u1 5, kobra-s1 1", rep.groups.map(g2 => g2.label));
  rep = C.report(rows, projects, clients, RR, { groupBy: "material" });
  ok(rep.groups.map(g2 => g2.label + ":" + g2.prints).join("|") === "PLA:4|PETG:1|(unknown):1", "by material: PLA 4, PETG 1, unknown 1 (the row with no material)", rep.groups.map(g2 => g2.label + ":" + g2.prints));
  rep = C.report(rows, projects, clients, RR, { groupBy: "outcome" });
  ok(rep.groups.map(g2 => g2.label + ":" + g2.prints).join("|") === "done:4|cancelled:1|error:1" && GR(rep, "done").failed === 0 && GR(rep, "cancelled").failure_share === 100, "by outcome: done 4, cancelled 1, error 1; the failed groups are 100% failure cost", rep.groups.map(g2 => g2.label + ":" + g2.prints));
  ok(C.report([], {}, {}, RR, { groupBy: "client" }).groups.length === 0 && C.report(rows, projects, clients, RR, { groupBy: "nonsense" }).group_by === "client", "an empty ledger reports no groups; an unknown grouping falls back to client", null);
  ok(C.report(rows, Object.values(projects), Object.values(clients), RR, { groupBy: "client" }).totals.cost === 30.87, "projects and clients may be arrays or maps", null);
  const rcsv = C.reportCsv(C.report(rows, projects, clients, RR, { groupBy: "client" }));
  const rl = rcsv.split("\r\n").filter(Boolean);
  ok(rl[0] === "group,prints,done,failed,counted,pieces,hours,grams,material,machine,energy,direct,failure_cost,failure_share_pct,labour,labour_minutes,extras,failure_allowance,overhead,cost,charged,margin,margin_pct,time_actual_pct,grams_actual_pct,material_actual_pct,machine_typed_pct,energy_typed_pct", "report CSV header names every column", rl[0]);
  ok(rl.length === 1 + 3 + 1 && rl[1].startsWith("Acme & Co,3,2,1,3,2,2.5,250,5,0.48,0.06,5.54,1.18,21.3,15,30,6.2,0,2.67,29.41,20,-9.41,-47,100,33,0,67,67") && rl[4].startsWith("TOTAL,6,4,2,5,"), "…one line per group plus TOTAL, with the numbers above", rl);
  const rhtml = C.reportHtml(C.report(rows, projects, clients, RR, { groupBy: "project", from: T("2026-01-01T00:00:00Z"), to: T("2026-04-01T00:00:00Z") }));
  ok(rhtml.includes("Spring &lt;order&gt;") && !rhtml.includes("Spring <order>") && !/<script/.test(rhtml), "the printable report escapes the project name and carries no script", null);
  ok(rhtml.includes("2026-01-01 to 2026-03-31") && rhtml.includes("$27.21") && rhtml.includes("Cost report by project") && /class="bar"/.test(rhtml), "…and shows the range, the project's cost and a bar per group", null);
}

// ---- live half ---------------------------------------------------------------------------------
(async () => {
  try { pureChecks(); } catch (e) { fail++; console.log("  FAIL (pure threw) " + (e && e.stack || e)); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-costing-"));
  const gcode = path.join(tmp, "gcode");
  fs.mkdirSync(gcode, { recursive: true });
  const FILE = "Frog x10.gcode";
  fs.writeFileSync(path.join(gcode, FILE), [
    "; generated by OrcaSlicer", "G28", "T0", "G1 X1", "T1", "G1 X2", "T2", "G1 X3",
    "; filament_colour = #FF0000;#00FF00;#0000FF;#FFFFFF", "; filament_type = PLA;PLA;PLA;PLA",
    "; filament used [g] = 10.0;12.5;3.2;0", "; estimated printing time (normal mode) = 1h 2m"
  ].join("\n"));
  const mock = createMock("u1");
  const portU1 = await mock.listen(0);
  const URL1 = "http://127.0.0.1:" + portU1;
  // Two priced rolls loaded in T1 and T2 with known weights; T3 has no roll, so
  // the deduction (and the ledger's material) is partial by construction.
  fs.writeFileSync(path.join(tmp, "spools.json"), JSON.stringify({ tags: {}, local: [], spools: {
    "-101": { id: -101, brand: "TestCo", material: "PLA", material_variant: "PLA", color_name: "Red", hex: "FF0000", lab: null, color_source: "user" },
    "-102": { id: -102, brand: "TestCo", material: "PLA", material_variant: "PLA", color_name: "Green", hex: "00FF00", lab: null, color_source: "user" } } }));
  fs.writeFileSync(path.join(tmp, "slots.json"), JSON.stringify({ [URL1]: { "0": { spool_id: "-101" }, "1": { spool_id: "-102" } } }));
  fs.writeFileSync(path.join(tmp, "resources.json"), JSON.stringify({ inv: {
    "-101": { remaining_g: 700, net_weight_g: 1000, cost_per_roll: 29.99 },
    "-102": { remaining_g: 400, net_weight_g: 1000, cost_per_roll: 27.5 } }, color_map: {}, settings: { assume_empty_when_unset: false, match_de_max: 7 } }));

  const fleetState = async () => { const f = (await jget("/api/fleet")).body || []; const p = f.find(x => x.id === 0); return p ? p.state : "absent"; };
  const waitState = async want => { let st = null; for (let i = 0; i < 60; i++) { st = await fleetState(); if (st === want) break; await sleep(250); } return st; };
  const check = async () => ((await jpost("/api/fleet-events/check", {})).body || {}).emitted || [];
  const waitRow = async (pred) => { for (let i = 0; i < 40; i++) { const rows = ((await jget("/api/costing/prints")).body || {}).prints || []; const r = rows.find(pred); if (r) return r; await sleep(250); } return null; };

  try {
    console.log("\n== LIVE: defaults, rates, validation ==");
    writeConfig(tmp, gcode, portU1, null);
    await startHub(tmp);
    let cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features.costing === true, "costing ships on: it only listens and writes its own files", cfg.features);
    let page = await (await fetch(HUB + "/")).text();
    ok(page.includes("/modules/costing-ui.js"), "costing on: its client script is injected");
    ok((await fetch(HUB + "/modules/costing-ui.js")).ok, "the client module file is served");
    ok(/HubModules\.register\("costing"/.test(fs.readFileSync(path.join(REPO, "public", "modules", "costing-ui.js"), "utf8")), "the client file registers a Projects tab");
    const hlog = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).join("\n");
    ok(hlog.includes("costing (ryvin/u1hub fork module) armed"), "Hub log names the fork module");
    let r = await jget("/api/costing");
    ok(r.status === 200 && r.body.fork === "ryvin/u1hub" && r.body.kwh_rate === null && r.body.cost_per_g === 0.02, "GET /api/costing: no rates set, every rate null; the flat $/g comes from the margin module", r.body);
    r = await jpost("/api/costing/settings", { kwh_rate: -1 });
    ok(r.status === 400 && /kwh_rate/.test(r.body.error), "KNOWN-BAD negative rate -> 400 with the key named", r.body);
    r = await jpost("/api/costing/settings", { labor_rate: "abc" });
    ok(r.status === 400, "KNOWN-BAD NaN rate -> 400", r.body);
    r = await jpost("/api/costing/settings", { printers: { "5": { purchase: 1 } } });
    ok(r.status === 400 && /no printer at index 5/.test(r.body.error), "KNOWN-BAD unknown printer index -> 400", r.body);
    r = await jpost("/api/costing/settings", { printers: { "0": { avg_watts: 0 } } });
    ok(r.status === 400, "KNOWN-BAD 0 W is not a measurement -> 400", r.body);
    r = await jpost("/api/costing/settings", { kwh_rate: 0.16, labor_rate: 30, overhead_pct: 10, markup_pct: 200, printers: { "0": { purchase: 1099, life_hours: 5000, maint_per_hour: 0.1, avg_watts: 250 } } });
    ok(r.status === 200 && r.body.kwh_rate === 0.16 && r.body.printers["0"].avg_watts === 250, "valid rates save", r.body);
    const cj = JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8"));
    ok(cj.costing && cj.costing.kwh_rate === 0.16 && cj.costing.printers["0"].purchase === 1099, "…to config.json under costing", cj.costing);
    r = await jpost("/api/costing/settings", { overhead_pct: "" });
    ok(r.status === 200 && r.body.overhead_pct === null, "an emptied rate is unset, not zero", r.body.overhead_pct);

    console.log("\n== LIVE: clients, projects, pending ==");
    r = await jpost("/api/costing/clients", { name: "" });
    ok(r.status === 400, "a client needs a name", r.body);
    r = await jpost("/api/costing/clients", { name: "Acme Toys", email: "orders@acme.example" });
    ok(r.status === 200 && r.body.client && r.body.client.id, "client created", r.body);
    const CL = r.body.client.id;
    r = await jpost("/api/costing/projects", { name: "Spring order", client_id: "cl_nope" });
    ok(r.status === 400 && /No such client/.test(r.body.error), "KNOWN-BAD unknown client id -> 400", r.body);
    r = await jpost("/api/costing/projects", { name: "x".repeat(161), client_id: CL });
    ok(r.status === 400, "KNOWN-BAD oversize name -> 400", r.body);
    r = await jpost("/api/costing/projects", { name: "Spring order", client_id: CL });
    ok(r.status === 200 && r.body.project.id && r.body.project.summary.cost === null, "project created, cost blank until something prints", r.body);
    const P1 = r.body.project.id;
    r = await jpost("/api/costing/projects", { name: "Trade show props" });
    const P2 = r.body.project.id;
    ok(r.status === 200 && P2 && r.body.project.client_id === null, "a project without a client is allowed", r.body);
    r = await jpost("/api/costing/pending", { file: FILE, type: "u1", project_id: "pr_nope" });
    ok(r.status === 400, "KNOWN-BAD pending to an unknown project -> 400", r.body);
    r = await jpost("/api/costing/pending", { file: FILE, type: "u1", project_id: P1 });
    ok(r.status === 200 && r.body.pending["u1:" + FILE] === P1, "the next print of the file is pointed at the project", r.body);

    console.log("\n== LIVE: a print on the mock U1 lands in the ledger with its actual seconds ==");
    await jget("/api/files?type=u1");                       // library snapshot, so the deduction finds the file
    ok(await waitState("standby") === "standby", "fleet reports the mock idle");
    await check();                                           // seeds the edge watcher
    mock.state.printState = "printing"; mock.state.filename = FILE;
    ok(await waitState("printing") === "printing", "fleet reports it printing");
    let ev = await check();
    ok(ev.some(e => e.type === "print.started"), "standby -> printing raises print.started", ev);
    mock.state.printState = "complete"; mock.state.printDuration = 3600;
    ok(await waitState("complete") === "complete", "fleet reports it complete");
    ev = await check();
    ok(ev.some(e => e.type === "print.done" && e.durationSec === 3600), "printing -> complete raises print.done with 3600 s", ev);
    const row = await waitRow(x => x.file === FILE && x.material.source === "deduction");
    ok(!!row, "a ledger row for the file appears, priced from the deduction the resources module made", row);
    const want = FALSIFY ? 3601 : 3600;
    ok(row && row.seconds === want && row.seconds_source === "actual", "the row carries the actual duration from print.done (" + want + " s)" + (FALSIFY ? " [FALSIFIED]" : ""), row && { seconds: row.seconds, src: row.seconds_source });
    ok(row && row.outcome === "done" && row.printer_id === 0 && row.printer === "U1-mock" && row.type === "u1", "outcome, printer and type recorded", row);
    ok(row && row.project_id === P1, "the pending assignment landed it in the project", row && row.project_id);
    ok(row && row.pieces === 10, "pieces from the file name (x10)", row && row.pieces);
    ok(row && row.material.grams === 25.7 && row.est_minutes === 62, "slicer grams (10+12.5+3.2, purge-inclusive) and estimate kept beside the actuals", row && row.material);
    ok(row && row.material.cost === 0.64 && row.material.partial === true && row.material.heads.length === 2 && /T3/.test(row.material.misses[0]),
      "material: 10 g of a $29.99 roll + 12.5 g of a $27.50 roll = $0.64, partial because T3 had no roll", row && row.material);
    ok(row && row.cost.direct === 1 && row.cost.machine.cost === 0.32 && row.cost.energy.cost === 0.04, "costed live with the saved rates: direct $1.00", row && row.cost);
    const d = (await jget("/api/resources/deductions")).body.deductions[0];
    ok(d && d.file === FILE && d.grams === 22.5, "the resources module deducted once (22.5 g), not twice", d);
    r = await jget("/api/costing/projects");
    ok(!r.body.pending["u1:" + FILE], "the finished print spent the pending assignment", r.body.pending);
    ok(r.body.projects.find(p => p.id === P1).summary.prints === 1, "the project lists one print", r.body.projects);

    console.log("\n== LIVE: a cancelled print is a row too; assign, move, uncount ==");
    mock.state.printState = "standby"; mock.state.printDuration = 0;
    ok(await waitState("standby") === "standby", "mock idle again");
    await check();
    mock.state.printState = "printing";
    await waitState("printing"); await check();
    mock.state.printState = "cancelled"; mock.state.printDuration = 600;
    ok(await waitState("cancelled") === "cancelled", "fleet reports it cancelled");
    ev = await check();
    ok(ev.some(e => e.type === "print.cancelled"), "printing -> cancelled raises print.cancelled", ev);
    const cx = await waitRow(x => x.file === FILE && x.outcome === "cancelled");
    ok(!!cx && cx.seconds === 600 && cx.seconds_source === "actual" && cx.counted === true, "the cancelled row carries the printer's print_duration and counts by default", cx);
    ok(cx && cx.project_id === null && cx.material.source === "slicer" && cx.material.partial === true && cx.material.cost === null && cx.cost.material.cost === 0.51,
      "…unassigned (nothing pending), material a partial slicer estimate priced at the flat $/g", cx && { pid: cx.project_id, m: cx.material, c: cx.cost.material });
    ok((await jget("/api/resources/deductions")).body.deductions.length === 1, "a cancelled print deducts nothing (resources' rule, unchanged)");
    r = await jget("/api/costing/projects");
    ok(r.body.unassigned.length === 1 && r.body.unassigned[0].id === cx.id, "it shows in the unassigned strip", r.body.unassigned);
    r = await jpost("/api/costing/prints/assign", { print_id: "pt_nope", project_id: P1 });
    ok(r.status === 404, "KNOWN-BAD unknown print -> 404", r.body);
    r = await jpost("/api/costing/prints/assign", { print_id: cx.id, project_id: "pr_nope" });
    ok(r.status === 400, "KNOWN-BAD assign to unknown project -> 400", r.body);
    r = await jpost("/api/costing/prints/assign", { print_id: cx.id, project_id: P2 });
    ok(r.status === 200 && r.body.print.project_id === P2, "assigned to project 2", r.body);
    r = await jpost("/api/costing/prints/assign", { print_id: cx.id, project_id: P1 });
    ok(r.status === 200 && r.body.print.project_id === P1 && ((await jget("/api/costing/projects/" + P2)).body.summary.prints === 0), "moved to project 1; project 2 is empty again", r.body);
    r = await jpost("/api/costing/prints/update", { print_id: cx.id, counted: false });
    ok(r.status === 200 && r.body.print.counted === false, "don't count it", r.body.print);
    let full = (await jget("/api/costing/projects/" + P1)).body;
    ok(full.summary.prints === 2 && full.summary.counted === 1 && full.summary.failed === 1 && full.summary.direct === 1, "project: 2 prints, 1 counted, 1 failed; direct is the done print alone", full.summary);
    r = await jpost("/api/costing/prints/update", { print_id: cx.id, counted: true, pieces: 0 });
    ok(r.status === 400, "KNOWN-BAD pieces 0 -> 400", r.body);
    r = await jpost("/api/costing/prints/update", { print_id: cx.id, counted: true });
    ok(r.status === 200 && r.body.print.counted === true, "counted again", r.body.print);

    console.log("\n== LIVE: line items, summary math from the API's own rows, CSV, quote ==");
    r = await jpost("/api/costing/items", { project_id: P1, kind: "labor", label: "Support removal", minutes: 30 });
    ok(r.status === 200 && r.body.item.minutes === 30, "labour item added", r.body.item);
    r = await jpost("/api/costing/items", { project_id: P1, kind: "hardware", label: "M3 inserts x40", cost: 6.2 });
    ok(r.status === 200 && r.body.item.cost === 6.2, "hardware item added", r.body.item);
    r = await jpost("/api/costing/items", { project_id: P1, kind: "labor", label: "x", minutes: -5 });
    ok(r.status === 400, "KNOWN-BAD negative minutes -> 400", r.body);
    r = await jpost("/api/costing/items", { project_id: P1, kind: "bribe", label: "x", cost: 1 });
    ok(r.status === 400, "KNOWN-BAD unknown item kind -> 400", r.body);
    await jpost("/api/costing/settings", { overhead_pct: 10 });
    await jpost("/api/costing/projects/update", { id: P1, charged: 40 });
    full = (await jget("/api/costing/projects/" + P1)).body;
    const S = full.summary;
    const directFromRows = r2(full.prints.filter(p => p.counted !== false).reduce((a, p) => a + (p.cost.direct || 0), 0));
    ok(S.direct === directFromRows && S.counted === 2, "summary direct equals the sum of its own counted rows (" + directFromRows + ")", { S: S.direct, rows: directFromRows });
    ok(S.labor.cost === 15 && S.extras === 6.2 && S.subtotal === r2(S.direct + 15 + 6.2), "labour $15 (30 min at $30/h), extras $6.20, subtotal adds up", S);
    ok(S.failure === 0 && S.overhead === r2(S.subtotal * 0.1) && S.cost === r2(S.subtotal + S.overhead), "no failure allowance (a failed row exists); overhead 10%; cost = subtotal + overhead", S);
    ok(S.charged === 40 && S.margin === r2(40 - S.cost) && S.margin_pct === Math.round(S.margin / 40 * 100), "charged 40 -> margin and margin %", S);
    ok(full.pricing && full.pricing.methods.find(m => m.key === "markup").price === r2(S.cost * 3) && full.pricing.methods.find(m => m.key === "per_gram").price === r2(S.grams * 0.12),
      "pricing helper: markup 200% and the per-gram floor from the margin module's sell floor", full.pricing.methods);
    ok(full.pricing.methods.find(m => m.key === "margin").price === null && /Settings/.test(full.pricing.methods.find(m => m.key === "margin").note), "unset target margin: blank with a note", full.pricing.methods);
    const csvR = await fetch(HUB + "/api/costing/projects/" + P1 + ".csv");
    const csvB = Buffer.from(await csvR.arrayBuffer());        // .text() would strip the BOM before we could see it
    const csvT = csvB.toString("utf8");
    const csvL = csvT.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    ok(csvR.status === 200 && /text\/csv/.test(csvR.headers.get("content-type")) && csvB[0] === 0xef && csvB[1] === 0xbb && csvB[2] === 0xbf, "CSV export answers as text/csv with a UTF-8 BOM", { ct: csvR.headers.get("content-type"), head: csvB.slice(0, 3) });
    ok(csvL[0].startsWith("kind,id,at,printer,file,outcome,counted,pieces,seconds,hours") && csvL.length === 1 + 2 + 2, "CSV: header + 2 print rows + 2 item rows", csvL);
    ok(csvL.some(l => l.startsWith("print,") && l.includes(",done,yes,10,3600,1,actual,25.7,0.64,deduction,yes,")) && csvL.some(l => l.startsWith("labor,") && l.endsWith(",Support removal,30,")), "CSV rows carry the ledger's numbers and the items", csvL);
    r = await jpost("/api/costing/projects/update", { id: P1, name: "Acme <script>alert(1)</script>", notes: "\"quoted\" & <b>bold</b>" });
    ok(r.status === 200, "project renamed to something hostile", r.body);
    const qR = await fetch(HUB + "/api/costing/projects/" + P1 + "/quote");
    const qT = await qR.text();
    ok(qR.status === 200 && /text\/html/.test(qR.headers.get("content-type")), "the quote page answers as HTML", qR.headers.get("content-type"));
    ok(qT.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !qT.includes("<script>") && qT.includes("&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;"), "…with every user string escaped", null);
    ok(qT.includes("$" + S.cost.toFixed(2)) && qT.includes("Acme Toys") && qT.includes("Support removal"), "…and carries the cost, the client and the items", null);
    ok((await fetch(HUB + "/api/costing/projects/pr_nope/quote")).status === 404 && (await jget("/api/costing/projects/pr_nope")).status === 404, "unknown project -> 404 on the page and the API");

    console.log("\n== LIVE: state files, removal ==");
    ok(fs.existsSync(path.join(tmp, "projects.json")) && fs.existsSync(path.join(tmp, "prints.json")), "projects.json and prints.json live beside config.json");
    const gi = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
    ok(/^projects\.json$/m.test(gi) && /^prints\.json$/m.test(gi), "…and both are gitignored");
    ok(!fs.existsSync(path.join(tmp, "prints.json.tmp")), "no .tmp file left behind by the save");
    const lj = JSON.parse(fs.readFileSync(path.join(tmp, "prints.json"), "utf8"));
    ok(lj.prints.length === 2 && lj.prints[0].id === row.id, "the ledger on disk holds both rows in order");
    r = await jpost("/api/costing/clients/remove", { id: CL });
    ok(r.status === 409, "a client with projects cannot be removed", r.body);
    r = await jpost("/api/costing/projects/remove", { id: P2 });
    ok(r.status === 200 && r.body.prints_unassigned === 0, "an empty project is removed", r.body);
    r = await jpost("/api/costing/projects/remove", { id: P1 });
    ok(r.status === 200 && r.body.prints_unassigned === 2, "removing a project frees its prints to the unassigned strip", r.body);
    ok(((await jget("/api/costing/projects")).body.unassigned_total) === 2, "…where they now sit", null);

    console.log("\n== LIVE: a file sent straight to the printer (not in the library) gets grams and time from the printer's own metadata ==");
    const PFILE = "Printer only x4.gcode";
    mock.state.metadata = { [PFILE]: { estimated_time: 11236, filament_weight_total: 120.38, filament_total: 40361.57, filament_type: "PLA;PLA;PLA;PLA", filament_name: "Generic PLA", slicer: "SnapmakerOrca" } };
    mock.state.printState = "standby"; mock.state.printDuration = 0; mock.state.filename = "";
    ok(await waitState("standby") === "standby", "mock idle");
    await check();
    mock.state.printState = "printing"; mock.state.filename = PFILE;
    ok(await waitState("printing") === "printing", "fleet reports it printing a file the library does not have");
    await check();
    const mrBefore = mock.state.metaRequests.filter(q => q.filename === PFILE).length;   // core/fleet.js asks once itself, for progress, while printing
    mock.state.printState = "complete"; mock.state.printDuration = 7200;
    ok(await waitState("complete") === "complete", "fleet reports it complete");
    ev = await check();
    ok(ev.some(e => e.type === "print.done" && e.durationSec === 7200), "print.done with 7200 s", ev);
    const pm = await waitRow(x => x.file === PFILE && x.outcome === "done");
    const wantG = FALSIFY ? 120.39 : 120.38;
    ok(pm && pm.material.grams === wantG && pm.material.grams_source === "printer-meta" && pm.material.source === "printer-meta", "the row's grams are the printer's filament_weight_total (" + wantG + " g, printer-meta)" + (FALSIFY ? " [FALSIFIED]" : ""), pm && pm.material);
    ok(pm && pm.seconds === 7200 && pm.seconds_source === "actual" && pm.est_minutes === 187 && pm.est_source === "printer-meta", "actual 7200 s kept; the printer's estimated_time 11236 s = 187 min recorded beside it (printer-meta)", pm && { s: pm.seconds, ss: pm.seconds_source, e: pm.est_minutes, es: pm.est_source });
    ok(pm && pm.material.material === "PLA" && pm.pieces === 4, "material PLA from filament_type; pieces 4 from the name", pm && { m: pm.material.material, p: pm.pieces });
    ok(pm && pm.cost.material.cost === 2.41 && pm.cost.material.source === "flat" && pm.cost.material.grams_source === "printer-meta", "priced at the flat $/g: 120.38 x 0.02 = $2.41, labelled flat with grams from printer metadata", pm && pm.cost.material);
    ok(mock.state.metaRequests.filter(q => q.filename === PFILE).length === mrBefore + 1, "exactly one metadata GET to the printer at print.done for that file", mock.state.metaRequests);
    ok((await jget("/api/resources/deductions")).body.deductions.length === 1, "resources deducted nothing for a file it cannot read (unchanged upstream rule)");

    console.log("\n== LIVE: the same print reported done twice is one ledger row ==");
    const before = (await jget("/api/costing/prints")).body.total;
    mock.state.printState = "printing";                       // the state flaps back, print_duration still counting
    ok(await waitState("printing") === "printing", "fleet reports printing again");
    ev = await check();
    ok(ev.some(e => e.type === "print.started"), "complete -> printing raises print.started (what the Hub saw 2026-10-02)", ev);
    mock.state.printState = "complete"; mock.state.printDuration = 7700;
    ok(await waitState("complete") === "complete", "…and complete again");
    ev = await check();
    ok(ev.some(e => e.type === "print.done" && e.durationSec === 7700), "a second print.done, 500 s later by the printer's own clock", ev);
    const again = await waitRow(x => x.id === pm.id && x.seconds === 7700);
    ok(!!again && again.done_twice === 1, "the existing row took the longer duration (7700 s) and counts the repeat", again && { s: again.seconds, twice: again.done_twice });
    const after = (await jget("/api/costing/prints")).body;
    ok(after.total === before && after.prints.filter(x => x.file === PFILE && x.outcome === "done").length === 1, "no second row: the ledger total is unchanged (" + before + ")", { before, after: after.total });
    const hl = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).filter(m => /reported again/.test(m));
    ok(hl.length === 1 && /7200 s -> 7700 s/.test(hl[0]), "the Hub log says so", hl);

    console.log("\n== LIVE: backfill of blank rows, one paced GET at a time, idempotent ==");
    r = await jget("/api/costing/projects");
    ok(r.body.blank_rows === 0 && r.body.sources && r.body.sources.grams["printer-meta"] === 1 && r.body.sources.grams.slicer === 2, "the tab's tally: 2 rows with slicer grams, 1 with printer metadata, none blank", r.body.sources);
    await stopHub();
    // Three rows an older Hub left blank: A has metadata on the printer, B only
    // a history job (PETG, 10 m of filament), C nothing anywhere.
    const blank = (id, file) => ({ id, at: Date.now() - 3600000, printer_id: 0, printer: "U1-mock", file, type: "u1", outcome: "done", project_id: null, job_id: null, bundle_id: null,
      seconds: null, seconds_source: null, est_minutes: null, material: { grams: null, cost: null, source: null, partial: false, heads: [] }, energy: null, pieces: 1, counted: true, note: "" });
    const lj2 = JSON.parse(fs.readFileSync(path.join(tmp, "prints.json"), "utf8"));
    lj2.prints.push(blank("pt_A", "Backfill A.gcode"), blank("pt_B", "Backfill B.gcode"), blank("pt_C", "Backfill C.gcode"));
    fs.writeFileSync(path.join(tmp, "prints.json"), JSON.stringify(lj2));
    mock.state.metadata["Backfill A.gcode"] = { estimated_time: 3600, filament_weight_total: 50.5, filament_type: "PLA" };
    const endB = Math.floor((Date.now() - 3600000) / 1000) - 10;
    mock.state.history = [{ job_id: "000002", exists: true, filename: "Backfill B.gcode", status: "completed", start_time: endB - 4990, end_time: endB, print_duration: 4800, total_duration: 4990, filament_used: 10000, metadata: { filament_type: "PETG" } },
                          { job_id: "000001", exists: true, filename: "Backfill B.gcode", status: "cancelled", start_time: endB - 90000, end_time: endB - 86400, print_duration: 100, total_duration: 120, filament_used: 500, metadata: {} }];
    mock.state.totalPrintTime = 123 * 3600;
    mock.state.metaRequests.length = 0;
    await startHub(tmp);
    r = await jget("/api/costing/projects");
    ok(r.body.blank_rows === 3 && r.body.ledger_total === 6, "after the restart: 6 rows, 3 blank, nothing asked of the printer yet", { blank: r.body.blank_rows, total: r.body.ledger_total, reqs: mock.state.metaRequests.length });
    ok(mock.state.metaRequests.length === 0, "boot backfill off (U1HUB_COSTING_BACKFILL_BOOT_MS=0): no metadata GET happened by itself", mock.state.metaRequests);
    const t0 = Date.now();
    r = await jpost("/api/costing/backfill", {});
    const ms = Date.now() - t0;
    ok(r.status === 200 && r.body.checked === 3 && r.body.filled === 2 && r.body.meta === 1 && r.body.history === 1 && r.body.none === 1, "POST /api/costing/backfill: 3 checked, 2 filled (1 metadata, 1 history), 1 still blank", r.body);
    ok(r.body.requests === 4 && mock.state.metaRequests.length === 3, "4 GETs: metadata for A, B, C and one history list (cached for C)", { body: r.body, meta: mock.state.metaRequests.map(q => q.filename) });
    // Pacing is asserted on the Hub's own record of when it sent each GET (the
    // mock's receive times carry socket jitter). 2 ms tolerance: a Node timer
    // can land a millisecond early on the event loop's cached clock.
    ok(r.body.pause_ms === PAUSE_MS && r.body.min_gap_ms >= PAUSE_MS - 2 && ms >= 3 * PAUSE_MS - 2, "paced: the smallest gap between two of the 4 GETs was " + r.body.min_gap_ms + " ms (pause " + PAUSE_MS + "); the whole run took " + ms + " ms, at least 3 pauses", { min_gap: r.body.min_gap_ms, ms });
    let rows = (await jget("/api/costing/prints")).body.prints;
    const A = rows.find(x => x.id === "pt_A"), B = rows.find(x => x.id === "pt_B"), Cc = rows.find(x => x.id === "pt_C");
    ok(A && A.material.grams === 50.5 && A.material.grams_source === "printer-meta" && A.est_minutes === 60 && A.est_source === "printer-meta" && A.cost.hours === 1 && A.cost.time_source === "printer-meta", "A: 50.5 g and 60 min from the printer's metadata; costed as 1 h (printer-meta)", A && { m: A.material, e: A.est_minutes, c: A.cost });
    ok(B && B.material.grams === 30.55 && B.material.grams_source === "history" && B.material.material === "PETG" && B.material.density === 1.27 && B.material.filament_mm === 10000, "B: 10000 mm of PETG from the history job = 30.55 g (history), density 1.27", B && B.material);
    ok(B && B.seconds === 4800 && B.seconds_source === "history" && B.cost.time_source === "history" && B.history_job === "000002", "B: 4800 s print_duration from the matching (completed, right time) job, not the older cancelled one", B && { s: B.seconds, ss: B.seconds_source, j: B.history_job });
    ok(Cc && Cc.material.grams == null && Cc.seconds == null && Cc.autofill && Cc.autofill.result === "none" && Cc.autofill.still_blank === true, "C: nothing anywhere stays blank and is marked as asked", Cc && Cc.autofill);
    const reqs1 = mock.state.metaRequests.length;
    r = await jpost("/api/costing/backfill", {});
    ok(r.status === 200 && r.body.checked === 1 && r.body.filled === 0 && r.body.requests === 2 && mock.state.metaRequests.length === reqs1 + 1, "a second forced run re-asks only for C (metadata + history, 2 GETs); A and B are settled", { body: r.body, reqs: mock.state.metaRequests.length - reqs1 });
    r = await jget("/api/costing");
    ok(r.status === 200 && r.body.suggested && r.body.suggested.kwh_rate === 0.183 && r.body.suggested.printers.purchase === 849 && r.body.suggested.notes && /EIA/.test(r.body.suggested.notes.kwh_rate), "GET /api/costing carries the suggested values with their notes", r.body.suggested);
    ok(r.body.printer_names[0].hours === 123 && r.body.printer_names[0].type === "u1", "…and each printer's print hours from its history totals (123 h), for the life-hours progress", r.body.printer_names);
    const hdiag = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).filter(m => /costing: backfill/.test(m));
    ok(hdiag.length === 2 && /3 blank rows checked, 2 filled \(1 from printer metadata, 1 from job history\), 1 still blank, 4 GETs/.test(hdiag[0]), "both runs are logged with their counts", hdiag);

    console.log("\n== LIVE: the boot backfill runs once, skips rows already asked about, and the ledger cost uses suggestions only where rates are unset ==");
    await stopHub();
    const lj3 = JSON.parse(fs.readFileSync(path.join(tmp, "prints.json"), "utf8"));
    ok(lj3.prints.find(x => x.id === "pt_B").material.grams === 30.55 && lj3.prints.find(x => x.id === "pt_C").autofill.result === "none", "the fills and the 'asked' marks are on disk", null);
    lj3.prints.push(blank("pt_D", "Backfill D.gcode"));
    fs.writeFileSync(path.join(tmp, "prints.json"), JSON.stringify(lj3));
    mock.state.metadata["Backfill D.gcode"] = { estimated_time: 600, filament_total: 1000, filament_type: "ASA" };
    const reqsC = mock.state.metaRequests.filter(q => q.filename === "Backfill C.gcode").length;
    await startHub(tmp, { U1HUB_COSTING_BACKFILL_BOOT_MS: "500" });
    const D = await waitRow(x => x.id === "pt_D" && x.material.grams != null);
    ok(D && D.material.grams === 2.57 && D.material.grams_source === "printer-meta" && D.material.density === 1.07 && D.est_minutes === 10, "boot backfill filled D: 1000 mm of ASA via filament_total = 2.57 g (density 1.07), 10 min", D && D.material);
    ok(mock.state.metaRequests.filter(q => q.filename === "Backfill C.gcode").length === reqsC, "…and did not ask about C again (already marked 'none'; only a POST retries it)", null);
    rows = (await jget("/api/costing/prints")).body.prints;
    const Dn = rows.find(x => x.id === "pt_D");
    ok(Dn && Dn.cost.machine && Dn.cost.machine.source === "typed" && Dn.cost.energy.source === "watts", "with the earlier typed printer rates and $/kWh, nothing on D is suggested", Dn && Dn.cost);
    r = await jpost("/api/costing/settings", { kwh_rate: "", printers: { "0": { purchase: "", life_hours: "", maint_per_hour: "", avg_watts: "" } } });
    ok(r.status === 200 && r.body.kwh_rate === null && !r.body.printers["0"], "rates unset again", r.body);
    rows = (await jget("/api/costing/prints")).body.prints;
    const Ds = rows.find(x => x.id === "pt_D");
    ok(Ds && Ds.cost.machine && Ds.cost.machine.source === "suggested" && Ds.cost.machine.per_hour === 0.27 && Ds.cost.energy.source === "suggested" && Ds.cost.energy.watts === 150 && Ds.cost.blanks.length === 0, "now every machine/energy line on D is the suggestion and says so: $0.27/h, 150 W", Ds && Ds.cost);
    r = await jpost("/api/costing/settings", { printers: { "0": { avg_watts: 90 } } });
    rows = (await jget("/api/costing/prints")).body.prints;
    const Dt = rows.find(x => x.id === "pt_D");
    ok(r.status === 200 && Dt && Dt.cost.energy.watts === 90 && Dt.cost.energy.watts_source === "typed" && Dt.cost.energy.source === "suggested" && Dt.cost.energy.rate_source === "suggested", "a typed 90 W wins over the suggested 150 W; the $/kWh is still the suggestion, so the line stays labelled suggested", Dt && Dt.cost.energy);
    r = await jpost("/api/costing/settings", { kwh_rate: 0.183, printers: { "0": { purchase: 849, life_hours: 5000, maint_per_hour: 0.1, avg_watts: 150 } } });
    rows = (await jget("/api/costing/prints")).body.prints;
    const Du = rows.find(x => x.id === "pt_D");
    ok(r.status === 200 && Du && Du.cost.machine.source === "typed" && Du.cost.energy.source === "watts" && Du.cost.machine.cost === Ds.cost.machine.cost && Du.cost.energy.cost === Ds.cost.energy.cost, "'use suggested values' = the same numbers saved as real rates: identical costs, now labelled typed", Du && Du.cost);
    await stopHub();

    console.log("\n== LIVE: the Prints list - filters, paging, totals; bulk assign; assign by file name ==");
    // Three printers from here on: the U1 mock, a Kobra S1 (generic Moonraker,
    // its own type and folder) and one that is never reachable.
    const kobra = createMock("generic");
    const portK = await kobra.listen(0);
    fs.mkdirSync(path.join(gcode, "kobra-s1"), { recursive: true });
    const threeConfig = () => fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")),
      types: [{ slug: "u1", label: "U1" }, { slug: "kobra-s1", label: "Kobra S1" }],
      printers: [{ name: "U1-mock", url: URL1, type: "u1" }, { name: "Kobra-mock", url: "http://127.0.0.1:" + portK, type: "kobra-s1" }, { name: "Offline-mock", url: "http://127.0.0.1:9", type: "u1" }] }, null, 2));
    threeConfig();
    await startHub(tmp);
    r = await jget("/api/costing/prints");
    const ALL = r.body.prints;
    ok(r.status === 200 && r.body.total === 7 && ALL.length === 7 && r.body.offset === 0 && r.body.limit === 200 && r.body.ledger_total === 7, "no filters: all 7 rows, total 7, newest first", { total: r.body.total, n: ALL.length });
    ok(ALL.every((x, i) => i === 0 || ALL[i - 1].at >= x.at), "…sorted newest first", ALL.map(x => x.at));
    ok(r.body.facets && r.body.facets.printers.length === 1 && r.body.facets.printers[0].name === "U1-mock" && r.body.facets.types.join() === "u1" && r.body.facets.outcomes.length === 3, "facets list the printers, types and outcomes present in the ledger", r.body.facets);
    r = await jget("/api/costing/prints?limit=3&offset=0");
    const p1 = r.body.prints.map(x => x.id);
    r = await jget("/api/costing/prints?limit=3&offset=3");
    const p2 = r.body.prints.map(x => x.id);
    r = await jget("/api/costing/prints?limit=3&offset=6");
    ok(p1.length === 3 && p2.length === 3 && r.body.prints.length === 1 && r.body.total === 7 && p1.concat(p2, r.body.prints.map(x => x.id)).join() === ALL.map(x => x.id).join(), "paging: 3 + 3 + 1 rows over three pages are the whole list in order, total 7 on every page", { p1, p2, p3: r.body.prints.map(x => x.id) });
    r = await jget("/api/costing/prints?outcome=cancelled");
    ok(r.body.total === 1 && r.body.prints[0].id === cx.id, "outcome=cancelled: the one cancelled row", r.body.total);
    r = await jget("/api/costing/prints?q=" + encodeURIComponent("Backfill*"));
    ok(r.body.total === 4 && r.body.prints.every(x => /^Backfill/.test(x.file)), "q=Backfill*: the four backfill rows (wildcard)", r.body.prints.map(x => x.file));
    r = await jget("/api/costing/prints?q=frog");
    ok(r.body.total === 2, "q=frog: case-insensitive substring, both Frog rows", r.body.total);
    r = await jget("/api/costing/prints?assigned=0");
    ok(r.body.total === 7 && (await jget("/api/costing/prints?assigned=1")).body.total === 0 && (await jget("/api/costing/prints?unassigned=1")).body.total === 7, "assigned=0 / unassigned=1: every row is unassigned since the projects were removed; assigned=1: none", r.body.total);
    r = await jget("/api/costing/prints?printer=0");
    ok(r.body.total === 7 && (await jget("/api/costing/prints?printer=1")).body.total === 0 && (await jget("/api/costing/prints?printer=U1-mock")).body.total === 7 && (await jget("/api/costing/prints?type=kobra-s1")).body.total === 0, "printer by index or name; type: nothing on the Kobra yet", r.body.total);
    const mid = ALL.find(x => x.id === row.id), fromMid = ALL.filter(x => x.at >= mid.at).length;   // the Frog print's timestamp is its own; the three blank rows share one
    r = await jget("/api/costing/prints?from=" + mid.at + "&to=" + (mid.at + 1));
    ok(r.body.total === 1 && r.body.prints[0].id === mid.id && (await jget("/api/costing/prints?from=" + mid.at + "&to=" + mid.at)).body.total === 0, "from/to is [from, to) on the row's own timestamp: one row in, none when to == from", r.body.total);
    r = await jget("/api/costing/prints?from=" + new Date(mid.at).toISOString() + "&source=hub");
    ok(r.body.total === fromMid && r.body.filters.from === mid.at, "from accepts an ISO date too (" + fromMid + " rows from that instant); source=hub keeps the Hub-watched rows (all of them, none imported yet)", { total: r.body.total, from: r.body.filters.from });
    // bulk
    r = await jpost("/api/costing/projects", { name: "Bulk <job>" });
    const P3 = r.body.project.id;
    r = await jpost("/api/costing/prints/bulk", { print_ids: [], project_id: P3 });
    ok(r.status === 400, "KNOWN-BAD bulk with no ids -> 400", r.body);
    r = await jpost("/api/costing/prints/bulk", { print_ids: [row.id], project_id: "pr_nope" });
    ok(r.status === 400, "KNOWN-BAD bulk to an unknown project -> 400", r.body);
    r = await jpost("/api/costing/prints/bulk", { print_ids: [row.id, cx.id, pm.id, "pt_nope"], project_id: P3 });
    ok(r.status === 200 && r.body.updated === 3 && r.body.missing === 1, "bulk assign: 3 rows moved, 1 unknown id reported", r.body);
    r = await jget("/api/costing/prints?project=" + P3);
    ok(r.body.total === 3 && (await jget("/api/costing/prints?assigned=0")).body.total === 4, "project=<id> lists the 3; 4 remain unassigned", r.body.total);
    r = await jpost("/api/costing/prints/bulk", { print_ids: [row.id, cx.id], counted: false });
    ok(r.status === 200 && r.body.updated === 2 && (await jget("/api/costing/prints?project=" + P3)).body.prints.filter(x => x.counted === false).length === 2, "bulk don't-count: 2 rows", r.body);
    r = await jpost("/api/costing/prints/bulk", { print_ids: [row.id, cx.id], counted: true });
    ok(r.body.updated === 2 && (await jget("/api/costing/prints?project=" + P3)).body.prints.every(x => x.counted !== false), "…and counted again", r.body);
    r = await jpost("/api/costing/clients", { name: "Bulk Client" });
    await jpost("/api/costing/projects/update", { id: P3, client_id: r.body.client.id });
    ok((await jget("/api/costing/prints?client=" + r.body.client.id)).body.total === 3 && (await jget("/api/costing/prints?client=cl_nope")).body.total === 0, "client=<id> follows the project's client", null);
    // assign by file name
    r = await jpost("/api/costing/prints/match", { pattern: "", project_id: P3 });
    ok(r.status === 400, "KNOWN-BAD empty pattern -> 400", r.body);
    r = await jpost("/api/costing/prints/match", { pattern: "Backfill", project_id: "pr_nope" });
    ok(r.status === 400, "KNOWN-BAD unknown project -> 400", r.body);
    r = await jpost("/api/costing/prints/match", { pattern: "backfill *", project_id: P3 });
    ok(r.status === 200 && r.body.preview === true && r.body.matched === 4 && r.body.sample.length === 4 && (await jget("/api/costing/prints?project=" + P3)).body.total === 3, "preview: 4 unassigned rows match 'backfill *' (case-insensitive, wildcard); nothing changed", r.body);
    r = await jpost("/api/costing/prints/match", { pattern: "backfill *", project_id: P3, apply: true });
    ok(r.status === 200 && r.body.applied === 4 && (await jget("/api/costing/prints?project=" + P3)).body.total === 7, "apply: the 4 join the project (7 now)", r.body);
    r = await jpost("/api/costing/prints/match", { pattern: "backfill *", project_id: P3 });
    ok(r.body.matched === 0, "a second preview finds nothing left to move", r.body);
    r = await jpost("/api/costing/prints/match", { pattern: "Backfill A", project_id: null, only_unassigned: false, apply: true });
    ok(r.status === 200 && r.body.applied === 1 && (await jget("/api/costing/prints?assigned=0")).body.total === 1, "only_unassigned:false with project null unassigns the one that matches", r.body);

    console.log("\n== LIVE: importing every printer's job history - paged, paced, deduped against Hub rows, idempotent, offline skipped ==");
    const nowS = Math.floor(Date.now() / 1000);
    const doneRow = (await jget("/api/costing/prints?q=" + encodeURIComponent("Frog x10") + "&outcome=done")).body.prints[0];
    // Seven jobs on the U1 (newest first), older than the two-minute settle
    // window except where the test wants them skipped:
    //   j7 in_progress (skipped), j6 completed but ended within the settle window (skipped until it is older),
    //   j5 = the Frog print the Hub watched (matched to its row, not added),
    //   j4 klippy_shutdown, j3 interrupted, j2 cancelled at 25% of its estimate (scaled grams), j1 completed (weight from metadata).
    mock.state.history = [
      { job_id: "000017", filename: "Live.gcode", status: "in_progress", start_time: nowS - 300, end_time: null, print_duration: 200, total_duration: 300, filament_used: 100, metadata: {} },
      { job_id: "000016", filename: "Fresh.gcode", status: "completed", start_time: nowS - 400, end_time: nowS, print_duration: 380, total_duration: 390, filament_used: 500, metadata: { filament_type: "PLA" } },
      { job_id: "000015", filename: FILE, status: "completed", start_time: Math.floor(doneRow.at / 1000) - 3660, end_time: Math.floor(doneRow.at / 1000) - 60, print_duration: 3600, total_duration: 3600, filament_used: 9000, metadata: { filament_type: "PLA;PLA;PLA;PLA" } },
      { job_id: "000014", filename: "gcodes/Shut.gcode", status: "klippy_shutdown", start_time: nowS - 86400 - 600, end_time: nowS - 86400, print_duration: 500, total_duration: 600, filament_used: 1000, metadata: { filament_type: "PETG" } },
      { job_id: "000013", filename: "Interrupted.gcode", status: "interrupted", start_time: nowS - 90000, end_time: nowS - 89000, print_duration: 0, total_duration: 1000, filament_used: 0, metadata: {} },
      { job_id: "000012", filename: "Quarter x2.gcode", status: "cancelled", start_time: nowS - 172800, end_time: nowS - 172800 + 900, print_duration: 900, total_duration: 900, filament_used: 7000, metadata: { estimated_time: 3600, filament_weight_total: 80, filament_type: "PLA" } },
      { job_id: "000011", filename: "Oldest.gcode", status: "completed", start_time: nowS - 259200, end_time: nowS - 259200 + 7200, print_duration: 7000, total_duration: 7200, filament_used: 40361.57, metadata: { estimated_time: 7100, filament_weight_total: 120.38, filament_type: "PLA" } }
    ];
    kobra.state.history = [
      { job_id: "000002", filename: "Kobra B.gcode", status: "error", start_time: nowS - 7200, end_time: nowS - 3600, print_duration: 3000, total_duration: 3600, filament_used: 2000, metadata: { filament_type: "ASA" } },
      { job_id: "000001", filename: "Kobra A.gcode", status: "completed", start_time: nowS - 200000, end_time: nowS - 196400, print_duration: 3500, total_duration: 3600, filament_used: 12000, metadata: { estimated_time: 3550, filament_weight_total: 35.5, filament_type: "PETG" } }
    ];
    mock.state.historyRequests.length = 0; kobra.state.historyRequests.length = 0;
    for (let i = 0; i < 60; i++) { const f = (await jget("/api/fleet")).body || []; if (f[2] && f[2].online === false && f[1] && f[1].online) break; await sleep(250); }
    r = await jget("/api/costing/import");
    ok(r.status === 200 && r.body.running === false && r.body.last === null && r.body.page === 3 && r.body.boot_ms === 0 && r.body.interval_ms === 0 && r.body.settle_ms === 5000, "GET /api/costing/import: nothing has run (boot and hourly runs are off under test; 5 s settle window)", r.body);
    mock.state.history[1].end_time = Math.floor(Date.now() / 1000);     // Fresh ended this second: inside the 5 s settle window by construction
    const t1 = Date.now();
    r = await jpost("/api/costing/import", {});
    const ms1 = Date.now() - t1;
    const im = r.body;
    ok(r.status === 200 && im.imported === 6 && im.matched === 1 && im.known === 0 && im.skipped === 2 && im.errors === 0, "first import: 6 rows added (4 U1 + 2 Kobra), 1 matched to the Frog print the Hub watched, 2 skipped (in progress, settling)", im);
    const pu = im.printers.find(p => p.name === "U1-mock"), pk = im.printers.find(p => p.name === "Kobra-mock"), po = im.printers.find(p => p.name === "Offline-mock");
    ok(pu && pu.status === "ok" && pu.pages === 3 && pu.seen === 7 && pu.imported === 4 && pu.matched === 1 && pu.skipped === 2, "U1: 7 jobs over 3 pages of 3", pu);
    ok(pk && pk.status === "ok" && pk.type === "kobra-s1" && pk.pages === 1 && pk.seen === 2 && pk.imported === 2, "Kobra (a generic Moonraker, its own type): 2 jobs on 1 page", pk);
    ok(po && po.status === "offline" && im.offline.join() === "Offline-mock" && po.pages === 0, "the unreachable printer is skipped as offline, nothing asked of it", po);
    ok(mock.state.historyRequests.map(q => q.start + "/" + q.limit + "/" + q.order).join(" ") === "0/3/desc 3/3/desc 6/3/desc", "the U1 was paged with start=0,3,6 limit=3 newest first", mock.state.historyRequests);
    ok(im.requests === 4 && im.pages === 4 && im.pause_ms === PAUSE_MS && im.min_gap_ms >= PAUSE_MS - 2 && ms1 >= 3 * PAUSE_MS - 2, "4 paced GETs: smallest gap " + im.min_gap_ms + " ms (pause " + PAUSE_MS + "), " + ms1 + " ms in all", { requests: im.requests, min_gap: im.min_gap_ms, ms: ms1 });
    rows = (await jget("/api/costing/prints?limit=100")).body.prints;
    ok(rows.length === 13 && rows.every((x, i) => i === 0 || rows[i - 1].at >= x.at), "the ledger has 13 rows, still newest first after the merge", rows.map(x => x.file + "@" + x.at));
    const byJob = j => rows.find(x => x.history_job === j && x.printer_id === 0);
    const fr = rows.find(x => x.id === doneRow.id);
    ok(fr && fr.history_job === "000015" && fr.history_status === "completed" && fr.source !== "history" && fr.seconds === 3600 && fr.seconds_source === "actual" && fr.material.grams === 25.7 && rows.filter(x => x.file === FILE).length === 2,
      "the Frog print the Hub watched kept its row (actual seconds, slicer grams), gained the job id; no duplicate was added", fr && { job: fr.history_job, s: fr.seconds, g: fr.material.grams });
    let j = byJob("000011");
    ok(j && j.source === "history" && j.outcome === "done" && j.file === "Oldest.gcode" && j.at === (nowS - 259200 + 7200) * 1000 && j.seconds === 7000 && j.seconds_source === "history" && j.est_minutes === 118 && j.est_source === "printer-meta" && j.type === "u1",
      "a completed job: outcome done, at = end_time, 7000 s (history), 118 min estimate (printer-meta), type u1", j);
    ok(j && j.material.grams === 120.38 && j.material.grams_source === "printer-meta" && j.material.material === "PLA" && j.material.partial === false && j.cost.material.cost === 2.41 && j.cost.time_source === "history", "…grams from the job's metadata weight (120.38 g), priced at the flat $/g", j && j.material);
    j = byJob("000012");
    ok(j && j.outcome === "cancelled" && j.file === "Quarter x2.gcode" && j.pieces === 2 && j.material.progress === 0.25 && j.material.grams === 20 && j.material.grams_source === "printer-meta" && j.material.partial === true,
      "a cancelled job at 900 of 3600 estimated seconds: 25% of the file's 80 g = 20 g, partial, pieces from the name", j && j.material);
    j = byJob("000013");
    ok(j && j.outcome === "error" && j.history_status === "interrupted" && j.seconds === null && j.material.grams === null && j.counted === true, "interrupted -> error; nothing printed leaves time and grams blank", j);
    j = byJob("000014");
    ok(j && j.outcome === "error" && j.history_status === "klippy_shutdown" && j.file === "Shut.gcode" && j.material.grams === 3.05 && j.material.grams_source === "history" && j.material.material === "PETG" && j.material.density === 1.27,
      "klippy_shutdown -> error; the file name loses its gcodes/ folder; no estimate to scale, so 1000 mm of PETG = 3.05 g (history)", j && j.material);
    ok(!rows.some(x => x.history_job === "000016" || x.history_job === "000017"), "the in-progress job and the one that ended seconds ago are not in the ledger", rows.map(x => x.history_job));
    const kb = rows.filter(x => x.printer_id === 1);
    ok(kb.length === 2 && kb.every(x => x.type === "kobra-s1" && x.printer === "Kobra-mock" && x.source === "history"), "the Kobra's two jobs carry its type and name", kb.map(x => ({ t: x.type, p: x.printer })));
    const ka = kb.find(x => x.history_job === "000001"), kbb = kb.find(x => x.history_job === "000002");
    ok(ka && ka.outcome === "done" && ka.material.grams === 35.5 && ka.seconds === 3500 && ka.cost.machine && ka.cost.machine.source === "suggested" && ka.cost.machine.per_hour === 0.08 && ka.cost.energy === null, "Kobra A: 35.5 g, 3500 s; costed with the Kobra S1 suggestion (depreciation only) and no energy", ka && ka.cost);
    ok(kbb && kbb.outcome === "error" && kbb.history_status === "error" && kbb.material.grams === 5.15 && kbb.material.material === "ASA" && kbb.material.density === 1.07, "Kobra B: error; 2000 mm of ASA = 5.15 g", kbb && kbb.material);
    r = await jget("/api/costing/projects");
    ok(r.body.imported_rows === 6 && r.body.import.last && r.body.import.last.imported === 6 && r.body.unassigned_total === 7, "the tab's view counts 6 imported rows and shows the last import; the new rows are unassigned", { imported: r.body.imported_rows, un: r.body.unassigned_total });
    ok((await jget("/api/costing/prints?source=history")).body.total === 6 && (await jget("/api/costing/prints?type=kobra-s1")).body.total === 2 && (await jget("/api/costing/prints?printer=1")).body.total === 2, "source=history, type=kobra-s1 and printer=1 filter the imported rows", null);
    // idempotent: a second run reads one page per online printer and adds nothing
    // (Fresh is made in-progress first, so its settle window cannot decide this)
    mock.state.history[1].status = "in_progress";
    mock.state.historyRequests.length = 0;
    r = await jpost("/api/costing/import", {});
    const wantImp = FALSIFY ? 1 : 0;
    ok(r.status === 200 && r.body.imported === wantImp && r.body.matched === 0 && r.body.known === 3 && r.body.pages === 2 && mock.state.historyRequests.length === 1, "a second run imports " + wantImp + ": the first page of each printer is already known, so it stops there (2 GETs)" + (FALSIFY ? " [FALSIFIED]" : ""), r.body);
    ok((await jget("/api/costing/prints?limit=100")).body.total === 13, "…and the ledger is still 13 rows", null);
    r = await jpost("/api/costing/import", { full: true });
    ok(r.body.imported === 0 && r.body.pages === 4 && r.body.known === 7, "a full run pages to the end (3 + 1) and still adds nothing", r.body);
    const hlog2 = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).filter(m => /costing: import/.test(m));
    ok(hlog2.length === 3 && /6 jobs imported, 1 matched to rows the Hub watched, 0 already known, 2 skipped, offline: Offline-mock; 4 GETs over 4 pages/.test(hlog2[0]), "every run is logged with its counts", hlog2);
    // the settled job comes in once it has finished and is older than the settle window
    mock.state.history[1].status = "completed"; mock.state.history[1].end_time = nowS - 900; mock.state.history[1].start_time = nowS - 1300;
    r = await jpost("/api/costing/import", {});
    ok(r.body.imported === 1 && byJob("000016") === undefined && (await jget("/api/costing/prints?q=Fresh")).body.total === 1, "a job that had been settling is imported on the next run", r.body);

    console.log("\n== LIVE: the boot import runs after the backfill; the ledger cap drops the oldest rows ==");
    await stopHub();
    const before14 = JSON.parse(fs.readFileSync(path.join(tmp, "prints.json"), "utf8")).prints;
    ok(before14.length === 14 && before14.every((x, i) => i === 0 || before14[i - 1].at <= x.at), "on disk: 14 rows in time order", before14.length);
    const oldestTwo = before14.slice(0, 2).map(x => x.id);
    kobra.state.history.unshift(
      { job_id: "000004", filename: "Kobra D.gcode", status: "completed", start_time: nowS - 1000, end_time: nowS - 700, print_duration: 280, total_duration: 300, filament_used: 300, metadata: {} },
      { job_id: "000003", filename: "Kobra C.gcode", status: "completed", start_time: nowS - 2000, end_time: nowS - 1700, print_duration: 280, total_duration: 300, filament_used: 300, metadata: {} });
    await startHub(tmp, { U1HUB_COSTING_IMPORT_BOOT_MS: "500", U1HUB_COSTING_LEDGER_MAX: "15" });
    let last = null;
    for (let i = 0; i < 80; i++) { last = (await jget("/api/costing/import")).body.last; if (last) break; await sleep(250); }
    ok(last && last.imported === 2 && last.dropped === 1, "the boot import (500 ms, no backfill boot) brought the Kobra's 2 new jobs and dropped 1 row at the 15-row cap", last);
    const after15 = (await jget("/api/costing/prints?limit=100")).body;
    ok(after15.total === 15 && after15.ledger_max === 15 && !after15.prints.some(x => x.id === oldestTwo[0]) && after15.prints.some(x => x.id === oldestTwo[1]), "15 rows remain; the oldest row went, the next oldest stayed", { total: after15.total, gone: oldestTwo[0] });
    ok(after15.prints.filter(x => x.printer_id === 1).length === 4 && after15.facets.printers.length === 2 && after15.facets.types.join() === "kobra-s1,u1", "the Kobra has 4 rows; the facets now list both printers and types", after15.facets);

    console.log("\n== LIVE: reports over the API, CSV and the printable page ==");
    r = await jget("/api/costing/report?group_by=nonsense");
    ok(r.status === 400, "KNOWN-BAD unknown group_by -> 400", r.body);
    r = await jget("/api/costing/report?group_by=printer");
    const gU = r.body.groups.find(g => g.label === "U1-mock"), gK = r.body.groups.find(g => g.label === "Kobra-mock");
    ok(r.status === 200 && r.body.aligned === false && r.body.groups.length === 2 && gU && gU.prints === 11 && gK && gK.prints === 4 && r.body.totals.prints === 15, "by printer: U1-mock 11, Kobra-mock 4, 15 in all", r.body.groups.map(g => g.label + ":" + g.prints));
    r = await jget("/api/costing/report?group_by=type");
    ok(r.body.groups.map(g => g.label + ":" + g.prints).sort().join("|") === "kobra-s1:4|u1:11", "by type: u1 11, kobra-s1 4", r.body.groups.map(g => g.label));
    r = await jget("/api/costing/report?group_by=client");
    const gB = r.body.groups.find(g => g.label === "Bulk Client");
    ok(r.body.aligned === true && gB && gB.prints === 6 && gB.projects === 1 && r.body.groups.find(g => g.label === "(no project)").prints === 9, "by client: Bulk Client's project holds 6 prints; 9 have no project", r.body.groups.map(g => g.label + ":" + g.prints));
    const sumDirect = r2(r.body.groups.reduce((a, g) => a + (g.direct || 0), 0));
    ok(r.body.totals.direct === sumDirect && r.body.totals.prints === 15, "totals are the sum of the groups (direct " + sumDirect + ")", { tot: r.body.totals.direct, sum: sumDirect });
    const lo = Math.min(...after15.prints.map(x => x.at)), hi = Math.max(...after15.prints.map(x => x.at));
    r = await jget("/api/costing/report?group_by=outcome&from=" + lo + "&to=" + hi);
    ok(r.body.rows === 14 && r.body.from === lo && r.body.to === hi, "from/to on the ledger's own edges: [oldest, newest) leaves the newest row out (14 of 15)", { rows: r.body.rows });
    const rc = await fetch(HUB + "/api/costing/report.csv?group_by=printer");
    const rcB = Buffer.from(await rc.arrayBuffer()), rcT = rcB.toString("utf8").replace(/^﻿/, "");
    const rcL = rcT.split("\r\n").filter(Boolean);
    ok(rc.status === 200 && /text\/csv/.test(rc.headers.get("content-type")) && rcB[0] === 0xef && /cost-report-by-printer-/.test(rc.headers.get("content-disposition")) && rcL[0].startsWith("group,prints,done,failed,") && rcL.length === 1 + 2 + 1 && rcL[3].startsWith("TOTAL,15,"), "report CSV: BOM, attachment name, header, 2 groups + TOTAL", rcL);
    const rp = await fetch(HUB + "/api/costing/report/print?group_by=client");
    const rpT = await rp.text();
    ok(rp.status === 200 && /text\/html/.test(rp.headers.get("content-type")) && rpT.includes("Bulk &lt;job&gt;") === false && rpT.includes("Bulk Client") && rpT.includes("Cost report by client") && !/<script/.test(rpT), "the printable report page answers as HTML, named by client, no script", null);
    const rp2 = await (await fetch(HUB + "/api/costing/report/print?group_by=project")).text();
    ok(rp2.includes("Bulk &lt;job&gt;") && !rp2.includes("Bulk <job>"), "…and by project the hostile project name is escaped", null);
    ok((await fetch(HUB + "/api/costing/report/print?group_by=nonsense")).status === 400, "KNOWN-BAD unknown grouping on the page -> 400", null);
    await stopHub();
    try { await kobra.close(); } catch {}
    writeConfig(tmp, gcode, portU1, null);

    console.log("\n== OFF and LITE ==");
    writeConfig(tmp, gcode, portU1, { costing: false });
    await startHub(tmp);
    r = await jget("/api/costing");
    ok(r.status === 404, "costing off: its API is absent", r.status);
    page = await (await fetch(HUB + "/")).text();
    ok(!page.includes("/modules/costing-ui.js"), "costing off: its client script is not injected");
    await stopHub();
    writeConfig(tmp, gcode, portU1, null);
    await startHub(tmp, { U1HUB_PROFILE: "lite" });
    cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features.costing === false, "Lite: costing is off", cfg.features);
    ok((await jget("/api/costing")).status === 404, "Lite: its API is absent");
  } catch (e) {
    fail++; console.log("  FAIL (threw) " + (e && e.stack || e));
  } finally {
    await stopHub();
    try { await mock.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_COSTING_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
})();
