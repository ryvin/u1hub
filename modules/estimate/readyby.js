// modules/estimate/readyby.js — when a quote could be ready: what each printer
// is doing, the Dispatch queue in order, this job's plates on the printers it
// fits, plates only started inside working hours, then post-processing days.
// Pure: `now` is an input (CLAUDE.md rule 7). Fork module estimate (ryvin/u1hub).
"use strict";
const STEP_MS = 15 * 60000, MAX_STEPS = 21 * 96;
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FMT = new Map();
function fmt(tz) {
  if (!FMT.has(tz)) FMT.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }));
  return FMT.get(tz);
}
function localParts(ms, tz) {
  const parts = fmt(tz || "UTC").formatToParts(new Date(ms)), g = t => (parts.find(p => p.type === t) || {}).value;
  return { date: g("year") + "-" + g("month") + "-" + g("day"), wd: WD[g("weekday")], min: Number(g("hour")) * 60 + Number(g("minute")) };
}
const hm = s => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
function inHours(ms, H) { const l = localParts(ms, H.tz); return H.days.includes(l.wd) && l.min >= hm(H.start) && l.min < hm(H.end); }
function nextStart(ms, H) {
  if (!H || !Array.isArray(H.days) || !H.days.length) return ms;
  if (inHours(ms, H)) return ms;
  let t = Math.ceil(ms / STEP_MS) * STEP_MS;   // every timezone offset is a whole quarter hour
  for (let i = 0; i < MAX_STEPS; i++, t += STEP_MS) if (inHours(t, H)) return t;
  return ms;   // hours that never open: ignore them rather than never finishing
}
function addWorkingDays(ms, n, H) {
  const tz = (H && H.tz) || "UTC", days = (H && H.days && H.days.length) ? H.days : [0, 1, 2, 3, 4, 5, 6];
  const [y, m, d] = localParts(ms, tz).date.split("-").map(Number);
  let k = 0, left = Math.max(0, Math.round(n || 0));
  while (left > 0) { k++; if (days.includes(new Date(Date.UTC(y, m - 1, d + k)).getUTCDay())) left--; }
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}
function readyBy(o) {
  const free = (o.printers || []).map(p => ({ ...p, at: o.now + Math.max(0, Number(p.free_in_min) || 0) * 60000 }));
  const place = (pick, minutes) => {
    let best = null, bestStart = Infinity;
    for (const p of free) if (pick(p)) { const s = nextStart(p.at, o.hours); if (s < bestStart) { best = p; bestStart = s; } }
    if (!best) return null;
    best.at = bestStart + Math.max(0, minutes) * 60000;
    return best.at;
  };
  const runQueue = () => { for (const q of o.queue || []) for (let i = 0; i < (q.plates || 0); i++) place(p => p.type === q.type, Number(q.minutes) || 0); };
  if (!o.rush) runQueue();
  let last = null;
  for (let i = 0; i < Math.max(1, o.job.plates || 1); i++) {
    const end = place(p => p.fits, Number(o.job.minutes) || 0);
    if (end == null) return null;
    last = Math.max(last || 0, end);
  }
  return { finish_at: last, ready_by: addWorkingDays(last, o.post_days, o.hours) };
}
module.exports = { readyBy, nextStart, addWorkingDays, localParts };
