// sme/core/schema.js — the review JSON contract and its validator. Pure.
// Part of the SME core (sme/core/, no Hub dependency; see CONTEXT.md).
//
// A review is what the reviewer answers with; validateReview() normalises
// one (caps every string and array, drops unknown keys) or says why it is
// unusable. The DRAFT changes (drafts.orca, drafts.klipper) are text and
// values for a person to apply; nothing here or anywhere in the core applies
// them.

"use strict";

const LESSONS = require("./lessons.js");

const KINDS = Object.freeze(["gcode", "3mf", "printer", "family", "photo"]);
const VERDICTS = Object.freeze(["GO", "TUNE", "RISK"]);
const IMPACTS = Object.freeze(["quality", "speed", "reliability"]);
const CONFIDENCE = Object.freeze(["low", "medium", "high"]);
const TUNING_AREAS = Object.freeze(["pressure_advance", "input_shaper", "accel_velocity", "temps", "retraction", "flow", "cooling", "other"]);
const EFFECTS = Object.freeze(["improved", "hurt", "neutral", "unknown"]);
const GAP_TOPICS = Object.freeze(["settings", "outcome_history", "loadout", "klipper", "geometry", "project_settings", "print_history", "iterations", "failure_stats", "firmware", "images"]);
const REVIEW_MAX_BYTES = 64 * 1024;

const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, " ").trim().slice(0, n || 200);

// -> { ok: true, review } or { ok: false, error }
function validateReview(input, kind) {
  const r = input;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "review must be an object" };
  const bad = m => ({ ok: false, error: m });
  const verdict = String(r.verdict || "").toUpperCase();
  if (!VERDICTS.includes(verdict)) return bad("verdict must be one of " + VERDICTS.join(", "));
  const summary = str(r.summary, 300);
  if (!summary) return bad("summary is required");
  const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
  const settings = [];
  for (const s of arr(r.settings, 20)) {
    if (!s || typeof s !== "object") continue;
    const key = str(s.key, 80); if (!key) continue;
    const impact = String(s.impact || "").toLowerCase();
    if (!IMPACTS.includes(impact)) return bad("settings[" + key + "].impact must be one of " + IMPACTS.join(", "));
    settings.push({ key, current: s.current == null ? null : str(s.current, 120), suggested: str(s.suggested, 120), why: str(s.why, 300), impact });
  }
  const printer_tuning = [];
  for (const p of arr(r.printer_tuning, 6)) {
    if (!p || typeof p !== "object") continue;
    const printer = str(p.printer, 80); if (!printer) continue;
    const items = [];
    for (const it of arr(p.items, 16)) {
      if (!it || typeof it !== "object") continue;
      const area = String(it.area || "other").toLowerCase();
      if (!TUNING_AREAS.includes(area)) return bad("printer_tuning[" + printer + "].items[].area must be one of " + TUNING_AREAS.join(", "));
      items.push({ area, param: str(it.param, 80), current: it.current == null ? null : str(it.current, 120), suggested: str(it.suggested, 120), why: str(it.why, 300) });
    }
    printer_tuning.push({ printer, items });
  }
  const strs = (v, n, len) => arr(v, n).map(x => str(x, len)).filter(Boolean);
  const d = (r.drafts && typeof r.drafts === "object" && !Array.isArray(r.drafts)) ? r.drafts : {};
  let orca = null;
  if (d.orca != null) {
    if (typeof d.orca !== "object" || Array.isArray(d.orca)) return bad("drafts.orca must be an object of Orca key -> value");
    orca = {};
    for (const [k, v] of Object.entries(d.orca).slice(0, 40)) { const kk = str(k, 80); if (kk) orca[kk] = typeof v === "number" ? v : str(v, 120); }
  }
  const klipper = d.klipper == null ? null : String(d.klipper).slice(0, 8000);
  const confidence = String(r.confidence || "").toLowerCase();
  if (!CONFIDENCE.includes(confidence)) return bad("confidence must be one of " + CONFIDENCE.join(", "));
  const gaps = [];
  for (const g of arr(r.gaps, 8)) { if (g && typeof g === "object" && str(g.topic, 40)) gaps.push({ topic: str(g.topic, 40), reason: str(g.reason, 200) }); }
  const ids = v => [...new Set(arr(v, 20).map(x => str(x, 40)).filter(Boolean))];
  const new_lessons = [];
  for (const L of arr(r.new_lessons, 8)) {
    if (!L || typeof L !== "object" || !str(L.finding, 300)) continue;
    const ch = (L.change && typeof L.change === "object") ? L.change : {};
    new_lessons.push({ signature: LESSONS.normSignature(L.signature), finding: str(L.finding, 300), change: { text: str(ch.text, 300), orca: (ch.orca && typeof ch.orca === "object" && !Array.isArray(ch.orca)) ? ch.orca : null, klipper: ch.klipper ? String(ch.klipper).slice(0, 4000) : null } });
  }
  let family = null;
  if (kind === "family") {
    const f = (r.family && typeof r.family === "object") ? r.family : null;
    if (!f) return bad("a family review needs a family block (best, iterations, next_experiment, member_status)");
    const b = (f.best && typeof f.best === "object") ? f.best : {};
    if (!str(b.member, 200)) return bad("family.best.member is required");
    const iterations = [];
    for (const it of arr(f.iterations, 12)) {
      if (!it || typeof it !== "object") continue;
      const effect = String(it.effect || "unknown").toLowerCase();
      if (!EFFECTS.includes(effect)) return bad("family.iterations[].effect must be one of " + EFFECTS.join(", "));
      iterations.push({ to: str(it.to, 200), effect, why: str(it.why, 300) });
    }
    const ne = (f.next_experiment && typeof f.next_experiment === "object") ? f.next_experiment : null;
    family = { best: { member: str(b.member, 200), why: str(b.why, 300) }, iterations,
               next_experiment: ne ? { change: str(ne.change, 200), why: str(ne.why, 300) } : null,
               member_status: arr(f.member_status, 12).filter(s => s && typeof s === "object" && str(s.member, 200)).map(s => ({ member: str(s.member, 200), line: str(s.line, 200) })) };
  }
  const out = { verdict, summary, settings, printer_tuning, speed_quality: strs(r.speed_quality, 8, 300), drafts: { orca, klipper },
                risks: strs(r.risks, 8, 300), confidence, evidence: strs(r.evidence, 12, 200), gaps, not_enough_data: r.not_enough_data === true,
                lessons_used: ids(r.lessons_used), confirmed_lessons: ids(r.confirmed_lessons), new_lessons, family };
  if (JSON.stringify(out).length > REVIEW_MAX_BYTES) return bad("review is larger than " + REVIEW_MAX_BYTES + " bytes");
  return { ok: true, review: out };
}

// The context contract (CONTEXT.md), checked lightly: the core needs a kind,
// a key and text sections to work from. -> { ok, error }
function validateContext(c) {
  if (!c || typeof c !== "object") return { ok: false, error: "context must be an object" };
  if (!KINDS.includes(c.kind)) return { ok: false, error: "kind must be one of " + KINDS.join(", ") };
  if (!c.key) return { ok: false, error: "key is required" };
  if (!c.sections || typeof c.sections !== "object" || !Object.keys(c.sections).length) return { ok: false, error: "sections {name: text} is required" };
  if (c.facts != null && typeof c.facts !== "object") return { ok: false, error: "facts must be an object" };
  if (c.kind === "photo" && !(Array.isArray(c.images) && c.images.length)) return { ok: false, error: "a photo target needs images[]" };
  return { ok: true };
}

module.exports = { KINDS, VERDICTS, IMPACTS, CONFIDENCE, TUNING_AREAS, EFFECTS, GAP_TOPICS, REVIEW_MAX_BYTES, validateReview, validateContext };
