"use strict";
// Cloudflare Turnstile server-side check (siteverify). Fails closed.
async function verify(token, ip, o) {
  if (!token || String(token).length > 4096) return false;
  try {
    const form = new URLSearchParams({ secret: o.secret, response: String(token) });
    if (ip) form.set("remoteip", ip);
    const r = await (o.fetchImpl || fetch)(o.verifyUrl, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j && j.success === true;
  } catch { return false; }
}
module.exports = { verify };
