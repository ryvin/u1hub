// public/modules/estimate-ui.js — the Estimate tab. Fork module (ryvin/u1hub),
// injected only when features.estimate is on. Server half: modules/estimate.js;
// docs/estimate.md.
//
// Drop or pick STL / 3MF files -> each uploads as a raw body (with progress)
// into one estimate -> the server measures it, reads any slice info, looks for
// earlier prints -> the page shows Model, Print, Printed before, Cost & price,
// the inputs that re-price it (debounced; the newest answer wins), Save (to a
// costing client / project) and the reports (quote / internal PDF, CSV, Excel).
// Every server string goes through esc().
"use strict";
(function () {
  if (window.HUB_FEATURES && window.HUB_FEATURES.estimate === false) return;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); const d = await r.json().catch(() => null); return { ok: r.ok, status: r.status, d }; } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; } }
  async function jsend(p, b, method) {
    try { const r = await fetch(p, { method: method || "POST", headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) }); const d = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, d }; }
    catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }
  const usd = v => v == null ? "—" : "$" + Number(v).toFixed(2);
  const hm = m => m == null ? "—" : (m >= 60 ? Math.floor(m / 60) + " h " + String(Math.round(m % 60)).padStart(2, "0") + " min" : Math.round(m) + " min");
  const g = v => v == null ? "—" : Number(v).toFixed(2) + " g";

  function style() {
    if (document.getElementById("estcss")) return;
    const s = document.createElement("style");
    s.id = "estcss";
    s.textContent = [
      ".estwrap{display:flex; flex-direction:column; gap:12px; padding:4px 0 24px; max-width:1100px;}",
      ".esth{font-size:18px; margin:4px 0 0;} .estsub{font-size:12.5px; color:var(--ink-dim); line-height:1.55;}",
      ".estdrop{display:flex; flex-direction:column; align-items:center; gap:8px; padding:22px 16px; border:1.5px dashed var(--line); border-radius:var(--r-md,10px); background:var(--panel); text-align:center; color:var(--ink-dim); font-size:13px;}",
      ".estdrop.over{border-color:var(--signal); background:color-mix(in srgb, var(--signal) 8%, var(--panel));}",
      ".estdrop .btn{font-size:12.5px;} .estfiles{display:flex; flex-direction:column; gap:4px; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); width:100%; max-width:560px;}",
      ".estfile{display:flex; gap:8px; align-items:center;} .estfile .n{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left;} .estfile .bar{width:120px; height:5px; background:var(--panel-2); border-radius:3px; overflow:hidden;} .estfile .bar i{display:block; height:100%; background:var(--signal); transition:width .2s cubic-bezier(.2,.7,.2,1);}",
      ".estfile.err{color:var(--bad,#e5484d);}",
      ".estgrid{display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;}",
      ".estcard{padding:12px 14px; border:1px solid var(--line); border-radius:var(--r-md,10px); background:var(--panel); display:flex; flex-direction:column; gap:8px; min-width:0;}",
      ".estcard h3{margin:0; font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-faint);}",
      ".estkv{display:grid; grid-template-columns:auto 1fr; gap:3px 12px; font-size:12.5px;} .estkv .k{color:var(--ink-faint); font-family:var(--mono); font-size:11px; padding-top:1px;} .estkv .v{color:var(--ink); overflow-wrap:anywhere;}",
      ".estbadge{display:inline-block; font-family:var(--mono); font-size:10.5px; padding:1px 8px; border-radius:99px; border:1px solid var(--line); color:var(--ink-dim);} .estbadge.ok{color:var(--ok,#3dd68c);} .estbadge.warn{color:var(--warn,#f5b316);} .estbadge.bad{color:var(--bad,#e5484d);}",
      ".estthumb{display:flex; flex-wrap:wrap; gap:10px; align-items:center;} .estthumb img{width:96px; height:96px; object-fit:contain; border-radius:8px; background:var(--panel-2); flex:none;} .estthumb svg{flex:none; max-width:100%; height:auto; color:var(--ink-dim);} .estthumb .estkv{flex:1 1 150px; min-width:150px;}",
      ".estprice{font-size:30px; font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; line-height:1.1;} .estprice small{font-size:13px; font-weight:500; color:var(--ink-dim);}",
      ".esttable{width:100%; border-collapse:collapse; font-size:12px;} .esttable td, .esttable th{padding:4px 6px; border-bottom:1px solid var(--line-soft); text-align:right; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim);} .esttable th{font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); font-weight:600;}",
      ".esttable td:first-child, .esttable th:first-child{text-align:left; font-family:var(--sans); font-size:12.5px; color:var(--ink);} .esttable tr.tot td{border-top:2px solid var(--line); color:var(--ink); font-weight:600;}",
      ".estblank{font-size:11.5px; color:var(--warn,#f5b316);} .estmsg{font-size:12px; color:var(--bad,#e5484d);} .estok{font-size:12px; color:var(--ok,#3dd68c); font-family:var(--mono);}",
      ".estinputs{display:flex; flex-wrap:wrap; gap:8px 12px; align-items:flex-end; padding:10px 12px; border:1px solid var(--line); border-radius:var(--r-md,10px); background:var(--panel);}",
      ".estinputs label{display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--ink-faint); font-family:var(--mono);} .estinputs .field{font-size:12.5px; padding:4px 7px; width:auto; min-width:0; max-width:150px;}",
      ".estcand{display:flex; gap:10px; align-items:center; padding:8px; border:1px solid var(--line-soft); border-radius:8px;} .estcand img{width:56px; height:56px; object-fit:contain; border-radius:6px; background:var(--panel-2); flex:none;}",
      ".estcand .t{flex:1; min-width:0; font-size:12.5px; color:var(--ink); overflow-wrap:anywhere;} .estcand .s{font-family:var(--mono); font-size:11px; color:var(--ink-faint); margin-top:2px;}",
      ".estrow{display:flex; gap:8px; flex-wrap:wrap; align-items:center;} .estrow .btn{font-size:12px; padding:5px 11px;} .estrow .field{font-size:12.5px; padding:4px 7px; width:auto; max-width:220px;}",
      "@media (max-width:420px){ .estinputs .field{max-width:120px;} .estprice{font-size:24px;} }"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- state ----------------------------------------------------------------------------
  let EL = null, INFO = null, CUR = null, PROJ = null, FLEET = [];
  let seq = 0, debounce = null;
  const files = [];   // { name, pct, err, done }

  // ---- upload ---------------------------------------------------------------------------
  function uploadOne(file, id) {
    return new Promise(resolve => {
      const x = new XMLHttpRequest();
      const row = { name: file.name, pct: 0, err: null, done: false }; files.push(row); paintFiles();
      x.open("POST", "/api/estimate/upload" + (id ? "?id=" + encodeURIComponent(id) : ""));
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      x.upload.onprogress = e => { if (e.lengthComputable) { row.pct = Math.round(e.loaded / e.total * 100); paintFiles(); } };
      x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} if (x.status !== 200 || !d) { row.err = (d && d.error) || ("HTTP " + x.status); paintFiles(); return resolve(null); } row.pct = 100; paintFiles(); resolve({ row, ...d }); };
      x.onerror = () => { row.err = "upload failed"; paintFiles(); resolve(null); };
      x.send(file);
    });
  }
  async function waitJob(jobId, row) {
    for (let i = 0; i < 600; i++) {
      const r = await jget("/api/estimate/job?job=" + encodeURIComponent(jobId));
      if (r.ok && r.d.done) { row.done = true; row.err = r.d.error || null; paintFiles(); return; }
      await new Promise(w => setTimeout(w, 400));
    }
    row.err = "analysis timed out"; paintFiles();
  }
  async function addFiles(list) {
    const arr = [...list].filter(f => /\.(stl|3mf)$/i.test(f.name));
    if (!arr.length) { msg("Only .stl and .3mf files can be estimated."); return; }
    let id = CUR ? CUR.id : null;
    for (const f of arr) {
      const up = await uploadOne(f, id);
      if (!up) continue;
      id = up.id;
      await waitJob(up.jobId, up.row);
    }
    if (id) await load(id);
  }

  // ---- rendering ------------------------------------------------------------------------
  function msg(t) { const m = EL && EL.querySelector(".estm"); if (m) m.textContent = t || ""; }
  function paintFiles() {
    const box = EL && EL.querySelector(".estfiles"); if (!box) return;
    box.innerHTML = files.map(f => '<div class="estfile' + (f.err ? " err" : "") + '"><span class="n" title="' + esc(f.name) + '">' + esc(f.name) + '</span>'
      + (f.err ? '<span>' + esc(f.err) + '</span>' : '<span class="bar"><i style="width:' + f.pct + '%"></i></span><span>' + (f.done ? "measured" : f.pct >= 100 ? "measuring…" : f.pct + "%") + '</span>') + '</div>').join("");
  }
  function outline(size) {
    const [w, d, h] = (size || [0, 0, 0]).map(v => Math.max(0.1, v)), m = Math.max(w, d, h), sc = 80 / m;
    const rw = w * sc, rd = d * sc, rh = h * sc;
    return '<svg width="200" height="96" viewBox="0 0 200 96" role="img" aria-label="top and side outline"><rect x="' + (8 + (80 - rw) / 2) + '" y="' + (8 + (80 - rd) / 2) + '" width="' + rw + '" height="' + rd + '" fill="none" stroke="currentColor" stroke-opacity=".6"/>'
      + '<rect x="' + (108 + (80 - rw) / 2) + '" y="' + (88 - rh) + '" width="' + rw + '" height="' + rh + '" fill="none" stroke="currentColor" stroke-opacity=".6"/>'
      + '<text x="48" y="94" font-size="8" text-anchor="middle" fill="currentColor" opacity=".6">top</text><text x="148" y="94" font-size="8" text-anchor="middle" fill="currentColor" opacity=".6">side</text></svg>';
  }
  function modelCard(v) {
    const f0 = (v.files || [])[0] || {};
    const thumb = f0.kind === "3mf" ? '<img src="/api/estimate/' + encodeURIComponent(v.id) + '/thumb?file_id=' + encodeURIComponent(f0.file_id) + '" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment(this.dataset.svg))" data-svg="' + esc(outline(v.model.size_mm)) + '">' : outline(v.model.size_mm);
    const parts = (v.files || []).reduce((a, f) => a + ((f.facts && f.facts.parts) || []).reduce((s, p) => s + (p.copies || 1), 0), 0);
    const errs = (v.files || []).filter(f => f.error).map(f => '<div class="estmsg">' + esc(f.name) + ': ' + esc(f.error) + '</div>').join("")
      + (v.files || []).filter(f => f.warning && !f.error).map(f => '<div class="estblank">' + esc(f.name) + ': ' + esc(f.warning) + '</div>').join("");
    return '<div class="estcard"><h3>Model</h3><div class="estthumb">' + thumb + '<div class="estkv">'
      + '<span class="k">size</span><span class="v">' + (v.model.size_mm ? esc(v.model.size_mm.join(" × ")) + ' mm' : 'not measured') + '</span>'
      + '<span class="k">volume</span><span class="v">' + (v.model.volume_cm3 != null ? esc(v.model.volume_cm3) + ' cm³' : '—') + '</span>'
      + '<span class="k">parts</span><span class="v">' + esc(parts || "—") + '</span>'
      + '<span class="k">colours</span><span class="v">' + esc(v.print.colours) + '</span></div></div>'
      + '<div class="estkv"><span class="k">fits</span><span class="v">' + (v.fits == null ? '<span class="estbadge">size not measured</span>' : v.fits.length ? esc(v.fits.join(", ")) : '<span class="estbadge bad">doesn\'t fit any printer</span>') + (v.fits_unchecked && v.fits_unchecked.length ? ' <span class="estbadge">size unchecked: ' + esc(v.fits_unchecked.join(", ")) + '</span>' : "") + '</span></div>' + errs + '</div>';
  }
  function printCard(v) {
    const p = v.print, sup = { yes: "warn", maybe: "", no: "ok" }[p.supports_needed] || "";
    return '<div class="estcard"><h3>Print</h3><div class="estkv">'
      + '<span class="k">grams</span><span class="v">' + g(p.grams) + ' each</span>'
      + '<span class="k">time</span><span class="v">' + hm(p.minutes) + ' each</span>'
      + '<span class="k">source</span><span class="v"><span class="estbadge' + (p.band_pct ? "" : " ok") + '">' + esc(v.source_label) + '</span>'
      + ((v.sources_available || []).filter(x => x !== "printed").length > 1 ? ' ' + (v.sources_available || []).filter(x => x !== "printed" && x !== v.source).map(x => '<a href="#" data-est="src" data-src="' + esc(x) + '" style="font-size:11px; color:var(--ink-dim)">use ' + (x === "sliced" ? "the file's slice" : "geometry") + '</a>').join(" ") : "") + '</span>'
      + '<span class="k">supports</span><span class="v"><span class="estbadge ' + sup + '">' + esc(p.supports_needed) + '</span>' + (p.supports_g ? ' ≈ ' + g(p.supports_g) : "") + '</span>'
      + '<span class="k">plates</span><span class="v">' + esc(p.plates) + '</span>'
      + (p.designer_minutes ? '<span class="k">designer</span><span class="v">' + hm(p.designer_minutes) + ' on their slicer (their printer)</span>' : "")
      + '</div>' + (p.brim ? '<div class="estsub">Tall and narrow: add a brim.</div>' : "") + (p.multiace ? '<div class="estsub">More than 4 colours: prints through multiACE; check the swap count on the printer card.</div>' : "")
      + (v.schedule && v.schedule.length ? '<div class="estsub">' + v.schedule.map(s => esc(s.name) + ': ' + (s.free_in_min ? 'free in ' + hm(s.free_in_min) : esc(s.state))).join(" · ") + '</div>' : "") + '</div>';
  }
  function candCard(v) {
    const cs = v.candidates || [];
    if (!cs.length) return '<div class="estcard"><h3>Printed before?</h3><div class="estsub">No earlier print found.</div></div>';
    const badge = c => c.size_check === "same" ? '<span class="estbadge ok">same size</span>' : c.size_check === "different" ? '<span class="estbadge bad">different size</span>' : '<span class="estbadge">size unchecked</span>';
    return '<div class="estcard"><h3>Printed before?</h3>' + cs.map(c => '<div class="estcand">'
      + (c.printer_id != null && c.file ? '<img loading="lazy" alt="" src="/api/pthumb?id=' + encodeURIComponent(c.printer_id) + '&file=' + encodeURIComponent(c.file) + '">' : "")
      + '<div class="t">' + esc(c.file) + '<div class="s">' + (c.kind === "printed" ? esc(c.times_printed) + '× · ' + Math.round((c.success_rate || 0) * 100) + '% done · ' + esc(c.printer || "") + (c.actual_minutes ? ' · actual ' + hm(c.actual_minutes) : "") : 'in the library, not printed') + (c.grams ? ' · ' + g(c.grams) : "") + ' ' + badge(c) + (c.same_file ? ' <span class="estbadge ok">same file</span>' : "") + '</div></div>'
      + (v.source === "printed" && v.candidate_key === c.key ? '<span class="estbadge ok">in use</span>' : '<button class="btn" data-est="use" data-key="' + esc(c.key) + '">Use these numbers</button>') + '</div>').join("")
      + (v.source === "printed" ? '<div class="estrow"><a href="#" data-est="geo" style="font-size:12px; color:var(--ink-dim)">back to the estimate</a></div>' : "") + '</div>';
  }
  function priceCard(v) {
    const c = v.cost || {}, rec = v.recommended || {}, P = v.pricing || { methods: [], breaks: [] };
    const blanks = (v.blanks || []).map(b => '<div class="estblank">' + esc(b) + '</div>').join("");
    const rows = [["Material", c.material], ["Machine", c.machine], ["Electricity", c.energy], ["Labour", c.labor && c.labor.cost], ["Failure allowance", c.failure], ["Overhead", c.overhead]];
    return '<div class="estcard"><h3>Cost &amp; price</h3><div class="estprice">' + usd(rec.price) + (v.qty > 1 ? ' <small>' + usd(rec.each) + ' each × ' + esc(v.qty) + '</small>' : "") + '</div>'
      + '<div class="estsub">recommended: the higher of your markup and your per-gram floor' + (rec.rush && rec.rush !== 1 ? ', × ' + esc(rec.rush) + ' rush' : "") + '</div>'
      + '<table class="esttable"><tr><th>Cost</th><th></th></tr>' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + usd(r[1]) + '</td></tr>').join("") + '<tr class="tot"><td>Total cost</td><td>' + usd(c.cost) + '</td></tr></table>' + blanks
      + '<table class="esttable"><tr><th>Method</th><th>Price</th><th>Each</th><th>Listed</th></tr>' + (P.methods || []).map(m => '<tr><td title="' + esc(m.note) + '">' + esc(m.label) + '</td><td>' + usd(m.price) + '</td><td>' + usd(m.per_piece) + '</td><td>' + usd(m.gross) + '</td></tr>').join("") + '</table>'
      + ((P.breaks || []).length ? '<div class="estsub">Quantity breaks (cost + markup): ' + P.breaks.map(b => '×' + esc(b.qty) + ' ' + usd(b.each) + ' each').join(" · ") + '</div>' : "") + '</div>';
  }
  function inputsBar(v) {
    const I = v.inputs || {}, opt = (list, cur) => list.map(o => '<option value="' + esc(o.v) + '"' + (String(o.v) === String(cur) ? " selected" : "") + '>' + esc(o.l) + '</option>').join("");
    const printers = FLEET.map(p => ({ v: p.id, l: p.name }));
    return '<div class="estinputs">'
      + '<label>qty<input class="field" type="number" min="1" max="10000" data-in="qty" value="' + esc(I.qty) + '"></label>'
      + '<label>material<select class="field" data-in="material">' + opt((INFO.materials || []).map(m => ({ v: m, l: m })), I.material) + '</select></label>'
      + '<label>preset<select class="field" data-in="preset">' + opt((INFO.presets || []).map(p => ({ v: p.key, l: p.label })), I.preset) + '</select></label>'
      + '<label>infill %<input class="field" type="number" min="0" max="100" step="5" data-in="infill" value="' + (I.infill == null ? "" : Math.round(I.infill * 100)) + '" placeholder="preset"></label>'
      + '<label>supports<select class="field" data-in="supports">' + opt([{ v: "auto", l: "auto" }, { v: "on", l: "on" }, { v: "off", l: "off" }], I.supports) + '</select></label>'
      + '<label>labour min<input class="field" type="number" min="0" max="6000" data-in="labor_minutes" value="' + esc(I.labor_minutes) + '"></label>'
      + '<label>rush ×<input class="field" type="number" min="0.5" max="5" step="0.25" data-in="rush" value="' + esc(I.rush) + '"></label>'
      + '<label>colours<input class="field" type="number" min="1" max="16" data-in="colours" value="' + (I.colours == null ? "" : esc(I.colours)) + '" placeholder="auto"></label>'
      + '<label>printer<select class="field" data-in="printer_id"><option value="">first that fits</option>' + opt(printers, I.printer_id == null ? "" : I.printer_id) + '</select></label>'
      + '<span class="estmsg esti"></span></div>';
  }
  function saveBar(v) {
    const D = PROJ || { clients: [], projects: [] };
    const cl = '<option value="">client</option>' + (D.clients || []).map(c => '<option value="' + esc(c.id) + '"' + (c.id === v.client_id ? " selected" : "") + '>' + esc(c.name) + '</option>').join("");
    const pr = '<option value="">project</option>' + (D.projects || []).map(p => '<option value="' + esc(p.id) + '"' + (p.id === v.project_id ? " selected" : "") + '>' + esc(p.name) + '</option>').join("");
    const base = "/api/estimate/" + encodeURIComponent(v.id) + "/report?";
    return '<div class="estcard"><h3>Save &amp; reports</h3><div class="estrow"><select class="field" data-sv="client_id">' + cl + '</select><select class="field" data-sv="project_id">' + pr + '</select>'
      + '<input class="field" data-sv="note" placeholder="note" value="' + esc(v.note || "") + '"><button class="btn primary" data-est="save">' + (v.saved ? "Saved ✓ update" : "Save") + '</button></div>'
      + '<div class="estrow"><button class="btn" data-est="pdf" data-view="quote">Quote PDF</button><button class="btn" data-est="pdf" data-view="internal">Internal PDF</button>'
      + '<button class="btn" data-est="dl" data-href="' + esc(base + 'format=csv&view=internal') + '">CSV</button><button class="btn" data-est="dl" data-href="' + esc(base + 'format=xlsx&view=internal') + '">Excel</button>'
      + '<a href="#" data-est="new" style="font-size:12px; color:var(--ink-dim)">start a new estimate</a></div><div class="estok esto"></div></div>';
  }
  async function paintSaved() {
    const box = EL && EL.querySelector(".estsaved"); if (!box) return;
    const r = await jget("/api/estimate");
    const list = (r.ok && r.d.saved) || [];
    box.innerHTML = '<div class="estcard"><h3>Saved estimates</h3>' + (list.length ? '<table class="esttable"><tr><th>Estimate</th><th>Date</th><th>Quoted</th><th>Actual</th><th></th></tr>'
      + list.map(s => '<tr><td><a href="#" data-est="open" data-id="' + esc(s.id) + '" style="color:inherit">' + esc(s.name) + '</a>' + (s.note ? '<div class="estsub">' + esc(s.note) + '</div>' : "") + '</td><td>' + esc(new Date(s.created).toISOString().slice(0, 10)) + '</td><td>' + usd(s.recommended && s.recommended.price) + '</td><td>' + (s.project_id ? usd(s.actual) : "—") + '</td><td><button class="btn" data-est="del" data-id="' + esc(s.id) + '">Delete</button></td></tr>').join("") + '</table>'
      : '<div class="estsub">Nothing saved yet.</div>') + '</div>';
  }
  function render() {
    if (!EL) return;
    const out = EL.querySelector(".estout");
    if (!CUR) { out.innerHTML = ""; return; }
    const v = CUR;
    out.innerHTML = inputsBar(v) + '<div class="estgrid">' + modelCard(v) + printCard(v) + priceCard(v) + candCard(v) + '</div>' + saveBar(v);
  }

  // ---- actions --------------------------------------------------------------------------
  async function load(id) {
    const r = await jget("/api/estimate/" + encodeURIComponent(id));
    if (!r.ok) { msg((r.d && r.d.error) || "could not load the estimate"); return; }
    CUR = r.d; render();
  }
  function onInput(e) {
    const t = e.target.closest("[data-in]"); if (!t || !CUR) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const body = {};
      EL.querySelectorAll("[data-in]").forEach(el => {
        const k = el.dataset.in; let v = el.value;
        if (k === "infill") v = v === "" ? null : Number(v) / 100;
        else if (["qty", "labor_minutes", "rush", "colours"].includes(k)) v = v === "" ? null : Number(v);
        else if (k === "printer_id") v = v === "" ? null : Number(v);
        body[k] = v;
      });
      const mine = ++seq;
      const r = await jsend("/api/estimate/" + encodeURIComponent(CUR.id) + "/inputs", body);
      if (mine !== seq) return;   // a newer change is on its way
      const m = EL.querySelector(".esti");
      if (!r.ok) { if (m) m.textContent = (r.d && r.d.error) || "could not re-price"; return; }
      CUR = r.d;
      const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.in : null;
      render();
      if (focus) { const el = EL.querySelector('[data-in="' + focus + '"]'); if (el) el.focus(); }
    }, 300);
  }
  async function onClick(e) {
    const t = e.target.closest("[data-est]"); if (!t) return;
    const act = t.dataset.est;
    if (t.tagName === "A") e.preventDefault();
    if (act === "pick") return EL.querySelector(".estpick").click();
    if (act === "dl") { const a = document.createElement("a"); a.href = t.dataset.href; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); return; }
    if (act === "new") { CUR = null; files.length = 0; paintFiles(); render(); return; }
    if (act === "open") return load(t.dataset.id);
    if (act === "del") { await jsend("/api/estimate/" + encodeURIComponent(t.dataset.id), undefined, "DELETE"); if (CUR && CUR.id === t.dataset.id) { CUR = null; render(); } return paintSaved(); }
    if (!CUR) return;
    if (act === "use" || act === "geo" || act === "src") {
      const back = (CUR.sources_available || []).includes("sliced") ? "sliced" : ((CUR.sources_available || []).find(x => x !== "printed") || "geometry");
      const r = await jsend("/api/estimate/" + encodeURIComponent(CUR.id) + "/source", act === "use" ? { source: "printed", key: t.dataset.key } : { source: act === "src" ? t.dataset.src : back });
      if (r.ok) { CUR = r.d; render(); } else msg((r.d && r.d.error) || "could not switch");
      return;
    }
    if (act === "save") {
      const b = {}; EL.querySelectorAll("[data-sv]").forEach(el => { b[el.dataset.sv] = el.value || null; });
      const r = await jsend("/api/estimate/" + encodeURIComponent(CUR.id) + "/save", b);
      if (r.ok) { CUR = r.d; render(); const o = EL.querySelector(".esto"); if (o) o.textContent = "Saved."; paintSaved(); } else msg((r.d && r.d.error) || "could not save");
      return;
    }
    if (act === "pdf") {
      const w = window.open("/api/estimate/" + encodeURIComponent(CUR.id) + "/report?format=pdf&view=" + encodeURIComponent(t.dataset.view), "_blank");
      if (w) w.addEventListener("load", () => { try { w.print(); } catch {} });
    }
  }

  // ---- the tab --------------------------------------------------------------------------
  function mount(el) {
    style();
    EL = el;
    el.innerHTML = '<div class="estwrap"><h2 class="esth">Estimate</h2><div class="estsub">Drop an STL or 3MF to get grams, print time, what it costs you and what to charge. Numbers say where they came from: the model\'s geometry, the file\'s own slice, or an earlier print of the same model.</div>'
      + '<div class="estdrop"><div>Drop .stl / .3mf files here</div><button class="btn" data-est="pick">Choose files</button><input class="estpick" type="file" accept=".stl,.3mf" multiple hidden><div class="estfiles"></div></div>'
      + '<div class="estmsg estm"></div><div class="estout"></div><div class="estsaved"></div></div>';
    const drop = el.querySelector(".estdrop"), pick = el.querySelector(".estpick");
    pick.addEventListener("change", () => { if (pick.files.length) addFiles(pick.files); pick.value = ""; });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    el.addEventListener("click", onClick);
    el.addEventListener("input", onInput);
    el.addEventListener("change", onInput);
  }
  async function onShow() {
    if (!INFO) { const r = await jget("/api/estimate/info"); INFO = r.ok ? r.d : { presets: [], materials: [] }; }
    const [p, f] = await Promise.all([jget("/api/costing/projects"), jget("/api/fleet")]);
    PROJ = p.ok ? p.d : null; FLEET = f.ok && Array.isArray(f.d) ? f.d : [];
    render(); paintSaved();
  }
  window.HubModules.register("estimate", { tab: "Estimate", mount, onShow });
})();
