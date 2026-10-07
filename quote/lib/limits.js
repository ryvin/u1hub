"use strict";
// Sliding-window counters in memory, `now` injected (rule 7). A restart forgets them; that is acceptable for abuse limits.
function createLimiter() {
  const B = new Map();
  function hit(bucket, key, max, windowMs, now) {
    const k = bucket + "\u0000" + key, list = (B.get(k) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { B.set(k, list); return false; }
    list.push(now); B.set(k, list);
    if (B.size > 50000) for (const [kk, l] of B) if (!l.length || now - l[l.length - 1] > 86400000) B.delete(kk);
    return true;
  }
  return { hit };
}
module.exports = { createLimiter };
