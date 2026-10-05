// modules/bl2u1.js — fork module (ryvin/u1hub), not upstream.
//
// The Models tab's "Convert to U1" button, done by the owner's own converter
// (github ryvin/bambu-to-snapmaker-converter, "bl2u1", container
// bambu-to-u1-converter on :8090) instead of upstream's template merge.
//
// Why: upstream's convert (modules/models.js POST /api/models/convert) writes
// the U1 copy beside the original, and on this host the 3MF folders are
// mounted READ-ONLY into the Hub (E:\3d at the models root, E:\Downloads at
// <root>/downloads) - so it cannot write. bl2u1 already mounts the whole E:
// drive read-write, knows Bambu projects (re-centres 256 -> 230 mm, maps
// filaments, carries tree supports), and writes to its own output folder
// (its settings: /mnt/e/3D/converted_u1), which is inside E:\3d, so the
// converted copy shows up on the Models tab by itself.
//
// How: this module registers POST /api/models/convert BEFORE the models
// module (MODULE_TABLE order), translates the card's models-relative path to
// the host path bl2u1 sees, calls bl2u1's POST /convert-file, and answers in
// the shape models-ui.js already renders. When bl2u1 cannot help - not
// reachable, not configured, or the file is not a Bambu Lab project - it
// calls next() and upstream's template convert answers exactly as before.
//
// GET /api/bl2u1 reports the configuration and whether bl2u1 answers.
// Config (config.json "bl2u1", all optional):
//   url    bl2u1's base URL (default http://host.docker.internal:8090)
//   roots  [{ rel, host }] models-relative prefix -> host path bl2u1 sees,
//          longest rel first (default: "downloads/" -> /mnt/e/Downloads/,
//          "" -> /mnt/e/3d/, matching docker-compose.override.yml here)

"use strict";

const fs = require("fs");

const TIMEOUT_MS = 10 * 60 * 1000;          // a big multi-plate project can take minutes
const PROBE_MS = 3000;
const DEFAULT_URL = "http://host.docker.internal:8090";
const DEFAULT_ROOTS = [{ rel: "downloads/", host: "/mnt/e/Downloads/" }, { rel: "", host: "/mnt/e/3d/" }];

const slash = s => String(s || "").replace(/\\/g, "/");
const withSlash = s => { const t = slash(s); return t && !t.endsWith("/") ? t + "/" : t; };

// models-relative path -> host path for bl2u1 (null when no root matches or
// the path tries to climb out)
function toHost(rel, roots) {
  const r = slash(rel).replace(/^\/+/, "");
  if (!r || r.split("/").some(p => p === ".." || p === ".")) return null;
  const sorted = [...roots].sort((a, b) => slash(b.rel).length - slash(a.rel).length);
  for (const root of sorted) {
    const pre = slash(root.rel);
    if (pre === "" || r.toLowerCase().startsWith(pre.toLowerCase())) return withSlash(root.host) + r.slice(pre.length);
  }
  return null;
}
// host path (bl2u1's output) -> models-relative path; Windows paths are
// case-insensitive (bl2u1 says /mnt/e/3D, the Hub mounts /mnt/e/3d)
function toRel(hostPath, roots) {
  const h = slash(hostPath);
  const sorted = [...roots].sort((a, b) => slash(b.host).length - slash(a.host).length);
  for (const root of sorted) {
    const pre = withSlash(root.host);
    if (pre && h.toLowerCase().startsWith(pre.toLowerCase())) return slash(root.rel) + h.slice(pre.length);
  }
  return null;
}

function register(ctx) {
  // The built-in URL (host.docker.internal) only means "the converter on this
  // PC" from inside the Hub's container. A Hub run anywhere else - the test
  // harness on the host, a Windows service install - must name bl2u1 in
  // config.json, or this module stays out of the way: a harness Hub on this
  // PC reached the owner's real bl2u1 on 2026-10-05.
  const IN_DOCKER = fs.existsSync("/.dockerenv");
  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.bl2u1 === "object" && ctx.cfg.bl2u1) || {};
    const roots = Array.isArray(c.roots) && c.roots.length ? c.roots.filter(x => x && typeof x.host === "string").map(x => ({ rel: String(x.rel || ""), host: String(x.host) })) : DEFAULT_ROOTS;
    const url = c.url ? String(c.url) : (IN_DOCKER ? DEFAULT_URL : "");
    return { url: url.replace(/\/+$/, ""), roots, configured: !!url };
  };

  async function call(method, p, body, ms) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(conf().url + p, { method, signal: ac.signal, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      let d = null; try { d = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, d };
    } finally { clearTimeout(to); }
  }

  // Ask the models module to re-walk its folder so the new card appears
  // without waiting for its TTL. Loopback GET to this Hub; failing it only
  // means the card shows up on the next natural refresh.
  function refreshModels() {
    const port = Number(process.env.U1HUB_PORT) || (ctx.cfg && ctx.cfg.port) || 4545;
    fetch("http://127.0.0.1:" + port + "/api/models?refresh=1&limit=1").catch(() => {});
  }

  ctx.app.get("/api/bl2u1", async (req, res) => {
    const c = conf();
    let reachable = false, settings = null, error = null;
    if (!c.configured) return res.json({ fork: "ryvin/u1hub", configured: false, url: null, roots: c.roots, reachable: false, error: "no bl2u1 url (set config.json bl2u1.url; the built-in default applies only inside the Hub's Docker container)", output_folder: null, output_rel: null });
    try { const r = await call("GET", "/settings", null, PROBE_MS); reachable = r.ok; settings = r.d; }
    catch (e) { error = String(e.message || e); }
    res.json({ fork: "ryvin/u1hub", configured: true, url: c.url, roots: c.roots, reachable, error,
      output_folder: settings && settings.output_folder || null,
      output_rel: settings && settings.output_folder ? toRel(settings.output_folder, c.roots) : null });
  });

  ctx.app.post("/api/models/convert", async (req, res, next) => {
    const rel = String((req.body || {}).file || "");
    const c = conf();
    if (!c.configured) return next();                                  // not configured here: upstream decides
    const host = toHost(rel, c.roots);
    if (!host) return next();                                         // not under a mapped root: upstream decides
    let settings;
    try { settings = (await call("GET", "/settings", null, PROBE_MS)).d || {}; }
    catch (e) { ctx.hublog("info", "bl2u1: not reachable (" + String(e.message || e) + "), using the template convert"); return next(); }
    let r;
    try { r = await call("POST", "/convert-file", { filepath: host }, TIMEOUT_MS); }
    catch (e) { ctx.hublog("warn", "bl2u1: convert of " + rel + " failed - " + String(e.message || e)); return next(); }
    const d = r.d || {};
    if (r.ok && d.skipped && d.error === "Not a Bambu Lab file") return next();   // not bl2u1's job: upstream's template convert
    // bl2u1 cannot see the file at the mapped host path: the roots do not
    // describe this install (a Hub run outside this host's Docker mounts, or
    // a moved folder). Not bl2u1's job either - measured 2026-10-05: the
    // harness's Hub reached the real bl2u1 and got "File not found".
    if (r.status === 404 && /file not found/i.test(String(d.error || ""))) { ctx.hublog("info", "bl2u1: " + host + " is not visible to bl2u1 (roots do not match), using the template convert"); return next(); }
    const outFolder = settings.output_folder || "";
    const base = rel.split("/").pop().replace(/\.3mf$/i, "");
    const outName = d.output_filename || (base + "_U1.3mf");
    const outRel = outFolder ? toRel(withSlash(outFolder) + outName, c.roots) : null;
    if (r.ok && d.skipped) {
      // bl2u1 has converted this exact file (same hash) before
      return res.status(409).json({ error: "Already converted by bl2u1 - " + outName + (outRel ? " is in " + outRel.split("/").slice(0, -1).join("/") : " is in bl2u1's output folder") + ".",
        exists: !!outRel, rel: outRel, converter: "bl2u1" });
    }
    if (!r.ok || !d.success) {
      return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({ error: "bl2u1 could not convert it: " + (d.error || ("HTTP " + r.status)), converter: "bl2u1" });
    }
    ctx.hublog("info", "bl2u1: converted " + rel + " -> " + (outRel || outName) + " (" + (d.filaments || 0) + " filaments)");
    refreshModels();
    const notes = ["Converted by bl2u1 (" + c.url + "): re-centred for the U1 bed, filaments auto-mapped, supports carried" + (outRel ? "; the copy is in " + outRel.split("/").slice(0, -1).join("/") : "")];
    if ((d.filaments || 0) > 4) notes.push("The original uses " + d.filaments + " filaments; the U1 has 4 heads - print it on davinci via multiACE, or re-assign colours in Orca");
    res.json({ ok: true, rel: outRel || outName, from: rel, item: null, converter: "bl2u1",
      printer: "Snapmaker U1", process: null, kept: [], carried: [], skipped: [], mismatched: [], over4: 0, remapped: 0,
      notes, changed: true, template: null, profiles: "bl2u1", filaments: d.filaments || 0 });
  });

  ctx.hublog("info", "bl2u1 (ryvin/u1hub fork module) " + (conf().configured ? "armed: Convert to U1 goes to " + conf().url + " first, the template convert when it cannot help" : "idle: no bl2u1 url configured outside Docker, the template convert answers"));
}

module.exports = { register, toHost, toRel, DEFAULT_ROOTS, DEFAULT_URL };
