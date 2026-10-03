// public/modules/costing-ui.js — fork module (ryvin/u1hub), not upstream.
// Injected only when features.costing is on. Server side: modules/costing.js.
// Three places:
//   * the Projects tab, in three views under one nav tab (Projects | Prints |
//     Reports): clients and their projects, with a project page (the cost
//     summary where every line says where its number came from, the prints
//     on it, line items, the pricing helper, charged and margin, Export CSV
//     and Print quote); the full ledger as a filtered, paged list with
//     multi-select, bulk assign / don't count, and "assign every print whose
//     file name matches"; and reports over a date range grouped by client,
//     project, printer, type, month, material or outcome, with CSV and a
//     printable page.
//   * the job card: a project dropdown under the worth-printing line, so the
//     NEXT print of the selected file lands in that project.
//   * Settings: the rates, global and per printer.
// Same voice as margin-ui.js / logbook-ui.js: mono readouts, sans inputs, the
// gold.css tokens, nothing decided for the person. Every user string escaped.
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
    } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }
  const usd = v => v == null ? "—" : "$" + Number(v).toFixed(2);
  const hrs = h => h == null ? "—" : (h < 1 ? Math.round(h * 60) + " min" : (Math.round(h * 10) / 10) + " h");
  const when = t => { const d = new Date(t); return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const typeSlug = () => (typeof window.activeType === "function" && window.activeType().slug) || "u1";
  const SRC = { deduction: "actual", flat: "flat $/g", slicer: "slicer est.", actual: "actual", watts: "typed W", metered: "metered", typed: "typed", blank: "blank", "hub-clock": "hub clock",
                "printer-meta": "printer metadata", history: "printer history", suggested: "suggested", "typed+suggested": "typed + suggested" };
  const srcText = t => Object.entries(t || {}).map(([k, n]) => n + " " + (SRC[k] || k)).join(", ") || "—";
  const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

  let EL = null, DATA = null, OPEN = null, PROJ = null, FORM = null, MSG = "", OKMSG = "";
  let VIEW = "projects";                                           // projects | prints | reports
  // the Prints view
  const PF = { from: "", to: "", printer: "", type: "", outcome: "", assigned: "", project: "", client: "", q: "", source: "", offset: 0, limit: 50 };
  let PL = null, SEL = new Set(), MATCH = null;
  // the Reports view
  const RF = { range: "month", from: "", to: "", group: "client" };
  let REP = null;

  function style() {
    if (document.getElementById("cstcss")) return;
    const s = document.createElement("style");
    s.id = "cstcss";
    s.textContent = [
      ".cst-sec{margin:18px 0 8px; font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent,#f5b316); display:flex; gap:10px; align-items:center; flex-wrap:wrap;}",
      ".cst-sec .sp{flex:1} .cst-sec .btn{font-family:inherit; letter-spacing:normal; text-transform:none;}",
      ".cst-row{display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px; flex-wrap:wrap;}",
      ".cst-row .cmain{flex:1 1 240px; min-width:0;} .cst-row .t{font-weight:600; color:var(--ink); overflow-wrap:anywhere;} .cst-row .t a{color:inherit; text-decoration:none;} .cst-row .t a:hover{color:var(--signal);}",
      ".cst-row .s{font-family:var(--mono); font-size:11px; color:var(--ink-faint); margin-top:3px; overflow-wrap:anywhere;} .cst-row .s b{color:var(--ink-dim); font-weight:600;}",
      ".cst-row .acts{display:flex; gap:6px; align-items:center; flex-wrap:wrap;} .cst-row .btn{font-size:11.5px; padding:4px 9px;}",
      ".cst-row.off{opacity:.55;} .cst-row .btn.danger{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 45%, var(--line));}",
      ".cst-pill{font-family:var(--mono); font-size:10px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--ink-dim); white-space:nowrap;}",
      ".cst-pill.bad{color:var(--bad,#e5484d);} .cst-pill.ok{color:var(--ok,#3dd68c);} .cst-pill.warn{color:var(--warn,#f5b316);}",
      ".cst-form{display:grid; gap:8px; padding:12px; border:1px dashed var(--line); border-radius:10px; margin-bottom:10px;} .cst-form .r{display:flex; gap:8px; flex-wrap:wrap; align-items:center;} .cst-form .field{flex:1 1 160px; min-width:0;} .cst-form input.num{flex:0 0 100px;}",
      ".cst-sum{display:grid; grid-template-columns:auto 1fr auto; gap:4px 12px; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); align-items:baseline;}",
      ".cst-sum .k{color:var(--ink-faint);} .cst-sum .v{text-align:right; color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums;} .cst-sum .src{color:var(--ink-faint); font-size:10.5px;} .cst-sum .tot{border-top:1px solid var(--line); padding-top:4px; margin-top:2px;}",
      ".cst-sum .tot.v{font-size:13px;} .cst-blank{font-size:11.5px; color:var(--warn,#f5b316); margin-top:6px;}",
      ".cst-table{width:100%; border-collapse:collapse; font-size:12.5px;} .cst-table th{text-align:right; font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap;}",
      ".cst-table th:first-child, .cst-table td:first-child{text-align:left;} .cst-table td{padding:6px 8px; border-bottom:1px solid var(--line-soft); text-align:right; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); white-space:nowrap; font-variant-numeric:tabular-nums;}",
      ".cst-table td:first-child{font-family:var(--sans); font-size:13px; color:var(--ink); white-space:normal;} .cst-table td.hi{color:var(--ink); font-weight:600;} .cst-table td .note{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); white-space:normal;}",
      ".cst-wrap{overflow:auto;} .cst-empty{color:var(--ink-faint); padding:10px 2px;} .cst-msg{font-size:12px; color:var(--bad,#e5484d); margin:6px 0;}",
      ".cst-ok{font-size:12px; color:var(--ok,#3dd68c); margin:6px 0; font-family:var(--mono);}",
      ".cst-note{font-size:12px; color:var(--ink-dim); padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel-2,var(--panel)); margin:4px 0 12px; line-height:1.6;} .cst-note b{color:var(--ink);} .cst-note .mono{font-family:var(--mono); font-size:11px; color:var(--ink-faint);} .cst-note .btn{margin-top:6px;}",
      ".cst-inline{display:flex; gap:6px; align-items:center; flex-wrap:wrap;} .cst-inline select.field, .cst-inline input.field{width:auto; flex:0 1 auto; font-size:12px; padding:3px 7px;}",
      ".cst-table tr.tot td{border-top:2px solid var(--line); color:var(--ink); font-weight:600;} .cst-table th.l, .cst-table td.l{text-align:left;} .cst-table td.ck, .cst-table th.ck{width:28px; text-align:center; padding:6px 4px;}",
      ".cst-table tr.sel td{background:color-mix(in srgb, var(--signal) 10%, transparent);} .cst-table tr.off td{opacity:.55;} .cst-table td .fn{font-family:var(--sans); font-size:13px; color:var(--ink); overflow-wrap:anywhere;} .cst-table td .sub{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".cst-table select.field{font-size:11.5px; padding:2px 6px; max-width:170px;} .cst-note .btn{margin-right:6px;}",
      // the three views under the one nav tab
      ".cst-tabs{display:flex; gap:6px; margin:10px 0 14px; flex-wrap:wrap;} .cst-tab{font:inherit; font-size:12px; font-weight:700; letter-spacing:.05em; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--ink-dim); cursor:pointer; transition:background .18s cubic-bezier(.2,.7,.2,1), color .18s cubic-bezier(.2,.7,.2,1);}",
      ".cst-tab:hover{color:var(--ink);} .cst-tab.on{background:color-mix(in srgb, var(--signal) 14%, var(--panel-2)); color:var(--ink); border-color:color-mix(in srgb, var(--signal) 40%, var(--line));}",
      ".cst-tab:focus-visible{outline:2px solid color-mix(in srgb, var(--signal) 65%, transparent); outline-offset:2px;}",
      // filters, the bulk bar, the pager
      ".cst-filters{display:flex; gap:6px 8px; align-items:center; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:10px;} .cst-filters label{display:flex; flex-direction:column; gap:2px; font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); letter-spacing:.04em;}",
      ".cst-filters .field{font-size:12px; padding:4px 7px; min-width:0;} .cst-filters input[type=date].field{width:138px;} .cst-filters input.q{width:170px;} .cst-filters .btn{align-self:flex-end;} .cst-filters a.btn{align-self:flex-end; text-decoration:none;}",
      ".cst-bulk{display:flex; gap:6px 10px; align-items:center; flex-wrap:wrap; padding:8px 12px; border:1px solid color-mix(in srgb, var(--signal) 40%, var(--line)); border-radius:10px; background:color-mix(in srgb, var(--signal) 6%, var(--panel)); margin-bottom:10px; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim);}",
      ".cst-bulk .btn{font-size:11.5px; padding:4px 9px;} .cst-bulk select.field{font-size:12px; padding:3px 7px; width:auto;} .cst-bulk .sp{flex:1;}",
      ".cst-pager{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:10px 0; font-family:var(--mono); font-size:11.5px; color:var(--ink-faint);} .cst-pager .sp{flex:1;} .cst-pager .btn{font-size:11.5px; padding:4px 9px;} .cst-pager select.field{font-size:12px; padding:3px 7px; width:auto;}",
      // the report chart: one series, one hue, plain markup (no library)
      ".cst-bars{display:grid; grid-template-columns:minmax(90px, 180px) 1fr auto; gap:4px 10px; align-items:center; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:10px;}",
      ".cst-bars .bl{font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;} .cst-bars .bt{height:16px; background:var(--panel-2); border-radius:0 4px 4px 0;}",
      ".cst-bars .bf{height:100%; background:var(--signal); border-radius:0 4px 4px 0; min-width:2px; transition:width .3s cubic-bezier(.2,.7,.2,1);} .cst-bars .bv{font-family:var(--mono); font-size:11.5px; color:var(--ink); font-variant-numeric:tabular-nums; white-space:nowrap;}",
      ".cst-kpis{display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; margin-bottom:10px;} .cst-kpi{padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel);} .cst-kpi .k{font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint);} .cst-kpi .v{font-size:20px; font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; margin-top:2px;} .cst-kpi .s{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      "@media (max-width:640px){ .cst-bars{grid-template-columns:minmax(70px, 110px) 1fr auto;} .cst-filters input.q{width:100%;} }",
      // the job card line
      ".cstline{display:none; margin-top:4px; font-family:var(--mono); font-size:11.5px; line-height:1.7; color:var(--ink-dim); align-items:center; gap:8px; flex-wrap:wrap;} .cstline.show{display:flex;}",
      ".cstline .k{color:var(--ink-faint);} .cstline select{font:inherit; font-family:var(--sans); font-size:12.5px; color:var(--ink); background:var(--panel-2); border:1px solid var(--line); border-radius:var(--r-sm,6px); padding:3px 7px; max-width:260px;}",
      ".cstline .st{color:var(--ink-faint);}",
      // settings
      ".cst-rates{display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:8px 12px; margin-top:8px; max-width:900px;} .cst-rates label{display:flex; flex-direction:column; gap:3px; font-size:12px; color:var(--ink-dim);} .cst-rates label .hint{font-size:10.5px;}",
      ".cst-rates input{max-width:140px;} .cst-ptable{border-collapse:collapse; margin-top:10px; font-size:12.5px;} .cst-ptable th{font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); text-align:left; padding:4px 8px;} .cst-ptable td{padding:3px 8px;} .cst-ptable input{width:96px;}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- the tab ------------------------------------------------------------------------
  function mount(el) {
    EL = el; style();
    el.innerHTML = '<div class="sechead"><h2>Projects</h2><span class="count" id="cst-count"></span></div>' +
      '<p class="subnote">What each piece of client work cost - every finished, cancelled or failed print, the Hub\'s own and the printers\' history, with the material priced from the rolls that were loaded, plus labour, hardware and shipping - and what to charge for it. Nothing is decided here; rates you have not set show as blanks, never as zero.</p>' +
      '<div class="cst-tabs" role="tablist"><button class="cst-tab on" data-cstview="projects" role="tab">Projects</button><button class="cst-tab" data-cstview="prints" role="tab">Prints</button><button class="cst-tab" data-cstview="reports" role="tab">Reports</button></div>' +
      '<div id="cst-body"></div>';
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input.field") && e.target.closest("[data-enter]")) { e.preventDefault(); const b = e.target.closest("[data-enter]").querySelector("[data-go]"); if (b) b.click(); } if (e.key === "Escape" && FORM) { FORM = null; render(); } });
  }
  async function load() {
    const d = await jget("/api/costing/projects");
    if (d) { DATA = d; refreshCard(true); }
    if (VIEW === "projects" && OPEN) { const p = await jget("/api/costing/projects/" + encodeURIComponent(OPEN)); PROJ = p; if (!p) OPEN = null; }
    if (VIEW === "prints") PL = await jget("/api/costing/prints?" + qs(printsQuery()));
    if (VIEW === "reports") REP = await jget("/api/costing/report?" + qs(reportQuery()));
    render();
  }
  function onShow() { load(); }

  function render() {
    if (!EL || !DATA) return;
    EL.querySelector("#cst-count").textContent = DATA.projects.length + " project" + (DATA.projects.length === 1 ? "" : "s") + " · " + DATA.ledger_total + " print" + (DATA.ledger_total === 1 ? "" : "s") + (DATA.unassigned_total ? " · " + DATA.unassigned_total + " unassigned" : "");
    EL.querySelectorAll(".cst-tab").forEach(t => t.classList.toggle("on", t.dataset.cstview === VIEW));
    const body = EL.querySelector("#cst-body");
    body.innerHTML = VIEW === "prints" ? renderPrints() : (VIEW === "reports" ? renderReports() : (OPEN && PROJ ? renderProject() : renderList()));
    if (MSG) { const m = document.createElement("div"); m.className = "cst-msg"; m.textContent = MSG; body.prepend(m); MSG = ""; }
    if (OKMSG) { const m = document.createElement("div"); m.className = "cst-ok"; m.id = "cst-okmsg"; m.textContent = OKMSG; body.prepend(m); OKMSG = ""; }
    const f = body.querySelector("[data-focus]"); if (f) setTimeout(() => f.focus(), 0);
  }
  const projOpts = (sel, blank) => (blank ? '<option value="">' + esc(blank) + "</option>" : "") + DATA.projects.map(p => '<option value="' + esc(p.id) + '"' + (p.id === sel ? " selected" : "") + ">" + esc(p.name) + (p.client_id ? " · " + esc(clientName(p.client_id)) : "") + "</option>").join("");
  const clientName = id => { const c = DATA.clients.find(x => x.id === id); return c ? c.name : ""; };
  const srcPill = p => p.source === "history" ? ' <span class="cst-pill" title="imported from the printer\'s own job history">imported</span>' : "";
  const printRow = (p, inProject) => {
    const c = p.cost || {};
    const mat = c.material || {};
    return '<div class="cst-row' + (p.counted === false ? " off" : "") + '" data-print="' + esc(p.id) + '"><div class="cmain"><div class="t">' + esc(String(p.file).replace(/\.gcode$/i, "")) +
      ' <span class="cst-pill ' + (p.outcome === "done" ? "ok" : "bad") + '">' + esc(p.outcome) + "</span>" + (p.counted === false ? ' <span class="cst-pill">not counted</span>' : "") + srcPill(p) + "</div>" +
      '<div class="s">' + when(p.at) + " · " + esc(p.printer) + " · " + (p.pieces || 1) + " pc · " + hrs(c.hours) + (c.time_source ? " (" + (SRC[c.time_source] || c.time_source) + ")" : "") +
      " · " + (mat.grams != null ? mat.grams + " g" + (mat.grams_source ? " (" + (SRC[mat.grams_source] || mat.grams_source) + ")" : "") : "no grams") + " · material <b>" + usd(mat.cost) + "</b>" + (mat.source ? " (" + (SRC[mat.source] || mat.source) + (mat.partial ? ", partial" : "") + ")" : "") +
      (c.machine ? " · machine <b>" + usd(c.machine.cost) + "</b>" + (c.machine.source !== "typed" ? " (" + (SRC[c.machine.source] || c.machine.source) + ")" : "") : "") +
      (c.energy ? " · energy <b>" + usd(c.energy.cost) + "</b>" + (c.energy.source === "suggested" ? " (suggested)" : "") : "") + " · direct <b>" + usd(c.direct) + "</b></div></div>" +
      '<div class="acts cst-inline"><select class="field" data-assign="' + esc(p.id) + '">' + projOpts(p.project_id || "", inProject ? "move to…" : "assign to…") + "</select>" +
      (inProject ? '<button class="btn ghost" data-count="' + esc(p.id) + '" data-to="' + (p.counted === false ? "1" : "0") + '">' + (p.counted === false ? "Count it" : "Don't count") + "</button>" : "") + "</div></div>";
  };

  // What the Hub filled in by itself and what only the person can set, with
  // the ledger's own tallies, so "no grams" reads as a gap with a reason.
  function renderFilledNote() {
    const s = DATA.sources || {};
    const tl = t => srcText(t);
    const bf = DATA.backfill || {}, im = DATA.import || {};
    const last = bf.last ? "Last fill: " + bf.last.checked + " checked, " + bf.last.filled + " filled (" + bf.last.meta + " printer metadata, " + bf.last.history + " job history), " + bf.last.none + " still blank, " + bf.last.requests + " requests." : "";
    const lastImp = im.last ? "Last import: " + im.last.imported + " imported, " + im.last.matched + " matched to prints the Hub watched, " + im.last.known + " already known" + (im.last.offline && im.last.offline.length ? ", offline: " + im.last.offline.join(", ") : "") + ", " + im.last.requests + " requests." : "";
    return '<div class="cst-note" id="cst-filled"><b>Filled by the Hub</b> - time from the printer when the print ended; grams from the rolls that were loaded, else the file in the library, else the printer\'s own metadata for the file, else its job history (filament length x density); machine and energy from your rates, or the cited suggestions in Settings until you type your own. Prints started from a printer\'s own screen, or finished while the Hub was down, come in from each printer\'s job history' + (im.interval_ms ? " every " + Math.round(im.interval_ms / 60000) + " min" : "") + ' and are marked "imported". ' +
      '<b>Set by you</b> - client, project, pieces, "don\'t count", line items, what you charged, and every rate in Settings &rarr; Project costing.' +
      '<div class="mono">' + DATA.ledger_total + " rows (" + (DATA.imported_rows || 0) + " imported) · grams: " + esc(tl(s.grams)) + " · time: " + esc(tl(s.time)) + " · machine: " + esc(tl(s.machine)) + " · energy: " + esc(tl(s.energy)) + "</div>" +
      (DATA.blank_rows ? '<button class="btn ghost" data-backfill' + (bf.running ? " disabled" : "") + ">" + (bf.running ? "Filling from the printers…" : "Fill the " + DATA.blank_rows + " blank row" + (DATA.blank_rows === 1 ? "" : "s") + " from the printers") + "</button>" : "") +
      '<button class="btn ghost" data-import' + (im.running ? " disabled" : "") + ">" + (im.running ? "Importing from the printers…" : "Import job history from the printers") + "</button>" +
      (last ? '<div class="mono" id="cst-bflast">' + esc(last) + "</div>" : "") + (lastImp ? '<div class="mono" id="cst-imlast">' + esc(lastImp) + "</div>" : "") + "</div>";
  }

  function renderList() {
    let h = "";
    if (DATA.ledger_total) h += renderFilledNote();
    if (DATA.unassigned.length) {
      h += '<div class="cst-sec">Unassigned prints <span class="cst-pill">' + DATA.unassigned_total + '</span><span class="sp"></span><button class="btn ghost" data-cstview="prints" data-unassigned>All ' + DATA.unassigned_total + " in Prints</button></div>" + DATA.unassigned.map(p => printRow(p, false)).join("") +
        (DATA.unassigned_total > DATA.unassigned.length ? '<div class="cst-empty">Showing the newest ' + DATA.unassigned.length + " of " + DATA.unassigned_total + ". The Prints view lists every one, with filters and bulk assignment.</div>" : "");
    }
    h += '<div class="cst-sec">Clients<span class="sp"></span><button class="btn ghost" data-form="client">+ Add client</button><button class="btn ghost" data-form="project">+ Add project</button></div>';
    if (FORM === "client") h += '<div class="cst-form" data-enter><div class="r"><input class="field" id="cst-cn" placeholder="Client name" data-focus><input class="field" id="cst-ce" placeholder="Email (optional)"></div><div class="r"><button class="btn primary" data-go data-addclient>Save</button><button class="btn ghost" data-form="">Cancel</button></div></div>';
    if (FORM === "project") h += '<div class="cst-form" data-enter><div class="r"><input class="field" id="cst-pn" placeholder="Project name (e.g. Spring order, Trade show props)" data-focus><select class="field" id="cst-pc"><option value="">No client</option>' + DATA.clients.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>").join("") + '</select></div><div class="r"><button class="btn primary" data-go data-addproject>Save</button><button class="btn ghost" data-form="">Cancel</button></div></div>';
    const groups = [...DATA.clients.map(c => ({ id: c.id, name: c.name, email: c.email })), { id: null, name: "No client" }];
    let any = false;
    for (const g of groups) {
      const ps = DATA.projects.filter(p => (p.client_id || null) === g.id);
      if (!ps.length && g.id === null) continue;
      any = true;
      h += '<div class="cst-row"><div class="cmain"><div class="t">' + esc(g.name) + (g.email ? ' <span class="s" style="display:inline">' + esc(g.email) + "</span>" : "") + "</div>" +
        (ps.length ? ps.map(p => { const s = p.summary || {}; return '<div class="s" style="margin-top:6px"><a href="#" data-openp="' + esc(p.id) + '" style="color:var(--ink); text-decoration:none; font-family:var(--sans); font-size:13px">' + esc(p.name) + "</a> · " + esc(p.state) + " · " + s.prints + " print" + (s.prints === 1 ? "" : "s") + (s.failed ? " (" + s.failed + " failed)" : "") +
          " · cost <b>" + usd(s.cost) + "</b>" + (s.partial ? " <span class=\"cst-pill warn\" title=\"some lines are blank or partial\">partial</span>" : "") + (s.charged != null ? " · charged <b>" + usd(s.charged) + "</b> · margin <b>" + usd(s.margin) + "</b>" + (s.margin_pct != null ? " (" + s.margin_pct + "%)" : "") : "") + "</div>"; }).join("")
          : '<div class="s">No projects yet.</div>') + "</div>" +
        (g.id ? '<div class="acts"><button class="btn ghost" data-form="rmclient:' + esc(g.id) + '" title="Remove client" aria-label="Remove">×</button>' + (FORM === "rmclient:" + g.id ? '<button class="btn ghost danger" data-rmclient="' + esc(g.id) + '">Remove client</button>' : "") + "</div>" : "") + "</div>";
    }
    if (!any) h += '<div class="cst-empty">Add a client, then a project for them. Prints join a project from the job card (pick the project before you send the file), from the unassigned strip above once they finish, or in bulk from the Prints view.</div>';
    return h;
  }

  function renderProject() {
    const { project: p, client: c, summary: s, pricing: pz, prints } = PROJ;
    let h = '<div class="cst-sec"><a href="#" data-back style="color:inherit; text-decoration:none">← projects</a><span class="sp"></span>' +
      '<a class="btn ghost" href="/api/costing/projects/' + encodeURIComponent(p.id) + '.csv" download style="text-decoration:none">Export CSV</a>' +
      '<a class="btn ghost" href="/api/costing/projects/' + encodeURIComponent(p.id) + '/quote" target="_blank" rel="noopener" style="text-decoration:none">Print quote</a>' +
      '<button class="btn ghost" data-form="rmproject" title="Remove project">×</button></div>' +
      (FORM === "rmproject" ? '<div class="cst-form"><div class="r">Remove this project? Its prints go back to unassigned.<button class="btn ghost danger" data-rmproject>Remove</button><button class="btn ghost" data-form="">Keep</button></div></div>' : "") +
      '<div class="cst-row"><div class="cmain"><div class="t">' + esc(p.name) + (c ? ' <span class="s" style="display:inline">' + esc(c.name) + "</span>" : "") + "</div>" +
      '<div class="s cst-inline" style="margin-top:6px">state <select class="field" data-state><option' + (p.state === "open" ? " selected" : "") + '>open</option><option' + (p.state === "quoted" ? " selected" : "") + '>quoted</option><option' + (p.state === "delivered" ? " selected" : "") + '>delivered</option><option' + (p.state === "closed" ? " selected" : "") + ">closed</option></select>" +
      ' client <select class="field" data-client><option value="">none</option>' + DATA.clients.map(x => '<option value="' + esc(x.id) + '"' + (x.id === p.client_id ? " selected" : "") + ">" + esc(x.name) + "</option>").join("") + "</select>" +
      ' charged $<input class="field" type="number" min="0" step="0.01" data-charged value="' + (p.charged != null ? esc(p.charged) : "") + '" placeholder="what you billed" style="width:110px"></div></div></div>';
    // summary
    const line = (k, v, src, cls) => '<div class="k ' + (cls || "") + '">' + esc(k) + '</div><div class="src ' + (cls || "") + '">' + esc(src || "") + '</div><div class="v ' + (cls || "") + '">' + v + "</div>";
    h += '<div class="cst-sec">Cost <span class="cst-pill">' + s.counted + " of " + s.prints + " prints counted" + (s.failed ? " · " + s.failed + " failed" : "") + "</span>" + (s.pieces ? ' <span class="cst-pill">' + s.pieces + " pieces</span>" : "") + (s.hours != null ? ' <span class="cst-pill">' + hrs(s.hours) + "</span>" : "") + "</div>" +
      '<div class="cst-sum">' +
      line("material", usd(s.material), srcText(s.sources.material) + (s.sources.material_partial ? " · " + s.sources.material_partial + " partial" : "") + (s.grams != null ? " · " + s.grams + " g" : "")) +
      line("machine time", usd(s.machine), srcText(s.sources.machine)) + line("energy", usd(s.energy), srcText(s.sources.energy)) +
      line("labour", usd(s.labor.cost), s.labor.minutes + " min" + (s.labor.setup_minutes ? " incl. " + s.labor.setup_minutes + "/print setup" : "") + (s.labor.minutes && s.labor.cost == null ? " · no labour rate" : "")) +
      line("extras", usd(s.extras), "hardware, packaging, shipping") +
      (s.failure ? line("failure allowance", usd(s.failure), "quoting only - no failed prints yet") : "") + (s.overhead ? line("overhead", usd(s.overhead), "of subtotal") : "") +
      line("cost", usd(s.cost), "", "tot") +
      (s.charged != null ? line("charged", usd(s.charged), "") + line("margin", usd(s.margin) + (s.margin_pct != null ? ' <span class="src">' + s.margin_pct + "%</span>" : ""), "", "") : "") + "</div>" +
      (s.blanks.length ? '<div class="cst-blank">Not included: ' + esc(s.blanks.join("; ")) + ". Set the missing rates in Settings → Project costing, or price the roll on the Spools tab.</div>" : "");
    // prints
    h += '<div class="cst-sec">Prints <span class="cst-pill">' + prints.length + "</span></div>" + (prints.length ? prints.map(x => printRow(x, true)).join("") : '<div class="cst-empty">No prints yet. Pick this project on the job card before sending a file, or assign finished prints from the unassigned strip.</div>');
    // items
    h += '<div class="cst-sec">Line items<span class="sp"></span><button class="btn ghost" data-form="item">+ Add item</button></div>';
    if (FORM === "item") h += '<div class="cst-form" data-enter><div class="r"><select class="field" id="cst-ik" style="flex:0 0 140px"><option value="labor">Labour (minutes)</option><option value="hardware">Hardware</option><option value="packaging">Packaging</option><option value="shipping">Shipping</option><option value="other">Other</option></select><input class="field" id="cst-il" placeholder="What (e.g. support removal, M3 inserts x40, UPS)" data-focus><input class="field num" id="cst-iv" type="number" min="0" step="0.01" placeholder="minutes / $"></div><div class="r"><button class="btn primary" data-go data-additem>Save</button><button class="btn ghost" data-form="">Cancel</button></div></div>';
    h += p.items.length ? p.items.map(i => '<div class="cst-row"><div class="cmain"><div class="t">' + esc(i.label) + ' <span class="cst-pill">' + esc(i.kind) + '</span></div><div class="s">' + (i.kind === "labor" ? i.minutes + " min" : usd(i.cost)) + '</div></div><div class="acts"><button class="btn ghost" data-rmitem="' + esc(i.id) + '" title="Remove" aria-label="Remove">×</button></div></div>').join("") : '<div class="cst-empty">Labour, hardware, packaging, shipping - anything the printers did not do.</div>';
    // pricing
    h += '<div class="cst-sec">Pricing helper</div>';
    if (!pz) h += '<div class="cst-empty">Nothing to price yet - the cost is blank.</div>';
    else h += '<div class="cst-wrap"><table class="cst-table"><thead><tr><th>Method</th><th>Price</th><th>Per piece</th><th>Listed</th></tr></thead><tbody>' +
      pz.methods.map(m => "<tr><td>" + esc(m.label) + '<div class="note">' + esc(m.note) + '</div></td><td class="hi">' + usd(m.price) + "</td><td>" + usd(m.per_piece) + "</td><td>" + usd(m.gross) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<div class="cst-wrap" style="margin-top:8px"><table class="cst-table"><thead><tr><th>Quantity</th>' + pz.breaks.map(b => "<th>" + b.qty + "</th>").join("") + "</tr></thead><tbody><tr><td>cost each</td>" + pz.breaks.map(b => "<td>" + usd(b.cost_each) + "</td>").join("") + "</tr><tr><td>price each (markup)</td>" + pz.breaks.map(b => '<td class="hi">' + usd(b.each) + "</td>").join("") + "</tr></tbody></table></div>" +
      '<div class="cst-empty" style="font-size:12px">Listed = the price grossed up for the platform fee' + (pz.platform.pct != null || pz.platform.fixed != null ? " (" + (pz.platform.pct || 0) + "% + $" + (pz.platform.fixed || 0) + ")" : " (none set)") + (pz.min_fee != null ? "; minimum fee $" + pz.min_fee + " applied" : "") + ". Quantity breaks amortise labour and extras over the run. Pick one; nothing here is chosen for you.</div>";
    return h;
  }

  // ---- the Prints view: the whole ledger, filtered, paged, multi-select -----------------
  const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? " selected" : "") + ">" + esc(label) + "</option>";
  function renderPrints() {
    if (!PL) return '<div class="cst-empty">Loading the ledger…</div>';
    const fx = PL.facets || {};
    let h = '<div class="cst-filters" data-enter>' +
      '<label>from<input class="field" type="date" data-pf="from" value="' + esc(PF.from) + '"></label><label>to<input class="field" type="date" data-pf="to" value="' + esc(PF.to) + '"></label>' +
      '<label>printer<select class="field" data-pf="printer">' + opt("", "any", PF.printer) + (fx.printers || []).map(p => opt(p.id, p.name + " (" + p.type + ")", PF.printer)).join("") + "</select></label>" +
      ((fx.types || []).length > 1 ? '<label>type<select class="field" data-pf="type">' + opt("", "any", PF.type) + fx.types.map(t => opt(t, t, PF.type)).join("") + "</select></label>" : "") +
      '<label>outcome<select class="field" data-pf="outcome">' + opt("", "any", PF.outcome) + (fx.outcomes || []).map(o => opt(o, o, PF.outcome)).join("") + "</select></label>" +
      '<label>assigned<select class="field" data-pf="assigned">' + opt("", "any", PF.assigned) + opt("0", "unassigned", PF.assigned) + opt("1", "assigned", PF.assigned) + "</select></label>" +
      '<label>project<select class="field" data-pf="project">' + opt("", "any", PF.project) + DATA.projects.map(p => opt(p.id, p.name, PF.project)).join("") + "</select></label>" +
      '<label>client<select class="field" data-pf="client">' + opt("", "any", PF.client) + DATA.clients.map(c => opt(c.id, c.name, PF.client)).join("") + "</select></label>" +
      '<label>source<select class="field" data-pf="source">' + opt("", "any", PF.source) + opt("hub", "watched by the Hub", PF.source) + opt("history", "imported", PF.source) + "</select></label>" +
      '<label>file name<input class="field q" data-pf="q" placeholder="substring, * wildcard" value="' + esc(PF.q) + '"></label>' +
      '<button class="btn primary" data-go data-pf-apply>Filter</button><button class="btn ghost" data-pf-reset>Reset</button></div>';
    // bulk actions
    const n = SEL.size;
    h += '<div class="cst-bulk"><span><b>' + n + "</b> selected" + (n ? " of " + PL.total : "") + "</span>" +
      '<select class="field" id="cst-bulkproj">' + projOpts("", "assign to…") + '<option value="__none">unassign</option></select><button class="btn ghost" data-bulk="assign"' + (n ? "" : " disabled") + ">Assign selected</button>" +
      '<button class="btn ghost" data-bulk="uncount"' + (n ? "" : " disabled") + ">Don't count</button><button class=\"btn ghost\" data-bulk=\"count\"" + (n ? "" : " disabled") + ">Count</button>" +
      (n ? '<button class="btn ghost" data-bulk="clear">Clear selection</button>' : "") +
      '<span class="sp"></span><button class="btn ghost" data-form="match">Assign by file name…</button></div>';
    if (FORM === "match") h += '<div class="cst-form" data-enter><div class="r"><input class="field" id="cst-mp" placeholder="file name contains… (* wildcard, e.g. Frog*)" value="' + esc(MATCH && MATCH.pattern || "") + '" data-focus>' +
      '<select class="field" id="cst-mproj">' + projOpts(MATCH && MATCH.project_id || "", "to project…") + '</select><label class="cst-inline" style="font-size:12px"><input type="checkbox" id="cst-munass"' + (!MATCH || MATCH.only_unassigned !== false ? " checked" : "") + "> only unassigned</label></div>" +
      '<div class="r"><button class="btn primary" data-go data-match="preview">Preview</button>' + (MATCH && MATCH.preview ? '<span class="cst-ok" style="margin:0" id="cst-mres">' + MATCH.matched + " print" + (MATCH.matched === 1 ? "" : "s") + " match" + (MATCH.sample.length ? ": " + esc(MATCH.sample.join(", ")) + (MATCH.matched > MATCH.sample.length ? ", …" : "") : "") + "</span>" + (MATCH.matched ? '<button class="btn primary" data-match="apply">Assign ' + MATCH.matched + "</button>" : "") : "") + '<button class="btn ghost" data-form="">Close</button></div></div>';
    // the table
    if (!PL.prints.length) h += '<div class="cst-empty">' + (PL.total ? "Nothing on this page." : (PL.ledger_total ? "No prints match these filters." : "No prints yet. The Hub logs every print it watches finish; the printers' own job history comes in by import.")) + "</div>";
    else {
      const allSel = PL.prints.every(p => SEL.has(p.id));
      h += '<div class="cst-wrap"><table class="cst-table" id="cst-ptable"><thead><tr><th class="ck"><input type="checkbox" data-selall' + (allSel ? " checked" : "") + ' aria-label="select this page"></th><th class="l">File</th><th class="l">When</th><th class="l">Printer</th><th>Outcome</th><th>Time</th><th>Grams</th><th>Direct</th><th class="l">Project</th></tr></thead><tbody>' +
        PL.prints.map(p => { const c = p.cost || {}, m = c.material || {}; return '<tr data-print="' + esc(p.id) + '" class="' + (SEL.has(p.id) ? "sel" : "") + (p.counted === false ? " off" : "") + '"><td class="ck"><input type="checkbox" data-sel="' + esc(p.id) + '"' + (SEL.has(p.id) ? " checked" : "") + "></td>" +
          '<td class="l"><div class="fn">' + esc(String(p.file).replace(/\.gcode$/i, "")) + '</div><div class="sub">' + (p.pieces || 1) + " pc" + (p.counted === false ? " · not counted" : "") + (p.source === "history" ? " · imported" : "") + (m.grams_source ? " · grams " + (SRC[m.grams_source] || m.grams_source) : "") + "</div></td>" +
          '<td class="l">' + when(p.at) + '</td><td class="l">' + esc(p.printer) + '</td><td><span class="cst-pill ' + (p.outcome === "done" ? "ok" : "bad") + '">' + esc(p.outcome) + "</span></td><td>" + hrs(c.hours) + "</td><td>" + (m.grams != null ? m.grams + " g" : "—") + '</td><td class="hi">' + usd(c.direct) + "</td>" +
          '<td class="l"><select class="field" data-assign="' + esc(p.id) + '">' + projOpts(p.project_id || "", "unassigned") + "</select></td></tr>"; }).join("") + "</tbody></table></div>";
    }
    const a = PL.total ? PL.offset + 1 : 0, b = Math.min(PL.total, PL.offset + PL.prints.length);
    h += '<div class="cst-pager"><span id="cst-pages">' + a + "–" + b + " of " + PL.total + (PL.total !== PL.ledger_total ? " (" + PL.ledger_total + " in the ledger)" : "") + '</span><span class="sp"></span>' +
      '<button class="btn ghost" data-page="prev"' + (PL.offset > 0 ? "" : " disabled") + ">← newer</button><button class=\"btn ghost\" data-page=\"next\"" + (b < PL.total ? "" : " disabled") + ">older →</button>" +
      '<select class="field" data-pagesize>' + [25, 50, 100, 200].map(n2 => opt(n2, n2 + " per page", PF.limit)).join("") + "</select></div>";
    return h;
  }
  const dayStart = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null; };
  const dayEnd = s => { const t = dayStart(s); return t == null ? null : new Date(new Date(t).setDate(new Date(t).getDate() + 1)).getTime(); };
  function readFilters() {
    EL.querySelectorAll("[data-pf]").forEach(i => { PF[i.dataset.pf] = i.value; });
    PF.offset = 0;
  }
  const printsQuery = () => ({ ...PF, from: dayStart(PF.from), to: dayEnd(PF.to) });
  const reloadPrints = async () => { PL = await jget("/api/costing/prints?" + qs(printsQuery())); const dd = await jget("/api/costing/projects"); if (dd) DATA = dd; render(); };

  // ---- the Reports view -----------------------------------------------------------------
  const RANGES = [["month", "this month"], ["last_month", "last month"], ["ytd", "YTD"], ["12m", "last 12 months"], ["all", "all time"], ["custom", "custom"]];
  const GROUPS = [["client", "client"], ["project", "project"], ["printer", "printer"], ["type", "printer type"], ["month", "month"], ["material", "material"], ["outcome", "outcome"]];
  function rangeOf() {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    switch (RF.range) {
      case "month": return [new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()];
      case "last_month": return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
      case "ytd": return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()];
      case "12m": return [new Date(y, m - 11, 1).getTime(), new Date(y, m + 1, 1).getTime()];
      case "custom": return [dayStart(RF.from), dayEnd(RF.to)];
      default: return [null, null];
    }
  }
  function reportQuery() { const [from, to] = rangeOf(); return { from, to, group_by: RF.group, tz_offset_min: new Date().getTimezoneOffset() }; }
  function renderReports() {
    let h = '<div class="cst-filters" data-enter><label>range<select class="field" data-rf="range">' + RANGES.map(([v, l]) => opt(v, l, RF.range)).join("") + "</select></label>" +
      (RF.range === "custom" ? '<label>from<input class="field" type="date" data-rf="from" value="' + esc(RF.from) + '"></label><label>to<input class="field" type="date" data-rf="to" value="' + esc(RF.to) + '"></label>' : "") +
      '<label>group by<select class="field" data-rf="group">' + GROUPS.map(([v, l]) => opt(v, l, RF.group)).join("") + "</select></label>" +
      '<button class="btn primary" data-go data-rf-apply>Run</button><span class="sp" style="flex:1"></span>' +
      '<a class="btn ghost" id="cst-rcsv" href="/api/costing/report.csv?' + qs(reportQuery()) + '" download>Export CSV</a>' +
      '<a class="btn ghost" id="cst-rprint" href="/api/costing/report/print?' + qs(reportQuery()) + '" target="_blank" rel="noopener">Print report</a></div>';
    if (!REP) return h + '<div class="cst-empty">Loading…</div>';
    const T = REP.totals, al = REP.aligned;
    const pc = c => c.actual_pct == null ? "—" : c.actual_pct + "%";
    const kpi = (k, v, s) => '<div class="cst-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="s">' + esc(s || "") + "</div></div>";
    h += '<div class="cst-kpis" id="cst-kpis">' + kpi("prints", T.prints, T.failed + " failed · " + T.counted + " counted") + kpi("print time", hrs(T.hours), T.grams != null ? T.grams + " g" : "") +
      kpi(al ? "cost" : "print cost", usd(T.cost), al ? "incl. labour, extras, overhead" : "material + machine + energy") +
      kpi("failed prints", usd(T.failure_cost) + (T.failure_share ? ' <span class="s">' + T.failure_share + "%</span>" : ""), "of the print cost") +
      (al ? kpi("charged", usd(T.charged), T.margin != null ? "margin " + usd(T.margin) + (T.margin_pct != null ? " (" + T.margin_pct + "%)" : "") : "") : "") +
      kpi("actual numbers", pc(T.coverage.time), "time · grams " + pc(T.coverage.grams) + " · material " + pc(T.coverage.material)) + "</div>";
    // the chart: cost per group, one hue, the tail past twelve folded into "other"
    const gs = REP.groups.filter(g => g.cost != null && g.cost > 0);
    if (gs.length) {
      const shown = gs.slice(0, 12), rest = gs.slice(12);
      if (rest.length) shown.push({ label: "other (" + rest.length + ")", cost: Math.round(rest.reduce((a2, g) => a2 + g.cost, 0) * 100) / 100 });
      const max = Math.max(...shown.map(g => g.cost));
      h += '<div class="cst-bars" id="cst-chart" role="img" aria-label="cost per ' + esc(RF.group) + '">' + shown.map(g => '<div class="bl" title="' + esc(g.label) + '">' + esc(g.label) + '</div><div class="bt" title="' + esc(g.label + ": " + usd(g.cost)) + '"><div class="bf" style="width:' + Math.max(1, Math.round(g.cost / max * 100)) + '%"></div></div><div class="bv">' + usd(g.cost) + "</div>").join("") + "</div>";
    }
    const row = (g, cls) => '<tr class="' + (cls || "") + '"><td>' + esc(g.label) + (g.projects && RF.group === "client" ? '<div class="note">' + g.projects + " project" + (g.projects === 1 ? "" : "s") + "</div>" : "") + "</td><td>" + g.prints + (g.failed ? ' <span class="note">' + g.failed + " failed</span>" : "") + "</td><td>" + hrs(g.hours) + "</td><td>" + (g.grams != null ? g.grams + " g" : "—") +
      "</td><td>" + usd(g.material) + "</td><td>" + usd(g.machine) + "</td><td>" + usd(g.energy) + '</td><td class="hi">' + usd(g.direct) + "</td><td>" + usd(g.failure_cost) + (g.failure_share ? ' <span class="note">' + g.failure_share + "%</span>" : "") + "</td>" +
      (al ? "<td>" + usd(g.labor) + "</td><td>" + usd(g.extras) + "</td><td>" + usd(g.overhead != null || g.failure != null ? (g.overhead || 0) + (g.failure || 0) : null) + '</td><td class="hi">' + usd(g.cost) + "</td><td>" + usd(g.charged) + "</td><td>" + usd(g.margin) + (g.margin_pct != null ? ' <span class="note">' + g.margin_pct + "%</span>" : "") + "</td>" : "") +
      "<td>" + pc(g.coverage.time) + " · " + pc(g.coverage.grams) + " · " + pc(g.coverage.material) + "</td></tr>";
    h += '<div class="cst-wrap"><table class="cst-table" id="cst-rtable"><thead><tr><th>' + esc((GROUPS.find(g => g[0] === RF.group) || [])[1] || RF.group) + "</th><th>Prints</th><th>Time</th><th>Grams</th><th>Material</th><th>Machine</th><th>Energy</th><th>Direct</th><th>Failed</th>" +
      (al ? "<th>Labour</th><th>Extras</th><th>Overhead</th><th>Cost</th><th>Charged</th><th>Margin</th>" : "") + "<th>Actual t·g·m</th></tr></thead><tbody>" +
      (REP.groups.length ? REP.groups.map(g => row(g, "")).join("") + row(T, "tot") : '<tr><td colspan="' + (al ? 16 : 10) + '">No prints in this range.</td></tr>') + "</tbody></table></div>" +
      '<div class="cst-empty" style="font-size:12px">' + esc(REP.note) + ' "Actual t·g·m" is the share of counted prints whose time, grams and material are measured (the printer\'s clock, the rolls that were loaded, the filament actually extruded) rather than a slicer, metadata or suggested figure.' + (T.labor_blank ? " Some labour minutes have no labour rate and are not costed." : "") + "</div>";
    return h;
  }

  // ---- events ---------------------------------------------------------------------------
  const val = id => { const x = EL.querySelector(id); return x ? x.value : ""; };
  async function onClick(e) {
    const a = e.target.closest("[data-cstview],[data-form],[data-openp],[data-back],[data-addclient],[data-addproject],[data-additem],[data-rmitem],[data-rmclient],[data-rmproject],[data-count],[data-backfill],[data-import],[data-pf-apply],[data-pf-reset],[data-page],[data-bulk],[data-match],[data-rf-apply]");
    if (!a) return;
    e.preventDefault();
    const d = a.dataset;
    if (d.cstview != null) { VIEW = d.cstview; FORM = null; if (d.unassigned != null) { Object.assign(PF, { assigned: "0", offset: 0 }); SEL.clear(); } await load(); return; }
    if (d.form != null) { FORM = FORM === d.form || d.form === "" ? null : d.form; if (d.form === "match") MATCH = null; render(); return; }
    if (d.openp != null) { OPEN = d.openp; FORM = null; await load(); return; }
    if (d.back != null) { OPEN = null; PROJ = null; FORM = null; await load(); return; }
    if (d.backfill != null) {
      a.disabled = true; a.textContent = "Filling from the printers…";
      const r = await jpost("/api/costing/backfill", {});
      if (!r.ok) MSG = r.d.error || "The backfill did not run";
      else OKMSG = "Asked the printers: " + r.d.checked + " blank row" + (r.d.checked === 1 ? "" : "s") + " checked, " + r.d.filled + " filled (" + r.d.meta + " from printer metadata, " + r.d.history + " from job history), " + r.d.none + " still blank.";
      await load(); return;
    }
    if (d.import != null) {
      a.disabled = true; a.textContent = "Importing from the printers…";
      const r = await jpost("/api/costing/import", {});
      if (!r.ok) MSG = r.d.error || "The import did not run";
      else OKMSG = "Read the printers' job history: " + r.d.imported + " print" + (r.d.imported === 1 ? "" : "s") + " imported, " + r.d.matched + " matched to prints the Hub watched, " + r.d.known + " already known" + (r.d.offline.length ? "; offline, tried next time: " + r.d.offline.join(", ") : "") + (r.d.dropped ? "; " + r.d.dropped + " oldest rows dropped at the cap" : "") + ".";
      await load(); return;
    }
    if (d.pfApply != null) { readFilters(); SEL.clear(); await reloadPrints(); return; }
    if (d.pfReset != null) { Object.assign(PF, { from: "", to: "", printer: "", type: "", outcome: "", assigned: "", project: "", client: "", q: "", source: "", offset: 0 }); SEL.clear(); await reloadPrints(); return; }
    if (d.page != null) { PF.offset = Math.max(0, PF.offset + (d.page === "next" ? PF.limit : -PF.limit)); await reloadPrints(); return; }
    if (d.rfApply != null) { EL.querySelectorAll("[data-rf]").forEach(i => { RF[i.dataset.rf] = i.value; }); REP = await jget("/api/costing/report?" + qs(reportQuery())); render(); return; }
    if (d.bulk != null) {
      if (d.bulk === "clear") { SEL.clear(); render(); return; }
      const ids = [...SEL]; if (!ids.length) return;
      let r;
      if (d.bulk === "assign") { const v = val("#cst-bulkproj"); if (!v) { MSG = "Pick a project to assign to (or 'unassign')."; render(); return; } r = await jpost("/api/costing/prints/bulk", { print_ids: ids, project_id: v === "__none" ? null : v }); }
      else r = await jpost("/api/costing/prints/bulk", { print_ids: ids, counted: d.bulk === "count" });
      if (!r.ok) MSG = (r.d.error || "That did not work") + (r.status ? " (HTTP " + r.status + ")" : "");
      else { OKMSG = r.d.updated + " print" + (r.d.updated === 1 ? "" : "s") + (d.bulk === "assign" ? (val("#cst-bulkproj") === "__none" ? " unassigned." : " assigned.") : (d.bulk === "count" ? " counted." : " not counted.")); SEL.clear(); }
      await reloadPrints(); return;
    }
    if (d.match != null) {
      const body = { pattern: val("#cst-mp"), project_id: val("#cst-mproj") || null, only_unassigned: !!(EL.querySelector("#cst-munass") || {}).checked, apply: d.match === "apply" };
      if (!body.pattern) { MSG = "Type part of a file name first."; render(); return; }
      if (!body.project_id) { MSG = "Pick the project those prints belong to."; render(); return; }
      const r = await jpost("/api/costing/prints/match", body);
      if (!r.ok) { MSG = (r.d.error || "That did not work") + (r.status ? " (HTTP " + r.status + ")" : ""); render(); return; }
      if (r.d.preview) { MATCH = { ...body, matched: r.d.matched, sample: r.d.sample, preview: true }; render(); return; }
      OKMSG = r.d.applied + " print" + (r.d.applied === 1 ? "" : "s") + " matching “" + body.pattern + "” assigned."; MATCH = null; FORM = null; SEL.clear();
      await reloadPrints(); return;
    }
    let r = null, said = "";
    if (d.addclient != null) { r = await jpost("/api/costing/clients", { name: val("#cst-cn"), email: val("#cst-ce") }); if (r.ok) said = "Saved client “" + r.d.client.name + "” (projects.json)."; }
    else if (d.addproject != null) { r = await jpost("/api/costing/projects", { name: val("#cst-pn"), client_id: val("#cst-pc") || null }); if (r.ok) said = "Saved project “" + r.d.project.name + "”" + (r.d.project.client_id ? " for " + clientName(r.d.project.client_id) : "") + " (projects.json)."; }
    else if (d.additem != null) { const k = val("#cst-ik"); r = await jpost("/api/costing/items", { project_id: OPEN, kind: k, label: val("#cst-il"), [k === "labor" ? "minutes" : "cost"]: val("#cst-iv") }); if (r.ok) said = "Saved " + k + " item “" + r.d.item.label + "”."; }
    else if (d.rmitem != null) { r = await jpost("/api/costing/items/remove", { project_id: OPEN, id: d.rmitem }); if (r.ok) said = "Item removed."; }
    else if (d.rmclient != null) { r = await jpost("/api/costing/clients/remove", { id: d.rmclient }); if (r.ok) said = "Client removed."; }
    else if (d.rmproject != null) { r = await jpost("/api/costing/projects/remove", { id: OPEN }); if (r.ok) { OPEN = null; PROJ = null; said = "Project removed; its " + r.d.prints_unassigned + " print" + (r.d.prints_unassigned === 1 ? "" : "s") + " went back to unassigned."; } }
    else if (d.count != null) { r = await jpost("/api/costing/prints/update", { print_id: d.count, counted: d.to === "1" }); if (r.ok) said = d.to === "1" ? "Counted again." : "Not counted on this project."; }
    if (r && !r.ok) { MSG = (r.d.error || "That did not work") + (r.status ? " (HTTP " + r.status + ")" : " (no answer from the Hub)"); render(); return; }
    FORM = null; OKMSG = said;
    await load();
  }
  async function onChange(e) {
    const t = e.target;
    if (t.dataset.sel != null) { if (t.checked) SEL.add(t.dataset.sel); else SEL.delete(t.dataset.sel); render(); return; }
    if (t.dataset.selall != null) { for (const p of PL.prints) { if (t.checked) SEL.add(p.id); else SEL.delete(p.id); } render(); return; }
    if (t.dataset.pagesize != null) { PF.limit = Number(t.value) || 50; PF.offset = 0; await reloadPrints(); return; }
    if (t.dataset.rf === "range") { RF.range = t.value; render(); return; }
    if (t.dataset.rf != null || t.dataset.pf != null) return;      // applied by the Run / Filter buttons
    let r = null, said = "";
    if (t.dataset.assign != null) { r = await jpost("/api/costing/prints/assign", { print_id: t.dataset.assign, project_id: t.value || null }); if (r.ok) said = t.value ? "Print assigned to “" + (t.options[t.selectedIndex] || {}).text + "”." : "Print unassigned."; }
    else if (t.dataset.state != null) { r = await jpost("/api/costing/projects/update", { id: OPEN, state: t.value }); if (r.ok) said = "State saved: " + t.value + "."; }
    else if (t.dataset.client != null) { r = await jpost("/api/costing/projects/update", { id: OPEN, client_id: t.value || null }); if (r.ok) said = "Client saved."; }
    else if (t.dataset.charged != null) { r = await jpost("/api/costing/projects/update", { id: OPEN, charged: t.value }); if (r.ok) said = t.value ? "Charged " + usd(Number(t.value)) + " saved." : "Charged amount cleared."; }
    else return;
    if (!r.ok) MSG = (r.d.error || "That did not work") + (r.status ? " (HTTP " + r.status + ")" : " (no answer from the Hub)");
    else OKMSG = said;
    if (VIEW === "prints") await reloadPrints(); else await load();
  }

  // ---- the job card ----------------------------------------------------------------
  let LINE = null, CARDKEY = null;
  function buildCard() {
    const meta = document.getElementById("jmeta");
    if (!meta || LINE) return;
    LINE = document.createElement("div");
    LINE.className = "cstline"; LINE.id = "cstline";
    const after = document.getElementById("mgline") || meta;
    after.insertAdjacentElement("afterend", LINE);
    LINE.innerHTML = '<span class="k">project</span><select id="cstsel" title="The next print of this file lands in this project"></select><span class="st" id="cstst"></span>';
    LINE.querySelector("#cstsel").addEventListener("change", async e => {
      const name = window.SELECTED; if (!name) return;
      const r = await jpost("/api/costing/pending", { file: name, type: typeSlug(), project_id: e.target.value || null });
      const st = LINE.querySelector("#cstst");
      if (!r.ok) { st.textContent = r.d.error || "could not save"; return; }
      if (DATA) DATA.pending = r.d.pending;
      st.textContent = e.target.value ? "next print of this file goes there" : "";
    });
    const jt = document.getElementById("jt");
    if (jt) new MutationObserver(() => refreshCard(false)).observe(jt, { childList: true, characterData: true, subtree: true });
    refreshCard(true);
  }
  function refreshCard(force) {
    if (!LINE) return;
    const name = window.SELECTED;
    if (!name || !DATA) { LINE.className = "cstline"; return; }
    const key = name + "|" + DATA.projects.map(p => p.id).join(",");
    if (!force && key === CARDKEY) return;
    CARDKEY = key;
    if (!DATA.projects.length) { LINE.className = "cstline"; return; }
    const cur = (DATA.pending || {})[typeSlug() + ":" + name] || "";
    LINE.querySelector("#cstsel").innerHTML = projOpts(cur, "none");
    LINE.querySelector("#cstst").textContent = cur ? "next print of this file goes there" : "";
    LINE.className = "cstline show";
  }

  // ---- Settings ----------------------------------------------------------------------
  let SET = null, RATES = null;
  const RATE_LABELS = [["kwh_rate", "electricity $/kWh", "your tariff"], ["labor_rate", "labour $/hour", "for line items and setup"], ["setup_minutes", "setup minutes per print", "blank = none; adds labour to every counted print"],
    ["failure_pct", "failure allowance %", "quotes only; dropped once a failed print is on the project"], ["overhead_pct", "overhead %", "of subtotal"], ["min_fee", "minimum fee $", "floor for any price"],
    ["markup_pct", "markup %", "cost x (1 + markup)"], ["margin_pct", "target margin %", "cost / (1 - margin)"], ["hour_rate", "machine-hour rate $/h", "for the machine-hour method"],
    ["platform_fee_pct", "platform fee %", "e.g. Etsy 6.5 + 3"], ["platform_fee_fixed", "platform fee fixed $", "e.g. 0.45"]];
  const PKEYS = [["purchase", "purchase $"], ["life_hours", "life hours"], ["maint_per_hour", "maintenance $/h"], ["avg_watts", "average watts"]];
  // The suggestion block for a printer: its type's block, else the default
  // block when the type is the one it applies to. A type with neither gets
  // no printer suggestion.
  const sugFor = (sug, p) => (sug.by_type && sug.by_type[p.type]) || (!sug.applies_to || p.type === sug.applies_to ? sug.printers : null) || null;
  const noteFor = (sug, p, k) => ((sug.type_notes || {})[p.type] || {})[k] || (!sug.applies_to || p.type === sug.applies_to ? (sug.notes || {})[k] : "") || "";
  function buildSettings() {
    const host = document.getElementById("setModules");
    if (!host || SET) return;
    SET = document.createElement("div");
    SET.id = "setCosting";
    SET.innerHTML = '<label class="fl" style="margin-top:18px">Project costing <span class="hint" id="cstHint">fork</span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">Every print the Hub watches finish is logged with its real duration and its filament priced from the rolls that were loaded. Machine time is purchase price over life hours plus a maintenance reserve, per printer; energy is average watts x hours x your tariff. A rate you leave blank is costed from the <b>suggested</b> value shown greyed in its box - a cited number (source on hover, and in docs/costing.md), labelled "suggested" on every line it touches - or stays blank where there is no citation to lean on. Your own number always wins: the U1 has no published average draw (400 W is its 120 V ceiling), so a smart-plug reading of one print beats the suggestion.</div>' +
      '<div class="cst-rates" id="cstRates">' + RATE_LABELS.map(([k, l, h]) => '<label>' + esc(l) + '<input class="field" type="number" step="0.01" min="0" data-rate="' + k + '"><span class="hint" data-hint="' + k + '">' + esc(h) + "</span></label>").join("") + "</div>" +
      '<div id="cstPrinters"></div>' +
      '<div class="row" style="margin-top:8px; align-items:center; gap:8px"><button class="btn ghost" id="cstSave">Save</button><button class="btn ghost" id="cstUseSug" title="Write every suggested value into the rates you have left blank. Typed rates are not touched.">Use suggested values</button><span class="pstatus" id="cstMsg"></span></div>';
    host.appendChild(SET);
    const save = async body => {
      const r = await jpost("/api/costing/settings", body);
      const m = SET.querySelector("#cstMsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = (r.d.error || "Could not save") + (r.status ? " (HTTP " + r.status + ")" : ""); return null; }
      paint(r.d); if (OPEN) load(); return r.d;
    };
    const collect = () => {
      const body = { printers: {} };
      SET.querySelectorAll("[data-rate]").forEach(i => body[i.dataset.rate] = i.value);
      SET.querySelectorAll("[data-pidx]").forEach(i => { (body.printers[i.dataset.pidx] = body.printers[i.dataset.pidx] || {})[i.dataset.pkey] = i.value; });
      return body;
    };
    SET.querySelector("#cstSave").addEventListener("click", async () => {
      const d = await save(collect());
      if (d) { const m = SET.querySelector("#cstMsg"); m.className = "pstatus ok"; m.textContent = "Saved to config.json."; }
    });
    // The suggestions become real, typed rates - only where the box is blank,
    // and only for printers the suggestion is for (a U1).
    SET.querySelector("#cstUseSug").addEventListener("click", async () => {
      const sug = (RATES && RATES.suggested) || {};
      const body = collect();
      let n = 0;
      for (const k of Object.keys(sug)) if (k !== "printers" && k !== "notes" && k !== "type_notes" && k !== "by_type" && k !== "applies_to" && (body[k] === "" || body[k] == null) && sug[k] != null) { body[k] = sug[k]; n++; }
      for (const p of (RATES && RATES.printer_names) || []) {
        const sp = sugFor(sug, p); if (!sp) continue;
        const pb = body.printers[String(p.idx)] = body.printers[String(p.idx)] || {};
        for (const [k, v] of Object.entries(sp)) if ((pb[k] === "" || pb[k] == null) && v != null) { pb[k] = v; n++; }
      }
      const d = await save(body);
      if (d) { const m = SET.querySelector("#cstMsg"); m.className = "pstatus ok"; m.textContent = n ? "Saved " + n + " suggested value" + (n === 1 ? "" : "s") + " as your rates (config.json). Change any of them whenever you know better." : "Nothing to fill - every suggested rate is already set."; }
    });
  }
  function paint(s) {
    if (!SET || !s) return;
    RATES = s;
    const sug = s.suggested || {}, notes = sug.notes || {};
    SET.querySelectorAll("[data-rate]").forEach(i => {
      const k = i.dataset.rate;
      i.value = s[k] != null ? s[k] : "";
      i.placeholder = sug[k] != null ? "suggested " + sug[k] : "";
      if (notes[k]) i.title = notes[k];
      const h = SET.querySelector('[data-hint="' + k + '"]');
      if (h && sug[k] != null) h.textContent = (s[k] != null ? "" : "suggested " + sug[k] + " - ") + (notes[k] || "");
    });
    const set = Object.keys(s.keys ? s : {}).filter(k => s.keys.includes(k) && s[k] != null).length;
    SET.querySelector("#cstHint").textContent = set ? set + " of " + s.keys.length + " rates set" : "no rates set yet - lines with a suggested value are costed from it and say so";
    const hrsOf = p => { const sp = sugFor(sug, p); return p.hours != null ? '<div class="hint" title="print hours on this printer, from its own Moonraker history totals">' + Math.round(p.hours).toLocaleString() + " h printed" + (sp && sp.life_hours && ((s.printers || {})[String(p.idx)] || {}).life_hours == null ? " of " + sp.life_hours.toLocaleString() + " suggested (" + Math.round(p.hours / sp.life_hours * 100) + "%)" : "") + "</div>" : ""; };
    const typed = new Set();
    SET.querySelector("#cstPrinters").innerHTML = '<table class="cst-ptable"><thead><tr><th>Printer</th>' + PKEYS.map(([, l]) => "<th>" + esc(l) + "</th>").join("") + "</tr></thead><tbody>" +
      (s.printer_names || []).map(p => { const sp = sugFor(sug, p); if (sp) typed.add(p.type); return "<tr><td>" + esc(p.name) + ' <span class="hint">' + esc(p.type) + "</span>" + hrsOf(p) + "</td>" + PKEYS.map(([k]) => {
        const v = (s.printers || {})[String(p.idx)] && s.printers[String(p.idx)][k] != null ? esc(s.printers[String(p.idx)][k]) : "";
        const sv = sp ? sp[k] : null;
        return '<td><input class="field" type="number" min="0" step="0.01" data-pidx="' + p.idx + '" data-pkey="' + k + '" value="' + v + '"' + (sv != null ? ' placeholder="suggested ' + esc(sv) + '"' : "") + ' title="' + esc(noteFor(sug, p, k)) + '"></td>';
      }).join("") + "</tr>"; }).join("") + "</tbody></table>" +
      (typed.size ? '<div class="hint" style="margin-top:6px; max-width:640px">Greyed values are suggestions per printer type - ' + [...typed].map(t => esc(t) + ": " + esc(Object.values(t === sug.applies_to ? notes : ((sug.type_notes || {})[t] || {})).filter(Boolean).join(" · "))).join("<br>") + ".</div>" : "");
  }
  // Core's Settings feature list prints the raw key for anything it has no
  // label for; name this flag there.
  function relabel() {
    const box = document.getElementById("setFeatures"); if (!box) return;
    const i = box.querySelector('input[data-feat="costing"]'); const t = i && i.nextSibling;
    if (t && t.nodeType === 3 && t.textContent.trim() === "costing") t.textContent = " Project costing: print ledger, clients, reports & quotes (fork)";
  }

  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.costing === false) return;
    style();
    buildSettings();
    buildCard();
    const box = document.getElementById("setFeatures");
    if (box) { new MutationObserver(relabel).observe(box, { childList: true }); relabel(); }
    const [s, d] = await Promise.all([jget("/api/costing"), jget("/api/costing/projects")]);
    if (s) paint(s);
    if (d) { DATA = d; refreshCard(true); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.HubModules.register("costing", { tab: "Projects", mount, onShow });
})();
