"use strict";
// test/quote-backend-standalone.js — fork module estimate (ryvin/u1hub): the
// public-quote backend. Pure units (quote.js, readyby.js), then a booted Hub
// (backend key, upload -> token -> customer view, options, request, owner
// routes, retention). Rule 6: U1HUB_QUOTE_FALSIFY=1 flips the allow-list
// expectation; the run must go red. Rule 7: every time is an input.
//
// Run: node test/quote-backend-standalone.js   (part of npm run test:standalone)
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const REPO = path.join(__dirname, "..");
const PORT = 45994, HUB = "http://127.0.0.1:" + PORT;
const FALSIFY = process.env.U1HUB_QUOTE_FALSIFY === "1";
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 600) : "")); } }
const Q = require("../modules/estimate/quote.js");

function pureQuote() {
  console.log("\n-- quote.js --");
  const KEY = "k".repeat(40);
  ok(Q.keyOk(KEY, KEY) && !Q.keyOk("x", KEY) && !Q.keyOk("", KEY) && !Q.keyOk(KEY, "short") && !Q.keyOk(undefined, KEY), "keyOk: equal long key only");

  const cand = { key: "c1", size_check: "same", done: 2, actual_minutes: 10, grams: 4 };
  ok(Q.pickPublicSource({ candidates: [cand] }).candidate_key === "c1", "pickPublicSource: a same-size, printed-before match is used");
  ok(Q.pickPublicSource({ candidates: [{ ...cand, size_check: "different" }] }) === null && Q.pickPublicSource({ candidates: [{ ...cand, done: 0 }] }) === null, "pickPublicSource: different size or never done is not used");

  const V = (source, band_pct, extra) => ({ source, print: { band_pct, k_err: null }, candidates: [cand], candidate_key: "c1", ...(extra || {}) });
  ok(Q.confidenceOf(V("printed", 0)) === "exact", "printed before, same size -> exact");
  ok(Q.confidenceOf(V("sliced", 0)) === "exact" && Q.confidenceOf(V("sliced", 29)) === "good", "plate gcode -> exact, slice info -> good");
  ok(Q.confidenceOf(V("geometry", 33)) === "rough" && Q.confidenceOf(V("none", null)) === null, "geometry -> rough, nothing -> null");

  ok(JSON.stringify(Q.bandsFor("good", V("sliced", 29))) === JSON.stringify({ g: 0, t: 0.29 }), "good: grams fixed, time ± the fit's band");
  ok(Q.bandsFor("rough", V("geometry", 33)).g === 0.30 && Q.bandsFor("rough", V("geometry", 33, { print: { band_pct: 33, k_err: 0.2 } })).g === 0.2
     && Q.bandsFor("rough", V("geometry", 33, { print: { band_pct: 33, k_err: 0.01 } })).g === 0.15, "rough: grams ± k's error, 15 % floor, 30 % without a k");

  const lin = (g, m) => g * 0.5 + m * 0.1;   // a fake priceAt: $0.50/g + $0.10/min
  const good = Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5, min_fee: null }, lin);
  // low = 10 + 7 = 17.00, high = 10 + 13 = 23.00
  ok(good.price_low === 17 && good.price_high === 23 && !("price" in good), "good range: priced at both ends", good);
  const odd = Q.priceRange({ grams: 21, minutes: 100, confidence: "rough", g: 0.3, t: 0.3, round_to: 0.5, min_fee: null }, lin);
  // low = 7.35 + 7 = 14.35 -> 14.00, high = 13.65 + 13 = 26.65 -> 27.00
  ok(odd.price_low === 14 && odd.price_high === 27, "rounded outward to $0.50", odd);
  const ex = Q.priceRange({ grams: 20, minutes: 100, confidence: "exact", round_to: 0.5, firm: false }, lin);
  // centre 20.00 -> 19.00 .. 21.00 (±5 %)
  ok(ex.price_low === 19 && ex.price_high === 21, "exact, not firm: a narrow ±5 % range", ex);
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "exact", round_to: 0.5, firm: true }, lin).price === 20, "exact and firm: one price");
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5, firm: true }, lin).price_low === 17, "firm applies to exact only");
  ok(Q.priceRange({ grams: 2, minutes: 10, confidence: "rough", g: 0.3, t: 0.3, round_to: 0.5, min_fee: 5 }, lin).price_low === 5, "the low end never goes under the minimum fee");
  ok(Q.priceRange({ grams: 20, minutes: 100, confidence: "good", g: 0, t: 0.3, round_to: 0.5 }, () => null) === null, "no rates -> no price (never $0)");
  const tiny = Q.priceRange({ grams: 1, minutes: 1, confidence: "rough", g: 0.3, t: 0.3, round_to: 0.5, min_fee: null }, (g, m) => 0.3 * g + 0.01 * m);
  ok(tiny.price_low === 0.5 && tiny.price_high === 0.5, "a tiny part's low end rounds to one step, never $0", tiny);
  ok(Q.priceRange({ grams: 1, minutes: 1, confidence: "exact", round_to: 0.5, firm: true }, () => 0.2).price === 0.5, "a tiny firm price is one step, never $0");

  const S = { ...Q.QUOTE_DEFAULTS, palette: [{ id: "pla-blk", material: "PLA", colour: "Black", hex: "#000000", in_stock: true }, { id: "petg-red", material: "PETG", colour: "Red", hex: "#ff0000", in_stock: false }] };
  ok(Q.checkOptions({ qty: 3, palette_id: "pla-blk", quality: "strong", rush: true }, S, false).options.qty === 3, "options: valid set accepted");
  ok(/qty/.test(Q.checkOptions({ qty: 101 }, S, false).error) && /qty/.test(Q.checkOptions({ qty: 0 }, S, false).error) && /qty/.test(Q.checkOptions({ qty: "x" }, S, false).error), "options: qty 1-100");
  ok(/colour/.test(Q.checkOptions({ palette_id: "petg-red" }, S, false).error) && /colour/.test(Q.checkOptions({ palette_id: "nope" }, S, false).error), "options: unknown or out-of-stock colour refused");
  ok(!Q.checkOptions({ palette_id: "nope" }, S, true).error, "options: a multi-colour model ignores the colour");
  ok(/quality/.test(Q.checkOptions({ quality: "hueforge" }, S, false).error), "options: quality is standard or strong");
  const inp = Q.inputsFor({ qty: 2, palette_id: "pla-blk", quality: "strong", rush: true }, S, false);
  ok(inp.qty === 2 && inp.material === "PLA" && inp.preset === "strong" && inp.rush === 1.5 && inp.colour_name === "Black", "inputsFor: palette -> material, rush -> multiplier", inp);
  const gone = Q.inputsFor({ qty: 1, palette_id: "petg-red", quality: "standard", rush: false }, S, false);
  ok(gone.colour_changed === true && gone.colour_name === "Black" && gone.rush === 1, "inputsFor: an out-of-stock pick falls back to the first in-stock colour and says so", gone);

  ok(Q.checkContact({ name: "Ann", email: "ann@example.com", notes: "hi" }).contact.email === "ann@example.com", "contact: valid");
  ok(Q.checkContact({ name: "", email: "ann@example.com" }).error && Q.checkContact({ name: "Ann", email: "nope" }).error && Q.checkContact({ name: "Ann", email: "a@b.co", notes: "x".repeat(2001) }).error, "contact: name, email and notes length checked");
  ok(Q.checkContact({ name: "A\u0000nn\u0007", email: "a@b.co" }).contact.name === "Ann", "contact: control characters stripped");

  ok(Q.checkPalette([{ material: "pla", colour: "Blue", hex: "#0000FF", in_stock: true }]).palette[0].material === "PLA", "palette: material upper-cased, id assigned");
  ok(Q.checkPalette([{ material: "PLA", colour: "Blue", hex: "blue" }]).error, "palette: hex must be #rrggbb");
  ok(Q.checkSettings({ round_to: 0 }, Q.QUOTE_DEFAULTS).error && Q.checkSettings({ hours: { days: [8] } }, Q.QUOTE_DEFAULTS).error && Q.checkSettings({ hours: { tz: "Mars/Base" } }, Q.QUOTE_DEFAULTS).error, "settings: bad round_to, day or timezone refused");
  ok(Q.checkSettings({ firm_prices: true, post_days: 2 }, Q.QUOTE_DEFAULTS).settings.post_days === 2, "settings: valid change accepted");

  const leaky = { status: "quote", confidence: "rough", price_low: 1, price_high: 2, cost: { total: 9 }, printer: "davinci", files: [{ name: "secret.stl" }], candidates: [1], email: "x@y.z", qty: 1 };
  const cv = Q.customerView(leaky);
  // falsified: expect the leaked cost to survive - the real filter must make that fail
  ok(Object.keys(cv).every(k => Q.VIEW_FIELDS.includes(k)) && Object.keys(leaky).filter(k => !Q.VIEW_FIELDS.includes(k)).every(k => !(k in cv)) && (!FALSIFY || "cost" in cv), "customerView keeps only the allow-list" + (FALSIFY ? " [FALSIFIED]" : ""), cv);

  const D = 24 * 3600 * 1000, now = 100 * D;
  ok(Q.expired({ public: true, status: "quote", created: now - 8 * D }, now) && !Q.expired({ public: true, status: "quote", created: now - 6 * D }, now), "unrequested: gone after 7 days");
  ok(!Q.expired({ public: true, status: "new", created: now - 90 * D }, now), "an open request never expires");
  ok(Q.expired({ public: true, status: "closed", created: 0, closed_at: now - 31 * D }, now) && !Q.expired({ public: true, status: "declined", created: 0, closed_at: now - 29 * D }, now), "closed/declined: gone 30 days after");
  ok(!Q.expired({ status: "quote", created: 0 }, now), "a non-public estimate is not this rule's business");
}

const RB = require("../modules/estimate/readyby.js");
function pureReadyBy() {
  console.log("\n-- readyby.js --");
  const H = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "UTC" };
  const MON8 = Date.UTC(2026, 9, 5, 8, 0);           // Mon 2026-10-05 08:00Z
  const P = (over) => [{ name: "a", type: "u1", fits: true, free_in_min: 0, ...(over || {}) }];
  const base = { now: MON8, printers: P(), queue: [], job: { minutes: 120, plates: 1 }, hours: H, post_days: 1, rush: false };
  let r = RB.readyBy(base);
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0) && r.ready_by === "2026-10-06", "idle printer, before hours: starts 09:00, done 11:00, ready next working day", r);
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 9, 16, 30) });
  ok(r.finish_at === Date.UTC(2026, 9, 9, 18, 30) && r.ready_by === "2026-10-12", "Fri 16:30 start runs past 17:00; +1 working day skips the weekend", r);
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 9, 17, 30) });
  ok(r.finish_at === Date.UTC(2026, 9, 12, 11, 0) && r.ready_by === "2026-10-13", "Fri after hours: waits for Mon 09:00", r);
  const queue = [{ type: "u1", minutes: 300, plates: 1 }];
  r = RB.readyBy({ ...base, queue });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 16, 0), "behind a 5 h queued job: 14:00-16:00", r);
  r = RB.readyBy({ ...base, queue, rush: true });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "rush goes ahead of the queue", r);
  r = RB.readyBy({ ...base, queue: [{ type: "kobra-s1", minutes: 300, plates: 1 }] });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "a queued job for another printer type does not delay this one", r);
  r = RB.readyBy({ ...base, printers: [...P(), { name: "b", type: "u1", fits: true, free_in_min: 0 }], job: { minutes: 120, plates: 2 } });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 11, 0), "two plates on two printers run side by side", r);
  r = RB.readyBy({ ...base, printers: [...P({ free_in_min: 600 }), { name: "big", type: "u1", fits: false, free_in_min: 0 }] });
  ok(r.finish_at === Date.UTC(2026, 9, 6, 11, 0) && r.ready_by === "2026-10-07", "busy until 18:00: next morning; a printer it doesn't fit is not used", r);
  ok(RB.readyBy({ ...base, printers: P({ fits: false }) }) === null, "nothing fits -> null");
  r = RB.readyBy({ ...base, now: Date.UTC(2026, 9, 5, 13, 0), hours: { ...H, tz: "America/Chicago" }, post_days: 0 });
  ok(r.finish_at === Date.UTC(2026, 9, 5, 16, 0) && r.ready_by === "2026-10-05", "Chicago hours: 08:00 CDT waits for 09:00 CDT (14:00Z)", r);
  ok(RB.localParts(Date.UTC(2026, 9, 5, 13, 0), "America/Chicago").min === 8 * 60, "localParts: 13:00Z is 08:00 in Chicago");
}

function pruneRule() {
  console.log("\n-- retention rule --");
  const D = 24 * 3600 * 1000, now = 100 * D;
  ok(Q.dropOnPrune({ public: true, status: "new", created: now - 40 * D, saved: false }, now) === false, "an open public request survives the old 30-day unsaved rule");
  ok(Q.dropOnPrune({ status: "quote", created: now - 31 * D, saved: false }, now) === true && Q.dropOnPrune({ created: now - 31 * D, saved: true }, now) === false, "internal estimates: unsaved > 30 days dropped, saved kept");
  ok(Q.dropOnPrune({ public: true, status: "quote", created: now - 8 * D }, now) === true, "an unrequested public quote is dropped after 7 days");
}

const { createMock } = require("./mock-moonraker.js");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = "test-quote-key-0123456789abcdef0123456789";
let CHILD = null, LOG = "";
async function startHub(dir) {
  LOG = "";
  CHILD = spawn(process.execPath, ["server.js"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(PORT), U1HUB_POLL_MS: "400", U1HUB_EVENTS_POLL_MS: "3600000", U1HUB_SYNC_MS: "3600000",
           U1HUB_COSTING_BACKFILL_BOOT_MS: "0", U1HUB_COSTING_IMPORT_BOOT_MS: "0", U1HUB_COSTING_IMPORT_MS: "0", U1HUB_ESTIMATE_CALIBRATE_BOOT_MS: "0",
           U1HUB_ESTIMATE_LIB_TTL_MS: "0", SME_HOME: path.join(dir, "sme-home"), U1HUB_PROFILE: "" } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  // waits for observable state, not a timer (a cold boot over /mnt/e measured 15 s)
  for (let i = 0; i < 400; i++) { try { const r = await fetch(HUB + "/api/auth/status"); if (r.ok) return; } catch {} await sleep(150); }
  throw new Error("hub did not start:\n" + LOG.slice(-2000));
}
async function stopHub() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }
const kh = (k) => (k === null ? {} : { "X-Quote-Key": k === undefined ? KEY : k });
async function bget(p, k) { const r = await fetch(HUB + p, { headers: kh(k) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function bpost(p, b, k) { const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json", ...kh(k) }, body: JSON.stringify(b || {}) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function bup(name, buf, k) { const r = await fetch(HUB + "/api/quote-backend/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), ...kh(k) }, body: buf }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
function cubeTris(s) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(t => t.map(i => v[i]));
}
function binStl(tris) { const b = Buffer.alloc(84 + tris.length * 50); b.writeUInt32LE(tris.length, 80); tris.forEach((t, i) => { let o = 84 + i * 50 + 12; for (const p of t) for (const c of p) { b.writeFloatLE(c, o); o += 4; } }); return b; }
const waitReady = async (token) => { for (let i = 0; i < 400; i++) { const r = await bget("/api/quote-backend/quote/" + token); if (r.body && r.body.phase !== "analysing") return r; await sleep(50); } return { status: 0, body: { error: "timeout" } }; };

async function booted() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-quote-")), gdir = path.join(tmp, "gcode");
  fs.mkdirSync(gdir, { recursive: true });
  const moon = createMock("u1"); const mport = await moon.listen(0);
  // a fake ntfy server: the request notification must arrive here
  const NTFY = []; const ntfy = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { NTFY.push({ url: req.url, body: b, title: req.headers["title"] || req.headers["x-title"] }); res.end("{}"); }); });
  await new Promise(r => ntfy.listen(0, "127.0.0.1", r));
  const palette = [{ id: "pla-black", material: "PLA", colour: "Black", hex: "#000000", in_stock: true }, { id: "petg-red", material: "PETG", colour: "Red", hex: "#ff0000", in_stock: true }];
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: gdir, port: PORT, printers: [{ name: "SECRET-PRINTER", url: "http://127.0.0.1:" + mport }],
    notify: { enabled: true, url: "http://127.0.0.1:" + ntfy.address().port, topic: "quotes" },
    estimate: { quote_key: KEY, quote: { enabled: true, palette, hours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", tz: "UTC" } } } }, null, 2));
  // the same earlier-print fixture as the estimate suite: a 20 mm cube printed once in 10 min
  fs.writeFileSync(path.join(tmp, "prints.json"), JSON.stringify({ prints: [{ id: "p1", at: 1, printer_id: 0, printer: "SECRET-PRINTER", type: "u1", file: "cube_PLA_10m.gcode", outcome: "done", seconds: 600, seconds_source: "actual", material: { grams: 4, source: "slicer", grams_source: "slicer" }, counted: true, pieces: 1 }] }));
  fs.writeFileSync(path.join(gdir, "cube_PLA_10m.gcode"), "; HEADER_BLOCK_START\n; max_z_height: 20.00\n; HEADER_BLOCK_END\nG1 X1\n; filament used [g] = 4.00\n; total filament used [g] = 4.00\n; estimated printing time (normal mode) = 10m 0s\n; CONFIG_BLOCK_START\n; filament_type = PLA\n; filament_colour = #FF0000\n; print_settings_id = 0.20 Standard\n; CONFIG_BLOCK_END\n");
  try {
    await startHub(tmp);
    console.log("\n-- the backend key --");
    ok((await bget("/api/quote-backend/ping", null)).status === 401, "no key -> 401");
    ok((await bget("/api/quote-backend/ping", "wrong-key-wrong-key-wrong-key-wrong-key")).status === 401, "wrong key -> 401");
    const ping = await bget("/api/quote-backend/ping");
    ok(ping.status === 200 && ping.body.enabled === true && ping.body.max_mb === 100, "right key -> ping, 100 MB cap", ping.body);

    console.log("\n-- upload -> token -> customer view --");
    let r = await bup("SECRETNAME_widget.stl", binStl(cubeTris(20)));
    ok(r.status === 200 && /^[0-9a-f]{32}$/.test(r.body && r.body.token || ""), "upload -> a 128-bit hex token", r.body);
    const T1 = r.body.token;
    let v = await waitReady(T1);
    ok(v.status === 200 && v.body.status === "quote" && v.body.confidence === "rough" && v.body.fits === true && v.body.qty === 1, "an unknown model: rough, fits, qty 1", v.body);
    const txt = JSON.stringify(v.body);
    ok(!/SECRETNAME|SECRET-PRINTER|cost|candidates|rates|est_/i.test(txt), "the customer view carries no file name, printer name, cost or candidate", txt.slice(0, 400));
    ok(v.body.price !== 0 && v.body.price_low !== 0 && v.body.price_high !== 0, "no rates set: never a $0 price", v.body);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(v.body.ready_by || "") && /^\d{4}-\d{2}-\d{2}$/.test(v.body.valid_until || ""), "ready_by and valid_until are dates", v.body);
    ok(Array.isArray(v.body.limits.palette) && v.body.limits.palette.length === 2 && v.body.limits.qty_max === 100 && v.body.material === "PLA" && v.body.colour === "Black", "limits carry the palette; default colour is the first in stock", v.body.limits);

    r = await bup("cube.stl", binStl(cubeTris(20)));
    v = await waitReady(r.body.token);
    ok(v.body.confidence === "exact", "printed before (same size, done) -> exact", v.body);

    console.log("\n-- options --");
    r = await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 4, palette_id: "petg-red", quality: "strong", rush: true });
    ok(r.status === 200 && r.body.qty === 4 && r.body.material === "PETG" && r.body.colour === "Red" && r.body.quality === "strong" && r.body.rush === true, "options change the quote", r.body);
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 101 })).status === 400, "qty over the cap -> 400");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { palette_id: "nope" })).status === 400, "unknown colour -> 400");

    console.log("\n-- tokens --");
    ok((await bget("/api/quote-backend/quote/" + "0".repeat(32))).status === 404, "an unknown token -> 404");
    ok((await bget("/api/quote-backend/quote/__proto__")).status === 404, "a prototype key is no token");

    console.log("\n-- request --");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "bad" })).status === 400, "a bad email -> 400");
    r = await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "ann@example.com", notes: "for a gift" });
    ok(r.status === 200 && r.body.status === "new", "request -> status new", r.body);
    for (let i = 0; i < 100 && !NTFY.length; i++) await sleep(50);
    ok(NTFY.length === 1 && /Ann/.test(NTFY[0].body), "the owner is notified (ntfy)", NTFY);
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/request", { name: "Ann", email: "ann@example.com" })).status === 409, "a second request on the same quote -> 409");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/options", { qty: 2 })).status === 409, "options are frozen once requested");

    console.log("\n-- delete my files --");
    r = await bup("throwaway.stl", binStl(cubeTris(10)));
    const T3 = r.body.token; await waitReady(T3);
    ok((await bpost("/api/quote-backend/quote/" + T3 + "/delete")).status === 200 && (await bget("/api/quote-backend/quote/" + T3)).status === 404, "an unrequested quote is deleted outright");
    ok((await bpost("/api/quote-backend/quote/" + T1 + "/delete")).status === 200, "a requested quote: delete accepted");
    v = await bget("/api/quote-backend/quote/" + T1);
    ok(v.status === 200 && v.body.files_deleted === true && v.body.status === "new", "...its files go, the request stays", v.body);

    console.log("\n-- paused --");
    // (Task 5 adds the owner settings route; here the switch is flipped through it once it exists)
    return { tmp, moon, ntfy, T1 };
  } catch (e) { await stopHub(); throw e; }
}

async function gateInPasswordMode() {
  console.log("\n-- the gate in password mode --");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-quote-pw-"));
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ gcodeFolder: path.join(tmp, "g"), port: PORT, printers: [], estimate: { quote_key: KEY, quote: { enabled: true } } }));
  fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ mode: "password" }));   // password mode, no session
  await startHub(tmp);
  try {
    ok((await bget("/api/estimate/info", null)).status === 401, "password mode: an ordinary API route needs a session");
    ok((await bget("/api/quote-backend/ping", null)).status === 401, "password mode: the backend without a key -> 401");
    ok((await bget("/api/quote-backend/ping")).status === 200, "password mode: the backend with the key -> 200");
    ok((await bget("/api/estimate/info", "anything")).status === 401, "a quote key does not open other routes");
  } finally { await stopHub(); }
}

async function main() {
  pureQuote(); pureReadyBy(); pruneRule();
  let ctxB = null;
  try { ctxB = await booted(); }
  catch (e) { fail++; console.log("  FAIL booted section threw: " + e.message); }
  finally { await stopHub(); if (ctxB) { ctxB.moon.close && ctxB.moon.close(); ctxB.ntfy.close(); } }
  try { await gateInPasswordMode(); }
  catch (e) { fail++; console.log("  FAIL password-mode section threw: " + e.message); }
  finally { await stopHub(); }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
