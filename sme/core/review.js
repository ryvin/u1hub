// sme/core/review.js — the review pipeline. Part of the SME core (no Hub
// dependency): a context (CONTEXT.md) in, a validated review out, with
// lessons matched before and merged after, the tier picked by difficulty, one
// escalation when the answer is weak, the review cache consulted first.
//
//   reviewContext(ctx, opts) -> { status: "stored"|"cached"|"lessons"|"dry"|"paused"|"error",
//                                 review, tier, model, model_id, escalated, escalated_from,
//                                 usage, lessons: { created, merged, confirmed, auto },
//                                 prompt_chars, knowledge_sections, knowledge_mode,
//                                 paused_until, error }
//   opts: { bin, cwd, agentFile, knowledgeFile, dry, force (skip the cache),
//           tier (1|2|3 to force), log(fn), rejected (map kept across calls),
//           timeoutMs, local: [{ title, text }] (adapter-side extra blocks) }

"use strict";

const fs = require("fs");
const path = require("path");
const TIERS = require("./tiers.js");
const LESSONS = require("./lessons.js");
const FAM = require("./family.js");
const SCHEMA = require("./schema.js");
const CLAUDE = require("./claude.js");
const STORE = require("./store.js");

const CORE_DIR = __dirname;
const AGENT_FILE = () => path.resolve(process.env.SME_AGENT_FILE || path.join(CORE_DIR, "agent.md"));
// The knowledge base: SME_KNOWLEDGE_FILE, else the shared copy in SME_HOME
// when a refresh has written one, else the repo's sme/core/knowledge.md.
function knowledgeFile() {
  if (process.env.SME_KNOWLEDGE_FILE) return path.resolve(process.env.SME_KNOWLEDGE_FILE);
  const shared = STORE.knowledgeFile();
  return fs.existsSync(shared) ? shared : path.join(CORE_DIR, "knowledge.md");
}
function knowledgeText(file) { try { return fs.readFileSync(file || knowledgeFile(), "utf8"); } catch { return ""; } }
function knowledgeMeta(md) {
  const m = /Last refreshed:\s*\**\s*(\d{4}-\d{2}-\d{2})/i.exec(md || "");
  return { updated: m ? m[1] : null, bytes: Buffer.byteLength(md || ""), sections: TIERS.knowledgeSections(md).filter(s => s.heading).length };
}

// Which knowledge.md headings a printer type pulls in when only matching
// sections are sent (tier 1): §2 "Snapmaker U1" + §2b "paxx12 ... U1 Extended
// Firmware" for a U1 (and multiACE, which lives in §2b, for a printer that
// has it), §3 for the Kobra, §6 filament rows for the material.
const TYPE_TERMS = { u1: ["Snapmaker U1", "U1", "paxx12"], "kobra-s1": ["Kobra S1", "Kobra", "Rinkhals"] };
function knowledgeFor(ctx, tier, md) {
  const f = ctx.facts || {}, fw = ctx.firmware || f.firmware || {};
  const terms = [].concat(...(f.printer_types || []).map(t => TYPE_TERMS[t] || [t]), (fw.multiace || /davinci/i.test(String(ctx.name))) ? ["multiACE"] : []);
  const sel = TIERS.selectKnowledge(md, { tier, materials: f.materials || [], printerTypes: terms, terms: tier === 1 ? ["Filaments"] : (tier === 2 ? ["Filaments", "Orca", "Speed", "Failure"] : []) });
  if (tier === 1 && sel.text) {
    const mats = (f.materials || []).map(m => String(m).toUpperCase());
    sel.text = sel.text.split("\n").filter(l => !/^\|/.test(l) || /^\|\s*-/.test(l) || /^\|\s*(Material|Filament|Thing|Item)/i.test(l) || mats.some(m => l.toUpperCase().includes(m))).join("\n");
  }
  return sel;
}
// Lessons for a target, from the shared store, and the lines the reviewer reads.
function lessonsFor(ctx, store) {
  const facts = ctx.facts || {};
  const tags = facts.tags || LESSONS.tagsFor(facts);
  const matches = LESSONS.matchLessons({ facts: { ...facts, tags }, settings: ctx.settings || {} }, store);
  const cov = LESSONS.coverage({ ...facts, tags }, matches);
  const lines = matches.length ? ["KNOWN SOLUTIONS (lessons this farm already confirmed; apply and cite by id, do not re-derive):"] : ["KNOWN SOLUTIONS: none match this target yet"];
  for (const m of matches.slice(0, 8)) {
    const L = m.lesson, ch = L.change || {};
    lines.push("  [" + L.id + "] " + (m.exact ? "exact" : "partial") + " match, confirmed " + (L.times_confirmed || 0) + "x, confidence " + (L.confidence || 0) + " (outcomes after use: " + ((L.evidence.outcomes || {}).done || 0) + " done / " + ((L.evidence.outcomes || {}).failed || 0) + " failed): " + L.finding +
               (ch.text ? " -> " + ch.text : "") + (ch.orca ? " Orca " + JSON.stringify(ch.orca) : ""));
  }
  return { tags, matches, cov, text: lines.join("\n") };
}
function buildPrompt(ctx, tier, md, lessonsText, local) {
  const kb = knowledgeFor(ctx, tier, md);
  const only = TIERS.sectionsForTier(ctx.kind, tier);
  const order = (ctx.order || Object.keys(ctx.sections)).filter(k => k !== "lessons" && (!only || only.includes(k)));
  const loc = (tier >= 2 && local && local.length) ? "\n\n=== LOCAL SOURCES (read-only files and services on this PC) ===\n" + local.map(b => b.title + "\n" + b.text).join("\n\n") : "";
  const imgs = (ctx.images || []).length ? "\n\nIMAGES (read each with the Read tool before judging): " + ctx.images.map(i => i.path + (i.caption ? " - " + i.caption : "")).join("; ") : "";
  const body = order.map(k => ctx.sections[k]).filter(Boolean).join("\n\n") + "\n\n" + lessonsText + loc + imgs;
  const what = ctx.kind === "family" ? "a FAMILY of " + (ctx.members || []).length + " gcode variants of one model (an iteration history)" : ctx.kind === "printer" ? "a PRINTER's Klipper configuration (tuning review)" : ctx.kind === "3mf" ? "a 3MF project (pre-slicing review)" : ctx.kind === "photo" ? "PHOTOS of a finished print (visual quality review)" : "a sliced GCODE file";
  const head = "Review " + what + ": " + ctx.name + " (kind " + ctx.kind + ", key " + ctx.key + ", tier " + tier + ").\n" +
    (ctx.paths && ctx.paths.length > 1 ? "The same content exists at " + ctx.paths.length + " paths; review it once.\n" : "") +
    (ctx.kind === "family" ? "Answer the family questions (which changes helped or hurt, which variant is best, ONE next experiment, a status line per variant) in the family block.\n" : "");
  const text = head + "\n=== KNOWLEDGE BASE (knowledge.md, " + kb.mode + (kb.sections.length ? ": " + kb.sections.slice(0, 6).join(" | ") : "") + ") ===\n" + (kb.text || "(no section applies to this target)") +
    "\n\n=== TARGET CONTEXT ===\n" + body + "\n\n=== OUTPUT ===\nReturn ONLY the JSON object described in your system prompt. No fence, no prose." + (ctx.kind === "family" ? " Include the family block." : " Set family to null.");
  return { text, knowledge_sections: kb.sections, knowledge_mode: kb.mode };
}
// Lessons the family's outcomes justify (sme/core/family.js), from the
// context's own iteration table and the reviewer's verdict on each step.
function familyAuto(ctx, review) {
  if (ctx.kind !== "family" || !ctx.iterations || !ctx.members) return [];
  const table = { ordered: ctx.members.map(m => ({ cid: m.cid, name: m.name })), iterations: ctx.iterations };
  const effects = {};
  for (const it of ((review.family && review.family.iterations) || [])) { const m = table.ordered.find((x, i) => x.name === it.to || x.cid === it.to || ("v" + (i + 1)) === it.to); if (m) effects[m.cid] = it.effect; }
  const f = ctx.facts || {};
  return FAM.familyLessons(table, { printer_type: (f.printer_types || [])[0], material: (f.materials || [])[0], geometry_flags: [], review_effects: effects, issue_tag: null });
}

async function reviewContext(ctx, opts) {
  const o = opts || {}, log = o.log || (() => {});
  const vc = SCHEMA.validateContext(ctx);
  if (!vc.ok) return { status: "error", error: "context: " + vc.error };
  const store = STORE.loadLessons();
  const ls = lessonsFor(ctx, store);
  const facts = { ...(ctx.facts || {}), kind: ctx.kind, tags: ls.tags, lessons_cover_all: ls.cov.all_covered };
  const tier0 = o.tier && [1, 2, 3].includes(Number(o.tier)) ? Number(o.tier) : TIERS.pickTier(facts).tier;
  const reasons = o.tier ? ["forced"] : TIERS.pickTier(facts).reasons;
  // 0. the cache: the same content reviewed before, in any project
  const cached = !o.force && STORE.cacheGet(ctx.kind, ctx.content_hash);
  if (cached) { log("cached review of this content (" + (cached.model_id || cached.model || "?") + ", " + new Date(cached.cached_at).toISOString() + ")"); return { status: "cached", review: cached.review, tier: cached.tier, model: cached.model, model_id: cached.model_id, escalated: !!cached.escalated, escalated_from: cached.escalated_from || null, usage: cached.usage || null, lessons: { created: [], merged: [], confirmed: [], auto: [] }, lessons_matched: ls.matches.map(m => m.lesson.id), prompt_chars: cached.prompt_chars || null, knowledge_sections: cached.knowledge_sections || [], knowledge_mode: cached.knowledge_mode || null, from_cache: true }; }
  // 1. known solutions cover every issue: no model call
  if (ls.cov.lesson_only) {
    const review = LESSONS.lessonReview({ facts, settings: ctx.settings || {} }, ls.matches, ls.cov);
    log("from lessons (" + review.lessons_used.join(", ") + "), no model call");
    if (o.dry) return { status: "dry", tier: 1, model: null, review, lessons_matched: review.lessons_used };
    const lessons = STORE.absorb(review, [], { review_id: o.review_id, now: Date.now() });
    STORE.cachePut(ctx.kind, ctx.content_hash, { review, tier: 1, model: null, model_id: "lessons", from_lessons: true, key: ctx.key, name: ctx.name });
    return { status: "lessons", review, tier: 1, model: null, model_id: "lessons", escalated: false, usage: null, lessons: { created: lessons.created, merged: lessons.merged, confirmed: lessons.confirmed, auto: [] }, lessons_matched: review.lessons_used, from_lessons: true };
  }
  // 2. the model, with one escalation
  let systemPrompt = ""; try { systemPrompt = fs.readFileSync(o.agentFile || AGENT_FILE(), "utf8"); } catch { return { status: "error", error: "agent prompt missing: " + (o.agentFile || AGENT_FILE()) }; }
  const md = knowledgeText(o.knowledgeFile);
  let tier = tier0, escalated = false, escalatedFrom = null, lastError = null;
  const rejected = o.rejected || {};
  const addDirs = ctx.kind === "photo" ? [...new Set((ctx.images || []).map(i => path.dirname(path.resolve(i.path))))] : [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const model = rejected[TIERS.modelForTier(tier, process.env)] || TIERS.modelForTier(tier, process.env);
    const prompt = buildPrompt(ctx, tier, md, ls.text, o.local);
    log("tier " + tier + " -> " + model + (escalated ? " (escalated from " + escalatedFrom + ")" : "") + ", prompt " + prompt.text.length + " chars, knowledge " + prompt.knowledge_mode + " [" + reasons.join("; ") + "]");
    if (o.dry) return { status: "dry", tier, model, prompt: prompt.text, prompt_chars: prompt.text.length, knowledge_sections: prompt.knowledge_sections, knowledge_mode: prompt.knowledge_mode, lessons_matched: ls.matches.map(m => m.lesson.id) };
    const res = await CLAUDE.callWithFallback({ model, mode: ctx.kind === "photo" ? "photo" : "review", systemPrompt, prompt: prompt.text, bin: o.bin, cwd: o.cwd, timeoutMs: o.timeoutMs, addDirs }, rejected);
    if (res.fallback_from) log("model " + res.fallback_from + " rejected by the CLI; fell back to " + res.model);
    if (res.usage_limit) { log("usage limit: " + (res.text || res.err || "").trim().split("\n")[0].slice(0, 200)); return { status: "paused", paused_until: res.paused_until, tier, model: res.model, error: "usage limit" }; }
    const modelId = res.model_id || res.model;
    if (!res.ok) { lastError = res.timed_out ? "timed out after " + res.ms + " ms" : "claude failed (exit " + res.code + "): " + (res.text || res.err || res.error || "").trim().slice(0, 300); log(lastError); break; }
    const parsed = CLAUDE.extractJson(res.text);
    const v = parsed ? SCHEMA.validateReview(parsed, ctx.kind) : { ok: false, error: "no JSON object in the answer: " + String(res.text || "").slice(0, 120) };
    const esc = TIERS.shouldEscalate(v.ok ? v.review : null, facts, v);
    if (v.ok && (!esc.escalate || escalated || tier >= 3)) {
      const review = v.review;
      const lessons = STORE.absorb(review, familyAuto(ctx, review), { review_id: o.review_id, now: Date.now() });
      const rec = { review, tier, model: res.model, model_id: modelId, escalated, escalated_from: escalatedFrom, usage: res.usage, runtime_ms: res.ms, prompt_chars: prompt.text.length, knowledge_sections: prompt.knowledge_sections, knowledge_mode: prompt.knowledge_mode, key: ctx.key, name: ctx.name };
      STORE.cachePut(ctx.kind, ctx.content_hash, rec);
      return { status: "stored", ...rec, lessons: { created: lessons.created, merged: lessons.merged, confirmed: lessons.confirmed, auto: lessons.auto }, lessons_matched: ls.matches.map(m => m.lesson.id), kept_despite: esc.escalate ? esc.reason : null };
    }
    if (esc.escalate && !escalated && tier < 3) { log("escalating one tier: " + esc.reason); escalated = true; escalatedFrom = res.model; tier++; lastError = esc.reason; continue; }
    lastError = v.ok ? esc.reason : "review rejected: " + v.error; log(lastError); break;
  }
  return { status: "error", error: lastError || "unknown", tier, escalated, escalated_from: escalatedFrom };
}

// ---- the monthly knowledge refresh ------------------------------------------------------------------
const REFRESH_INSTRUCTION = [
  "You maintain the knowledge base below for a 3D-printing SME reviewer (two Snapmaker U1 toolchangers on paxx12's Extended Firmware and SnapmakerOrca, one Anycubic Kobra S1 + ACE Pro on Rinkhals; PLA / PETG / TPU; OrcaSlicer keys; Klipper tuning).",
  "Refresh it with web research: check every version number, release date, profile default and claim against its primary source today, update what changed since the last refresh, add what is new and relevant (firmware, SnapmakerOrca / OrcaSlicer / Rinkhals / paxx12 / multiACE releases, filament data sheets, Klipper calibration practice), remove nothing that is still true, and keep the same section structure and numbering.",
  "Every fact keeps or gains a [Sn] source tag resolving to a URL + title + date read in the Sources section. Mark anything you could not confirm from a primary source UNVERIFIED rather than dropping or asserting it.",
  "Set the header line to 'Last refreshed: " + new Date().toISOString().slice(0, 10) + "' and keep a 'What changed recently' section current.",
  "Output ONLY the complete new markdown file, starting with its '# ' title line. No commentary before or after."
].join(" ");
// -> { status: "written"|"dry"|"paused"|"error", file, meta, backup, model, usage, error, paused_until }
async function refreshKnowledge(opts) {
  const o = opts || {}, log = o.log || (() => {});
  const file = o.knowledgeFile || knowledgeFile();
  const old = knowledgeText(file);
  const model = (o.rejected || {})[TIERS.modelForTier(3, process.env)] || TIERS.modelForTier(3, process.env);
  const prompt = REFRESH_INSTRUCTION + "\n\n=== CURRENT KNOWLEDGE BASE (" + file + ", " + old.length + " chars) ===\n" + (old || "(empty - write the first version with the sections: header/scope, Snapmaker U1, paxx12 Extended Firmware, Kobra S1 + ACE + Rinkhals, Orca Slicer, Klipper tuning, Filaments, Speed vs quality playbook, Failure modes, What changed recently, Sources)");
  log("refresh: " + model + ", " + prompt.length + " chars of prompt, web tools on, target " + file);
  if (o.dry) return { status: "dry", file, model, prompt_chars: prompt.length };
  const res = await CLAUDE.callWithFallback({ model, mode: "refresh", systemPrompt: "You are a careful technical researcher. Cite primary sources with URLs and the date read.", prompt, bin: o.bin, cwd: o.cwd, timeoutMs: o.timeoutMs || 3600000 }, o.rejected || {});
  if (res.usage_limit) return { status: "paused", paused_until: res.paused_until, model: res.model, error: "usage limit" };
  if (!res.ok) return { status: "error", error: "refresh failed: " + (res.text || res.err || res.error || "").slice(0, 300), model: res.model };
  const md = String(res.text || "").replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim() + "\n";
  const meta = knowledgeMeta(md);
  const problems = [];
  if (!/^# /.test(md)) problems.push("does not start with a '# ' title");
  if (!meta.updated) problems.push("no 'Last refreshed: YYYY-MM-DD' line");
  if (meta.sections < 5) problems.push("only " + meta.sections + " sections");
  if (!/https?:\/\//.test(md)) problems.push("no source URLs");
  if (old && md.length < old.length * 0.5) problems.push("less than half the size of the current file (" + md.length + " vs " + old.length + ")");
  if (problems.length) return { status: "error", error: "refresh output rejected: " + problems.join("; "), model: res.model, usage: res.usage };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (old) fs.writeFileSync(file + ".bak", old); fs.writeFileSync(file, md); }
  catch (e) { return { status: "error", error: "could not write " + file + ": " + e.message }; }
  log("refresh: wrote " + md.length + " chars, " + meta.sections + " sections, updated " + meta.updated + " (backup: " + path.basename(file) + ".bak)");
  return { status: "written", file, meta, backup: old ? file + ".bak" : null, model: res.model, model_id: res.model_id, usage: res.usage };
}

module.exports = { AGENT_FILE, knowledgeFile, knowledgeText, knowledgeMeta, knowledgeFor, lessonsFor, buildPrompt, familyAuto, reviewContext, refreshKnowledge, REFRESH_INSTRUCTION, TYPE_TERMS };
