// scripts/sme-family.js — print families as iteration histories, pure. Fork (ryvin/u1hub).
// Required by modules/sme.js and test/sme-standalone.js. No I/O.
//
// The same model sliced several ways ("regal-iron-lung-blood-v2_PLA_6h16m",
// "..._9h21m", "model (1)") is usually a run of attempts to improve the print.
// So a family is reviewed ONCE, as a timeline: members in the order they were
// first printed (else file time), the settings that changed between each pair
// (only keys that differ), and how the outcomes moved (done / cancelled /
// error, actual vs estimated time, grams). The reviewer says which changes
// helped, which hurt, which variant is best now, and the single next thing to
// try. Improvements the outcomes confirm become lessons; regressions become
// "avoid" lessons.
//
// member: { cid, key, name, paths[], settings: {orcaKey: value}, mtime,
//           stats: { done, cancelled, error, first_at, last_at, actual_s[],
//                    time_ratio, grams } }

"use strict";

const FILAMENTS = /\b(pla|petg|abs|tpu|asa|pc|pa|pva|hips|pctg|nylon|pet|cf)\b/g;
// Keys worth a line in the iteration table (Orca names). Anything else that
// differs is counted, not listed, so a table stays short.
const DIFF_KEYS = Object.freeze([
  "layer_height", "initial_layer_print_height", "wall_loops", "top_shell_layers", "bottom_shell_layers", "sparse_infill_density", "sparse_infill_pattern",
  "enable_support", "support_type", "support_style", "support_threshold_angle", "support_on_build_plate_only", "enable_prime_tower", "prime_tower_width", "flush_multiplier",
  "brim_type", "brim_width", "skirt_loops", "curr_bed_type", "nozzle_temperature", "nozzle_temperature_initial_layer", "hot_plate_temp", "textured_plate_temp", "cool_plate_temp", "eng_plate_temp",
  "chamber_temperature", "fan_min_speed", "fan_max_speed", "close_fan_the_first_x_layers", "overhang_fan_speed", "slow_down_layer_time", "slow_down_min_speed",
  "filament_max_volumetric_speed", "filament_flow_ratio", "filament_retraction_length", "filament_z_hop", "retraction_length", "retract_lift_above", "z_hop", "retraction_speed", "wipe",
  "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "initial_layer_speed", "travel_speed", "bridge_speed", "overhang_1_4_speed",
  "default_acceleration", "outer_wall_acceleration", "initial_layer_acceleration", "enable_pressure_advance", "pressure_advance", "seam_position", "ironing_type", "detect_thin_wall",
  "xy_hole_compensation", "xy_contour_compensation", "elefant_foot_compensation", "filament_type", "filament_settings_id", "printer_model", "print_settings_id", "nozzle_diameter", "printable_height"
]);

// A file name as a family: lower case, extension gone, Orca's "_<material>_<time>"
// tail gone, plate counts and copy / version suffixes gone, punctuation to
// spaces. "Regal Iron Lung Blood v2_PLA_6h16m.gcode", "regal-iron-lung-blood-v3
// (1).gcode" and "Regal iron lung blood.3mf" are one family.
function familyName(name) {
  return String(name || "").toLowerCase()
    .replace(/\.(gcode|gco|g|3mf)$/i, "")
    .replace(/\s*\(\d+\)\s*$/g, " ").replace(/[\s_-]*(copy|duplicate|final|fixed|new)(\s*\(\d+\))?\s*$/gi, " ").replace(/\s*-\s*copy\b/gi, " ")
    .replace(/[_+\-.,()\[\]#]+/g, " ")
    .replace(/\b(x\s?\d+|plate\s?\d+|\d+h(\d+m)?|\d+m|\d+d\d+h)\b/g, " ")
    .replace(FILAMENTS, " ")
    .replace(/\b(v|ver|version|rev|r|try|attempt|test)\s?\d+[a-z]?\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
const numOr = v => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Members in iteration order: first print (ledger) first, a never-printed
// member by its file time, ties by name.
function orderMembers(members) {
  const t = m => (m.stats && m.stats.first_at) || m.mtime || 0;
  return (members || []).slice().sort((a, b) => t(a) - t(b) || String(a.name).localeCompare(String(b.name)));
}
// Settings that differ between two members. -> { changes: [{ key, from, to }], other: n }
function diffSettings(a, b) {
  const A = (a && a.settings) || {}, B = (b && b.settings) || {};
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  const changes = [];
  let other = 0;
  for (const k of keys) {
    const x = A[k] == null ? null : String(A[k]), y = B[k] == null ? null : String(B[k]);
    if (x === y) continue;
    if (DIFF_KEYS.includes(k)) changes.push({ key: k, from: x, to: y }); else other++;
  }
  changes.sort((p, q) => DIFF_KEYS.indexOf(p.key) - DIFF_KEYS.indexOf(q.key));
  return { changes, other };
}
// How the outcomes moved from one member to the next. -> { effect, why, backing }
// effect: improved | hurt | neutral | unknown. backing = prints behind the call.
function outcomeEffect(from, to) {
  const F = from || {}, T = to || {};
  const tot = s => (s.done || 0) + (s.cancelled || 0) + (s.error || 0);
  const fail = s => (s.cancelled || 0) + (s.error || 0);
  const nf = tot(F), nt = tot(T);
  if (!nt) return { effect: "unknown", why: "the later variant has no recorded prints yet", backing: 0 };
  if (!nf) return { effect: "unknown", why: "the earlier variant has no recorded prints", backing: nt };
  const rf = fail(F) / nf, rt = fail(T) / nt;
  const backing = Math.min(nf, nt);
  if (rt < rf - 1e-9) return { effect: "improved", why: "failure rate " + pct(rf) + " -> " + pct(rt) + " (" + fail(F) + "/" + nf + " -> " + fail(T) + "/" + nt + ")", backing };
  if (rt > rf + 1e-9) return { effect: "hurt", why: "failure rate " + pct(rf) + " -> " + pct(rt) + " (" + fail(F) + "/" + nf + " -> " + fail(T) + "/" + nt + ")", backing };
  // same failure rate: a faster print at the same reliability is an improvement
  const tf = numOr(F.time_ratio), tt = numOr(T.time_ratio);
  if (tf != null && tt != null && Math.abs(tf - tt) > 0.1) return { effect: tt < tf ? "improved" : "hurt", why: "same failure rate; actual/estimate time " + tf + " -> " + tt, backing };
  return { effect: "neutral", why: "same failure rate (" + pct(rt) + "), " + nt + " print" + (nt === 1 ? "" : "s"), backing };
}
function pct(r) { return Math.round(r * 100) + "%"; }

// The table the reviewer reads. -> { ordered, iterations: [{ from, to, changes, other, effect, why, backing }], best, conflicting, failed }
function familyTable(members) {
  const ordered = orderMembers(members);
  const iterations = [];
  for (let i = 1; i < ordered.length; i++) {
    const d = diffSettings(ordered[i - 1], ordered[i]), e = outcomeEffect(ordered[i - 1].stats, ordered[i].stats);
    iterations.push({ from: ordered[i - 1].cid, to: ordered[i].cid, from_name: ordered[i - 1].name, to_name: ordered[i].name, changes: d.changes, other: d.other, ...e });
  }
  // Best by the numbers: lowest failure rate among printed members, then the
  // most completed prints, then the latest. The reviewer may disagree and say why.
  const printed = ordered.filter(m => m.stats && ((m.stats.done || 0) + (m.stats.cancelled || 0) + (m.stats.error || 0)) > 0);
  const rate = m => ((m.stats.cancelled || 0) + (m.stats.error || 0)) / ((m.stats.done || 0) + (m.stats.cancelled || 0) + (m.stats.error || 0));
  const best = printed.slice().sort((a, b) => rate(a) - rate(b) || (b.stats.done || 0) - (a.stats.done || 0) || ordered.indexOf(b) - ordered.indexOf(a))[0] || null;
  const failed = ordered.reduce((n, m) => n + ((m.stats && m.stats.cancelled) || 0) + ((m.stats && m.stats.error) || 0), 0);
  const mixed = ordered.filter(m => m.stats && m.stats.done > 0 && ((m.stats.cancelled || 0) + (m.stats.error || 0)) > 0).length;
  const conflicting = mixed >= 2 || iterations.some((it, i) => it.effect === "improved" && iterations.slice(i + 1).some(j => j.effect === "hurt"));
  return { ordered, iterations, best: best ? best.cid : null, best_name: best ? best.name : null, conflicting, failed };
}
// -> the text lines the reviewer reads.
function familyLines(fam, table) {
  const L = ["FAMILY: " + fam.name + " - " + table.ordered.length + " variants of the same model, in the order they were first printed (oldest first)"];
  table.ordered.forEach((m, i) => {
    const s = m.stats || {};
    L.push("  v" + (i + 1) + ": " + m.name + (m.paths && m.paths.length > 1 ? " (also at " + m.paths.slice(1, 3).join(", ") + ")" : "") +
      " - done " + (s.done || 0) + ", cancelled " + (s.cancelled || 0) + ", error " + (s.error || 0) +
      (s.first_at ? ", first printed " + new Date(s.first_at).toISOString().slice(0, 10) : ", never printed") +
      (s.time_ratio != null ? ", actual/estimate " + s.time_ratio : "") + (s.grams != null ? ", " + s.grams + " g" : "") + (s.est_minutes != null ? ", est " + s.est_minutes + " min" : "") +
      (table.best === m.cid ? "  <- best by the numbers" : ""));
  });
  table.iterations.forEach((it, i) => {
    L.push("  v" + (i + 1) + " -> v" + (i + 2) + ": " + (it.changes.length ? it.changes.map(c => c.key + " " + (c.from == null ? "(unset)" : c.from) + " -> " + (c.to == null ? "(unset)" : c.to)).join("; ") : "no listed setting changed") +
      (it.other ? " (+" + it.other + " other keys)" : "") + " => " + it.effect + ": " + it.why);
  });
  return L;
}

// Lessons the outcomes themselves justify, for the Hub to merge after a family
// review: an improvement backed by prints -> a lesson to apply; a regression
// -> an "avoid" lesson. Conditions = the family's printer type, material and
// geometry flags, plus the changed key at its old (apply) or new (avoid) value.
// confidence scales with the prints behind it. The reviewer's own call on an
// iteration (review.family.iterations[].effect) must agree with the numbers.
function familyLessons(table, meta) {
  const out = [];
  const M = meta || {};
  for (const it of table.iterations) {
    if (!it.changes.length || !it.backing) continue;
    if (it.effect !== "improved" && it.effect !== "hurt") continue;
    const agree = !M.review_effects || M.review_effects[it.to] == null || M.review_effects[it.to] === it.effect;
    if (!agree) continue;
    const changes = it.changes.slice(0, 4);
    const desc = changes.map(c => c.key + " " + (c.from == null ? "(unset)" : c.from) + " -> " + (c.to == null ? "(unset)" : c.to)).join(", ");
    const conf = Math.min(0.9, 0.5 + 0.1 * Math.min(4, it.backing));
    if (it.effect === "improved") {
      out.push({ signature: { printer_type: M.printer_type || "*", material: M.material || "*", tag: M.issue_tag || ("improve_" + changes[0].key), geometry_flags: M.geometry_flags || [],
                              setting_keys: changes.map(c => ({ key: c.key, equals: c.from == null ? undefined : c.from })).filter(k => k.equals !== undefined) },
                 finding: "On " + (M.printer_type || "this printer") + (M.material ? " with " + M.material : "") + ", " + desc + " improved outcomes: " + it.why,
                 change: { text: "Apply: " + desc, orca: Object.fromEntries(changes.filter(c => c.to != null).map(c => [c.key, c.to])), klipper: null },
                 confidence: conf, backing: it.backing, kind: "apply" });
    } else {
      out.push({ signature: { printer_type: M.printer_type || "*", material: M.material || "*", tag: "avoid_" + changes[0].key, geometry_flags: M.geometry_flags || [],
                              setting_keys: changes.map(c => ({ key: c.key, equals: c.to == null ? undefined : c.to })).filter(k => k.equals !== undefined) },
                 finding: "On " + (M.printer_type || "this printer") + (M.material ? " with " + M.material : "") + ", " + desc + " hurt outcomes: " + it.why,
                 change: { text: "Avoid: " + desc + "; go back to " + changes.map(c => c.key + " " + (c.from == null ? "(unset)" : c.from)).join(", "), orca: Object.fromEntries(changes.filter(c => c.from != null).map(c => [c.key, c.from])), klipper: null },
                 confidence: conf, backing: it.backing, kind: "avoid" });
    }
  }
  return out;
}
// One line per member from the review's own verdicts, else from the table.
function memberStatus(table, review) {
  const n = table.ordered.length;
  const best = (review && review.family && review.family.best && review.family.best.member) || table.best_name;
  const byName = new Map((review && review.family && Array.isArray(review.family.member_status) ? review.family.member_status : []).map(s => [String(s.member), String(s.line || "")]));
  return table.ordered.map((m, i) => {
    const it = table.iterations[i - 1];
    const own = byName.get(m.name) || byName.get(m.cid) || byName.get("v" + (i + 1));
    const isBest = best === m.name || best === m.cid || best === "v" + (i + 1);
    const line = own || ((isBest ? "current best" : (i < n - 1 ? "superseded by v" + (i + 2) : "latest attempt")) + (it && it.changes.length ? (it.effect === "improved" ? ": improved via " : it.effect === "hurt" ? ": regressed via " : ": changed ") + it.changes.slice(0, 2).map(c => c.key + " " + (c.from == null ? "(unset)" : c.from) + "->" + (c.to == null ? "(unset)" : c.to)).join(", ") : ""));
    return { member: m.cid, name: m.name, v: i + 1, of: n, best: isBest, line: "v" + (i + 1) + " of " + n + " - " + line };
  });
}

module.exports = { DIFF_KEYS, familyName, orderMembers, diffSettings, outcomeEffect, familyTable, familyLines, familyLessons, memberStatus };
