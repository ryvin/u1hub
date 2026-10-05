// flatten.js — scratch feasibility tool: resolve an Orca preset's "inherits"
// chain across user → AppData/system bundle → Program Files bundle and write
// a full, self-contained JSON the CLI's --load-settings / --load-filaments
// accepts (it needs "type", "name", "from" and full keys).
//
// node flatten.js <type:process|machine|filament> "<preset name>" <out.json> [from=User|system]
"use strict";
const fs = require("fs"), path = require("path");
const U = "/mnt/c/Users/raul/AppData/Roaming/Snapmaker_Orca";
const E = "/mnt/e/Program Files/Snapmaker_Orca/resources/profiles";
const [type, name, out, from = "User"] = process.argv.slice(2);
if (!type || !name || !out) { console.error("usage"); process.exit(2); }

function roots(t) {
  const r = [path.join(U, "user/default", t)];
  for (const base of [path.join(U, "system"), E]) {
    let vendors = [];
    try { vendors = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
    for (const v of vendors) r.push(path.join(base, v, t));
  }
  return r.filter(d => fs.existsSync(d));
}
const R = roots(type);
const cache = new Map();
function find(n) {
  if (cache.has(n)) return cache.get(n);
  let hit = null;
  for (const d of R) { const f = path.join(d, n + ".json"); if (fs.existsSync(f)) { hit = f; break; } }
  if (!hit) for (const d of R) {           // slow path: match the "name" field
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8").replace(/^﻿/, ""));
        // Orca's GUI follows "renamed_from" ("old name;older name") when a user
        // preset inherits a name the vendor bundle has since renamed.
        const renamed = String(j.renamed_from || "").split(";").map(s => s.trim());
        if (j.name === n || renamed.includes(n)) { hit = path.join(d, f); if (j.name !== n) console.log("renamed_from: " + n + " -> " + j.name); break; }
      } catch {}
    }
    if (hit) break;
  }
  cache.set(n, hit); return hit;
}
const chain = [], coerced = [];
function resolve(n, depth) {
  if (depth > 12) throw new Error("inherits loop at " + n);
  const f = find(n); if (!f) throw new Error("preset not found: " + n);
  const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  chain.push(f);
  const parent = j.inherits ? resolve(j.inherits, depth + 1) : {};
  const { inherits, ...own } = j;
  // Legacy shape: Snapmaker Orca 2.2.x saved per-flow-mode pairs
  // (process_flow_support ["standard","high_flow"]) for speed/accel keys; the
  // 2.3+ bundle stores scalars. Coerce to the parent's (system) shape: first
  // element = "standard" flow. The GUI migrates these on load; the CLI's
  // load_config_file faulted on them (0xC0000005, 2026-10-05).
  for (const k of Object.keys(own))
    if (Array.isArray(own[k]) && k in parent && !Array.isArray(parent[k])) { coerced.push(k); own[k] = own[k][0]; }
  return { ...parent, ...own };
}
let full = resolve(name, 0);
// Shape oracle: the project_settings.config the CURRENT app wrote into a 3MF
// is the app's real schema (the vendor bundle's leaf presets still carry the
// 2.2-era per-flow arrays; the 2.3.6 GUI writes scalars). Scalar there ->
// scalar here (element 0 = "standard" flow). Set SHAPE_ORACLE=<path.json>.
if (process.env.SHAPE_ORACLE) {
  const O = JSON.parse(fs.readFileSync(process.env.SHAPE_ORACLE, "utf8"));
  const c2 = [];
  for (const k of Object.keys(full)) if (Array.isArray(full[k]) && k in O && !Array.isArray(O[k])) { full[k] = full[k][0]; c2.push(k); }
  if (c2.length) console.log("oracle-coerced (" + c2.length + "): " + c2.join(", "));
}
// The CLI derives the "system name" of a User preset from its inherits and
// checks the process's compatible_printers against the MACHINE's system name
// (CLI_PROCESS_NOT_COMPATIBLE otherwise), so keep the user's direct parent.
const own = JSON.parse(fs.readFileSync(chain[0], "utf8").replace(/^﻿/, ""));
full.type = type; full.name = name; full.from = from;
if (own.inherits) full.inherits = own.inherits; else delete full.inherits;
delete full.instantiation; delete full.setting_id;
delete full.different_settings_to_system;
if (type === "process") full.print_settings_id = name;
if (type === "machine") full.printer_settings_id = name;
if (type === "filament") full.filament_settings_id = [name];
fs.writeFileSync(out, JSON.stringify(full, null, 2));
console.log("chain:\n  " + chain.join("\n  "));
if (coerced.length) console.log("coerced legacy arrays -> scalar (" + coerced.length + "): " + coerced.join(", "));
console.log("keys: " + Object.keys(full).length + " -> " + out);
