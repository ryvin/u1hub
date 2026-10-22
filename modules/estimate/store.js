// modules/estimate/store.js — estimate-store.json on disk: read once at boot,
// written tmp + rename. Fork module estimate (ryvin/u1hub).
//
// Writes: <file>.tmp, then rename over the store, so a crash mid-write never
// leaves a half store. Where the filesystem refuses rename-over-existing (the
// X: share; modules/dispatch.js save() and costing.js writeState() have the
// same fallback) it latches to direct writes for the rest of the run and warns
// once. A tmp write that fails (disk full) throws and leaves the store alone:
// falling back to a direct write there would truncate the one good copy.
//
// Reads: a store that does not parse is moved aside as
// <file>.corrupt-<time> and logged as an error, so the next save cannot
// replace the owner's estimates with an empty store. If it cannot be moved or
// copied aside, the caller is told to stop saving for this run.
"use strict";
const fs = require("fs"), path = require("path");

function writer(file, o) {
  const F = (o && o.fs) || fs.promises, warn = (o && o.warn) || (() => {});
  const tmp = file + ".tmp";
  let direct = false;
  return async function write(data) {
    if (!direct) {
      try { await F.writeFile(tmp, data); }
      catch (e) { await F.unlink(tmp).catch(() => {}); throw e; }
      try { await F.rename(tmp, file); return "atomic"; }
      catch (e) { direct = true; warn("atomic save failed (" + (e.code || "") + " " + e.message + ") - direct writes for the rest of this run"); }
    }
    try { await F.writeFile(file, data); }
    finally { await F.unlink(tmp).catch(() => {}); }
    return "direct";
  };
}

const stamp = now => new Date(now).toISOString().replace(/[:.]/g, "-");

// -> { state }            a good store ({ estimates: {...} })
//    { missing: true }     no store yet
//    { corrupt: <path> }   damaged; moved (or copied) aside to <path>, start empty
//    { blocked: true }     damaged or unreadable and could not be kept aside: do not save this run
function load(file, o) {
  const F = (o && o.fs) || fs, log = (o && o.log) || (() => {}), now = (o && o.now) || Date.now();
  const name = path.basename(file);
  let text;
  try { text = F.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return { missing: true };
    log("error", "estimate: " + name + " could not be read (" + (e.code || "") + " " + e.message + ") - saving is off until it is readable, so it is not overwritten");
    return { blocked: true };
  }
  let why = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j) && j.estimates && typeof j.estimates === "object" && !Array.isArray(j.estimates)) return { state: j };
    why = "no estimates object";
  } catch (e) { why = e.message; }
  const aside = file + ".corrupt-" + stamp(now);
  let kept = false;
  try { F.renameSync(file, aside); kept = true; }
  catch { try { F.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL); kept = true; } catch {} }
  if (!kept) {
    log("error", "estimate: " + name + " is damaged (" + why + ") and could not be kept aside - saving is off for this run so it is not overwritten");
    return { blocked: true };
  }
  log("error", "estimate: " + name + " is damaged (" + why + ") - kept as " + path.basename(aside) + ", starting with no estimates");
  return { corrupt: aside };
}
module.exports = { writer, load };
