"use strict";
// The Hub's /api/quote-backend, over the shared key. Any network failure or timeout is "paused", never a 500.
const { Readable, Transform } = require("stream");
const PAUSED = { status: 503, body: { error: "Quotes are paused - try again soon", paused: true } };
function createHub(o) {
  const H = { "X-Quote-Key": o.quoteKey };
  async function call(p, init) {
    try {
      const r = await fetch(o.hubUrl + "/api/quote-backend" + p, { ...init, headers: { ...H, ...(init && init.headers) }, signal: AbortSignal.timeout(init && init.long ? 300000 : o.timeoutMs), ...(init && init.body && init.duplex ? { duplex: "half" } : {}) });
      let body = null; try { body = await r.json(); } catch {}
      if (r.status === 401 || r.status >= 500) return r.status === 503 && body && body.paused ? { status: 503, body } : PAUSED;
      return { status: r.status, body };
    } catch { return PAUSED; }
  }
  return {
    ping: () => call("/ping"),
    get: token => call("/quote/" + token),
    post: (token, action, body) => call("/quote/" + token + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }),
    // Streams the visitor's body to the Hub, counting bytes; over maxBytes the stream errors and the caller answers 413.
    upload(req, name, maxBytes, onOver) {
      let n = 0;
      const counter = new Transform({ transform(chunk, enc, cb) { n += chunk.length; if (n > maxBytes) { onOver(); return cb(new Error("too big")); } cb(null, chunk); } });
      req.pipe(counter);
      return call("/upload", { method: "POST", long: true, duplex: "half", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: Readable.toWeb(counter) });
    }
  };
}
module.exports = { createHub, PAUSED };
