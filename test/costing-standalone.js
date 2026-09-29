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
// Run: node test/costing-standalone.js   (part of npm run test:standalone)
// Rule 6 evidence: U1HUB_COSTING_FALSIFY=1 flips the actual-seconds
// expectation on the ledger row; the run must then go red.

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
           U1HUB_SYNC_MS: "3600000", U1HUB_PROFILE: "", ...(extraEnv || {}) }
  });
  CHILD.stdout.on("data", d => LOG += d);
  CHILD.stderr.on("data", d => LOG += d);
  for (let i = 0; i < 80; i++) {
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
  ok(c.machine && c.machine.per_hour === 0.32 && c.machine.cost === 0.32 && c.machine.source === "depreciation+maintenance", "machine: 1099/5000 + 0.10 = $0.32/h over 1 h", c.machine);
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
  ok(c.machine && c.machine.source === "depreciation" && c.machine.per_hour === 0.22, "…depreciation alone when no maintenance reserve is set", c.machine);
  c = C.costOf(B, {});
  ok(c.material.cost === null && c.machine === null && c.energy === null && c.direct === null && c.blanks.length === 3, "no rates at all: every line blank, direct null, three blanks named", c);
  c = C.costOf({ material: { grams: 10, source: "slicer", slicer_cost: 0.5 } }, {});
  ok(c.material.cost === 0.5 && c.material.source === "slicer", "the slicer's own filament cost is the last fallback", c.material);
  c = C.costOf({ printer_id: 0, seconds: 3600, energy: { kwh: 0.8, source: "metered" } }, R);
  ok(c.energy.kwh === 0.8 && c.energy.cost === 0.13 && c.energy.source === "metered", "a metered kWh on the row beats the typed watts (the v2 hook)", c.energy);

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
    await stopHub();

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
