// sme/core/store.js — the SME's shared state on disk: SME_HOME. Part of the
// SME core (no Hub dependency). One directory every 3D-printing project on
// the machine reads and writes through this module, so lessons learned in
// one project are known solutions in the next:
//
//   $SME_HOME/lessons.json        { lessons: { id: lesson }, saved }   the one source of truth
//   $SME_HOME/reviews/<kind>-<content_hash>.json   the review cache: a review of the
//                                 same content (same hash) is served from here
//   $SME_HOME/knowledge.md        optional: a shared copy the refresh writes
//                                 (the repo's sme/core/knowledge.md is the default)
//
// SME_HOME defaults to /mnt/e/Code/print-sme-data and is created on first
// write, never by a checkout. Writes are tmp+rename with a direct-write
// fallback (a share can refuse rename-over-existing).

"use strict";

const fs = require("fs");
const path = require("path");
const LESSONS = require("./lessons.js");

const DEFAULT_HOME = "/mnt/e/Code/print-sme-data";
const home = () => path.resolve(process.env.SME_HOME || DEFAULT_HOME);
const lessonsFile = () => path.join(home(), "lessons.json");
const reviewsDir = () => path.join(home(), "reviews");
const knowledgeFile = () => path.join(home(), "knowledge.md");

function ensureHome() { fs.mkdirSync(reviewsDir(), { recursive: true }); return home(); }
function writeJson(file, obj) {
  ensureHome();
  const data = JSON.stringify(obj, null, 1), tmp = file + ".tmp";
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, data); try { fs.unlinkSync(tmp); } catch {} }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }

// ---- lessons: the source of truth ------------------------------------------------------------
function loadLessons() { const j = readJson(lessonsFile(), null); return j && j.lessons && typeof j.lessons === "object" ? j.lessons : {}; }
function saveLessons(map) { writeJson(lessonsFile(), { lessons: map, saved: Date.now(), by: "sme/core" }); return map; }
// Apply one review's lesson effects to the store: new lessons merged, applied
// ones confirmed, family-outcome lessons merged. -> { store, created, merged, confirmed, auto }
function absorb(review, auto, meta) {
  let store = loadLessons();
  const out = { created: [], merged: [], confirmed: [], auto: [] };
  let r = LESSONS.mergeLessons(store, review.new_lessons, { ...meta, source: "review" }); store = r.store; out.created.push(...r.created); out.merged.push(...r.merged);
  r = LESSONS.confirmLessons(store, [...new Set([...(review.confirmed_lessons || []), ...(review.lessons_used || [])])], meta); store = r.store; out.confirmed.push(...r.confirmed);
  if (auto && auto.length) {
    r = LESSONS.mergeLessons(store, auto, { ...meta, source: "family-outcomes" }); store = r.store; out.auto.push(...r.created, ...r.merged);
    for (const id of r.created) { const a = auto.find(x => LESSONS.signatureKey(x.signature) === LESSONS.signatureKey(store[id].signature)); if (a) store[id] = { ...store[id], confidence: a.confidence, times_confirmed: Math.min(5, a.backing || 1), kind: a.kind }; }
  }
  saveLessons(store);
  return { store, ...out };
}
// Outcome feedback (a later print of a file whose review used these lessons).
function applyFeedback(ids, outcome, meta) { const r = LESSONS.feedback(loadLessons(), ids, outcome, meta); saveLessons(r.store); return r; }

// ---- the review cache ---------------------------------------------------------------------------
const safe = s => String(s || "").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
function cacheFile(kind, hash) { return path.join(reviewsDir(), safe(kind) + "-" + safe(hash) + ".json"); }
function cacheGet(kind, hash) { if (!hash) return null; const j = readJson(cacheFile(kind, hash), null); return j && j.review ? j : null; }
function cachePut(kind, hash, rec) { if (!hash) return; writeJson(cacheFile(kind, hash), { ...rec, cached_at: Date.now() }); }

module.exports = { DEFAULT_HOME, home, ensureHome, lessonsFile, reviewsDir, knowledgeFile, loadLessons, saveLessons, absorb, applyFeedback, cacheGet, cachePut, readJson, writeJson };
