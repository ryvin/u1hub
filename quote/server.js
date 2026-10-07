"use strict";
// u1-quote — the public quote page for the U1 Print Hub (fork ryvin/u1hub).
// Holds no Hub code and no Hub files: every quote lives in the Hub, reached at
// HUB_URL with X-Quote-Key. This service adds what the public edge needs:
// Turnstile, per-IP and global limits, a size cap, a strict CSP, and a second
// field allow-list. Spec: docs/superpowers/specs/2026-10-07-public-quote-design.md; ops: docs/quote.md.
const express = require("express"), path = require("path");
const { load } = require("./lib/config.js"), { createLimiter } = require("./lib/limits.js"), { verify } = require("./lib/turnstile.js");
const { createHub } = require("./lib/hub.js"), V = require("./lib/view.js");
const C = load(process.env);
const hub = createHub({ hubUrl: C.hubUrl, quoteKey: C.quoteKey, timeoutMs: C.hubTimeoutMs });
const L = createLimiter(), HOUR = 3600000, DAY = 24 * HOUR;
const app = express();
app.disable("x-powered-by");
const TOKEN = /^[0-9a-f]{32}$/;
const ipOf = req => (C.trustCf && req.get("CF-Connecting-IP")) || req.socket.remoteAddress || "?";
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.use((req, res, next) => { res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }); next(); });
const page = (req, res) => res.sendFile(path.join(__dirname, "public", "index.html"));
app.get("/", page);
app.get("/q/:token", page);
app.use("/static", express.static(path.join(__dirname, "public"), { index: false }));
const json = express.json({ limit: "16kb" });
const out = (res, r) => res.status(r.status).json(r.status === 200 ? V.clean(r.body) : { error: (r.body && r.body.error) || "Something went wrong", paused: !!(r.body && r.body.paused) });
const tooMany = (res, what) => res.status(429).json({ error: "Too many " + what + " - please try again later" });
const readLimit = (req, res, next) => (L.hit("read", ipOf(req), C.readsPerHour, HOUR, Date.now()) ? next() : tooMany(res, "requests"));

app.get("/api/config", (req, res) => res.json({ siteKey: C.siteKey, maxMb: C.maxMb }));
app.get("/healthz", async (req, res) => { const r = await hub.ping(); res.json({ ok: true, hub: r.status === 200, enabled: !!(r.body && r.body.enabled) }); });
app.post("/upload", async (req, res) => {
  const ip = ipOf(req);
  let name = ""; try { name = path.basename(decodeURIComponent(String(req.get("X-File-Name") || ""))).slice(0, 200); } catch {}
  if (!/\.(stl|3mf)$/i.test(name)) { req.resume(); return res.status(400).json({ error: "Please upload an .stl or .3mf file" }); }
  const len = Number(req.get("Content-Length"));
  if (len > C.maxMb * 1048576) { req.resume(); res.set("Connection", "close"); return res.status(413).json({ error: "Files are limited to " + C.maxMb + " MB" }); }
  if (!(await verify(req.get("X-Turnstile-Token"), ip, { secret: C.secret, verifyUrl: C.verifyUrl }))) { req.resume(); return res.status(403).json({ error: "Please complete the check and try again" }); }
  const now = Date.now();
  if (!L.hit("upload", ip, C.uploadsPerHour, HOUR, now)) { req.resume(); return tooMany(res, "uploads"); }
  if (!L.hit("upload-all", "*", C.globalUploadsPerHour, HOUR, now)) { req.resume(); return res.status(503).json({ error: "We're busy right now - please try again in a while", paused: true }); }
  let over = false;
  const r = await hub.upload(req, name, C.maxMb * 1048576, () => { over = true; });
  if (over) { res.set("Connection", "close"); return res.status(413).json({ error: "Files are limited to " + C.maxMb + " MB" }); }
  if (r.status !== 200 || !r.body || !TOKEN.test(String(r.body.token || ""))) return out(res, r.status === 200 ? { status: 502, body: {} } : r);
  res.json({ token: r.body.token });
});
const withToken = fn => (req, res) => (TOKEN.test(req.params.token) ? fn(req, res) : res.status(404).json({ error: "This quote has expired" }));
app.get("/api/q/:token", readLimit, withToken(async (req, res) => out(res, await hub.get(req.params.token))));
app.post("/api/q/:token/options", readLimit, json, withToken(async (req, res) => {
  const b = req.body || {}, body = {};
  for (const k of ["qty", "palette_id", "quality", "rush"]) if (k in b) body[k] = b[k];
  out(res, await hub.post(req.params.token, "options", body));
}));
app.post("/api/q/:token/request", json, withToken(async (req, res) => {
  const ip = ipOf(req), b = req.body || {};
  if (!(await verify(b.turnstile, ip, { secret: C.secret, verifyUrl: C.verifyUrl }))) return res.status(403).json({ error: "Please complete the check and try again" });
  if (!L.hit("request", ip, C.requestsPerDay, DAY, Date.now())) return tooMany(res, "requests today");
  out(res, await hub.post(req.params.token, "request", { name: b.name, email: b.email, notes: b.notes }));
}));
app.post("/api/q/:token/delete", readLimit, withToken(async (req, res) => { const r = await hub.post(req.params.token, "delete", {}); res.status(r.status).json(r.status === 200 ? { ok: true } : { error: (r.body && r.body.error) || "Something went wrong" }); }));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(C.port, () => console.log("u1-quote listening on " + C.port + " -> " + C.hubUrl));
