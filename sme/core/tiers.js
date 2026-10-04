// scripts/sme-tiers.js — the SME's model routing, pure and in one place.
// Fork (ryvin/u1hub). Required by scripts/sme-runner.js (which model to call,
// when to escalate, which knowledge sections to send) and by modules/sme.js
// (so the queue and the UI can say which tier a target would get). No I/O.
//
// Every threshold lives in THRESHOLDS and is documented in docs/sme.md. The
// rule: route each review to the cheapest model that can do it well and
// escalate one tier when the answer shows it could not.
//
//   tier 1  haiku   routine gcode: one material, >= 3 completed prints, no
//                   cancels or errors, actual time close to the estimate
//   tier 2  sonnet  the default: most gcode and 3MF reviews
//   tier 3  opus    hard cases: printer tuning (Klipper drafts), repeated
//                   failures, difficult geometry, conflicting evidence, and
//                   the monthly knowledge refresh (web research synthesis)
//
// `fable` is never chosen by default; SME_MODEL_TIER3=fable (or SME_MODEL=
// fable) is the only way it is used.

"use strict";

const THRESHOLDS = Object.freeze({
  tier1: Object.freeze({ min_done: 3, time_ratio: Object.freeze([0.8, 1.25]) }),
  tier3: Object.freeze({ min_failures: 2, steep_pct: 25, flat_unsupported_pct: 10, bed_contact_pct: 20, time_ratio_out: Object.freeze([0.6, 1.5]) })
});
const DEFAULT_MODELS = Object.freeze({ 1: "haiku", 2: "sonnet", 3: "opus" });
// What to try when the CLI rejects an alias (not offered on this account, or
// retired). A full model id that is rejected falls to sonnet.
const FALLBACK = Object.freeze({ fable: "opus", opus: "sonnet", sonnet: "haiku", haiku: "sonnet" });
const KNOWLEDGE_MAX_CHARS = 60000;

// facts: the `facts` block GET /api/sme/context returns:
//   { kind: "gcode"|"3mf"|"printer", materials: [..], multi_color: bool,
//     prints: { done, cancelled, error }, time_ratio: number|null,
//     geometry: { steep_pct, flat_unsupported_pct, bed_contact_pct, floating } | null,
//     conflicting: bool }
// -> { tier, reasons[] }
function pickTier(facts) {
  const f = facts || {};
  const reasons = [];
  const prints = f.prints || {};
  const done = num(prints.done), failed = num(prints.cancelled) + num(prints.error);
  const T3 = THRESHOLDS.tier3, T1 = THRESHOLDS.tier1;
  if (f.kind === "printer") { reasons.push("printer tuning review (Klipper drafts)"); return { tier: 3, reasons }; }
  if (f.kind === "refresh") { reasons.push("knowledge refresh (web research synthesis)"); return { tier: 3, reasons }; }
  if (f.kind === "family") {
    // an iteration history: tier 2, tier 3 when the outcomes conflict or the
    // family kept failing
    if (failed >= T3.min_failures) reasons.push(failed + " failed prints across the family (>= " + T3.min_failures + ")");
    if (f.conflicting) reasons.push("outcomes conflict between variants");
    if (reasons.length) return { tier: 3, reasons };
    return { tier: 2, reasons: ["family iteration review"] };
  }
  // Known solutions: every open issue on this target is covered by a confirmed
  // lesson, so the model only has to apply and cite them.
  if (f.lessons_cover_all && (f.kind === "gcode" || f.kind === "3mf")) { reasons.push("every issue covered by confirmed lessons"); return { tier: 1, reasons }; }
  if (failed >= T3.min_failures) reasons.push(failed + " failed prints (>= " + T3.min_failures + ")");
  const g = f.geometry;
  if (g) {
    if (num(g.steep_pct) >= T3.steep_pct) reasons.push("steep overhang " + g.steep_pct + "% (>= " + T3.steep_pct + "%)");
    if (num(g.flat_unsupported_pct) >= T3.flat_unsupported_pct) reasons.push("floating underside " + g.flat_unsupported_pct + "% (>= " + T3.flat_unsupported_pct + "%)");
    if (g.bed_contact_pct != null && num(g.bed_contact_pct) < T3.bed_contact_pct) reasons.push("bed contact " + g.bed_contact_pct + "% of footprint (< " + T3.bed_contact_pct + "%)");
    if (num(g.floating) > 0) reasons.push(g.floating + " part(s) floating above the plate");
  }
  const tr = f.time_ratio;
  if (tr != null && Number.isFinite(tr) && done >= 2 && (tr < T3.time_ratio_out[0] || tr > T3.time_ratio_out[1])) reasons.push("actual time is " + tr + "x the estimate (conflicting evidence)");
  if (f.conflicting) reasons.push("conflicting evidence");
  if (reasons.length) return { tier: 3, reasons };
  if (f.kind === "gcode") {
    const mats = [...new Set((f.materials || []).map(m => String(m).toUpperCase()).filter(Boolean))];
    const simple = mats.length <= 1 && !f.multi_color && done >= T1.min_done && failed === 0 && tr != null && tr >= T1.time_ratio[0] && tr <= T1.time_ratio[1];
    if (simple) { reasons.push("routine: " + (mats[0] || "one material") + ", " + done + " completed prints, no failures, time ratio " + tr); return { tier: 1, reasons }; }
    if (mats.length > 1) reasons.push("mixed materials " + mats.join("/"));
    if (f.multi_color) reasons.push("multi-color / prime tower");
    if (done < T1.min_done) reasons.push("only " + done + " completed prints");
    if (failed) reasons.push(failed + " failed print(s)");
    if (tr == null) reasons.push("no actual-vs-estimate ratio");
  } else reasons.push(f.kind === "3mf" ? "3MF review (typical geometry)" : "default");
  return { tier: 2, reasons: reasons.length ? reasons : ["default"] };
}

function modelForTier(tier, env) {
  const e = env || process.env;
  if (e.SME_MODEL) return String(e.SME_MODEL);
  return String(e["SME_MODEL_TIER" + tier] || DEFAULT_MODELS[tier] || DEFAULT_MODELS[2]);
}
function fallbackFor(model) { return FALLBACK[String(model || "").toLowerCase()] || "sonnet"; }

// The CLI said the model is not one it can use (not found / not offered on
// this account / retired). The text is the json result's `result` plus stderr.
function isModelRejected(text) {
  const t = String(text || "");
  return /model/i.test(t) && /(invalid|unknown|not (found|available|supported|a valid|offered)|unavailable|does not exist|no such|not have access|not accessible|not_found|is not a valid)/i.test(t);
}
// A subscription usage limit or a rate limit: stop the batch and pause.
function isUsageLimit(text) {
  const t = String(text || "");
  return /(usage limit|rate[ _-]?limit|too many requests|limit reached|hit your limit|reached your limit|out of (extra )?usage|spending cap|\b429\b|overloaded|resets? (at|in))/i.test(t);
}
// "resets at 3pm" / "resets at 10:30 PM" / "resets in 2 hours" -> epoch ms;
// otherwise now + fallbackMin.
function parsePauseUntil(text, now, fallbackMin) {
  const t = String(text || ""), n = now || Date.now();
  let m = /resets? in (\d+)\s*(min|minute|hour|h)/i.exec(t);
  if (m) return n + Number(m[1]) * (/^h/i.test(m[2]) ? 3600000 : 60000);
  m = /resets? at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if (m[3]) { const pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    const d = new Date(n); d.setHours(h, mi, 0, 0);
    if (d.getTime() <= n) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return n + (fallbackMin || 60) * 60000;
}

// knowledge.md -> [{ heading, body }], split on "## " headings; the text
// before the first heading is the "preamble" (the date header lives there).
function knowledgeSections(md) {
  const out = [];
  const parts = String(md || "").split(/^(?=## )/m);
  for (const p of parts) {
    const m = /^## ([^\n]*)\n?([\s\S]*)$/.exec(p);
    if (m) out.push({ heading: m[1].trim(), body: m[2] });
    else if (p.trim()) out.push({ heading: "", body: p });
  }
  return out;
}
// What of knowledge.md goes into a prompt. Tier 1 gets only the sections that
// name the file's material(s) (nothing when none matches); tiers 2 and 3 get
// the whole file when it fits KNOWLEDGE_MAX_CHARS, else the matching sections
// plus the preamble.
function selectKnowledge(md, opt) {
  const o = opt || {}, text = String(md || "");
  if (!text.trim()) return { text: "", sections: [], mode: "none" };
  const secs = knowledgeSections(text);
  const terms = [...(o.materials || []), ...(o.printerTypes || []), ...(o.terms || [])].map(s => String(s || "").trim()).filter(s => s.length >= 2);
  const matches = s => terms.some(t => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(s.heading));
  if (o.tier === 1) {
    const hit = secs.filter(s => s.heading && matches(s));
    return { text: hit.map(s => "## " + s.heading + "\n" + s.body).join("\n"), sections: hit.map(s => s.heading), mode: hit.length ? "matched" : "none" };
  }
  // Tier 3 (hard cases) reads the whole file when it fits; tier 2 never does:
  // it gets the preamble plus the matching sections, so a routine review does
  // not pay ~15k tokens for printers and materials it is not about.
  if (o.tier !== 2 && text.length <= (o.max || KNOWLEDGE_MAX_CHARS)) return { text, sections: secs.filter(s => s.heading).map(s => s.heading), mode: "full" };
  const pre = secs.find(s => !s.heading);
  const hit = secs.filter(s => s.heading && matches(s));
  return { text: (pre ? pre.body + "\n" : "") + hit.map(s => "## " + s.heading + "\n" + s.body).join("\n"), sections: hit.map(s => s.heading), mode: "matched" };
}

// After a review comes back: escalate one tier when it failed validation, when
// the reviewer rated its own confidence low, or when it said "not enough
// data" about something the context actually covered (review.gaps[].topic is
// one of facts.covers[]). One escalation per target per run, never past 3.
function shouldEscalate(review, facts, validation) {
  if (validation && validation.ok === false) return { escalate: true, reason: "schema: " + validation.error };
  if (!review) return { escalate: true, reason: "no review" };
  if (review.confidence === "low") return { escalate: true, reason: "confidence low" };
  const covers = new Set((facts && facts.covers) || []);
  const gap = (review.gaps || []).find(g => g && covers.has(String(g.topic)));
  if (gap) return { escalate: true, reason: "not enough data on " + gap.topic + ", which the context covers" };
  return { escalate: false, reason: null };
}

// Which context sections a tier is sent (keys of GET /api/sme/context .sections).
function sectionsForTier(kind, tier) {
  if (kind === "gcode" && tier === 1) return ["file", "settings", "outcome", "loadout"];
  return null;   // all of them
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

module.exports = { THRESHOLDS, DEFAULT_MODELS, FALLBACK, KNOWLEDGE_MAX_CHARS, pickTier, modelForTier, fallbackFor, isModelRejected, isUsageLimit, parsePauseUntil, knowledgeSections, selectKnowledge, shouldEscalate, sectionsForTier };
