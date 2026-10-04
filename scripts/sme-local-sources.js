// scripts/sme-local-sources.js — optional, runner-side context from the
// person's own projects on this PC. Fork (ryvin/u1hub). The runner runs on the
// host, so it can read what the Hub container cannot; everything here is
// read-only, best-effort and skipped when a path is missing. Required by
// scripts/sme-runner.js; pure helpers exported for test/sme-standalone.js.
//
// Sources (each path overridable by env; docs/sme.md "Local sources"):
//   printer_configs/  SME_PRINTER_CONFIGS   Klipper config backups / working
//                     copies (<printer>_working.cfg, <printer>_current.cfg):
//                     the same whitelisted sections as the live summary, and
//                     the differences against the live printer (live wins).
//   multiACE/         SME_MULTIACE_DIR      the ACE-on-U1 project installed on
//                     davinci: its README's known issues, for that printer.
//   Spoolman          SPOOLMAN_URL          GET /api/v1/spool: what materials
//                     and vendors are actually in stock (no prices there).
//   bl2u1/            SME_BL2U1_DIR         the Bambu -> U1 converter: a 3MF
//                     that looks converted gets a note about its artefacts
//                     (re-centred 256 -> 230 mm bed, filament remaps).
//   printcat/         (not read) its catalog lives in a Docker volume; the
//                     Hub's own zip-directory content id already answers
//                     "same file" in one small read, so nothing is reused.

"use strict";

const fs = require("fs");
const path = require("path");
const { klipperSummary } = require("../modules/sme.js");

const DEFAULT_ROOT = "/mnt/e/Code";
const PATHS = () => ({
  printer_configs: process.env.SME_PRINTER_CONFIGS || path.join(DEFAULT_ROOT, "printer_configs"),
  multiace: process.env.SME_MULTIACE_DIR || path.join(DEFAULT_ROOT, "multiACE"),
  bl2u1: process.env.SME_BL2U1_DIR || path.join(DEFAULT_ROOT, "bl2u1"),
  spoolman: (process.env.SPOOLMAN_URL || "http://localhost:7912").replace(/\/+$/, "")
});
const CAP = { cfg: 4000, diff: 2500, multiace: 1500, spoolman: 1500, bl2u1: 600 };
const SPOOLMAN_TIMEOUT_MS = 3000;

// A Klipper .cfg -> { section: { key: value } }. Indented lines continue the
// previous key (gcode blocks) and are dropped; [include ...] is ignored.
function parseKlipperCfg(text) {
  const out = {};
  let sec = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s*[#;].*$/, "");
    if (!line.trim()) continue;
    if (/^\s/.test(raw)) continue;                       // continuation of a multi-line value
    const m = /^\[([^\]]+)\]\s*$/.exec(line);
    if (m) { const name = m[1].trim(); sec = /^include\b/i.test(name) ? null : name; if (sec && !out[sec]) out[sec] = {}; continue; }
    if (!sec) continue;
    const kv = /^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    const n = Number(v);
    out[sec][kv[1]] = v !== "" && Number.isFinite(n) ? n : v;
  }
  return out;
}
// Which backup file speaks for a printer: <name>_working.cfg, then
// <name>_current.cfg, then the newest <name>_backup_*.cfg.
function configFileFor(dir, printerName) {
  // both sides squashed to [a-z0-9]: "U1-mock" finds "u1-mock_working.cfg",
  // "davinci" finds "davinci_current.cfg"; the part before the first "_" is
  // the printer
  const squash = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const n = squash(printerName);
  if (!n) return null;
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /\.cfg$/i.test(f) && squash(f.split("_")[0]) === n && f.includes("_")); } catch { return null; }
  const pick = re => names.filter(f => re.test(f)).sort().reverse()[0];
  const f = pick(/_working\.cfg$/i) || pick(/_current\.cfg$/i) || pick(/_backup/i) || names.sort().reverse()[0];
  return f ? path.join(dir, f) : null;
}
// live: the "section.key" -> value map the Hub's context carries (ctx.settings
// for a printer). -> lines naming where the file and the printer disagree.
function diffAgainstLive(fileValues, live) {
  const lines = [];
  for (const [k, v] of Object.entries(fileValues || {})) {
    if (!(k in (live || {}))) continue;
    const a = String(live[k]), b = String(v);
    if (a !== b && Number(a) !== Number(b)) lines.push(k + ": file " + b + " / live " + a + " (live wins)");
  }
  return lines;
}
function cut(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 20) + "\n[truncated]" : s; }

async function spoolmanStock(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), SPOOLMAN_TIMEOUT_MS);
  try {
    const r = await fetch(url + "/api/v1/spool?limit=500", { signal: ac.signal });
    if (!r.ok) return null;
    const spools = await r.json();
    if (!Array.isArray(spools)) return null;
    const by = new Map();
    for (const s of spools) {
      if (!s || s.archived) continue;
      const f = s.filament || {};
      const mat = String(f.material || "?").toUpperCase(), vendor = (f.vendor && f.vendor.name) || "?";
      const k = mat + " | " + vendor;
      const e = by.get(k) || { material: mat, vendor, spools: 0, remaining_g: 0, temps: new Set() };
      e.spools++; e.remaining_g += Number(s.remaining_weight) || 0;
      if (f.settings_extruder_temp) e.temps.add(f.settings_extruder_temp + "/" + (f.settings_bed_temp || "?"));
      by.set(k, e);
    }
    return { total: spools.length, groups: [...by.values()].sort((a, b) => b.remaining_g - a.remaining_g) };
  } catch { return null; } finally { clearTimeout(t); }
}

// ctx: GET /api/sme/context's answer. -> [{ title, text }] blocks (possibly empty).
async function localContext(ctx) {
  const P = PATHS();
  const blocks = [];
  const kind = ctx && ctx.kind;
  if (kind === "printer") {
    const file = configFileFor(P.printer_configs, ctx.name);
    if (file) {
      try {
        const cfg = parseKlipperCfg(fs.readFileSync(file, "utf8"));
        const s = klipperSummary(cfg);
        const diff = diffAgainstLive(s.values, ctx.settings || {});
        blocks.push({ title: "LOCAL KLIPPER CONFIG (" + path.basename(file) + " in printer_configs/, the owner's working copy; the live printer wins where they differ)",
                      text: cut(s.lines.map(l => "  " + l).join("\n"), CAP.cfg) + (diff.length ? "\n  DIFFERENCES vs the live printer:\n" + cut(diff.map(l => "    " + l).join("\n"), CAP.diff) : "\n  (agrees with the live printer on every key both report)") });
      } catch {}
    }
    const fw = ctx.firmware || (ctx.facts && ctx.facts.firmware) || {};
    if (fw.multiace || /davinci/i.test(String(ctx.name))) {
      try {
        const md = fs.readFileSync(path.join(P.multiace, "README.md"), "utf8").split(/\r?\n/);
        const hits = md.filter(l => /known issue|ACE_MODE_NORMAL|USB reset|ace_device_count|must be run|workaround/i.test(l)).map(l => "  " + l.trim());
        if (hits.length) blocks.push({ title: "multiACE (the owner's ACE-on-U1 project installed on this printer) - known issues from its README", text: cut(hits.join("\n"), CAP.multiace) });
      } catch {}
    }
  }
  if (kind === "gcode" || kind === "family" || kind === "3mf") {
    const stock = await spoolmanStock(P.spoolman);
    if (stock && stock.groups.length) {
      const mats = new Set((ctx.facts && ctx.facts.materials || []).map(m => String(m).toUpperCase()));
      const rows = stock.groups.filter(g => !mats.size || mats.has(g.material)).slice(0, 12).map(g => "  " + g.material + " " + g.vendor + ": " + g.spools + " spool" + (g.spools === 1 ? "" : "s") + ", " + Math.round(g.remaining_g) + " g left" + (g.temps.size ? " (" + [...g.temps].slice(0, 2).join(", ") + " nozzle/bed per Spoolman)" : ""));
      const all = [...new Set(stock.groups.map(g => g.material))].join(", ");
      blocks.push({ title: "SPOOLMAN STOCK (" + stock.total + " spools recorded; materials in stock: " + all + "; no prices there)", text: cut(rows.join("\n") || "  (none of this target's materials in stock)", CAP.spoolman) });
    }
  }
  if (kind === "3mf") {
    const proj = (ctx.sections && ctx.sections.project) || "", name = String(ctx.name || "");
    const converted = /\(U1\)|_U1\b|bl2u1/i.test(name) || /printer_model = .*(Bambu|X1|P1|A1|H2)/i.test(proj);
    if (converted && fs.existsSync(P.bl2u1)) blocks.push({ title: "bl2u1 (the owner's Bambu -> U1 converter) - this project looks converted or Bambu-born", text: cut("  Converter artefacts to expect: models re-centred from the Bambu 256 mm bed (128,128) to the U1 230 mm centre (115,115); filament slots remapped to the U1's four heads; the designer's Bambu process settings carried with the U1 printer/filament presets. Judge supports, brim and temperatures against the U1 presets, not the Bambu ones.", CAP.bl2u1) });
  }
  return blocks;
}
function localLines(blocks) { return (blocks || []).map(b => b.title + "\n" + b.text).join("\n\n"); }

module.exports = { PATHS, parseKlipperCfg, configFileFor, diffAgainstLive, spoolmanStock, localContext, localLines };
