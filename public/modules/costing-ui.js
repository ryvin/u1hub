// public/modules/costing-ui.js — fork module (ryvin/u1hub), not upstream.
// Injected only when features.costing is on. Server side: modules/costing.js.
// Three places:
//   * the Projects tab: clients and their projects; a project page with the
//     cost summary (every line says where its number came from), the prints
//     on it (move, don't count), line items, the pricing helper, charged and
//     margin, Export CSV and Print quote. An "unassigned prints" strip at the
//     top for prints that were started from the printer's own screen.
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
  const SRC = { deduction: "actual", flat: "flat $/g", slicer: "slicer est.", actual: "actual", watts: "typed W", metered: "metered", typed: "typed", blank: "blank", "hub-clock": "hub clock" };
  const srcText = t => Object.entries(t || {}).map(([k, n]) => n + " " + (SRC[k] || k)).join(", ") || "—";

  let EL = null, DATA = null, OPEN = null, PROJ = null, FORM = null, MSG = "";

  function style() {
    if (document.getElementById("cstcss")) return;
    const s = document.createElement("style");
    s.id = "cstcss";
    s.textContent = [
      ".cst-sec{margin:18px 0 8px; font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent,#f5b316); display:flex; gap:10px; align-items:center; flex-wrap:wrap;}",
      ".cst-sec .sp{flex:1} .cst-sec .btn{font-family:inherit; letter-spacing:normal; text-transform:none;}",
      ".cst-row{display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px; flex-wrap:wrap;}",
      ".cst-row .main{flex:1 1 240px; min-width:0;} .cst-row .t{font-weight:600; color:var(--ink); overflow-wrap:anywhere;} .cst-row .t a{color:inherit; text-decoration:none;} .cst-row .t a:hover{color:var(--signal);}",
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
      ".cst-wrap{overflow:auto;} .cst-empty{color:var(--ink-faint); padding:10px 2px;} .cst-msg{font-size:12px; color:var(--bad,#e5484d);}",
      ".cst-inline{display:flex; gap:6px; align-items:center; flex-wrap:wrap;} .cst-inline select.field, .cst-inline input.field{width:auto; flex:0 1 auto; font-size:12px; padding:3px 7px;}",
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
      '<p class="subnote">What each piece of client work cost - every finished, cancelled or failed print the Hub watched, with the material priced from the rolls that were loaded, plus labour, hardware and shipping - and what to charge for it. Nothing is decided here; rates you have not set show as blanks, never as zero.</p>' +
      '<div id="cst-body"></div>';
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input.field") && e.target.closest("[data-enter]")) { e.preventDefault(); const b = e.target.closest("[data-enter]").querySelector("[data-go]"); if (b) b.click(); } if (e.key === "Escape" && FORM) { FORM = null; render(); } });
  }
  async function load() {
    const d = await jget("/api/costing/projects");
    if (d) { DATA = d; refreshCard(true); }
    if (OPEN) { const p = await jget("/api/costing/projects/" + encodeURIComponent(OPEN)); PROJ = p; if (!p) OPEN = null; }
    render();
  }
  function onShow() { load(); }

  function render() {
    if (!EL || !DATA) return;
    EL.querySelector("#cst-count").textContent = DATA.projects.length + " project" + (DATA.projects.length === 1 ? "" : "s") + (DATA.unassigned_total ? " · " + DATA.unassigned_total + " unassigned print" + (DATA.unassigned_total === 1 ? "" : "s") : "");
    const body = EL.querySelector("#cst-body");
    body.innerHTML = OPEN && PROJ ? renderProject() : renderList();
    if (MSG) { const m = document.createElement("div"); m.className = "cst-msg"; m.textContent = MSG; body.prepend(m); MSG = ""; }
    const f = body.querySelector("[data-focus]"); if (f) setTimeout(() => f.focus(), 0);
  }
  const projOpts = (sel, blank) => (blank ? '<option value="">' + esc(blank) + "</option>" : "") + DATA.projects.map(p => '<option value="' + esc(p.id) + '"' + (p.id === sel ? " selected" : "") + ">" + esc(p.name) + (p.client_id ? " · " + esc(clientName(p.client_id)) : "") + "</option>").join("");
  const clientName = id => { const c = DATA.clients.find(x => x.id === id); return c ? c.name : ""; };
  const printRow = (p, inProject) => {
    const c = p.cost || {};
    const mat = c.material || {};
    return '<div class="cst-row' + (p.counted === false ? " off" : "") + '" data-print="' + esc(p.id) + '"><div class="main"><div class="t">' + esc(String(p.file).replace(/\.gcode$/i, "")) +
      ' <span class="cst-pill ' + (p.outcome === "done" ? "ok" : "bad") + '">' + esc(p.outcome) + "</span>" + (p.counted === false ? ' <span class="cst-pill">not counted</span>' : "") + "</div>" +
      '<div class="s">' + when(p.at) + " · " + esc(p.printer) + " · " + (p.pieces || 1) + " pc · " + hrs(c.hours) + (c.time_source ? " (" + (SRC[c.time_source] || c.time_source) + ")" : "") +
      " · " + (mat.grams != null ? mat.grams + " g" : "no grams") + " · material <b>" + usd(mat.cost) + "</b>" + (mat.source ? " (" + (SRC[mat.source] || mat.source) + (mat.partial ? ", partial" : "") + ")" : "") +
      (c.machine ? " · machine <b>" + usd(c.machine.cost) + "</b>" : "") + (c.energy ? " · energy <b>" + usd(c.energy.cost) + "</b>" : "") + " · direct <b>" + usd(c.direct) + "</b></div></div>" +
      '<div class="acts cst-inline"><select class="field" data-assign="' + esc(p.id) + '">' + projOpts(p.project_id || "", inProject ? "move to…" : "assign to…") + "</select>" +
      (inProject ? '<button class="btn ghost" data-count="' + esc(p.id) + '" data-to="' + (p.counted === false ? "1" : "0") + '">' + (p.counted === false ? "Count it" : "Don't count") + "</button>" : "") + "</div></div>";
  };

  function renderList() {
    let h = "";
    if (DATA.unassigned.length) {
      h += '<div class="cst-sec">Unassigned prints <span class="cst-pill">' + DATA.unassigned_total + "</span></div>" + DATA.unassigned.map(p => printRow(p, false)).join("") +
        (DATA.unassigned_total > DATA.unassigned.length ? '<div class="cst-empty">Showing the newest ' + DATA.unassigned.length + " of " + DATA.unassigned_total + ".</div>" : "");
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
      h += '<div class="cst-row"><div class="main"><div class="t">' + esc(g.name) + (g.email ? ' <span class="s" style="display:inline">' + esc(g.email) + "</span>" : "") + "</div>" +
        (ps.length ? ps.map(p => { const s = p.summary || {}; return '<div class="s" style="margin-top:6px"><a href="#" data-openp="' + esc(p.id) + '" style="color:var(--ink); text-decoration:none; font-family:var(--sans); font-size:13px">' + esc(p.name) + "</a> · " + esc(p.state) + " · " + s.prints + " print" + (s.prints === 1 ? "" : "s") + (s.failed ? " (" + s.failed + " failed)" : "") +
          " · cost <b>" + usd(s.cost) + "</b>" + (s.partial ? " <span class=\"cst-pill warn\" title=\"some lines are blank or partial\">partial</span>" : "") + (s.charged != null ? " · charged <b>" + usd(s.charged) + "</b> · margin <b>" + usd(s.margin) + "</b>" + (s.margin_pct != null ? " (" + s.margin_pct + "%)" : "") : "") + "</div>"; }).join("")
          : '<div class="s">No projects yet.</div>') + "</div>" +
        (g.id ? '<div class="acts"><button class="btn ghost" data-form="rmclient:' + esc(g.id) + '" title="Remove client" aria-label="Remove">×</button>' + (FORM === "rmclient:" + g.id ? '<button class="btn ghost danger" data-rmclient="' + esc(g.id) + '">Remove client</button>' : "") + "</div>" : "") + "</div>";
    }
    if (!any) h += '<div class="cst-empty">Add a client, then a project for them. Prints join a project from the job card (pick the project before you send the file) or from the unassigned strip above once they finish.</div>';
    return h;
  }

  function renderProject() {
    const { project: p, client: c, summary: s, pricing: pz, prints } = PROJ;
    let h = '<div class="cst-sec"><a href="#" data-back style="color:inherit; text-decoration:none">← projects</a><span class="sp"></span>' +
      '<a class="btn ghost" href="/api/costing/projects/' + encodeURIComponent(p.id) + '.csv" download style="text-decoration:none">Export CSV</a>' +
      '<a class="btn ghost" href="/api/costing/projects/' + encodeURIComponent(p.id) + '/quote" target="_blank" rel="noopener" style="text-decoration:none">Print quote</a>' +
      '<button class="btn ghost" data-form="rmproject" title="Remove project">×</button></div>' +
      (FORM === "rmproject" ? '<div class="cst-form"><div class="r">Remove this project? Its prints go back to unassigned.<button class="btn ghost danger" data-rmproject>Remove</button><button class="btn ghost" data-form="">Keep</button></div></div>' : "") +
      '<div class="cst-row"><div class="main"><div class="t">' + esc(p.name) + (c ? ' <span class="s" style="display:inline">' + esc(c.name) + "</span>" : "") + "</div>" +
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
    h += p.items.length ? p.items.map(i => '<div class="cst-row"><div class="main"><div class="t">' + esc(i.label) + ' <span class="cst-pill">' + esc(i.kind) + '</span></div><div class="s">' + (i.kind === "labor" ? i.minutes + " min" : usd(i.cost)) + '</div></div><div class="acts"><button class="btn ghost" data-rmitem="' + esc(i.id) + '" title="Remove" aria-label="Remove">×</button></div></div>').join("") : '<div class="cst-empty">Labour, hardware, packaging, shipping - anything the printers did not do.</div>';
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

  const val = id => { const x = EL.querySelector(id); return x ? x.value : ""; };
  async function onClick(e) {
    const a = e.target.closest("[data-form],[data-openp],[data-back],[data-addclient],[data-addproject],[data-additem],[data-rmitem],[data-rmclient],[data-rmproject],[data-count]");
    if (!a) return;
    e.preventDefault();
    const d = a.dataset;
    if (d.form != null) { FORM = FORM === d.form || d.form === "" ? null : d.form; render(); return; }
    if (d.openp != null) { OPEN = d.openp; FORM = null; await load(); return; }
    if (d.back != null) { OPEN = null; PROJ = null; FORM = null; await load(); return; }
    let r = null;
    if (d.addclient != null) r = await jpost("/api/costing/clients", { name: val("#cst-cn"), email: val("#cst-ce") });
    else if (d.addproject != null) r = await jpost("/api/costing/projects", { name: val("#cst-pn"), client_id: val("#cst-pc") || null });
    else if (d.additem != null) { const k = val("#cst-ik"); r = await jpost("/api/costing/items", { project_id: OPEN, kind: k, label: val("#cst-il"), [k === "labor" ? "minutes" : "cost"]: val("#cst-iv") }); }
    else if (d.rmitem != null) r = await jpost("/api/costing/items/remove", { project_id: OPEN, id: d.rmitem });
    else if (d.rmclient != null) r = await jpost("/api/costing/clients/remove", { id: d.rmclient });
    else if (d.rmproject != null) { r = await jpost("/api/costing/projects/remove", { id: OPEN }); if (r.ok) { OPEN = null; PROJ = null; } }
    else if (d.count != null) r = await jpost("/api/costing/prints/update", { print_id: d.count, counted: d.to === "1" });
    if (r && !r.ok) { MSG = r.d.error || "That did not work"; render(); return; }
    FORM = null;
    await load();
  }
  async function onChange(e) {
    const t = e.target;
    let r = null;
    if (t.dataset.assign != null) r = await jpost("/api/costing/prints/assign", { print_id: t.dataset.assign, project_id: t.value || null });
    else if (t.dataset.state != null) r = await jpost("/api/costing/projects/update", { id: OPEN, state: t.value });
    else if (t.dataset.client != null) r = await jpost("/api/costing/projects/update", { id: OPEN, client_id: t.value || null });
    else if (t.dataset.charged != null) r = await jpost("/api/costing/projects/update", { id: OPEN, charged: t.value });
    else return;
    if (!r.ok) { MSG = r.d.error || "That did not work"; }
    await load();
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
  function buildSettings() {
    const host = document.getElementById("setModules");
    if (!host || SET) return;
    SET = document.createElement("div");
    SET.id = "setCosting";
    SET.innerHTML = '<label class="fl" style="margin-top:18px">Project costing <span class="hint" id="cstHint">fork</span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">Every print the Hub watches finish is logged with its real duration and its filament priced from the rolls that were loaded. Machine time is purchase price over life hours plus a maintenance reserve, per printer; energy is average watts x hours x your tariff. Any rate you leave blank leaves that line blank - the Hub never guesses. The U1 has no published average draw (1150 W is its peak): measure one print on a smart plug and type what you saw.</div>' +
      '<div class="cst-rates" id="cstRates">' + RATE_LABELS.map(([k, l, h]) => '<label>' + esc(l) + '<input class="field" type="number" step="0.01" min="0" data-rate="' + k + '"><span class="hint">' + esc(h) + "</span></label>").join("") + "</div>" +
      '<div id="cstPrinters"></div>' +
      '<div class="row" style="margin-top:8px; align-items:center; gap:8px"><button class="btn ghost" id="cstSave">Save</button><span class="pstatus" id="cstMsg"></span></div>';
    host.appendChild(SET);
    SET.querySelector("#cstSave").addEventListener("click", async () => {
      const body = { printers: {} };
      SET.querySelectorAll("[data-rate]").forEach(i => body[i.dataset.rate] = i.value);
      SET.querySelectorAll("[data-pidx]").forEach(i => { (body.printers[i.dataset.pidx] = body.printers[i.dataset.pidx] || {})[i.dataset.pkey] = i.value; });
      const r = await jpost("/api/costing/settings", body);
      const m = SET.querySelector("#cstMsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      paint(r.d); m.className = "pstatus ok"; m.textContent = "Saved."; if (OPEN) load();
    });
  }
  function paint(s) {
    if (!SET || !s) return;
    RATES = s;
    SET.querySelectorAll("[data-rate]").forEach(i => { i.value = s[i.dataset.rate] != null ? s[i.dataset.rate] : ""; });
    const set = Object.keys(s.keys ? s : {}).filter(k => s.keys.includes(k) && s[k] != null).length;
    SET.querySelector("#cstHint").textContent = set ? set + " of " + s.keys.length + " rates set" : "no rates set yet - every cost line is blank";
    SET.querySelector("#cstPrinters").innerHTML = '<table class="cst-ptable"><thead><tr><th>Printer</th>' + PKEYS.map(([, l]) => "<th>" + esc(l) + "</th>").join("") + "</tr></thead><tbody>" +
      (s.printer_names || []).map(p => "<tr><td>" + esc(p.name) + "</td>" + PKEYS.map(([k]) => '<td><input class="field" type="number" min="0" step="0.01" data-pidx="' + p.idx + '" data-pkey="' + k + '" value="' + ((s.printers || {})[String(p.idx)] && s.printers[String(p.idx)][k] != null ? esc(s.printers[String(p.idx)][k]) : "") + '"></td>').join("") + "</tr>").join("") + "</tbody></table>";
  }
  // Core's Settings feature list prints the raw key for anything it has no
  // label for; name this flag there.
  function relabel() {
    const box = document.getElementById("setFeatures"); if (!box) return;
    const i = box.querySelector('input[data-feat="costing"]'); const t = i && i.nextSibling;
    if (t && t.nodeType === 3 && t.textContent.trim() === "costing") t.textContent = " Project costing: print ledger, clients & quotes (fork)";
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
