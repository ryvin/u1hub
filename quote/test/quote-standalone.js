"use strict";
// quote/test/quote-standalone.js — the public u1-quote service against a fake
// Hub and a fake Turnstile siteverify (no network). Rule 6: QUOTE_FALSIFY=1
// flips the allow-list expectation; the run must go red. Rule 7: the limiter
// takes `now`; the booted checks wait on observable state.
// Run: node quote/test/quote-standalone.js
const { spawn } = require("child_process");
const http = require("http"), path = require("path");
const FALSIFY = process.env.QUOTE_FALSIFY === "1";
const SVC_PORT = 45996, FAKE_PORT = 45997, SVC = "http://127.0.0.1:" + SVC_PORT;
const KEY = "test-quote-key-0123456789abcdef0123456789";
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 500) : "")); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the fakes: one server, /hub/* is the Hub backend, /siteverify is Turnstile ----
const FAKE = { up: true, uploads: [], requests: [], lastKey: null };
const LEAKY = { status: "quote", phase: "done", confidence: "rough", price_low: 10, price_high: 14, qty: 1, cost: { total: 3 }, printer: "davinci", files: [{ name: "secret.stl" }], ready_by: "2026-10-08", limits: { qty_max: 100, palette: [] } };
function fakeServer() {
  return http.createServer((req, res) => {
    let chunks = []; req.on("data", d => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks), j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/siteverify") { const p = new URLSearchParams(body.toString()); return j(200, { success: p.get("response") === "good-token" && p.get("secret") === "test-secret" }); }
      if (!FAKE.up) { req.socket.destroy(); return; }
      FAKE.lastKey = req.headers["x-quote-key"];
      if (FAKE.lastKey !== KEY) return j(401, { error: "bad quote key" });
      if (req.url === "/api/quote-backend/ping") return j(200, { ok: true, enabled: true, max_mb: 100 });
      if (req.url === "/api/quote-backend/upload") { FAKE.uploads.push({ name: decodeURIComponent(req.headers["x-file-name"] || ""), bytes: body.length }); return j(200, { token: "a".repeat(32) }); }
      const m = /^\/api\/quote-backend\/quote\/([0-9a-f]{32})(?:\/(\w+))?$/.exec(req.url);
      if (!m) return j(404, { error: "This quote has expired" });
      if (m[2] === "request") { FAKE.requests.push(JSON.parse(body.toString() || "{}")); return j(200, { ...LEAKY, status: "new" }); }
      if (m[2] === "delete") return j(200, { ok: true });
      return j(200, LEAKY);
    });
  });
}
let CHILD = null, LOG = "";
async function startSvc(extra) {
  LOG = "";
  CHILD = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(SVC_PORT),
    HUB_URL: "http://127.0.0.1:" + FAKE_PORT, QUOTE_KEY: KEY, TURNSTILE_SITEKEY: "test-site", TURNSTILE_SECRET: "test-secret", TURNSTILE_VERIFY_URL: "http://127.0.0.1:" + FAKE_PORT + "/siteverify",
    MAX_MB: "1", UPLOADS_PER_HOUR: "3", REQUESTS_PER_DAY: "2", GLOBAL_UPLOADS_PER_HOUR: "60", HUB_TIMEOUT_MS: "1500", ...(extra || {}) } });
  CHILD.stdout.on("data", d => LOG += d); CHILD.stderr.on("data", d => LOG += d);
  // waits on observable state; a cold require of express over /mnt/e measured 12.8 s (2026-10-07), so the cap is 60 s
  for (let i = 0; i < 600; i++) { try { if ((await fetch(SVC + "/healthz")).status) return; } catch {} await sleep(100); }
  throw new Error("service did not start:\n" + LOG);
}
async function stopSvc() { if (CHILD) { const c = CHILD; CHILD = null; await new Promise(r => { c.once("exit", r); c.kill(); }); } }
const up = (name, buf, tok, ip) => fetch(SVC + "/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-Turnstile-Token": tok || "good-token", ...(ip ? { "CF-Connecting-IP": ip } : {}) }, body: buf }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const jget = p => fetch(SVC + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const jpost = (p, b, ip) => fetch(SVC + p, { method: "POST", headers: { "Content-Type": "application/json", ...(ip ? { "CF-Connecting-IP": ip } : {}) }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  console.log("\n-- pure --");
  const { createLimiter } = require("../lib/limits.js");
  const L = createLimiter(), H = 3600000;
  ok(L.hit("u", "ip1", 2, H, 0) && L.hit("u", "ip1", 2, H, 1) && !L.hit("u", "ip1", 2, H, 2), "limiter: third in the window refused");
  ok(L.hit("u", "ip2", 2, H, 2), "limiter: per key");
  ok(L.hit("u", "ip1", 2, H, H + 1), "limiter: the window slides");
  const V = require("../lib/view.js");
  const cv = V.clean(LEAKY);
  // falsified: expect the leaked cost to survive - the real filter must make that fail
  ok(Object.keys(LEAKY).filter(k => !V.FIELDS.includes(k)).every(k => !(k in cv)) && cv.price_low === 10 && (!FALSIFY || "cost" in cv), "view.clean keeps only the allow-list" + (FALSIFY ? " [FALSIFIED]" : ""), cv);
  const HUBQ = require("../../modules/estimate/quote.js");
  ok(JSON.stringify(V.FIELDS) === JSON.stringify(HUBQ.VIEW_FIELDS), "the service's allow-list equals the Hub's");
  const { load } = require("../lib/config.js");
  let threw = false; try { load({ QUOTE_KEY: "short", TURNSTILE_SITEKEY: "s", TURNSTILE_SECRET: "t" }); } catch { threw = true; }
  ok(threw, "config: a short QUOTE_KEY refuses to start");

  const fake = fakeServer(); await new Promise(r => fake.listen(FAKE_PORT, "127.0.0.1", r));
  try {
    await startSvc();
    console.log("\n-- page and headers --");
    const page = await fetch(SVC + "/"); const html = await page.text();
    const csp = page.headers.get("content-security-policy") || "";
    ok(page.status === 200 && /<title>/.test(html) && /default-src 'self'/.test(csp) && /challenges\.cloudflare\.com/.test(csp) && !/unsafe-inline/.test(csp.split("script-src")[1] || ""), "page served with a strict CSP", csp);
    ok((await fetch(SVC + "/q/" + "a".repeat(32))).status === 200, "the status page path serves the page");
    const cfg = await jget("/api/config");
    ok(cfg.body.siteKey === "test-site" && cfg.body.maxMb === 1 && !JSON.stringify(cfg.body).includes("test-secret") && !JSON.stringify(cfg.body).includes(KEY), "config: site key only, never secrets", cfg.body);

    const js = await fetch(SVC + "/static/app.js"), css = await fetch(SVC + "/static/style.css");
    ok(js.status === 200 && css.status === 200, "app.js and style.css served");
    ok(/src="\/static\/app\.js"/.test(html) && /href="\/static\/style\.css"/.test(html) && !/<script>[^<]/.test(html) && !/style="/.test(html), "no inline script or style (the CSP would block them)");
    const appjs = await js.text();
    ok(!/\.innerHTML\s*=\s*[^"'`]/.test(appjs.replace(/innerHTML = ""/g, "")), "app.js never assigns data to innerHTML");
    ok(/turnstile\.reset/.test(appjs) && /X-Turnstile-Token/.test(appjs), "app.js resets Turnstile after use and sends the token");

    console.log("\n-- upload --");
    ok((await up("a.stl", Buffer.alloc(10), "bad-token")).status === 403, "a failed Turnstile -> 403, nothing sent");
    ok((await up("a.obj", Buffer.alloc(10))).status === 400, "only .stl / .3mf");
    ok((await up("a.stl", Buffer.alloc(1048576 + 10), null, "9.9.9.1")).status === 413, "over MAX_MB -> 413");
    let r = await up("model.stl", Buffer.alloc(1000), null, "1.1.1.1");
    ok(r.status === 200 && r.body.token === "a".repeat(32) && FAKE.uploads.some(u => u.name === "model.stl" && u.bytes === 1000) && FAKE.lastKey === KEY, "upload streamed to the Hub with the key", r.body);
    await up("m.stl", Buffer.alloc(10), null, "1.1.1.1"); await up("m.stl", Buffer.alloc(10), null, "1.1.1.1");
    ok((await up("m.stl", Buffer.alloc(10), null, "1.1.1.1")).status === 429, "the 4th upload in an hour from one IP -> 429");
    ok((await up("m.stl", Buffer.alloc(10), null, "2.2.2.2")).status === 200, "another IP is not limited by it");

    console.log("\n-- quote --");
    r = await jget("/api/q/" + "a".repeat(32));
    ok(r.status === 200 && !("cost" in r.body) && !("printer" in r.body) && !("files" in r.body) && r.body.price_low === 10, "the quote view is allow-listed again", r.body);
    ok((await jget("/api/q/not-a-token")).status === 404, "a malformed token never reaches the Hub");

    console.log("\n-- request --");
    ok((await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "bad-token" }, "3.3.3.3")).status === 403, "request needs Turnstile");
    r = await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", notes: "x", turnstile: "good-token" }, "3.3.3.3");
    ok(r.status === 200 && r.body.status === "new" && FAKE.requests.length === 1 && !("turnstile" in FAKE.requests[0]), "request forwarded without the Turnstile token", FAKE.requests);
    await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "good-token" }, "3.3.3.3");
    ok((await jpost("/api/q/" + "a".repeat(32) + "/request", { name: "A", email: "a@b.co", turnstile: "good-token" }, "3.3.3.3")).status === 429, "3rd request in a day -> 429");

    console.log("\n-- paused --");
    FAKE.up = false;
    r = await up("p.stl", Buffer.alloc(10), null, "4.4.4.4");
    ok(r.status === 503 && r.body.paused === true, "Hub unreachable -> 503 paused", r.body);
    const hz = await jget("/healthz");
    ok(hz.status === 200 && hz.body.hub === false, "healthz reports the Hub down", hz.body);
    FAKE.up = true;
    await stopSvc();

    console.log("\n-- client IP --");
    await startSvc({ TRUST_CF: "0", UPLOADS_PER_HOUR: "1" });
    await up("x.stl", Buffer.alloc(10), null, "5.5.5.1");
    ok((await up("x.stl", Buffer.alloc(10), null, "5.5.5.2")).status === 429, "TRUST_CF=0: a spoofed CF-Connecting-IP does not reset the limit");
    await stopSvc();
  } finally { await stopSvc(); fake.close(); }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
