"use strict";
// u1-quote configuration, from the environment only (quote/.env via compose).
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
function load(env) {
  const c = {
    port: n(env.PORT, 4560), hubUrl: String(env.HUB_URL || "http://host.docker.internal:4545").replace(/\/+$/, ""),
    quoteKey: String(env.QUOTE_KEY || ""), siteKey: String(env.TURNSTILE_SITEKEY || ""), secret: String(env.TURNSTILE_SECRET || ""),
    verifyUrl: String(env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify"),
    maxMb: n(env.MAX_MB, 100), uploadsPerHour: n(env.UPLOADS_PER_HOUR, 5), requestsPerDay: n(env.REQUESTS_PER_DAY, 3),
    globalUploadsPerHour: n(env.GLOBAL_UPLOADS_PER_HOUR, 60), readsPerHour: n(env.READS_PER_HOUR, 300), hubTimeoutMs: n(env.HUB_TIMEOUT_MS, 10000),
    trustCf: env.TRUST_CF !== "0", publicUrl: String(env.PUBLIC_URL || "")
  };
  if (c.quoteKey.length < 32) throw new Error("QUOTE_KEY must be the Hub's estimate.quote_key (32+ characters)");
  if (!c.siteKey || !c.secret) throw new Error("TURNSTILE_SITEKEY and TURNSTILE_SECRET are required");
  return c;
}
module.exports = { load };
