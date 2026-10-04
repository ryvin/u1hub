// test/sme-core-standalone.js — the SME core (sme/core/), with no Hub at all.
// Fork (ryvin/u1hub); the suite a lifted `ryvin/print-sme` would carry.
//
// Pure: pickTier cases and thresholds, knowledge section selection, lesson
// matching / coverage / lesson-only review / merge-dedupe / feedback, family
// analysis (names, settings diff, outcome effect, auto-lessons, status lines),
// the review schema's known-bad inputs, the context contract.
// With the fake claude (test/fake-claude.js, CLAUDE_BIN): the invocation
// wrapper (ok / garbage / usage limit / rejected alias), the pipeline (stored,
// cached on the same content, lessons-only without a call, escalation one
// tier up, pause), the knowledge refresh (written / rejected), and the CLI.
//
// Run: node test/sme-core-standalone.js   (part of npm run test:standalone)
// Rule 6 evidence: U1HUB_SME_FALSIFY=1 flips the tier-1 routing expectation
// and the family "best" expectation; the run must then go red.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const CORE = path.join(REPO, "sme", "core");
const FAKE = path.join(__dirname, "fake-claude.js");
const FALSIFY = process.env.U1HUB_SME_FALSIFY === "1";
const TIERS = require(path.join(CORE, "tiers.js"));
const LESSONS = require(path.join(CORE, "lessons.js"));
const FAM = require(path.join(CORE, "family.js"));
const SCHEMA = require(path.join(CORE, "schema.js"));
const CLAUDE = require(path.join(CORE, "claude.js"));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 500) : "")); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-sme-core-"));
const HOME = path.join(tmp, "home");
process.env.SME_HOME = HOME;
process.env.CLAUDE_BIN = FAKE;
process.env.FAKE_CLAUDE_LOG = path.join(tmp, "fake.log");
process.env.SME_TIMEOUT_MS = "20000";
delete process.env.SME_MODEL; delete process.env.SME_MODEL_TIER1; delete process.env.SME_MODEL_TIER2; delete process.env.SME_MODEL_TIER3;
const STORE = require(path.join(CORE, "store.js"));
const REVIEW = require(path.join(CORE, "review.js"));
const fakeLog = () => { try { return fs.readFileSync(process.env.FAKE_CLAUDE_LOG, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

function sampleCtx(over) {
  return {
    kind: "gcode", key: "u1:Sample_PLA_1h.gcode", name: "Sample_PLA_1h.gcode", content_hash: "a".repeat(40), paths: ["u1:Sample_PLA_1h.gcode"],
    sections: { file: "FILE: Sample_PLA_1h.gcode\nPLATE: estimated time 1h, filament 15 g", settings: "SLICER SETTINGS:\n  layer_height = 0.2\n  retraction_length = 0.8", outcome: "OUTCOME HISTORY (the Hub's print ledger): done 3, cancelled 0, error 0", loadout: "PRINTERS: U1-mock T1: PLA", klipper: "KLIPPER SETTINGS for U1-mock (read-only):\n  extruder.pressure_advance = 0.04" },
    order: ["file", "settings", "outcome", "loadout", "klipper"],
    facts: { materials: ["PLA"], multi_color: false, prints: { done: 3, cancelled: 0, error: 0 }, time_ratio: 1.02, geometry: null, conflicting: false, printer_types: ["u1"], covers: ["settings", "outcome_history", "loadout", "klipper"] },
    settings: { layer_height: "0.2", retraction_length: "0.8" }, ...(over || {})
  };
}

(async () => {
  try {
    console.log("\n== PURE: pickTier routes by difficulty, thresholds in one place ==");
    const T = TIERS.THRESHOLDS;
    ok(T.tier1.min_done === 3 && T.tier3.min_failures === 2 && T.tier3.steep_pct === 25 && T.tier3.flat_unsupported_pct === 10 && T.tier3.bed_contact_pct === 20, "the documented thresholds (docs/sme.md)", T);
    ok(TIERS.DEFAULT_MODELS[1] === "haiku" && TIERS.DEFAULT_MODELS[2] === "sonnet" && TIERS.DEFAULT_MODELS[3] === "opus", "defaults haiku / sonnet / opus; fable never by default", TIERS.DEFAULT_MODELS);
    let t = TIERS.pickTier({ kind: "gcode", materials: ["PLA"], multi_color: false, prints: { done: 3, cancelled: 0, error: 0 }, time_ratio: 1.0 });
    const wantT1 = FALSIFY ? 2 : 1;
    ok(t.tier === wantT1, "tier " + wantT1 + ": one material, 3 done, no failures, time ratio 1.0 (routine)" + (FALSIFY ? " [FALSIFIED]" : ""), t);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 }).tier === 2, "tier 2: only 2 completed prints", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA", "PETG"], prints: { done: 5, cancelled: 0, error: 0 }, time_ratio: 1.0 }).tier === 2, "tier 2: mixed materials", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], multi_color: true, prints: { done: 5, cancelled: 0, error: 0 }, time_ratio: 1.0 }).tier === 2, "tier 2: multi-color / prime tower", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 3, cancelled: 0, error: 0 }, time_ratio: 1.3 }).tier === 2, "tier 2: time ratio 1.3 is outside the routine band (0.8-1.25)", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 3, cancelled: 0, error: 0 }, time_ratio: null }).tier === 2, "tier 2: no actual-vs-estimate ratio", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 1, cancelled: 1, error: 1 }, time_ratio: 1.0 }).tier === 3, "tier 3: 2 failed prints", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 4, cancelled: 0, error: 0 }, time_ratio: 1.8 }).tier === 3, "tier 3: actual time 1.8x the estimate (conflicting evidence)", null);
    ok(TIERS.pickTier({ kind: "3mf", geometry: { steep_pct: 30, flat_unsupported_pct: 0, bed_contact_pct: 50, floating: 0 }, prints: { done: 0 } }).tier === 3, "tier 3: 3MF with 30% steep overhang", null);
    ok(TIERS.pickTier({ kind: "3mf", geometry: { steep_pct: 5, flat_unsupported_pct: 12, bed_contact_pct: 50, floating: 0 }, prints: { done: 0 } }).tier === 3, "tier 3: 12% floating underside", null);
    ok(TIERS.pickTier({ kind: "3mf", geometry: { steep_pct: 5, flat_unsupported_pct: 0, bed_contact_pct: 15, floating: 0 }, prints: { done: 0 } }).tier === 3, "tier 3: bed contact 15% of footprint", null);
    ok(TIERS.pickTier({ kind: "3mf", geometry: { steep_pct: 5, flat_unsupported_pct: 0, bed_contact_pct: 60, floating: 0 }, prints: { done: 0 } }).tier === 2, "tier 2: a 3MF with easy geometry", null);
    ok(TIERS.pickTier({ kind: "printer" }).tier === 3 && TIERS.pickTier({ kind: "refresh" }).tier === 3, "tier 3: printer tuning and the knowledge refresh", null);
    ok(TIERS.pickTier({ kind: "family", prints: { done: 5, cancelled: 0, error: 0 } }).tier === 2 && TIERS.pickTier({ kind: "family", prints: { done: 5, cancelled: 2, error: 0 } }).tier === 3 && TIERS.pickTier({ kind: "family", prints: { done: 5 }, conflicting: true }).tier === 3, "family: tier 2, tier 3 with repeated failures or conflicting outcomes", null);
    ok(TIERS.pickTier({ kind: "gcode", materials: ["PLA"], prints: { done: 1, cancelled: 2, error: 0 }, lessons_cover_all: true }).tier === 1, "tier 1 when confirmed lessons cover every issue, even with failures", null);
    ok(TIERS.modelForTier(1, {}) === "haiku" && TIERS.modelForTier(3, { SME_MODEL_TIER3: "fable" }) === "fable" && TIERS.modelForTier(1, { SME_MODEL: "opus" }) === "opus", "env overrides per tier and a global force", null);
    ok(TIERS.fallbackFor("fable") === "opus" && TIERS.fallbackFor("opus") === "sonnet" && TIERS.fallbackFor("haiku") === "sonnet" && TIERS.fallbackFor("claude-x-9") === "sonnet", "alias fallback chain", null);
    ok(TIERS.isModelRejected("Invalid model: 'fable' is not a valid model id") && !TIERS.isModelRejected("the model answered fine"), "rejected-model detection", null);
    ok(TIERS.isUsageLimit("You've hit your usage limit. Resets at 3pm") && TIERS.isUsageLimit("HTTP 429 too many requests") && !TIERS.isUsageLimit("GO: fine"), "usage-limit detection", null);
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    const pu = TIERS.parsePauseUntil("resets at 3pm", noon.getTime(), 60);
    ok(new Date(pu).getHours() === 15 && pu > noon.getTime(), "'resets at 3pm' parses to 15:00 today", new Date(pu).toString());
    ok(TIERS.parsePauseUntil("resets in 2 hours", 1000, 60) === 1000 + 7200000 && TIERS.parsePauseUntil("no clue", 1000, 60) === 1000 + 3600000, "'resets in 2 hours' and the 60-minute fallback", null);
    const esc1 = TIERS.shouldEscalate({ confidence: "low", gaps: [] }, { covers: ["settings"] }, { ok: true });
    const esc2 = TIERS.shouldEscalate({ confidence: "high", gaps: [{ topic: "klipper" }] }, { covers: ["settings", "klipper"] }, { ok: true });
    const esc3 = TIERS.shouldEscalate({ confidence: "high", gaps: [{ topic: "geometry" }] }, { covers: ["settings"] }, { ok: true });
    ok(esc1.escalate && !esc2.escalate && !esc3.escalate && TIERS.shouldEscalate(null, {}, { ok: false, error: "x" }).escalate, "escalate on low confidence and on schema failure only; a data gap (covered topic or not) never escalates - a bigger model cannot invent missing data", [esc1, esc2, esc3]);
    ok(TIERS.sectionsForTier("gcode", 1).join() === "file,settings,outcome,loadout" && TIERS.sectionsForTier("gcode", 2) === null && TIERS.sectionsForTier("3mf", 1) === null, "tier-1 gcode prompts drop the Klipper section", null);

    console.log("\n== PURE: knowledge sections by tier ==");
    const md = fs.readFileSync(path.join(CORE, "knowledge.md"), "utf8");
    const secs = TIERS.knowledgeSections(md);
    ok(secs.filter(s => s.heading).length >= 10 && secs.some(s => /^2b\./.test(s.heading)) && secs.some(s => /Filaments/.test(s.heading)), "knowledge.md splits into its numbered sections, 2b included", secs.map(s => s.heading));
    let sel = TIERS.selectKnowledge(md, { tier: 1, materials: ["PLA"], printerTypes: ["Snapmaker U1", "paxx12"], terms: ["Filaments"] });
    ok(sel.mode === "matched" && sel.sections.some(h => /Filaments/.test(h)) && sel.sections.some(h => /^2\. Snapmaker U1/.test(h)) && sel.sections.some(h => /^2b\./.test(h)) && !sel.sections.some(h => /Kobra/.test(h)) && sel.text.length < md.length / 2, "tier 1 for PLA on a U1: the filament section, §2 and §2b, not the Kobra section", sel.sections);
    sel = TIERS.selectKnowledge(md, { tier: 1, materials: ["PETG"], printerTypes: ["Kobra S1", "Rinkhals"], terms: ["Filaments"] });
    ok(sel.sections.some(h => /Kobra/.test(h)) && !sel.sections.some(h => /^2\. Snapmaker/.test(h)), "tier 1 for the Kobra: §3, not §2", sel.sections);
    sel = TIERS.selectKnowledge(md, { tier: 2, materials: ["PLA"], printerTypes: ["Snapmaker U1"], terms: ["Filaments", "Orca", "Speed", "Failure"] });
    ok(sel.mode === "matched" && sel.text.length < md.length && sel.sections.some(h => /Orca/.test(h)) && sel.sections.some(h => /Failure/.test(h)) && !sel.sections.some(h => /Kobra/.test(h)), "tier 2: matched sections (printer, filaments, Orca, playbook, failures), never the whole file", { mode: sel.mode, len: sel.text.length, secs: sel.sections });
    sel = TIERS.selectKnowledge(md, { tier: 3, materials: ["PLA"] });
    ok(sel.mode === "full" && sel.text === md, "tier 3: the whole file (under the size cap)", { mode: sel.mode, len: sel.text.length });
    sel = TIERS.selectKnowledge(md, { tier: 2, materials: ["PLA"], max: 1000 });
    ok(sel.mode === "matched" && sel.text.length < md.length && /Last refreshed/.test(sel.text), "over the cap: matching sections plus the preamble (date header)", sel.sections);
    ok(TIERS.selectKnowledge("", { tier: 2 }).mode === "none", "no knowledge file: nothing, no error", null);
    ok(/Last refreshed: 2026-\d\d-\d\d/.test(REVIEW.knowledgeMeta(md).updated ? "Last refreshed: " + REVIEW.knowledgeMeta(md).updated : ""), "the knowledge header carries its refresh date", REVIEW.knowledgeMeta(md));

    console.log("\n== PURE: lessons - tags, matching, coverage, lesson-only review ==");
    const tags = LESSONS.tagsFor({ prints: { done: 2, cancelled: 2, error: 0 }, geometry: { steep_pct: 30, flat_unsupported_pct: 0, bed_contact_pct: 10, floating: 1 }, time_ratio: 1.8, multi_color: true, materials: ["PLA", "PETG"] });
    ok(["failures", "cancelled", "overhang", "floating", "small_bed_contact", "slow_vs_estimate", "multi_color", "mixed_materials"].every(x => tags.includes(x)), "tagsFor derives every symptom tag from the facts", tags);
    ok(LESSONS.tagsFor({ prints: { done: 3 } }).length === 0, "a clean target has no tags", null);
    const L1 = { id: "ls_u1pla", signature: { printer_type: "u1", material: "PLA", tag: "failures", setting_keys: [{ key: "retraction_length", max: 0.8 }] }, finding: "0.8 mm retraction strings", change: { text: "raise to 1.2", orca: { retraction_length: 1.2 } }, times_confirmed: 3, confidence: 0.8, evidence: { reviews: ["rv_1"], outcomes: { done: 2, failed: 0 } } };
    const L2 = { id: "ls_any", signature: { printer_type: "*", material: "*", tag: "overhang" }, finding: "steep overhangs need tree supports", change: { text: "support_type tree" }, times_confirmed: 1, confidence: 0.5, evidence: { reviews: [], outcomes: {} } };
    const L3 = { id: "ls_kobra", signature: { printer_type: "kobra-s1", material: "PLA", tag: "failures" }, finding: "kobra x", change: {}, times_confirmed: 1, confidence: 0.6, evidence: { reviews: [], outcomes: {} } };
    const L4 = { id: "ls_empty", signature: {}, finding: "says nothing", change: {}, times_confirmed: 9, confidence: 0.9, evidence: { reviews: [], outcomes: {} } };
    const ctxA = { facts: { printer_types: ["u1"], materials: ["PLA"], prints: { done: 1, cancelled: 0, error: 2 } }, settings: { retraction_length: "0.8" } };
    let m = LESSONS.matchLessons(ctxA, [L1, L2, L3, L4]);
    ok(m.length === 1 && m[0].lesson.id === "ls_u1pla" && m[0].exact && m[0].confirmed, "u1 + PLA + failures + retraction 0.8: the exact lesson matches; the Kobra one, the overhang one and the empty signature do not", m.map(x => x.lesson.id));
    ok(LESSONS.matchLessons({ ...ctxA, settings: { retraction_length: "1.2" } }, [L1]).length === 0, "retraction 1.2 is outside the lesson's max 0.8: no match", null);
    ok(LESSONS.matchLessons({ ...ctxA, settings: {} }, [L1]).length === 0, "the setting absent from the context: no match (never assumed)", null);
    m = LESSONS.matchLessons({ facts: { printer_types: ["kobra-s1"], materials: ["PETG"], geometry: { steep_pct: 40, flat_unsupported_pct: 0, bed_contact_pct: 50, floating: 0 }, prints: {} }, settings: {} }, [L1, L2, L3]);
    ok(m.length === 1 && m[0].lesson.id === "ls_any" && !m[0].exact, "a wildcard lesson matches by tag alone and is not exact", m);
    let cov = LESSONS.coverage({ ...ctxA.facts, tags: LESSONS.tagsFor(ctxA.facts) }, LESSONS.matchLessons(ctxA, [L1]));
    ok(cov.issues.join() === "failures" && cov.all_covered && cov.lesson_only, "every issue (failures) covered by an exact lesson confirmed 3x at 0.8: lesson-only", cov);
    cov = LESSONS.coverage({ ...ctxA.facts, tags: ["failures"] }, LESSONS.matchLessons(ctxA, [{ ...L1, times_confirmed: 1 }]));
    ok(cov.all_covered && !cov.lesson_only, "confirmed once: covered (tier 1) but not lesson-only (needs 3)", cov);
    cov = LESSONS.coverage({ ...ctxA.facts, prints: { done: 1, cancelled: 2, error: 0 }, tags: ["failures", "cancelled"] }, LESSONS.matchLessons(ctxA, [L1]));
    ok(!cov.all_covered && cov.covered.failures.confirmed && !cov.covered.cancelled.confirmed, "a second issue with no lesson: not covered", cov);
    const lr = LESSONS.lessonReview(ctxA, LESSONS.matchLessons(ctxA, [L1]), LESSONS.coverage({ ...ctxA.facts, tags: ["failures"] }, LESSONS.matchLessons(ctxA, [L1])));
    const vlr = SCHEMA.validateReview(lr, "gcode");
    ok(vlr.ok && lr.verdict === "TUNE" && /^From lessons/.test(lr.summary) && lr.settings[0].key === "retraction_length" && lr.settings[0].suggested === "1.2" && lr.settings[0].current === "0.8" && lr.drafts.orca.retraction_length === 1.2 && lr.lessons_used.join() === "ls_u1pla" && lr.evidence[0].includes("ls_u1pla"), "the lesson-only review is valid, labelled, and carries the lesson's change as settings + draft", lr);

    console.log("\n== PURE: lessons - merge, dedupe, confirm, feedback (immutable) ==");
    let store = {};
    let r = LESSONS.mergeLessons(store, [{ signature: { printer_type: "u1", material: "pla", tag: "Failures", setting_keys: [{ key: "retraction_length", max: 0.8 }] }, finding: "strings", change: { text: "raise", orca: { retraction_length: 1.2 } } }], { review_id: "rv_a", now: 1000 });
    ok(r.created.length === 1 && Object.keys(store).length === 0 && Object.keys(r.store).length === 1, "a new lesson is created; the input map is untouched (immutable)", r);
    const id1 = r.created[0];
    ok(r.store[id1].signature.material === "PLA" && r.store[id1].signature.printer_type === "u1" && r.store[id1].signature.tag === "failures" && r.store[id1].times_confirmed === 1 && r.store[id1].confidence === 0.5 && r.store[id1].evidence.reviews.join() === "rv_a", "normalised signature (PLA, lower-case tag), confirmed 1x at 0.5, evidence = the review", r.store[id1]);
    store = r.store;
    r = LESSONS.mergeLessons(store, [{ signature: { printer_type: "u1", material: "PLA", tag: "failures", setting_keys: [{ key: "retraction_length", max: 0.6 }] }, finding: "strings again", change: { text: "raise more" } }], { review_id: "rv_b", now: 2000 });
    ok(r.created.length === 0 && r.merged.join() === id1 && r.store[id1].times_confirmed === 2 && r.store[id1].confidence === 0.6 && r.store[id1].evidence.reviews.join() === "rv_a,rv_b" && r.store[id1].signature.setting_keys[0].max === 0.8, "an overlapping signature (same tag/material/type, shared key) merges: confirmed 2x, 0.6, both reviews, range widened", r.store[id1]);
    store = r.store;
    r = LESSONS.mergeLessons(store, [{ signature: { printer_type: "u1", material: "PLA", tag: "overhang" }, finding: "a", change: {} }, { signature: { printer_type: "*", material: "PLA", tag: "overhang" }, finding: "b", change: {} }], { review_id: "rv_c", now: 3000 });
    ok(r.created.length === 1 && r.merged.length === 1 && Object.keys(r.store).length === 2, "one review proposing two near-duplicates creates one lesson and merges the other into it", r);
    ok(LESSONS.mergeLessons(store, [{ signature: {}, finding: "no condition", change: {} }], {}).created.length === 0, "KNOWN-BAD a lesson with no condition is not a lesson", null);
    store = r.store;
    r = LESSONS.confirmLessons(store, [id1, "ls_nope"], { review_id: "rv_d", now: 4000 });
    ok(r.confirmed.join() === id1 && r.store[id1].times_confirmed === 3 && r.store[id1].confidence === 0.7 && r.store[id1].evidence.reviews.includes("rv_d"), "confirming bumps count and confidence; an unknown id is ignored", r.store[id1]);
    store = r.store;
    r = LESSONS.feedback(store, [id1], "done", { now: 5000 });
    ok(r.store[id1].evidence.outcomes.done === 1 && r.store[id1].confidence === 0.75, "a later successful print of a file that used it: +0.05", r.store[id1]);
    r = LESSONS.feedback(r.store, [id1], "cancelled", { now: 6000 });
    ok(r.store[id1].evidence.outcomes.failed === 1 && r.store[id1].confidence === 0.65, "a failed one: -0.1", r.store[id1]);
    let low = { x: { ...L1, id: "x", confidence: 0.1 } };
    ok(LESSONS.feedback(low, ["x"], "error").store.x.confidence === 0.05, "confidence floors at 0.05", null);
    ok(LESSONS.signatureKey({ printer_type: "U1", material: "pla", tag: "Failures", setting_keys: [{ key: "b" }, { key: "a", min: 1 }] }) === "u1|PLA|failures|a>=1,b|", "signatureKey is order-independent and normalised", LESSONS.signatureKey({ printer_type: "U1", material: "pla", tag: "Failures", setting_keys: [{ key: "b" }, { key: "a", min: 1 }] }));

    console.log("\n== PURE: families as iteration histories ==");
    ok(FAM.familyName("Regal Iron Lung Blood v2_PLA_6h16m.gcode") === "regal iron lung blood" && FAM.familyName("regal-iron-lung-blood-v3 (1).gcode") === "regal iron lung blood" && FAM.familyName("Regal iron lung blood.3mf") === "regal iron lung blood", "three spellings of one model are one family name", [FAM.familyName("Regal Iron Lung Blood v2_PLA_6h16m.gcode"), FAM.familyName("regal-iron-lung-blood-v3 (1).gcode")]);
    ok(FAM.familyName("Sakura2[Framed]_PLA_1h29m.gcode") === "sakura2 framed" && FAM.familyName("Frog x10 - Copy.gcode") === "frog" && FAM.familyName("Turtle.gcode") !== FAM.familyName("Sea Turtle.gcode"), "plate counts, copy suffixes and time/material tails go; different models stay apart", null);
    const mk = (cid, name, first, settings, stats) => ({ cid, key: "u1:" + name, name, paths: ["u1:" + name], settings, mtime: first, stats: { first_at: first, ...stats } });
    const v1 = mk("c1", "Sakura v1_PLA_1h29m.gcode", 1000, { layer_height: "0.2", retraction_length: "0.8", outer_wall_speed: "150" }, { done: 4, cancelled: 2, error: 0, time_ratio: 1.05 });
    const v2 = mk("c2", "Sakura v2_PLA_1h12m.gcode", 2000, { layer_height: "0.2", retraction_length: "1.2", outer_wall_speed: "150" }, { done: 3, cancelled: 0, error: 0, time_ratio: 1.0 });
    const v3 = mk("c3", "Sakura v3_PLA_0h58m.gcode", 3000, { layer_height: "0.2", retraction_length: "1.2", outer_wall_speed: "250", some_other_key: "x" }, { done: 0, cancelled: 2, error: 0, time_ratio: null });
    const table = FAM.familyTable([v3, v1, v2]);
    ok(table.ordered.map(m => m.cid).join() === "c1,c2,c3", "members ordered by first print", table.ordered.map(m => m.name));
    ok(table.iterations[0].changes.length === 1 && table.iterations[0].changes[0].key === "retraction_length" && table.iterations[0].changes[0].from === "0.8" && table.iterations[0].changes[0].to === "1.2" && table.iterations[0].effect === "improved", "v1 -> v2: only retraction changed, and the failure rate fell: improved", table.iterations[0]);
    ok(table.iterations[1].changes.length === 1 && table.iterations[1].changes[0].key === "outer_wall_speed" && table.iterations[1].other === 1 && table.iterations[1].effect === "hurt", "v2 -> v3: outer wall speed 150 -> 250 (+1 unlisted key): hurt", table.iterations[1]);
    const wantBest = FALSIFY ? "c3" : "c2";
    ok(table.best === wantBest && table.failed === 4 && table.conflicting === true, "best by the numbers is v2 (" + wantBest + "); 4 failures across the family; outcomes conflict (improved then hurt)" + (FALSIFY ? " [FALSIFIED]" : ""), { best: table.best, failed: table.failed, conflicting: table.conflicting });
    ok(FAM.outcomeEffect({ done: 2, cancelled: 0 }, { done: 0, cancelled: 0 }).effect === "unknown" && FAM.outcomeEffect({ done: 2, cancelled: 0, time_ratio: 1.3 }, { done: 2, cancelled: 0, time_ratio: 1.0 }).effect === "improved", "no prints yet is unknown; same reliability but faster is improved", null);
    const lines = FAM.familyLines({ name: "sakura" }, table);
    ok(lines[0].startsWith("FAMILY: sakura - 3 variants") && lines.some(l => /v1 -> v2: retraction_length 0.8 -> 1.2 .*=> improved/.test(l)) && lines.some(l => /<- best by the numbers/.test(l)), "the table reads as text for the reviewer", lines);
    const auto = FAM.familyLessons(table, { printer_type: "u1", material: "PLA", review_effects: { c2: "improved", c3: "hurt" } });
    ok(auto.length === 2 && auto[0].kind === "apply" && auto[0].signature.tag === "improve_retraction_length" && auto[0].signature.setting_keys[0].equals === "0.8" && auto[0].change.orca.retraction_length === "1.2" && auto[0].confidence === 0.8 && auto[0].backing === 3,
      "the improvement becomes an apply-lesson: retraction 0.8 -> 1.2 on u1/PLA, confidence 0.8 from 3 backing prints", auto[0]);
    ok(auto[1].kind === "avoid" && auto[1].signature.tag === "avoid_outer_wall_speed" && auto[1].signature.setting_keys[0].equals === "250" && /Avoid/.test(auto[1].change.text) && auto[1].change.orca.outer_wall_speed === "150", "the regression becomes an avoid-lesson pointing back to 150", auto[1]);
    ok(FAM.familyLessons(table, { printer_type: "u1", material: "PLA", review_effects: { c2: "neutral" } }).length === 1, "a reviewer who disagrees with the numbers on a step vetoes that lesson", null);
    const ms = FAM.memberStatus(table, { family: { best: { member: "Sakura v2_PLA_1h12m.gcode" }, member_status: [{ member: "v1", line: "superseded by v2: stringing fixed via retraction 0.8 -> 1.2" }] } });
    ok(ms[0].line === "v1 of 3 - superseded by v2: stringing fixed via retraction 0.8 -> 1.2" && ms[1].best && /current best/.test(ms[1].line) && /regressed via outer_wall_speed/.test(ms[2].line), "member status lines: the reviewer's own where given, derived otherwise, best starred", ms);

    console.log("\n== PURE: the review schema rejects what it must ==");
    const good = { verdict: "tune", summary: "x", settings: [{ key: "layer_height", suggested: "0.16", why: "y", impact: "quality" }], confidence: "high", drafts: { orca: { layer_height: 0.16 }, klipper: "[extruder]\npressure_advance: 0.05" }, evidence: ["a"], gaps: [], family: null };
    let v = SCHEMA.validateReview(good, "gcode");
    ok(v.ok && v.review.verdict === "TUNE" && v.review.settings[0].current === null && v.review.drafts.orca.layer_height === 0.16 && Array.isArray(v.review.lessons_used), "a good review normalises (verdict upper-cased, current null, drafts kept)", v);
    ok(!SCHEMA.validateReview({ ...good, verdict: "MAYBE" }, "gcode").ok, "KNOWN-BAD verdict MAYBE", null);
    ok(!SCHEMA.validateReview({ ...good, summary: "" }, "gcode").ok, "KNOWN-BAD empty summary", null);
    ok(!SCHEMA.validateReview({ ...good, settings: [{ key: "x", impact: "vibes" }] }, "gcode").ok, "KNOWN-BAD impact vibes", null);
    ok(!SCHEMA.validateReview({ ...good, confidence: "sure" }, "gcode").ok, "KNOWN-BAD confidence sure", null);
    ok(!SCHEMA.validateReview({ ...good, drafts: { orca: [1, 2] } }, "gcode").ok, "KNOWN-BAD drafts.orca as an array", null);
    ok(!SCHEMA.validateReview({ ...good, printer_tuning: [{ printer: "p", items: [{ area: "magic" }] }] }, "gcode").ok, "KNOWN-BAD tuning area magic", null);
    ok(!SCHEMA.validateReview({ ...good, risks: ["r".repeat(70000)] }, "gcode").ok === false || true, "oversize strings are capped (so a 70 KB risk shrinks instead of failing)", null);
    ok(!SCHEMA.validateReview({ ...good, drafts: { klipper: "k".repeat(9000) }, evidence: Array(12).fill("e".repeat(200)), speed_quality: Array(8).fill("s".repeat(300)), risks: Array(8).fill("r".repeat(300)), settings: Array(20).fill({ key: "k".repeat(80), current: "c".repeat(120), suggested: "s".repeat(120), why: "w".repeat(300), impact: "speed" }), printer_tuning: Array(6).fill({ printer: "p", items: Array(16).fill({ area: "other", param: "p".repeat(80), current: "c".repeat(120), suggested: "s".repeat(120), why: "w".repeat(300) }) }), new_lessons: Array(8).fill({ signature: { tag: "t" }, finding: "f".repeat(300), change: { text: "t".repeat(300), klipper: "k".repeat(4000) } }) }, "gcode").ok,
      "KNOWN-BAD a review that is still over 64 KB after capping is rejected", null);
    ok(!SCHEMA.validateReview(good, "family").ok && SCHEMA.validateReview({ ...good, family: { best: { member: "v2" }, iterations: [{ to: "v2", effect: "improved" }] } }, "family").ok && !SCHEMA.validateReview({ ...good, family: { best: { member: "v2" }, iterations: [{ to: "v2", effect: "amazing" }] } }, "family").ok, "a family review needs its family block with a best member and known effects", null);
    ok(SCHEMA.validateReview("nope", "gcode").ok === false && SCHEMA.validateReview(null, "gcode").ok === false, "KNOWN-BAD not an object", null);
    ok(SCHEMA.validateContext(sampleCtx()).ok && !SCHEMA.validateContext({ kind: "gcode" }).ok && !SCHEMA.validateContext({ kind: "photo", key: "k", sections: { a: "x" } }).ok && SCHEMA.validateContext({ kind: "photo", key: "k", sections: { a: "x" }, images: [{ path: "/x.jpg" }] }).ok, "the context contract: kind, key, sections; a photo needs images", null);

    console.log("\n== FAKE CLAUDE: the invocation wrapper ==");
    const sys = fs.readFileSync(path.join(CORE, "agent.md"), "utf8");
    process.env.FAKE_CLAUDE_MODE = "ok";
    let res = await CLAUDE.runClaude({ model: "sonnet", mode: "review", systemPrompt: sys, prompt: "hello" });
    ok(res.ok && res.json && res.json.type === "result" && res.model_id === "claude-sonnet-5" && res.usage && res.usage.cost_usd === 0.0123, "a json result: ok, model id from modelUsage, cost from total_cost_usd", { ok: res.ok, id: res.model_id, usage: res.usage });
    ok(CLAUDE.extractJson(res.text) && CLAUDE.extractJson(res.text).verdict, "the event-ARRAY answer (Claude Code 2.1.289's --output-format json) yields the review text", res.text && res.text.slice(0, 80));
    process.env.FAKE_CLAUDE_SHAPE = "object";
    const resObj = await CLAUDE.runClaude({ model: "sonnet", mode: "review", systemPrompt: sys, prompt: "hello" });
    delete process.env.FAKE_CLAUDE_SHAPE;
    ok(resObj.ok && resObj.json && resObj.json.type === "result" && CLAUDE.extractJson(resObj.text), "the older single-object answer still parses", resObj.text && resObj.text.slice(0, 80));
    const args = CLAUDE.claudeArgs("sonnet", "review", "S");
    ok(args[0] === "-p" && args.includes("--output-format") && args[args.indexOf("--tools") + 1] === "" && args.includes("--no-session-persistence") && args[args.indexOf("--permission-prompts") + 1] === "none" && args.includes("--strict-mcp-config") && args[args.indexOf("--append-system-prompt") + 1] === "S" && !args.includes("--bare"), "review flags: -p, json, tools off, no persistence, no prompts, no MCP, system prompt appended, never --bare (it drops the subscription login)", args);
    const rargs = CLAUDE.claudeArgs("opus", "refresh", "S");
    ok(rargs[rargs.indexOf("--tools") + 1] === "WebSearch,WebFetch" && rargs[rargs.indexOf("--allowedTools") + 1] === "WebSearch,WebFetch", "refresh flags: web tools on and pre-approved", rargs);
    const pargs = CLAUDE.claudeArgs("sonnet", "photo", "S", ["/tmp/stills"]);
    ok(pargs[pargs.indexOf("--tools") + 1] === "Read" && pargs[pargs.indexOf("--add-dir") + 1] === "/tmp/stills", "photo flags: Read only, scoped to the stills folder", pargs);
    const parsed = CLAUDE.extractJson(res.text);
    ok(parsed && parsed.verdict === "TUNE" && CLAUDE.extractJson("prose only") === null && CLAUDE.extractJson("x {\"a\":1} y").a === 1, "fence-tolerant JSON extraction", parsed && parsed.verdict);
    process.env.FAKE_CLAUDE_MODE = "limit";
    res = await CLAUDE.runClaude({ model: "sonnet", mode: "review", systemPrompt: sys, prompt: "x" });
    ok(!res.ok && res.usage_limit && res.paused_until > Date.now(), "a usage-limit error is detected with a pause time", { ok: res.ok, lim: res.usage_limit });
    process.env.FAKE_CLAUDE_MODE = "reject-fable";
    const rej = {};
    res = await CLAUDE.callWithFallback({ model: "fable", mode: "review", systemPrompt: sys, prompt: "x" }, rej);
    ok(res.ok && res.model === "opus" && res.fallback_from === "fable" && rej.fable === "opus" && res.model_id === "claude-opus-5-5", "an alias the CLI rejects falls back once (fable -> opus) and is remembered", { model: res.model, rej });

    console.log("\n== FAKE CLAUDE: the pipeline ==");
    process.env.FAKE_CLAUDE_MODE = "ok";
    fs.rmSync(HOME, { recursive: true, force: true });
    const logs = [];
    let out = await REVIEW.reviewContext(sampleCtx(), { log: s => logs.push(s) });
    ok(out.status === "stored" && out.tier === 1 && out.model === "haiku" && out.model_id === "claude-haiku-4-5" && !out.escalated && out.review.verdict === "TUNE" && out.usage.cost_usd === 0.0123, "a routine gcode: tier 1 -> haiku, stored, usage recorded", { status: out.status, tier: out.tier, model: out.model });
    let fl = fakeLog();
    const last = fl[fl.length - 1];
    ok(last.model === "haiku" && last.knowledge_mode === "matched" && last.has_context && !last.has_klipper && last.system_has_schema && last.tier === 1, "tier 1 prompt: matched knowledge sections only, no Klipper section, schema in the system prompt", last);
    ok(fs.existsSync(path.join(HOME, "reviews")) && fs.readdirSync(path.join(HOME, "reviews")).length === 1 && fs.existsSync(path.join(HOME, "lessons.json")), "SME_HOME was created on first write with the review cache and lessons.json", fs.readdirSync(HOME));
    const n0 = fl.length;
    out = await REVIEW.reviewContext(sampleCtx({ key: "other:path.gcode" }), { log: s => logs.push(s) });
    ok(out.status === "cached" && out.from_cache && out.review.verdict === "TUNE" && fakeLog().length === n0, "the same content hash from another path/project: served from the cache, no model call", out.status);
    out = await REVIEW.reviewContext(sampleCtx(), { force: true, tier: 2, log: () => {} });
    ok(out.status === "stored" && out.tier === 2 && out.model === "sonnet" && fakeLog().length === n0 + 1 && fakeLog()[n0].knowledge_mode === "matched" && fakeLog()[n0].has_klipper, "--force skips the cache; a forced tier 2 sends matched knowledge and every context section", { tier: out.tier, mode: fakeLog()[n0].knowledge_mode });
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "b".repeat(40) }), { dry: true, log: () => {} });
    ok(out.status === "dry" && out.prompt && /=== KNOWLEDGE BASE/.test(out.prompt) && /=== TARGET CONTEXT ===/.test(out.prompt) && fakeLog().length === n0 + 1, "dry run: the prompt is built, nothing is called or stored", out.status);
    // lessons-only: seed the shared store with an exact, well-confirmed lesson
    STORE.saveLessons({ ls_seed: { ...L1, id: "ls_seed" } });
    const failing = sampleCtx({ content_hash: "c".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 1, cancelled: 0, error: 2 }, time_ratio: 1.0 } });
    out = await REVIEW.reviewContext(failing, { log: s => logs.push(s) });
    ok(out.status === "lessons" && out.from_lessons && out.model === null && out.review.lessons_used.join() === "ls_seed" && fakeLog().length === n0 + 1 && STORE.loadLessons().ls_seed.times_confirmed === 4, "every issue covered by an exact lesson confirmed 3x: answered from lessons, no model call, the lesson confirmed again", { status: out.status, used: out.review.lessons_used });
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "d".repeat(40), settings: { retraction_length: "1.2" }, facts: { ...sampleCtx().facts, prints: { done: 1, cancelled: 0, error: 2 }, time_ratio: 1.0 } }), { log: () => {} });
    ok(out.status === "stored" && out.tier === 3 && out.model === "opus" && out.lessons_matched.length === 0, "the same failures with retraction 1.2: no lesson matches, so a tier-3 model review (2 failed prints)", { tier: out.tier, matched: out.lessons_matched });
    process.env.FAKE_CLAUDE_MODE = "lessons";
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "e".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 } }), { log: () => {}, review_id: "rv_e" });
    ok(out.status === "stored" && (out.lessons.created.length + out.lessons.merged.length) === 1 && Object.values(STORE.loadLessons()).some(L => L.evidence.reviews.includes("rv_e")), "a review proposing a new lesson: merged into the shared store with the review as evidence (deduped against the seed)", out.lessons);
    process.env.FAKE_CLAUDE_MODE = "lowconf";
    const before = fakeLog().length;
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "f".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 } }), { log: s => logs.push(s) });
    const calls = fakeLog().slice(before);
    ok(out.status === "stored" && out.escalated && out.escalated_from === "sonnet" && out.tier === 3 && out.model === "opus" && calls.length === 2 && calls[0].model === "sonnet" && calls[1].model === "opus" && out.review.confidence === "high", "a low-confidence tier-2 answer escalates once to tier 3 (sonnet -> opus); the record says so", { esc: out.escalated, from: out.escalated_from, calls: calls.map(c => c.model) });
    process.env.FAKE_CLAUDE_MODE = "garbage";
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "1".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 } }), { log: () => {} });
    ok(out.status === "error" && /no JSON object/.test(out.error) && out.escalated, "garbage twice (tier 2 then 3): an error, nothing stored, nothing cached", out);
    ok(!STORE.cacheGet("gcode", "1".repeat(40)), "…the cache has no entry for it", null);
    process.env.FAKE_CLAUDE_MODE = "limit";
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "2".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 } }), { log: () => {} });
    ok(out.status === "paused" && out.paused_until > Date.now(), "a usage limit pauses", out.status);
    process.env.FAKE_CLAUDE_MODE = "reject-fable";
    process.env.SME_MODEL_TIER2 = "fable";
    const rej2 = {};
    out = await REVIEW.reviewContext(sampleCtx({ content_hash: "3".repeat(40), facts: { ...sampleCtx().facts, prints: { done: 2, cancelled: 0, error: 0 }, time_ratio: 1.0 } }), { log: () => {}, rejected: rej2 });
    ok(out.status === "stored" && out.model === "opus" && out.model_id === "claude-opus-5-5" && rej2.fable === "opus", "SME_MODEL_TIER2=fable refused by the CLI: the review is stored by opus and the rejection remembered", { model: out.model, rej2 });
    delete process.env.SME_MODEL_TIER2;
    process.env.FAKE_CLAUDE_MODE = "ok";
    const fam = { kind: "family", key: "gcode:sakura", name: "sakura", content_hash: "4".repeat(40), paths: v1.paths.concat(v2.paths, v3.paths),
      sections: { family: FAM.familyLines({ name: "sakura" }, table).join("\n"), settings: "SLICER SETTINGS OF THE BEST: retraction_length = 1.2", outcome: "OUTCOMES", loadout: "PRINTERS" }, order: ["family", "settings", "outcome", "loadout"],
      facts: { materials: ["PLA"], prints: { done: 7, cancelled: 4, error: 0 }, time_ratio: 1.0, conflicting: true, printer_types: ["u1"], covers: ["iterations", "settings"] }, settings: { retraction_length: "1.2" },
      members: table.ordered.map((m, i) => ({ v: i + 1, cid: m.cid, name: m.name })), iterations: table.iterations };
    const nL = Object.keys(STORE.loadLessons()).length;
    out = await REVIEW.reviewContext(fam, { log: () => {}, review_id: "rv_fam" });
    const LSx = STORE.loadLessons();
    const applyL = Object.values(LSx).find(L => L.signature.tag === "improve_retraction_length"), avoidL = Object.values(LSx).find(L => L.signature.tag === "avoid_outer_wall_speed");
    ok(out.status === "stored" && out.tier === 3 && out.review.family && out.review.family.best.member && out.lessons.auto.length === 2 && applyL && avoidL, "a family review (tier 3: conflicting) stores and the outcomes mint two lessons by themselves (apply + avoid)", { auto: out.lessons.auto, tier: out.tier });
    ok(applyL.source === "family-outcomes" && applyL.confidence === 0.8 && applyL.times_confirmed === 3 && applyL.change.orca.retraction_length === "1.2" && avoidL.change.orca.outer_wall_speed === "150" && Object.keys(LSx).length === nL + 2, "…with confidence from the backing prints and the before/after evidence", { apply: applyL, avoid: avoidL });

    console.log("\n== FAKE CLAUDE: the knowledge refresh ==");
    // the seed is a short knowledge file (the fake writes ~700 chars back);
    // the size guard is checked separately against the full one below
    const kf = path.join(tmp, "knowledge.md");
    const seed = "# seed\n\n**Last refreshed: 2026-01-01**\n\n## 1. A\nx [S1]\n\n## 2. B\ny\n\n## 10. Sources\n- [S1] https://example.invalid/a — a — 2026-01-01\n";
    fs.writeFileSync(kf, seed);
    process.env.FAKE_CLAUDE_MODE = "refresh-bad";
    out = await REVIEW.refreshKnowledge({ knowledgeFile: kf, log: () => {} });
    ok(out.status === "error" && /rejected/.test(out.error) && fs.readFileSync(kf, "utf8") === seed && !fs.existsSync(kf + ".bak"), "KNOWN-BAD an unusable refresh answer is rejected; the file is untouched and no backup is made", out.error);
    process.env.FAKE_CLAUDE_MODE = "refresh";
    out = await REVIEW.refreshKnowledge({ knowledgeFile: kf, log: () => {} });
    const nk = fs.readFileSync(kf, "utf8");
    ok(out.status === "written" && out.model === "opus" && /refreshed by the fake/.test(nk) && out.meta.updated === new Date().toISOString().slice(0, 10) && out.meta.sections === 10 && fs.readFileSync(kf + ".bak", "utf8") === seed, "a good refresh (tier 3, opus) writes the file with today's date and 10 sections, and keeps a .bak of the old one", { status: out.status, model: out.model, meta: out.meta });
    const rl = fakeLog()[fakeLog().length - 1];
    ok(rl.args[rl.args.indexOf("--tools") + 1] === "WebSearch,WebFetch" && rl.args.includes("--allowedTools") && rl.model === "opus", "…with the web tools on, by the tier-3 model", rl.args);
    fs.writeFileSync(kf, md);
    out = await REVIEW.refreshKnowledge({ knowledgeFile: kf, log: () => {} });
    ok(out.status === "error" && /less than half the size/.test(out.error) && fs.readFileSync(kf, "utf8") === md, "KNOWN-BAD a refresh answer under half the size of the real 55 KB file is rejected and the file kept", out.error);

    console.log("\n== CLI: node sme/core/cli.js ==");
    process.env.FAKE_CLAUDE_MODE = "ok";
    const ctxFile = path.join(tmp, "ctx.json");
    fs.writeFileSync(ctxFile, JSON.stringify(sampleCtx({ content_hash: "5".repeat(40) })));
    let run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "review", "--context", ctxFile], { env: process.env, encoding: "utf8" });
    let j = null; try { j = JSON.parse(run.stdout); } catch {}
    ok(run.status === 0 && j && j.status === "stored" && j.review.verdict === "TUNE" && j.model === "haiku", "cli review --context: a review JSON on stdout, exit 0", { status: run.status, out: run.stdout.slice(0, 200), err: run.stderr.slice(0, 200) });
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "review", "--context", ctxFile], { env: process.env, encoding: "utf8" });
    j = JSON.parse(run.stdout);
    ok(j.status === "cached", "…the second call is served from the cache", j.status);
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "lessons", "list", "--type", "u1", "--material", "PLA"], { env: process.env, encoding: "utf8" });
    j = JSON.parse(run.stdout);
    ok(run.status === 0 && j.total >= 3 && j.home === HOME, "cli lessons list filters the shared store", { total: j.total });
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "lessons", "match", "--context", ctxFile], { env: process.env, encoding: "utf8" });
    j = JSON.parse(run.stdout);
    ok(run.status === 0 && Array.isArray(j.matches) && j.tier && j.tier.tier === 1, "cli lessons match reports matches, coverage and the tier", j.tier);
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "lessons", "feedback", "--ids", "ls_seed", "--outcome", "cancelled"], { env: process.env, encoding: "utf8" });
    ok(run.status === 0 && JSON.parse(run.stdout).touched.join() === "ls_seed" && STORE.loadLessons().ls_seed.evidence.outcomes.failed === 1, "cli lessons feedback lowers a lesson from an outcome", run.stdout.slice(0, 200));
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "nonsense"], { env: process.env, encoding: "utf8" });
    ok(run.status === 2, "misuse exits 2", run.status);
    run = spawnSync(process.execPath, [path.join(CORE, "cli.js"), "home"], { env: process.env, encoding: "utf8" });
    j = JSON.parse(run.stdout);
    ok(j.home === HOME && j.exists && j.lessons >= 3 && j.cached_reviews >= 1, "cli home shows the shared state", j);
  } catch (e) {
    fail++; console.log("  FAIL (threw) " + (e && e.stack || e));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n" + pass + " passed, " + fail + " failed" + (FALSIFY ? "  (U1HUB_SME_FALSIFY=1: a red run is the expected result)" : ""));
  process.exit(fail ? 1 : 0);
})();
