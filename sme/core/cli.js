#!/usr/bin/env node
// sme/core/cli.js — the SME core as a command. Part of the SME core (no Hub
// dependency): any 3D-printing project on this PC builds a context JSON
// (CONTEXT.md), calls this, and gets a review JSON back; lessons and the
// review cache are shared through SME_HOME.
//
//   node sme/core/cli.js review --context ctx.json [--tier auto|1|2|3] [--dry-run] [--force]
//        -> stdout: { status, review, tier, model, model_id, escalated, usage, lessons, ... }
//   node sme/core/cli.js lessons list [--type u1] [--material PLA] [--tag failures]
//   node sme/core/cli.js lessons match --context ctx.json
//   node sme/core/cli.js lessons feedback --ids ls_a,ls_b --outcome done|cancelled|error
//   node sme/core/cli.js refresh-knowledge [--file path] [--dry-run]
//   node sme/core/cli.js home                 print SME_HOME and what is in it
// Exit 0 on a handled outcome (the JSON says which), 2 on misuse.
// Env: SME_HOME, SME_MODEL, SME_MODEL_TIER1/2/3, CLAUDE_BIN, SME_TIMEOUT_MS,
// SME_AGENT_FILE, SME_KNOWLEDGE_FILE.

"use strict";

const fs = require("fs");
const REVIEW = require("./review.js");
const STORE = require("./store.js");
const LESSONS = require("./lessons.js");
const TIERS = require("./tiers.js");

const argv = process.argv.slice(2);
const cmd = argv[0], sub = argv[1];
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const out = o => { process.stdout.write(JSON.stringify(o, null, 2) + "\n"); };
const log = s => process.stderr.write(new Date().toISOString() + " " + s + "\n");
const usage = () => { process.stderr.write("usage: cli.js review --context ctx.json [--tier 1|2|3] [--dry-run] [--force]\n       cli.js lessons list|match|feedback ...\n       cli.js refresh-knowledge [--file path] [--dry-run]\n       cli.js home\n"); process.exit(2); };
function readContext() {
  const f = opt("--context"); if (!f) usage();
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { process.stderr.write("cannot read " + f + ": " + e.message + "\n"); process.exit(2); }
}

(async () => {
  if (cmd === "review") {
    const ctx = readContext();
    const t = opt("--tier");
    const r = await REVIEW.reviewContext(ctx, { dry: flag("--dry-run"), force: flag("--force"), tier: t && t !== "auto" ? Number(t) : null, log });
    out(r);
  } else if (cmd === "lessons" && sub === "list") {
    let list = Object.values(STORE.loadLessons());
    if (opt("--type")) list = list.filter(L => L.signature.printer_type === opt("--type").toLowerCase() || L.signature.printer_type === "*");
    if (opt("--material")) list = list.filter(L => L.signature.material === opt("--material").toUpperCase() || L.signature.material === "*");
    if (opt("--tag")) list = list.filter(L => L.signature.tag === opt("--tag").toLowerCase() || L.signature.geometry_flags.includes(opt("--tag").toLowerCase()));
    out({ home: STORE.home(), total: list.length, lessons: list.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)) });
  } else if (cmd === "lessons" && sub === "match") {
    const ctx = readContext();
    const ls = REVIEW.lessonsFor(ctx, STORE.loadLessons());
    out({ tags: ls.tags, coverage: ls.cov, matches: ls.matches.map(m => ({ id: m.lesson.id, score: m.score, exact: m.exact, confirmed: m.confirmed, finding: m.lesson.finding, change: m.lesson.change })), tier: TIERS.pickTier({ ...(ctx.facts || {}), kind: ctx.kind, tags: ls.tags, lessons_cover_all: ls.cov.all_covered }) });
  } else if (cmd === "lessons" && sub === "feedback") {
    const ids = String(opt("--ids") || "").split(",").map(s => s.trim()).filter(Boolean), outcome = opt("--outcome");
    if (!ids.length || !["done", "cancelled", "error"].includes(outcome)) usage();
    out(STORE.applyFeedback(ids, outcome, { now: Date.now() }));
  } else if (cmd === "refresh-knowledge") {
    out(await REVIEW.refreshKnowledge({ knowledgeFile: opt("--file") || undefined, dry: flag("--dry-run"), log }));
  } else if (cmd === "home") {
    const h = STORE.home();
    let reviews = 0; try { reviews = fs.readdirSync(STORE.reviewsDir()).length; } catch {}
    out({ home: h, exists: fs.existsSync(h), lessons: Object.keys(STORE.loadLessons()).length, cached_reviews: reviews, knowledge: REVIEW.knowledgeFile(), knowledge_meta: REVIEW.knowledgeMeta(REVIEW.knowledgeText()), agent: REVIEW.AGENT_FILE(), tiers: TIERS.DEFAULT_MODELS, thresholds: TIERS.THRESHOLDS });
  } else usage();
})().catch(e => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
