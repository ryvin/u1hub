// test/printer-sync-standalone.js — fork module (ryvin/u1hub): printer-sync and
// library-colors, kept out of run-tests.js so the fork's diff against upstream
// stays two table lines and a mock route (docs/FORK.md).
//
// Boots the real server.js from this checkout against one mock U1, with an
// isolated U1HUB_DIR, and drives printer-sync through POST
// /api/printer-sync/run so every assertion follows a pass the test started,
// never a timer (CLAUDE.md rule 7). Printing/idle checks wait on what
// /api/fleet reports, because that snapshot is what the module consults.
//
// Run: node test/printer-sync-standalone.js   (part of npm run test:standalone)
// Rule 6 evidence: U1HUB_SYNC_FALSIFY=1 flips the busy expectation; the run
// must then go red.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMock } = require("./mock-moonraker.js");

const REPO = path.join(__dirname, "..");
const PORT = 45980;
const HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_SYNC_FALSIFY === "1";

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(p) { const r = await fetch(HUB + p); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function jpost(p, b) {
  const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
}

let CHILD = null, LOG = "";
async function startHub(dir) {
  CHILD = spawn(process.execPath, ["server.js"], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_POLL_MS: "400",
           U1HUB_SYNC_MS: "3600000", U1HUB_SYNC_PAUSE_MS: "0", U1HUB_PROFILE: "" }
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-psync-"));
  const gcode = path.join(tmp, "gcode");
  fs.mkdirSync(gcode, { recursive: true });
  fs.writeFileSync(path.join(gcode, "already.gcode"), "; already in the library\nG28\n");
  const mock = createMock("u1");
  const portU1 = await mock.listen(0);

  try {
    console.log("\n== DEFAULTS: fork features and their switches ==");
    writeConfig(tmp, gcode, portU1, null);
    await startHub(tmp);
    let cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features["printer-sync"] === false, "printer-sync ships off (no live hardware gate yet)", cfg.features);
    ok(cfg.features && cfg.features["library-colors"] === true, "library-colors ships on", cfg.features);
    let r = await jget("/api/printer-sync");
    ok(r.status === 404, "printer-sync off: its API is absent", r.status);
    let page = await (await fetch(HUB + "/")).text();
    ok(page.includes("/modules/library-colors-ui.js"), "library-colors on: its client script is injected");
    const ui = await fetch(HUB + "/modules/library-colors-ui.js");
    ok(ui.ok, "the client module file is served", ui.status);
    await stopHub();

    console.log("\n== LITE: the fork features stay out of the Lite profile ==");
    CHILD = spawn(process.execPath, ["server.js"], {
      cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, U1HUB_DIR: tmp, U1HUB_PORT: String(PORT), U1HUB_PROFILE: "lite" }
    });
    for (let i = 0; i < 80; i++) { await sleep(250); try { if ((await fetch(HUB + "/api/version")).ok) break; } catch {} }
    cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features["printer-sync"] === false && cfg.features["library-colors"] === false,
      "Lite: printer-sync and library-colors are off", cfg.features);
    page = await (await fetch(HUB + "/")).text();
    ok(!page.includes("/modules/library-colors-ui.js"), "Lite: the library-colors script is not injected");
    await stopHub();

    console.log("\n== SYNC: new printer files copy themselves into the library ==");
    writeConfig(tmp, gcode, portU1, { "printer-sync": true, "library-colors": false });
    await startHub(tmp);
    cfg = (await jget("/api/config")).body || {};
    ok(cfg.features["printer-sync"] === true, "config switches printer-sync on", cfg.features);
    const hlog = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).join("\n");
    ok(hlog.includes("printer-sync (ryvin/u1hub fork module) armed"), "Hub log names the fork module");
    r = await jget("/api/printer-sync");
    ok(r.status === 200 && r.body.fork === "ryvin/u1hub", "GET /api/printer-sync identifies the fork", r.body);

    const fleetState = async () => { const f = (await jget("/api/fleet")).body || []; const p = f.find(x => x.id === 0); return p ? p.state : "absent"; };
    const waitState = async want => { let st = null; for (let i = 0; i < 60; i++) { st = await fleetState(); if (st === want) break; await sleep(250); } return st; };
    const data = Buffer.from("; synced by printer-sync\nG28\nG1 X10\n");
    const arrived = path.join(gcode, "arrived_on_printer.gcode");

    mock.state.printState = "printing";
    mock.state.files.push({ name: "arrived_on_printer.gcode", size: data.length, data });
    ok(await waitState("printing") === "printing", "fleet reports the U1 printing");
    r = await jpost("/api/printer-sync/run", {});
    const leftAlone = r.status === 200 && r.body.busy.includes("U1-mock") && !fs.existsSync(arrived);
    ok(FALSIFY ? !leftAlone : leftAlone, "a printing printer is left alone: listed as busy, nothing copied", r.body);

    mock.state.printState = "standby";
    ok(await waitState("standby") === "standby", "fleet reports the U1 idle again");
    r = await jpost("/api/printer-sync/run", {});
    ok(r.status === 200 && r.body.copied.includes("arrived_on_printer.gcode"), "idle: the new printer file is copied", r.body);
    ok(fs.existsSync(arrived) && fs.readFileSync(arrived).equals(data), "the library copy is byte-identical to the printer's");
    ok(!fs.existsSync(arrived + ".part"), "no .part file is left behind");
    r = await jget("/api/files");
    ok(r.body && r.body.files.some(f => f.name === "arrived_on_printer.gcode"), "the copied file is a real library row");
    r = await jpost("/api/printer-sync/run", {});
    ok(r.status === 200 && r.body.copied.length === 0, "a second pass copies nothing: the library already has it", r.body);

    // never overwrite
    const clash = path.join(gcode, "clash.gcode");
    fs.writeFileSync(clash, "; local version\n");
    mock.state.files.push({ name: "clash.gcode", size: 5, data: Buffer.from("12345") });
    r = await jpost("/api/printer-sync/run", {});
    ok(fs.readFileSync(clash, "utf8") === "; local version\n" && r.body.skipped.includes("clash.gcode"),
      "same name, different bytes: the library copy is untouched and the file is reported skipped", r.body);
    r = await jpost("/api/printer-sync/run", {});
    ok(r.body.skipped.length === 0, "the skip is reported once, not on every pass", r.body);

    // a copy whose length disagrees with the listing is discarded
    const short = path.join(gcode, "short.gcode");
    mock.state.files.push({ name: "short.gcode", size: 999, data: Buffer.from("tiny") });
    await jpost("/api/printer-sync/run", {});
    const stat = (await jget("/api/printer-sync")).body;
    ok(!fs.existsSync(short) && !fs.existsSync(short + ".part") && stat.errors.some(e => e.name === "short.gcode"),
      "a copy whose byte count disagrees with the listing is discarded and logged", stat.errors);
    ok(stat.synced.some(x => x.name === "arrived_on_printer.gcode" && x.printer === "U1-mock"), "/api/printer-sync lists what it copied and from where");
    ok(stat.skipped["clash.gcode"] && /different file/.test(stat.skipped["clash.gcode"].reason), "/api/printer-sync explains the skip");

    // subfolders stay on the printer
    mock.state.files.push({ name: "sub/inner.gcode", size: 4, data: Buffer.from("G28\n") });
    await jpost("/api/printer-sync/run", {});
    ok(!fs.existsSync(path.join(gcode, "inner.gcode")) && !fs.existsSync(path.join(gcode, "sub")), "files in printer subfolders are ignored");

    // offline printer: nothing attempted
    await mock.close();
    for (let i = 0; i < 60; i++) { const f = (await jget("/api/fleet")).body || []; if (f[0] && !f[0].online) break; await sleep(250); }
    r = await jpost("/api/printer-sync/run", {});
    ok(r.status === 200 && r.body.offline.includes("U1-mock") && r.body.copied.length === 0, "an offline printer is listed as offline, nothing copied", r.body);
    page = await (await fetch(HUB + "/")).text();
    ok(!page.includes("/modules/library-colors-ui.js"), "library-colors off: its client script is not injected");
  } catch (e) {
    fail++; console.log("  FAIL (threw) " + (e && e.stack || e));
  } finally {
    await stopHub();
    try { await mock.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_SYNC_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
})();
