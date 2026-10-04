#!/usr/bin/env node
// test/fake-claude.js — a stand-in for the `claude` CLI, for test/sme-standalone.js.
// Fork (ryvin/u1hub). Reads the prompt from stdin the way `claude -p` does,
// records every invocation (args, prompt facts) as one JSON line in
// FAKE_CLAUDE_LOG, and answers in the shape of `claude -p --output-format
// json` according to FAKE_CLAUDE_MODE:
//   ok           a canned, valid review (family block for a family prompt)
//   lessons      ok + one new lesson and confirms every KNOWN SOLUTION id it was shown
//   lowconf      confidence "low" unless the model is opus (exercises escalation)
//   garbage      prose, no JSON (exit 0)
//   limit        a usage-limit error (is_error, exit 1)
//   reject-fable --model fable is refused ("not a valid model"); any other alias answers ok
//   refresh      a new knowledge.md (markdown, today's date)
//   refresh-bad  an unusable refresh answer
// Never spends anything, never talks to the network.

"use strict";
const fs = require("fs");

const MODE = process.env.FAKE_CLAUDE_MODE || "ok";
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const model = opt("--model") || "sonnet";
const IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };
const id = IDS[model] || model;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => stdin += d);
process.stdin.on("end", () => {
  try {
    if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
      at: Date.now(), mode: MODE, model, args, stdin_chars: stdin.length,
      has_knowledge: /=== KNOWLEDGE BASE/.test(stdin), knowledge_mode: (/=== KNOWLEDGE BASE \([^,]+, ([a-z]+)/.exec(stdin) || [])[1] || null,
      has_context: /=== TARGET CONTEXT ===/.test(stdin), has_lessons: /KNOWN SOLUTIONS \(lessons/.test(stdin), has_klipper: /KLIPPER SETTINGS/.test(stdin), has_family: /^FAMILY: /m.test(stdin),
      kind: (/\(kind ([a-z0-9]+), key/.exec(stdin) || [])[1] || null, tier: Number((/, tier (\d)\)/.exec(stdin) || [])[1]) || null,
      system_has_schema: /Output schema/.test(opt("--append-system-prompt") || ""), sections: (stdin.match(/^## /gm) || []).length
    }) + "\n");
  } catch {}
  // Claude Code 2.1.289 (measured 2026-10-04) prints --output-format json as an
  // ARRAY of events ending in the "result" object; FAKE_CLAUDE_SHAPE=object
  // keeps the older single-object shape so both stay covered.
  const out = (obj, code) => {
    const body = process.env.FAKE_CLAUDE_SHAPE === "object" ? obj
      : [{ type: "system", subtype: "init", model: id, tools: [] }, { type: "assistant", message: { model: id } }, { type: "rate_limit_event" }, obj];
    process.stdout.write(JSON.stringify(body) + "\n"); process.exit(code || 0);
  };
  const envelope = (text, extra) => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-" + Date.now(), duration_ms: 123, num_turns: 1,
    total_cost_usd: 0.0123, usage: { input_tokens: Math.round(stdin.length / 4), output_tokens: 400 }, modelUsage: { [id]: { inputTokens: Math.round(stdin.length / 4), outputTokens: 400, costUSD: 0.0123 } }, ...(extra || {}) });

  if (MODE === "limit") return out({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your usage limit for this session. Your limit resets at 3pm.", session_id: "fake", duration_ms: 5, num_turns: 0 }, 1);
  if (MODE === "garbage") return out(envelope("I am not able to produce the JSON you asked for; here is some prose instead."));
  if (MODE === "reject-fable" && model === "fable") return out({ type: "result", subtype: "error", is_error: true, result: "Invalid model: 'fable' is not a valid model id for this account", session_id: "fake", duration_ms: 5, num_turns: 0 }, 1);
  if (MODE === "refresh-bad") return out(envelope("nope"));
  if (MODE === "refresh") {
    const today = new Date().toISOString().slice(0, 10);
    const md = ["# 3D-printing SME knowledge base — refreshed by the fake", "", "**Last refreshed: " + today + "**", "", "## 1. Version snapshot", "| Thing | Current | Source |", "|---|---|---|", "| Fake firmware | 9.9.9 | [S1] |", "",
      "## 2. Snapmaker U1", "Refreshed text [S1].", "", "## 3. Anycubic Kobra S1 + ACE Pro + Rinkhals", "Refreshed [S1].", "", "## 4. Orca Slicer", "x", "", "## 5. Klipper tuning", "x", "", "## 6. Filaments", "| Material | Nozzle | Source |", "|---|---|---|", "| PLA | 200-220 | [S1] |", "| PETG | 230-250 | [S1] |", "",
      "## 7. Speed vs quality playbook", "x", "", "## 8. Failure modes", "x", "", "## 9. What changed recently", "- the fake refreshed it on " + today, "", "## 10. Sources", "- [S1] https://example.invalid/fake — Fake source — " + today, ""].join("\n");
    return out(envelope(md));
  }
  const isFamily = /^FAMILY: /m.test(stdin), isPrinter = /^PRINTER: /m.test(stdin);
  const known = [...stdin.matchAll(/\[(ls_[a-z0-9]+)\]/g)].map(m => m[1]);
  const conf = MODE === "lowconf" ? (model === "opus" ? "high" : "low") : "high";
  const review = {
    verdict: "TUNE", summary: "Fake review by " + id + (isFamily ? " of a family" : isPrinter ? " of a printer" : "") + ": raise retraction slightly for cleaner tool changes.",
    settings: isPrinter ? [] : [{ key: "retraction_length", current: "0.8", suggested: "1.2", why: "stringing seen on the cancelled attempts", impact: "quality" }, { key: "outer_wall_speed", current: "200", suggested: "150", why: "surface quality on display pieces", impact: "quality" }],
    printer_tuning: isPrinter ? [{ printer: "U1-mock", items: [{ area: "pressure_advance", param: "extruder.pressure_advance", current: "0.04", suggested: "0.045", why: "corner bulge on the failed files" }] }] : [],
    speed_quality: ["outer walls at 150 mm/s cost ~4 min on a 90 min print"],
    drafts: { orca: isPrinter ? null : { retraction_length: 1.2, outer_wall_speed: 150 }, klipper: isPrinter ? "[extruder]\npressure_advance: 0.045   # DRAFT, was 0.04" : null },
    risks: ["mixed PLA/PETG jobs break on SnapmakerOrca >= 2.3.5 (issue #908)"],
    confidence: conf, evidence: ["KB §6 PLA rows", "ledger: outcome history line", ...known.map(k => "lesson " + k)],
    gaps: [], not_enough_data: false,
    lessons_used: known, confirmed_lessons: known,
    new_lessons: MODE === "lessons" ? [{ signature: { printer_type: "u1", material: "PLA", tag: "failures", setting_keys: [{ key: "retraction_length", max: 0.8 }] }, finding: "retraction 0.8 mm on the U1 strings on multi-color PLA", change: { text: "raise retraction_length to 1.2", orca: { retraction_length: 1.2 } } }] : [],
    family: isFamily ? { best: { member: (/^  v2: (\S[^-]*?) - /m.exec(stdin) || [])[1] ? String((/^  v2: (.+?) - done/m.exec(stdin) || [])[1]).trim() : "v2", why: "lowest failure rate" },
                         iterations: [{ to: "v2", effect: "improved", why: "retraction fixed stringing" }, { to: "v3", effect: "hurt", why: "speed increase cancelled twice" }],
                         next_experiment: { change: "outer_wall_speed 150 on v2's settings", why: "one variable at a time" },
                         member_status: [{ member: "v1", line: "superseded by v2: stringing fixed via retraction 0.8 -> 1.2" }, { member: "v2", line: "current best" }, { member: "v3", line: "regressed: speed 250 cancelled twice" }] } : null
  };
  out(envelope("```json\n" + JSON.stringify(review, null, 1) + "\n```"));
});
