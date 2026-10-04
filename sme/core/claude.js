// sme/core/claude.js — the `claude -p` invocation wrapper. Part of the SME
// core (no Hub dependency). Runs Claude Code headless on the person's own
// subscription (never an API key), prompt on stdin (the documented
// `cat file | claude -p` form: no argv limit, 10 MB cap), the SME system
// prompt appended, JSON out, every tool off for a review (the context is in
// the prompt) - web tools only for the knowledge refresh, Read only for a
// photo target's image files.
//
// Flags come from `claude --help` (2.1.289) and the CLI reference; `--help`
// is documented as incomplete, so --max-turns and --append-system-prompt-file
// (both in the reference) are avoided in favour of listed ones where a
// listed one does the job.
//
//   runClaude({ model, mode, systemPrompt, prompt, bin, timeoutMs, cwd, addDirs })
//     -> { ok, code, json, text, err, ms, timed_out, model_id, usage,
//          rejected (the CLI refused the model), usage_limit, paused_until }

"use strict";

const { spawn } = require("child_process");
const TIERS = require("./tiers.js");

const MODEL_IDS = Object.freeze({ haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" });
const DEFAULT_TIMEOUT_MS = 600000;
const PAUSE_FALLBACK_MIN = 60;

function claudeArgs(model, mode, systemPrompt, addDirs) {
  const a = ["-p", "--output-format", "json", "--model", model, "--no-session-persistence", "--permission-prompts", "none", "--disable-slash-commands",
             "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--append-system-prompt", systemPrompt, "--permission-mode", "dontAsk"];
  if (mode === "refresh") a.push("--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--max-turns", "80");
  else if (mode === "photo") { a.push("--tools", "Read", "--allowedTools", "Read", "--max-turns", "8"); for (const d of addDirs || []) a.push("--add-dir", d); }
  else a.push("--tools", "", "--max-turns", "3");
  return a;
}
function runClaude(o) {
  const bin = o.bin || process.env.CLAUDE_BIN || "claude";
  const timeoutMs = Math.max(10000, Number(o.timeoutMs || process.env.SME_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  return new Promise(resolve => {
    const args = claudeArgs(o.model, o.mode || "review", o.systemPrompt || "", o.addDirs);
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try { child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: o.cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SME_RUNNER: "1" } }); }
    catch (e) { return resolve({ ok: false, error: "could not start " + bin + ": " + e.message, text: "", err: "", ms: 0 }); }
    let out = "", err = "", done = false;
    const t0 = Date.now();
    const timer = setTimeout(() => { if (!done) { try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000); } }, timeoutMs);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("error", e => { done = true; clearTimeout(timer); resolve({ ok: false, error: "could not start " + bin + ": " + e.message, text: "", out, err, ms: Date.now() - t0 }); });
    child.on("close", code => {
      done = true; clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.trim()); } catch { const m = /\{[\s\S]*\}\s*$/.exec(out); if (m) { try { json = JSON.parse(m[0]); } catch {} } }
      const text = json ? String(json.result != null ? json.result : "") : out;
      const isErr = code !== 0 || (json && json.is_error === true);
      const all = text + "\n" + err;
      const r = { ok: !isErr, code, json, text, out, err, ms: Date.now() - t0, timed_out: Date.now() - t0 >= timeoutMs,
                  model_id: (json && json.modelUsage && Object.keys(json.modelUsage)[0]) || MODEL_IDS[o.model] || o.model,
                  usage: json ? { input_tokens: json.usage && json.usage.input_tokens, output_tokens: json.usage && json.usage.output_tokens, cost_usd: json.total_cost_usd } : null,
                  rejected: isErr && TIERS.isModelRejected(all), usage_limit: isErr && TIERS.isUsageLimit(all) };
      if (r.usage_limit) r.paused_until = TIERS.parsePauseUntil(all, Date.now(), PAUSE_FALLBACK_MIN);
      resolve(r);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.prompt || "");
  });
}
// The model's JSON, tolerant of a fence or a sentence around it.
function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
// One call with the alias fallback: when the CLI refuses the model (not
// offered, retired), try TIERS.fallbackFor(model) once. rejected: a map the
// caller keeps across calls so a refused alias is not tried again.
async function callWithFallback(o, rejected) {
  let model = o.model;
  const R = rejected || {};
  if (R[model]) model = R[model];
  let res = await runClaude({ ...o, model });
  if (!res.ok && res.rejected) {
    const fb = TIERS.fallbackFor(model);
    R[model] = fb;
    res = await runClaude({ ...o, model: fb });
    res.fallback_from = model;
    model = fb;
  }
  res.model = model;
  return res;
}

module.exports = { MODEL_IDS, claudeArgs, runClaude, extractJson, callWithFallback };
