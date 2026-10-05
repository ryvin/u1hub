// test/bl2u1-standalone.js — fork module (ryvin/u1hub): Convert to U1 via the
// owner's bl2u1 converter (modules/bl2u1.js).
//
// Pure path mapping, then the real server.js against a mock bl2u1 (its
// /settings and /convert-file, shaped like bl2u1's app.py), proving: the card's
// models-relative path reaches bl2u1 as the host path it mounts; the answer is
// in the shape models-ui.js renders; "already converted" is a 409 that names
// the copy; a non-Bambu file and an unreachable bl2u1 both fall through to
// upstream's template convert (which, with no template, answers its own 409).
//
// Run: node test/bl2u1-standalone.js   (part of npm run test:standalone)
// Rule 6: U1HUB_BL2U1_FALSIFY=1 expects the wrong host path; the run must go red.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
const PORT = 45975;
const HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_BL2U1_FALSIFY === "1";
const B = require(path.join(REPO, "modules", "bl2u1.js"));

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
  CHILD = spawn(process.execPath, ["server.js"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_PROFILE: "", U1HUB_SYNC_MS: "3600000" } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  for (let i = 0; i < 240; i++) {   // up to 60 s: a boot from a /mnt Windows mount measured 12.9 s
    await sleep(250);
    try { if ((await fetch(HUB + "/api/version")).ok) return; } catch {}
    if (CHILD.exitCode !== null) throw new Error("hub exited early:\n" + LOG);
  }
  throw new Error("hub never came up:\n" + LOG);
}
async function stopHub() { if (!CHILD) return; CHILD.kill("SIGTERM"); await new Promise(r => { CHILD.on("exit", r); setTimeout(r, 2000); }); CHILD = null; }

// A bl2u1 stand-in: GET /settings, POST /convert-file {filepath}. Bambu files
// are the ones whose name contains "bambu"; converting writes nothing (the
// Hub never reads the output), it only answers like bl2u1 does.
function mockBl2u1(outFolder) {
  const state = { calls: [], converted: new Set() };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && req.url === "/settings") return send(200, { auto_detect: true, delete_duplicates: true, output_folder: outFolder, source_folder: "/mnt/e/Downloads" });
      if (req.method === "POST" && req.url === "/convert-file") {
        const fp = (JSON.parse(body || "{}")).filepath;
        state.calls.push(fp);
        if (/missing/i.test(fp)) return send(404, { error: "File not found" });
        if (!/bambu/i.test(fp)) return send(200, { error: "Not a Bambu Lab file", skipped: true });
        if (state.converted.has(fp)) return send(200, { skipped: true, reason: "Already converted" });
        state.converted.add(fp);
        return send(200, { success: true, output_filename: path.basename(fp).replace(/\.3mf$/i, "") + "_U1.3mf", filaments: /seven/i.test(fp) ? 7 : 3 });
      }
      send(404, { error: "no route" });
    });
  });
  return { state, listen: () => new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port))), close: () => new Promise(r => srv.close(r)) };
}

(async () => {
  console.log("\n== PURE: models-relative path <-> the host path bl2u1 mounts ==");
  const R = B.DEFAULT_ROOTS;
  ok(B.toHost("Yosh/Dragon/Dragon.3mf", R) === "/mnt/e/3d/Yosh/Dragon/Dragon.3mf", "a file under the models root maps to /mnt/e/3d", B.toHost("Yosh/Dragon/Dragon.3mf", R));
  ok(B.toHost("downloads/Cat.3mf", R) === "/mnt/e/Downloads/Cat.3mf" && B.toHost("Downloads/Cat.3mf", R) === "/mnt/e/Downloads/Cat.3mf", "downloads/ (any case) maps to /mnt/e/Downloads, the longer root wins", B.toHost("Downloads/Cat.3mf", R));
  ok(B.toHost("../etc/passwd", R) === null && B.toHost("a/../../x.3mf", R) === null && B.toHost("", R) === null, "climbing out of the root is refused", null);
  ok(B.toRel("/mnt/e/3D/converted_u1/Dragon_U1.3mf", R) === "converted_u1/Dragon_U1.3mf", "bl2u1's /mnt/e/3D output maps back case-insensitively to a models-relative path", B.toRel("/mnt/e/3D/converted_u1/Dragon_U1.3mf", R));
  ok(B.toRel("/mnt/e/Downloads/x_U1.3mf", R) === "downloads/x_U1.3mf" && B.toRel("/mnt/c/elsewhere/x.3mf", R) === null, "an output outside every root has no models path", null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-bl2u1-"));
  const models = path.join(tmp, "models"); fs.mkdirSync(path.join(models, "Yosh", "Dragon"), { recursive: true });
  fs.writeFileSync(path.join(models, "Yosh", "Dragon", "Bambu Dragon.3mf"), "PK fake");
  fs.writeFileSync(path.join(models, "Yosh", "Dragon", "Plain Dragon.3mf"), "PK fake");
  const mock = mockBl2u1("/HOST/3D/converted_u1");
  const mport = await mock.listen();
  const writeConfig = (extra) => fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: path.join(tmp, "gcode"), port: PORT, printers: [],
    models: { folder: models }, bl2u1: { url: "http://127.0.0.1:" + mport, roots: [{ rel: "", host: "/HOST/3d/" }] }, ...(extra || {}) }, null, 2));
  try {
    console.log("\n== LIVE: Convert to U1 goes to bl2u1 ==");
    writeConfig();
    await startHub(tmp);
    let r = await jget("/api/bl2u1");
    ok(r.status === 200 && r.body.reachable === true && r.body.output_rel === "converted_u1", "GET /api/bl2u1: reachable, and its output folder is inside the models root (converted_u1)", r.body);
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Dragon.3mf" });
    const want = FALSIFY ? "/HOST/3d/Bambu Dragon.3mf" : "/HOST/3d/Yosh/Dragon/Bambu Dragon.3mf";
    ok(mock.state.calls[0] === want, "bl2u1 was asked for the host path it mounts" + (FALSIFY ? " [FALSIFIED]" : ""), mock.state.calls);
    ok(r.status === 200 && r.body.ok === true && r.body.converter === "bl2u1" && r.body.rel === "converted_u1/Bambu Dragon_U1.3mf" && r.body.from === "Yosh/Dragon/Bambu Dragon.3mf",
      "the answer names the copy as a models path (converted_u1/...), in the shape the card renders", r.body);
    ok(Array.isArray(r.body.notes) && /bl2u1/.test(r.body.notes[0]) && Array.isArray(r.body.mismatched) && r.body.over4 === 0, "…with a note saying bl2u1 did it, and the fields models-ui.js reads", r.body.notes);
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Dragon.3mf" });
    ok(r.status === 409 && r.body.exists === true && r.body.rel === "converted_u1/Bambu Dragon_U1.3mf" && /Already converted by bl2u1/.test(r.body.error), "the same file again: 409 'already converted', naming the copy (the card offers to open it)", r.body);
    const before = mock.state.calls.length;
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Plain Dragon.3mf" });
    ok(mock.state.calls.length === before + 1 && r.status === 409 && r.body.converter === undefined && /U1 template/.test(r.body.error || ""), "a non-Bambu file is not bl2u1's job: upstream's template convert answers (409, no template here)", r.body);
    fs.writeFileSync(path.join(models, "Yosh", "Dragon", "Bambu Missing.3mf"), "PK fake");
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Missing.3mf" });
    ok(r.status === 409 && r.body.converter === undefined && /U1 template/.test(r.body.error || ""), "bl2u1 cannot see the file at the mapped path (404 File not found): upstream's template convert answers, not an error", r.body);
    const hlog = (((await jget("/api/diagnostics?logs=0")).body || {}).log || []).map(x => x.msg).join("\n");
    ok(/bl2u1 \(ryvin\/u1hub fork module\) armed/.test(hlog) && /bl2u1: converted Yosh\/Dragon\/Bambu Dragon\.3mf -> converted_u1\/Bambu Dragon_U1\.3mf \(3 filaments\)/.test(hlog), "the Hub log names the module and the conversion", null);
    await stopHub();

    console.log("\n== LIVE: bl2u1 unreachable -> the template convert, unchanged ==");
    writeConfig({ bl2u1: { url: "http://127.0.0.1:1", roots: [{ rel: "", host: "/HOST/3d/" }] } });
    await startHub(tmp);
    r = await jget("/api/bl2u1");
    ok(r.status === 200 && r.body.reachable === false, "GET /api/bl2u1 says it is not reachable", r.body);
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Dragon.3mf" });
    ok(r.status === 409 && /U1 template/.test(r.body.error || "") && r.body.converter === undefined, "Convert falls through to upstream's template convert", r.body);
    await stopHub();

    console.log("\n== OUTSIDE DOCKER: no url configured -> idle, bl2u1 never called ==");
    writeConfig({ bl2u1: { roots: [{ rel: "", host: "/HOST/3d/" }] } });
    await startHub(tmp);
    const n1 = mock.state.calls.length;
    r = await jget("/api/bl2u1");
    ok(r.status === 200 && r.body.configured === false && r.body.reachable === false, "no url and not inside Docker: GET /api/bl2u1 says not configured (the host.docker.internal default is container-only)", r.body);
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Dragon.3mf" });
    ok(mock.state.calls.length === n1 && /U1 template/.test((r.body || {}).error || ""), "…and Convert goes straight to upstream's template convert, bl2u1 never called", r.body);
    await stopHub();

    console.log("\n== FEATURE: off -> upstream only; Lite -> off ==");
    writeConfig({ features: { bl2u1: false } });
    await startHub(tmp);
    const n0 = mock.state.calls.length;
    r = await jget("/api/bl2u1");
    ok(r.status === 404, "bl2u1 off: its status API is absent", r.status);
    r = await jpost("/api/models/convert", { file: "Yosh/Dragon/Bambu Dragon.3mf" });
    ok(mock.state.calls.length === n0 && /U1 template/.test((r.body || {}).error || ""), "bl2u1 off: Convert never calls bl2u1", r.body);
    await stopHub();
    CHILD = spawn(process.execPath, ["server.js"], { cwd: REPO, stdio: "ignore", env: { ...process.env, U1HUB_DIR: tmp, U1HUB_PORT: String(PORT), U1HUB_PROFILE: "lite" } });
    for (let i = 0; i < 240; i++) { await sleep(250); try { if ((await fetch(HUB + "/api/version")).ok) break; } catch {} }
    const cfg = (await jget("/api/config")).body || {};
    ok(cfg.features && cfg.features.bl2u1 === false, "Lite: bl2u1 is off", cfg.features);
  } catch (e) {
    fail++; console.log("  FAIL (threw) " + (e && e.stack || e));
  } finally {
    await stopHub();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_BL2U1_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
})();
