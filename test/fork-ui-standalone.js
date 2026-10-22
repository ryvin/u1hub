// test/fork-ui-standalone.js - fork (ryvin/u1hub) checks on the two upstream
// client touch points the fork carries (docs/upstream-issues.md):
//   1. a thumbnail URL that failed once is not requested again on every
//      15 s list re-render (public/app.js lazyImg);
//   2. the desktop top bar may wrap instead of overflowing to the left under
//      the sidebar (public/gold.css).
// Run: node test/fork-ui-standalone.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -- " + detail : "")); }
}

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8").replace(/\r\n/g, "\n");
const GOLD = fs.readFileSync(path.join(ROOT, "public", "gold.css"), "utf8").replace(/\r\n/g, "\n");

// ---- 1. lazyImg: a failed thumbnail is not asked for again -----------------
// Lift the thumbnail block (THUMB_SEEN .. armLazy) out of app.js and run it in
// a sandbox, so the check exercises the shipped code, not a copy of it.
const start = APP.indexOf("const THUMB_SEEN");
const endMark = APP.indexOf("function armLazy");
const end = APP.indexOf("\n", endMark);
check("app.js thumbnail block found", start > 0 && endMark > start, "THUMB_SEEN / armLazy markers moved");
const block = APP.slice(start, end);

function sandbox(withIO) {
  const observed = [];
  const ctx = { window: {} };
  if (withIO) ctx.window.IntersectionObserver = ctx.IntersectionObserver = function (cb) { this.observe = i => observed.push(i); this.unobserve = () => {}; this.cb = cb; };
  vm.createContext(ctx);
  vm.runInContext(block + "\n;this.lazyImg = lazyImg; this.THUMB_SEEN = THUMB_SEEN;", ctx);
  return ctx;
}
// Run the <img>'s own onerror attribute the way the browser would, on a fake img.
function fireError(ctx, html, url) {
  const m = /onerror="([^"]*)"/.exec(html);
  if (!m) return false;
  const img = { style: {}, dataset: {}, getAttribute: a => (a === "src" ? url : null), src: url };
  vm.runInContext("(function(){" + m[1].replace(/&quot;/g, '"') + "}).call(__img)", Object.assign(ctx, { __img: img }));
  return img.style.display === "none";
}
const hasRequest = html => /\ssrc="/.test(html) || /\sdata-src="/.test(html);

for (const withIO of [false, true]) {
  const tag = withIO ? " (IntersectionObserver)" : " (no IntersectionObserver)";
  const ctx = sandbox(withIO);
  const url = "/api/thumb?file=Rye%20crate.gcode&type=u1&v=1";
  const first = ctx.lazyImg("jthumb", url);
  check("first render asks for the thumbnail" + tag, hasRequest(first), first);
  if (withIO) ctx.THUMB_SEEN.add(url);          // what the observer does when the row scrolls in
  const shown = ctx.lazyImg("jthumb", url);
  check("onerror still hides the broken image" + tag, fireError(ctx, shown, url));
  const again = ctx.lazyImg("jthumb", url);
  check("a thumbnail that failed is not requested again on re-render" + tag, !hasRequest(again), again);
  check("the re-rendered placeholder stays hidden" + tag, /display:\s*none/.test(again), again);
  const other = ctx.lazyImg("jthumb", "/api/thumb?file=Rye%20crate.gcode&type=u1&v=2");
  check("a new file version (new ?v=) is asked for again" + tag, hasRequest(other), other);
}

// The printing card's thumbnail is rebuilt on every fleet tick; it must go
// through the same miss-aware helper, not a bare <img src>.
check("renderFleet's cthumb goes through thumbTag()", /thumbTag\("cthumb"/.test(APP) && !/<img class="cthumb"[^>]*\ssrc=/.test(APP));

// ---- 2. gold.css: the desktop top bar may wrap -----------------------------
// Upstream's .topbar is a nowrap flex row pushed to the right edge; when the
// tabs + badges + gear buttons are wider than .main, the overflow goes LEFT,
// under the sticky sidebar. The fork rule lets the row wrap at desktop widths.
// (Layout itself is verified in a real browser; see docs/upstream-issues.md.)
function rulesFor(css, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(",").map(s => s.trim().replace(/^.*\*\/\s*/s, ""));
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}
// Only rules outside max-width (phone) media blocks count: strip those blocks.
const desktopCss = GOLD.replace(/@media\s*\(max-width:[^)]*\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
check("gold.css: .topbar wraps at desktop widths", rulesFor(desktopCss, ".topbar").some(b => /flex-wrap\s*:\s*wrap/.test(b)));
check("gold.css: .viewtabs wraps at desktop widths", rulesFor(desktopCss, ".viewtabs").some(b => /flex-wrap\s*:\s*wrap/.test(b)));
check("gold.css: .viewtabs may shrink below its content (min-width:0)", rulesFor(desktopCss, ".viewtabs").some(b => /min-width\s*:\s*0/.test(b)));

// ---- 3. 2.45 config schema and nightly backups know the fork's state --------
// core/config.js CONFIG_SCHEMA warns on unknown top-level keys; core/health.js
// STATE_FILES is what the nightly backup copies. Both are upstream lists with
// a marked fork touch point.
const CFGSRC = fs.readFileSync(path.join(ROOT, "core", "config.js"), "utf8").replace(/\r\n/g, "\n");
const sm = /const CONFIG_SCHEMA = (\{[\s\S]*?\});/.exec(CFGSRC);
check("config.js CONFIG_SCHEMA found", !!sm);
const SCHEMA = sm ? vm.runInNewContext("(" + sm[1] + ")") : {};
for (const k of ["costing", "estimate", "multiace", "sme", "bl2u1"])
  check("config schema knows the fork key \"" + k + "\" as an object (no unknown-key warning at boot)", SCHEMA[k] === "object", String(SCHEMA[k]));
const { STATE_FILES } = require(path.join(ROOT, "core", "health.js"));
for (const f of ["prints.json", "projects.json", "estimate-store.json", "estimate-calibration.json", "multiace.json", "sme-lessons.json"])
  check("nightly backup copies the fork state file " + f, STATE_FILES.includes(f));

console.log(`\nfork-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
