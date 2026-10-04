// scripts/sme-lessons.js — the SME's lessons-learned store, pure. Fork (ryvin/u1hub).
// Required by modules/sme.js (match before a review, merge after one, outcome
// feedback from the ledger) and by test/sme-standalone.js. No I/O here.
//
// A lesson is one condition -> fix pair the reviewer found once and should
// never re-derive:
//   { id, signature: { printer_type, material, tag, setting_keys: [{ key, min, max, equals }],
//                      geometry_flags: [] },
//     finding, change: { text, orca: {k: v} | null, klipper: string | null },
//     evidence: { reviews: [ids], outcomes: { done, failed } },
//     times_confirmed, last_seen, confidence (0..1), created, source }
//
// Matching is by signature against a target's facts (what the Hub knows:
// printer types, materials, symptom tags, geometry flags) and its settings
// (Orca keys from the gcode or project, "section.key" from Klipper). A field
// the signature leaves empty or "*" matches anything; every field it sets
// must match. `exact` means every signature field was set and matched.

"use strict";

// Symptom tags the Hub derives from a target's facts (tagsFor) and a lesson
// may name. Free tags are allowed too (<= 40 chars) but never derived.
const TAGS = Object.freeze(["failures", "cancelled", "overhang", "floating", "small_bed_contact", "slow_vs_estimate", "fast_vs_estimate", "multi_color", "mixed_materials"]);
const TAG_THRESHOLDS = Object.freeze({ failures: 2, cancelled: 1, overhang_pct: 25, floating_pct: 10, bed_contact_pct: 20, slow_ratio: 1.5, fast_ratio: 0.6 });
const CONFIRMED_MIN = 1;          // times_confirmed for a lesson to count as confirmed
const CONFIDENCE_MIN = 0.5;       // ...and its confidence
const LESSON_ONLY_CONFIRMS = 3;   // exact + this many confirmations -> no model call
const LESSON_ONLY_CONFIDENCE = 0.7;

const low = s => String(s == null ? "" : s).trim().toLowerCase();
const up = s => String(s == null ? "" : s).trim().toUpperCase();
const numOr = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n || 200);

// facts (from GET /api/sme/context .facts) -> symptom tags.
function tagsFor(facts) {
  const f = facts || {}, p = f.prints || {}, g = f.geometry, T = TAG_THRESHOLDS;
  const tags = new Set();
  const failed = (Number(p.cancelled) || 0) + (Number(p.error) || 0);
  if (failed >= T.failures) tags.add("failures");
  if ((Number(p.cancelled) || 0) >= T.cancelled) tags.add("cancelled");
  if (g) {
    if (Number(g.steep_pct) >= T.overhang_pct) tags.add("overhang");
    if (Number(g.flat_unsupported_pct) >= T.floating_pct || Number(g.floating) > 0) tags.add("floating");
    if (g.bed_contact_pct != null && Number(g.bed_contact_pct) < T.bed_contact_pct) tags.add("small_bed_contact");
  }
  const tr = f.time_ratio;
  if (tr != null && Number.isFinite(tr) && (Number(p.done) || 0) >= 2) { if (tr > T.slow_ratio) tags.add("slow_vs_estimate"); if (tr < T.fast_ratio) tags.add("fast_vs_estimate"); }
  if (f.multi_color) tags.add("multi_color");
  if ((f.materials || []).length > 1) tags.add("mixed_materials");
  return [...tags];
}

// A signature as stored: lower-cased type, upper-cased material, sorted keys.
function normSignature(sig) {
  const s = sig && typeof sig === "object" ? sig : {};
  const keys = (Array.isArray(s.setting_keys) ? s.setting_keys : []).map(k => {
    if (typeof k === "string") return { key: clean(k, 80) };
    if (!k || typeof k !== "object") return null;
    const o = { key: clean(k.key, 80) };
    if (!o.key) return null;
    if (numOr(k.min) != null) o.min = numOr(k.min);
    if (numOr(k.max) != null) o.max = numOr(k.max);
    if (k.equals != null && k.equals !== "") o.equals = clean(k.equals, 60);
    return o;
  }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 8);
  return {
    printer_type: low(s.printer_type) || "*",
    material: up(s.material) || "*",
    tag: low(s.tag).replace(/[^a-z0-9_]/g, "_").slice(0, 40) || "",
    setting_keys: keys,
    geometry_flags: [...new Set((Array.isArray(s.geometry_flags) ? s.geometry_flags : []).map(x => low(x)).filter(x => TAGS.includes(x)))].sort()
  };
}
function signatureKey(sig) {
  const n = normSignature(sig);
  return [n.printer_type, n.material, n.tag, n.setting_keys.map(k => k.key + (k.equals != null ? "=" + k.equals : "") + (k.min != null ? ">=" + k.min : "") + (k.max != null ? "<=" + k.max : "")).join(","), n.geometry_flags.join(",")].join("|");
}
const isExactField = v => v && v !== "*";

// One lesson against one target. -> null or { score, exact, missed: [] }.
function matchOne(sig, context) {
  const n = normSignature(sig);
  const f = (context && context.facts) || {}, settings = (context && context.settings) || {};
  const types = new Set((f.printer_types || []).map(low)), mats = new Set((f.materials || []).map(up));
  const tags = new Set((f.tags || tagsFor(f)).map(low));
  let score = 0, fields = 0;
  if (n.printer_type !== "*") { fields++; if (!types.has(n.printer_type)) return null; score++; }
  if (n.material !== "*") { fields++; if (!mats.has(n.material)) return null; score++; }
  if (n.tag) { fields++; if (!tags.has(n.tag)) return null; score += 2; }
  for (const g of n.geometry_flags) { fields++; if (!tags.has(g)) return null; score++; }
  for (const k of n.setting_keys) {
    fields++;
    if (!(k.key in settings)) return null;
    const v = settings[k.key], nv = numOr(v);
    if (k.equals != null && String(v).toLowerCase() !== String(k.equals).toLowerCase()) return null;
    if (k.min != null && (nv == null || nv < k.min)) return null;
    if (k.max != null && (nv == null || nv > k.max)) return null;
    score++;
  }
  if (!fields) return null;   // a signature that says nothing matches nothing
  return { score, exact: n.printer_type !== "*" && n.material !== "*" && !!n.tag, fields };
}

// context: { facts, settings }; lessons: array or { id: lesson } map.
// -> [{ lesson, score, exact, confirmed }] best first.
function matchLessons(context, lessons) {
  const list = Array.isArray(lessons) ? lessons : Object.values(lessons || {});
  const out = [];
  for (const L of list) {
    if (!L || !L.signature) continue;
    const m = matchOne(L.signature, context);
    if (!m) continue;
    out.push({ lesson: L, score: m.score, exact: m.exact, confirmed: isConfirmed(L) });
  }
  return out.sort((a, b) => b.score - a.score || (b.lesson.confidence || 0) - (a.lesson.confidence || 0) || (b.lesson.times_confirmed || 0) - (a.lesson.times_confirmed || 0));
}
function isConfirmed(L) { return (Number(L.times_confirmed) || 0) >= CONFIRMED_MIN && (Number(L.confidence) || 0) >= CONFIDENCE_MIN; }

// Which of a target's issue tags the matched lessons cover.
//   all_covered: every issue has a confirmed lesson (-> tier 1)
//   lesson_only: every issue has an exact lesson confirmed >= LESSON_ONLY_CONFIRMS
//                at confidence >= LESSON_ONLY_CONFIDENCE (-> no model call)
function coverage(facts, matches) {
  const issues = (facts && (facts.tags || tagsFor(facts))) || [];
  const covered = {};
  for (const t of issues) {
    const hits = (matches || []).filter(m => normSignature(m.lesson.signature).tag === t || normSignature(m.lesson.signature).geometry_flags.includes(t));
    covered[t] = { confirmed: hits.some(m => m.confirmed), strong: hits.some(m => m.exact && (m.lesson.times_confirmed || 0) >= LESSON_ONLY_CONFIRMS && (m.lesson.confidence || 0) >= LESSON_ONLY_CONFIDENCE) };
  }
  const all = issues.length > 0 && issues.every(t => covered[t].confirmed);
  const only = issues.length > 0 && issues.every(t => covered[t].strong);
  return { issues, covered, all_covered: all, lesson_only: only };
}

// A review built from lessons alone (no model call). Only when coverage says
// lesson_only; labelled so the UI and the record never pass it off as a model's.
function lessonReview(context, matches, cov) {
  const used = (matches || []).filter(m => m.exact && isConfirmed(m.lesson));
  const settings = [];
  let orca = null, klipper = null;
  const evidence = [], risks = [];
  for (const m of used) {
    const L = m.lesson, ch = L.change || {};
    evidence.push("lesson " + L.id + ": " + clean(L.finding, 120) + " (confirmed " + (L.times_confirmed || 0) + "x, confidence " + (L.confidence || 0) + ")");
    if (ch.orca && typeof ch.orca === "object") {
      orca = { ...(orca || {}), ...ch.orca };
      for (const [k, v] of Object.entries(ch.orca).slice(0, 10)) settings.push({ key: k, current: (context && context.settings && context.settings[k] != null) ? String(context.settings[k]) : null, suggested: String(v), why: clean(L.finding, 200), impact: "reliability" });
    }
    if (ch.klipper) klipper = (klipper ? klipper + "\n" : "") + ch.klipper;
    if (ch.text) risks.push(clean(ch.text, 200));
  }
  return {
    verdict: settings.length || klipper ? "TUNE" : "GO",
    summary: "From lessons: " + (cov.issues.length ? cov.issues.join(", ") + " covered by " + used.length + " confirmed lesson" + (used.length === 1 ? "" : "s") : "no open issues") + " - no new analysis needed.",
    settings: settings.slice(0, 20), printer_tuning: [], speed_quality: [], drafts: { orca, klipper }, risks: risks.slice(0, 8),
    confidence: "high", evidence: evidence.slice(0, 12), gaps: [], not_enough_data: false,
    lessons_used: used.map(m => m.lesson.id), confirmed_lessons: used.map(m => m.lesson.id), new_lessons: []
  };
}

// ---- the store (immutable updates: every function returns a new map) ----------------------
function newId() { return "ls_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function normLesson(input, meta) {
  const L = input || {};
  const sig = normSignature(L.signature);
  const ch = (L.change && typeof L.change === "object") ? L.change : {};
  let orca = null;
  if (ch.orca && typeof ch.orca === "object" && !Array.isArray(ch.orca)) { orca = {}; for (const [k, v] of Object.entries(ch.orca).slice(0, 20)) { const kk = clean(k, 80); if (kk) orca[kk] = typeof v === "number" ? v : clean(v, 120); } }
  return {
    id: newId(), signature: sig, finding: clean(L.finding, 300), change: { text: clean(ch.text, 300), orca: orca && Object.keys(orca).length ? orca : null, klipper: ch.klipper ? String(ch.klipper).slice(0, 4000) : null },
    evidence: { reviews: meta && meta.review_id ? [meta.review_id] : [], outcomes: { done: 0, failed: 0 } },
    times_confirmed: 1, last_seen: (meta && meta.now) || Date.now(), confidence: 0.5, created: (meta && meta.now) || Date.now(), source: (meta && meta.source) || "review"
  };
}
// Two signatures describe the same condition family when they share the tag
// and material, their printer types agree or one is a wildcard, and their
// setting keys overlap (or both name none).
function overlaps(a, b) {
  const A = normSignature(a), B = normSignature(b);
  if (A.tag !== B.tag || A.material !== B.material) return false;
  if (A.printer_type !== B.printer_type && A.printer_type !== "*" && B.printer_type !== "*") return false;
  const ak = new Set(A.setting_keys.map(k => k.key)), bk = new Set(B.setting_keys.map(k => k.key));
  if (!ak.size && !bk.size) return A.geometry_flags.join() === B.geometry_flags.join();
  return [...ak].some(k => bk.has(k));
}
function widen(target, incoming) {
  const T = normSignature(target), I = normSignature(incoming);
  const keys = new Map(T.setting_keys.map(k => [k.key, { ...k }]));
  for (const k of I.setting_keys) {
    const t = keys.get(k.key);
    if (!t) { keys.set(k.key, { ...k }); continue; }
    if (k.min != null) t.min = t.min != null ? Math.min(t.min, k.min) : k.min;
    if (k.max != null) t.max = t.max != null ? Math.max(t.max, k.max) : k.max;
    if (t.equals != null && k.equals != null && t.equals !== k.equals) delete t.equals;
  }
  return { ...T, printer_type: T.printer_type === I.printer_type ? T.printer_type : "*", setting_keys: [...keys.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
// store: { id: lesson }. incoming: review.new_lessons. -> { store, created, merged }
function mergeLessons(store, incoming, meta) {
  const next = { ...(store || {}) }, created = [], merged = [];
  const now = (meta && meta.now) || Date.now();
  for (const raw of (Array.isArray(incoming) ? incoming : []).slice(0, 8)) {
    if (!raw || !raw.finding) continue;
    const L = normLesson(raw, { ...meta, now });
    if (!L.signature.tag && !L.signature.setting_keys.length && !L.signature.geometry_flags.length) continue;   // a lesson with no condition is not a lesson
    const key = signatureKey(L.signature);
    let hit = Object.values(next).find(x => signatureKey(x.signature) === key) || Object.values(next).find(x => overlaps(x.signature, L.signature));
    // a review may not create two near-duplicates of its own either
    if (!hit) hit = created.map(id => next[id]).find(x => overlaps(x.signature, L.signature));
    if (hit) {
      const reviews = [...new Set([...(hit.evidence.reviews || []), ...L.evidence.reviews])];
      next[hit.id] = { ...hit, signature: widen(hit.signature, L.signature), finding: hit.finding || L.finding, change: { text: hit.change.text || L.change.text, orca: hit.change.orca || L.change.orca, klipper: hit.change.klipper || L.change.klipper },
                       evidence: { ...hit.evidence, reviews }, times_confirmed: (hit.times_confirmed || 0) + 1, last_seen: now, confidence: Math.min(0.95, (hit.confidence || 0.5) + 0.1) };
      merged.push(hit.id);
    } else { next[L.id] = L; created.push(L.id); }
  }
  return { store: next, created, merged };
}
// ids the reviewer applied: one confirmation each.
function confirmLessons(store, ids, meta) {
  const next = { ...(store || {}) }, confirmed = [];
  const now = (meta && meta.now) || Date.now();
  for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20)) {
    const L = next[id]; if (!L) continue;
    next[id] = { ...L, times_confirmed: (L.times_confirmed || 0) + 1, last_seen: now, confidence: Math.min(0.95, (L.confidence || 0.5) + 0.1),
                 evidence: { ...L.evidence, reviews: [...new Set([...(L.evidence.reviews || []), ...(meta && meta.review_id ? [meta.review_id] : [])])] } };
    confirmed.push(id);
  }
  return { store: next, confirmed };
}
// A later print of a file whose review applied these lessons finished (done)
// or failed: raise or lower each lesson's confidence.
function feedback(store, ids, outcome, meta) {
  const next = { ...(store || {}) }, touched = [];
  const ok = outcome === "done";
  for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))]) {
    const L = next[id]; if (!L) continue;
    const o = { done: (L.evidence.outcomes || {}).done || 0, failed: (L.evidence.outcomes || {}).failed || 0 };
    if (ok) o.done++; else o.failed++;
    next[id] = { ...L, evidence: { ...L.evidence, outcomes: o }, last_seen: (meta && meta.now) || Date.now(),
                 confidence: Math.round(Math.max(0.05, Math.min(0.95, (L.confidence || 0.5) + (ok ? 0.05 : -0.1))) * 100) / 100 };
    touched.push(id);
  }
  return { store: next, touched };
}

module.exports = { TAGS, TAG_THRESHOLDS, CONFIRMED_MIN, CONFIDENCE_MIN, LESSON_ONLY_CONFIRMS, LESSON_ONLY_CONFIDENCE, tagsFor, normSignature, signatureKey, matchOne, matchLessons, isConfirmed, coverage, lessonReview, normLesson, overlaps, widen, mergeLessons, confirmLessons, feedback };
