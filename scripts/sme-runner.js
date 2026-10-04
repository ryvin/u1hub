#!/usr/bin/env node
// scripts/sme-runner.js — u1hub's SME runner: the ADAPTER between the Hub and
// the SME core (sme/core/). Fork (ryvin/u1hub). Runs on the Hub PC from a
// scheduled task (hourly; monthly with --refresh-knowledge):
//   1. pulls the queue and one context per target from the Hub's sme module,
//   2. adds runner-side local sources (scripts/sme-local-sources.js),
//   3. hands each context to the core pipeline (sme/core/review.js), which
//      checks the shared review cache, applies known lessons, routes to the
//      cheapest model that can do the job via Claude Code headless on the
//      person's own subscription, validates, escalates once if weak, and
//      merges lessons into SME_HOME/lessons.json (the store of record),
//   4. posts the review to the Hub and syncs the Hub's lessons mirror.
// It never touches a printer, a gcode, config.json or the print queue; its
// own files are sme-runner.lock / .json / .log beside this repo.
//
//   node scripts/sme-runner.js                 review the next SME_BATCH targets
//   node scripts/sme-runner.js --dry-run       build the prompts, call nothing, store nothing
//   node scripts/sme-runner.js --refresh-knowledge   monthly: rewrite knowledge.md with web research (tier 3)
//   node scripts/sme-runner.js --kind gcode --key "u1:file.gcode" [--force]   one target
//
// Env: HUB_URL (http://127.0.0.1:4545), SME_TOKEN (else GET /api/sme/token),
// SME_BATCH (4), SME_HOME (the shared state, sme/core/store.js), SME_MODEL,
// SME_MODEL_TIER1/2/3, CLAUDE_BIN, SME_TIMEOUT_MS, SME_PAUSE_MS (2000 between
// targets), SME_STATE_DIR (this repo), SME_AGENT_FILE, SME_KNOWLEDGE_FILE,
// SME_QUEUE_WAIT_MS (600000: the Hub hashes a big shelf on its first build),
// plus the local-source paths in scripts/sme-local-sources.js.
// Exit code 0 for every handled outcome (a usage limit pauses and exits 0 so
// the scheduler never sees a failure storm); 2 for a misuse.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const REVIEW = require("../sme/core/review.js");
const STORE = require("../sme/core/store.js");
const LOCAL = require("./sme-local-sources.js");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.resolve(process.env.SME_STATE_DIR || ROOT);
const HUB = String(process.env.HUB_URL || "http://127.0.0.1:4545").replace(/\/+$/, "");
const BATCH = Math.max(1, parseInt(process.env.SME_BATCH, 10) || 4);
const PAUSE_MS = Math.max(0, Number(process.env.SME_PAUSE_MS ?? 2000));
const QUEUE_WAIT_MS = Math.max(0, Number(process.env.SME_QUEUE_WAIT_MS ?? 600000));
const LOCK = path.join(STATE_DIR, "sme-runner.lock"), STATE = path.join(STATE_DIR, "sme-runner.json"), LOGF = path.join(STATE_DIR, "sme-runner.log");
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DRY = flag("--dry-run"), REFRESH = flag("--refresh-knowledge"), FORCE = flag("--force");
const ONE = opt("--kind") ? { kind: opt("--kind"), key: opt("--key") } : null;
const BATCH_N = Math.max(1, parseInt(opt("--batch"), 10) || BATCH);

function log(line) {
  const s = new Date().toISOString() + " " + line;
  console.log(s);
  try { fs.appendFileSync(LOGF, s + "\n"); } catch {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(p) { const r = await fetch(HUB + p); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
async function jpost(p, b, token) {
  const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json", "X-SME-Token": token || "" }, body: JSON.stringify(b || {}) });
  let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")) || {}; } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (e) { log("state write failed: " + e.message); } }

// ---- lock: two runs never overlap ----------------------------------------------------------------
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function lock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (j && j.pid && alive(j.pid) && Date.now() - (j.at || 0) < LOCK_STALE_MS) return { held: true, pid: j.pid, at: j.at };
    log("stale lock from pid " + (j && j.pid) + " (" + (j && j.at ? Math.round((Date.now() - j.at) / 60000) + " min old" : "no time") + "), taking over");
  } catch {}
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() }));
  return { held: false };
}
function unlock() { try { const j = JSON.parse(fs.readFileSync(LOCK, "utf8")); if (j.pid === process.pid) fs.unlinkSync(LOCK); } catch {} }

// ---- the lessons mirror: Hub feedback -> shared store -> Hub mirror ------------------------------
async function syncLessons(token, run) {
  if (DRY) return;
  try {
    const fb = await jget("/api/sme/lessons/feedback");
    let through = 0;
    for (const f of ((fb.body && fb.body.feedback) || [])) { STORE.applyFeedback(f.ids, f.outcome, { now: f.at }); through = Math.max(through, f.at); run.feedback++; }
    const r = await jpost("/api/sme/lessons/sync", { lessons: STORE.loadLessons(), feedback_through: through }, token);
    if (r.status !== 200) log("lessons sync failed: HTTP " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
    else if (run.feedback || r.body.lessons) log("lessons: " + r.body.lessons + " in the shared store (" + STORE.lessonsFile() + "), " + r.body.feedback_acked + " outcome feedback applied");
  } catch (e) { log("lessons sync failed: " + e.message); }
}

// ---- one target ------------------------------------------------------------------------------------
async function reviewOne(item, token, run) {
  const c = await jget("/api/sme/context?kind=" + encodeURIComponent(item.kind) + "&key=" + encodeURIComponent(item.key));
  if (c.status !== 200 || !c.body) { log("  context failed: HTTP " + c.status + " " + JSON.stringify(c.body).slice(0, 200)); if (!DRY) await jpost("/api/sme/errors", { kind: item.kind, key: item.key, content_hash: item.content_hash, error: "context failed: HTTP " + c.status }, token); run.errors++; return; }
  const ctx = c.body;
  if (item.content_hash && ctx.content_hash !== item.content_hash) log("  note: content changed between queue and context (" + String(item.content_hash).slice(0, 8) + " -> " + String(ctx.content_hash).slice(0, 8) + "); reviewing the current content");
  let local = []; try { local = await LOCAL.localContext(ctx); } catch {}
  if (local.length) log("  local sources: " + local.map(b => b.title.split(" (")[0]).join(", "));
  const r = await REVIEW.reviewContext(ctx, { local, dry: DRY, force: FORCE, rejected: run.rejected, cwd: ROOT, log: s => log("  " + s), review_id: "rv_" + ctx.kind + "_" + String(ctx.content_hash).slice(0, 10) });
  if (r.status === "dry") { run.dry++; return; }
  if (r.status === "paused") { run.paused_until = r.paused_until; log("  paused until " + new Date(r.paused_until).toISOString()); return "paused"; }
  if (r.status === "error") { run.errors++; log("  " + r.error); await jpost("/api/sme/errors", { kind: ctx.kind, key: ctx.key, content_hash: ctx.content_hash, error: r.error }, token); return; }
  if (r.model_id) run.models[r.model_id] = (run.models[r.model_id] || 0) + 1;
  if (r.usage && r.usage.cost_usd && r.status === "stored") run.cost_usd += Number(r.usage.cost_usd) || 0;
  const post = await jpost("/api/sme/reviews", { kind: ctx.kind, key: ctx.key, content_hash: ctx.content_hash, name: ctx.name, review: r.review, reviewer: r.model_id || (r.status === "lessons" ? "lessons" : "cache"), model: r.model || null, tier: r.tier,
                                                 escalated: !!r.escalated, escalated_from: r.escalated_from || null, usage: r.usage || null, runtime_ms: r.runtime_ms || null, context_chars: ctx.chars, prompt_chars: r.prompt_chars || null,
                                                 knowledge_sections: r.knowledge_sections || [], from_lessons: r.status === "lessons", from_cache: r.status === "cached", lessons_created: [...((r.lessons || {}).created || []), ...((r.lessons || {}).auto || [])], lessons_matched: r.lessons_matched || [] }, token);
  if (post.status === 200) {
    run.reviewed++; if (r.status === "lessons") run.from_lessons++; if (r.status === "cached") run.from_cache++; if (r.escalated) run.escalated++;
    log("  stored: " + r.review.verdict + " - " + r.review.summary.slice(0, 120) + (r.kept_despite ? " (kept despite: " + r.kept_despite + ")" : "") + (r.lessons && (r.lessons.created.length + r.lessons.auto.length) ? "; lessons +" + (r.lessons.created.length + r.lessons.auto.length) : ""));
  } else { run.errors++; log("  store failed: HTTP " + post.status + " " + JSON.stringify(post.body).slice(0, 200)); }
}

// ---- main ----------------------------------------------------------------------------------------------------------
(async () => {
  if (ONE && (!ONE.kind || !ONE.key)) { console.error("--kind needs --key"); process.exit(2); }
  const L = lock();
  if (L.held) { log("another run is in progress (pid " + L.pid + " since " + new Date(L.at).toISOString() + "); exiting"); process.exit(0); }
  const run = { started_at: Date.now(), mode: REFRESH ? "refresh" : "review", reviewed: 0, from_lessons: 0, from_cache: 0, escalated: 0, errors: 0, dry: 0, feedback: 0, models: {}, rejected: {}, cost_usd: 0, paused_until: null, last_error: null, knowledge: null };
  let token = process.env.SME_TOKEN || null;
  try {
    const st = readState();
    if (st.paused_until && st.paused_until > Date.now()) { log("paused until " + new Date(st.paused_until).toISOString() + " (usage limit); exiting"); return; }
    const status = await jget("/api/sme/status?totals=0").catch(e => ({ status: 0, body: { error: e.message } }));
    if (status.status !== 200) { log("Hub not reachable at " + HUB + " (" + (status.body && status.body.error || "HTTP " + status.status) + "); exiting"); run.last_error = "hub unreachable"; return; }
    if (!token) { const t = await jget("/api/sme/token"); token = t.body && t.body.token; }
    if (!token) { log("no SME_TOKEN and the Hub gave none; exiting"); run.last_error = "no token"; return; }
    log("SME_HOME " + STORE.home() + " (" + Object.keys(STORE.loadLessons()).length + " lessons); knowledge " + REVIEW.knowledgeFile());
    if (REFRESH) {
      const r = await REVIEW.refreshKnowledge({ dry: DRY, rejected: run.rejected, cwd: ROOT, log });
      if (r.status === "written") { run.knowledge = r.meta; run.reviewed = 1; if (r.model_id || r.model) run.models[r.model_id || r.model] = 1; if (r.usage && r.usage.cost_usd) run.cost_usd += Number(r.usage.cost_usd) || 0; }
      else if (r.status === "paused") run.paused_until = r.paused_until;
      else if (r.status === "dry") run.dry++;
      else { run.errors++; run.last_error = r.error; log(r.error); }
      return;
    }
    const km = REVIEW.knowledgeMeta(REVIEW.knowledgeText());
    if (!km.bytes) log("warning: no knowledge base at " + REVIEW.knowledgeFile() + " - reviews run on the model's memory alone");
    else if (km.updated && Date.now() - Date.parse(km.updated) > 45 * 86400000) log("warning: knowledge base last refreshed " + km.updated + "; run --refresh-knowledge");
    await syncLessons(token, run);
    let items;
    if (ONE) items = [{ kind: ONE.kind, key: ONE.key, content_hash: "", reason: "requested" }];
    else {
      const t0 = Date.now();
      for (;;) {
        const q = await jget("/api/sme/queue?limit=" + BATCH_N);
        if (q.status !== 200) { log("queue failed: HTTP " + q.status); run.last_error = "queue failed"; return; }
        if (!q.body.building) { items = q.body.items; log("queue: " + q.body.pending + " pending of " + q.body.unique_targets + " unique targets (" + q.body.paths + " paths); " + JSON.stringify(q.body.totals)); break; }
        if (Date.now() - t0 > QUEUE_WAIT_MS) { log("the Hub is still hashing its shelf (" + JSON.stringify(q.body.progress) + "); try again next run"); return; }
        log("Hub building its queue (" + JSON.stringify(q.body.progress) + "), waiting"); await sleep(5000);
      }
    }
    if (!items.length) { log("nothing to review"); return; }
    for (const [i, item] of items.entries()) {
      log("[" + (i + 1) + "/" + items.length + "] " + item.kind + " " + item.key + (item.reason ? " (" + item.reason + ")" : ""));
      const r = await reviewOne(item, token, run);
      if (r === "paused") break;
      if (i < items.length - 1 && PAUSE_MS) await sleep(PAUSE_MS);
    }
    await syncLessons(token, run);
  } catch (e) {
    run.errors++; run.last_error = String(e && e.stack || e).slice(0, 500); log("run failed: " + run.last_error);
  } finally {
    run.finished_at = Date.now();
    const st = readState();
    writeState({ ...st, last_run: { at: run.started_at, finished_at: run.finished_at, mode: run.mode, reviewed: run.reviewed, from_lessons: run.from_lessons, from_cache: run.from_cache, escalated: run.escalated, errors: run.errors, dry: run.dry, models: run.models }, paused_until: run.paused_until || (st.paused_until > Date.now() ? st.paused_until : null), ...(run.knowledge ? { knowledge_refreshed_at: run.finished_at } : {}) });
    if (token && !DRY) {
      try { await jpost("/api/sme/runs", { started_at: run.started_at, finished_at: run.finished_at, mode: run.mode, reviewed: run.reviewed, from_lessons: run.from_lessons, escalated: run.escalated, errors: run.errors, models: run.models, cost_usd: run.cost_usd, paused_until: run.paused_until, last_error: run.last_error, knowledge: run.knowledge, host: os.hostname(),
                                           note: (Object.keys(run.rejected).length ? "model fallback: " + Object.entries(run.rejected).map(([a, b]) => a + "->" + b).join(", ") + "; " : "") + (run.from_cache ? run.from_cache + " from the shared cache" : "") }, token); } catch {}
    }
    log("done: " + run.reviewed + " reviewed (" + run.from_lessons + " from lessons, " + run.from_cache + " from cache, " + run.escalated + " escalated), " + run.errors + " errors" + (run.dry ? ", " + run.dry + " dry" : "") + (run.paused_until ? ", paused until " + new Date(run.paused_until).toISOString() : "") + ", models " + JSON.stringify(run.models) + (run.cost_usd ? ", ~$" + run.cost_usd.toFixed(3) : ""));
    unlock();
    process.exit(0);
  }
})();
