// public/modules/sme-ui.js — fork module (ryvin/u1hub), not upstream.
// Injected only when features.sme is on. Server side: modules/sme.js. Four
// places, and nothing in core app.js, models-ui.js or costing-ui.js is
// patched: this file decorates their DOM after they render (MutationObserver,
// the way library-colors-ui.js and margin-ui.js do), with sme-prefixed class
// names so it can never restyle them.
//   * a "✦ SME" badge on every 3MF card (Models tab), every print row (the
//     Projects tab's Prints list / project pages) and the Dash job card for
//     the selected gcode; a click opens the review inline: verdict, settings
//     table, printer tuning, speed-vs-quality notes, risks, evidence, lessons
//     used, the family timeline (variants, what changed, outcome, ★ current
//     best, the next experiment) and the DRAFT changes in copyable blocks.
//   * an "SME" tab: progress per kind, last run, the review list (filter by
//     kind / verdict), printer tuning reviews, and a Lessons list (filter by
//     printer type / material / tag).
//   * Settings: the runner token (copy), how to run and schedule the runner.
// Every user string is escaped. Phone width: the panel wraps and tables
// scroll inside .sme-scroll.
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  const when = t => t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const typeSlug = () => (typeof window.activeType === "function" && window.activeType().slug) || "u1";
  const baseName = s => String(s || "").replace(/\.(gcode|gco|g)$/i, "").trim().toLowerCase();
  const VLABEL = { GO: "GO", TUNE: "TUNE", RISK: "RISK" };

  let STATUS = null, BRIEFS = [], BYPATH = new Map(), BYNAME = new Map(), LESSONS = null, EL = null, VIEW = "reviews", OPEN = null, FULL = null;
  const RF = { kind: "", verdict: "" }, LF = { type: "", material: "", tag: "" };

  function style() {
    if (document.getElementById("smecss")) return;
    const s = document.createElement("style");
    s.id = "smecss";
    s.textContent = [
      ".sme-badge{display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; padding:2px 8px; border-radius:var(--r-pill,999px); border:1px solid var(--line); color:var(--ink-dim); cursor:pointer; background:transparent; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; vertical-align:middle;}",
      ".sme-badge b{font-weight:800;} .sme-badge.GO b{color:var(--good,#46a758);} .sme-badge.TUNE b{color:var(--signal);} .sme-badge.RISK b{color:var(--bad,#e5484d);}",
      ".sme-badge.GO{border-color:color-mix(in srgb, var(--good,#46a758) 50%, var(--line));} .sme-badge.TUNE{border-color:color-mix(in srgb, var(--signal) 50%, var(--line));} .sme-badge.RISK{border-color:color-mix(in srgb, var(--bad,#e5484d) 50%, var(--line));}",
      ".sme-badge .st{color:var(--ink-faint); font-weight:400; letter-spacing:0; overflow:hidden; text-overflow:ellipsis;}",
      ".sme-hold{margin-top:4px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-width:0;} .sme-hold:empty{display:none;}",
      ".sme-panel{margin-top:8px; border:1px solid color-mix(in srgb, var(--signal) 40%, var(--line)); border-radius:10px; padding:10px 12px; background:var(--panel-2,var(--panel)); font-size:13px; line-height:1.5; max-width:100%; min-width:0; overflow-wrap:anywhere;}",
      ".sme-panel .sme-head{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;} .sme-panel .sme-head .x{margin-left:auto; background:transparent; border:none; color:var(--ink-faint); font:inherit; font-size:16px; cursor:pointer; padding:2px 6px;}",
      ".sme-v{font-family:var(--mono); font-weight:800; letter-spacing:.08em; font-size:11.5px; padding:2px 8px; border-radius:6px; border:1px solid var(--line);} .sme-v.GO{color:var(--good,#46a758);} .sme-v.TUNE{color:var(--signal);} .sme-v.RISK{color:var(--bad,#e5484d);}",
      ".sme-meta{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;}",
      ".sme-sec{margin:10px 0 4px; font-family:var(--mono); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-faint);}",
      ".sme-scroll{overflow:auto; max-width:100%;} .sme-table{width:100%; border-collapse:collapse; font-size:12.5px; min-width:420px;} .sme-table th{text-align:left; font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); padding:4px 8px 6px 0; border-bottom:1px solid var(--line); white-space:nowrap;}",
      ".sme-table td{padding:5px 8px 5px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 55%, transparent); vertical-align:top;} .sme-table td.k{font-family:var(--mono); font-size:11px; color:var(--ink-dim); white-space:nowrap;} .sme-table td.v{font-weight:600; color:var(--ink); white-space:nowrap;} .sme-table td.f{font-family:var(--mono); font-size:11px; color:var(--ink-faint); white-space:nowrap;}",
      ".sme-panel ul{margin:4px 0 4px 18px; padding:0;} .sme-panel li{margin:3px 0;}",
      ".sme-draft{position:relative; margin:6px 0;} .sme-draft pre{margin:0; padding:10px 12px; padding-right:72px; background:var(--panel); border:1px dashed color-mix(in srgb, var(--signal) 50%, var(--line)); border-radius:8px; font:11.5px/1.5 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--ink); max-height:320px; overflow:auto;}",
      ".sme-draft .sme-copy{position:absolute; top:6px; right:6px; font-size:10.5px; padding:2px 8px;} .sme-draft .lbl{font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--signal); margin-bottom:3px;}",
      ".sme-tl{display:grid; gap:6px; margin:4px 0;} .sme-tl .m{display:grid; grid-template-columns:auto 1fr; gap:4px 10px; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--panel); font-size:12.5px;} .sme-tl .m.best{border-color:color-mix(in srgb, var(--good,#46a758) 60%, var(--line));}",
      ".sme-tl .v{font-family:var(--mono); font-size:11px; color:var(--ink-dim); white-space:nowrap;} .sme-tl .n{font-weight:600; color:var(--ink); overflow-wrap:anywhere;} .sme-tl .l{grid-column:2; font-size:12px; color:var(--ink-dim);} .sme-tl .o{grid-column:2; font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".sme-next{padding:8px 10px; border-left:3px solid var(--signal); background:color-mix(in srgb, var(--signal) 8%, transparent); border-radius:0 8px 8px 0; margin:6px 0; font-size:12.5px;}",
      ".sme-tabs{display:flex; gap:6px; margin:10px 0 14px; flex-wrap:wrap;} .sme-tab{font:inherit; font-size:12px; font-weight:700; letter-spacing:.05em; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--ink-dim); cursor:pointer;} .sme-tab.on{background:color-mix(in srgb, var(--signal) 14%, var(--panel-2)); color:var(--ink); border-color:color-mix(in srgb, var(--signal) 40%, var(--line));}",
      ".sme-prog{display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:8px; margin-bottom:10px;} .sme-kpi{padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel);} .sme-kpi .k{font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint);} .sme-kpi .n{font-size:18px; font-weight:700; color:var(--ink); margin-top:2px;}",
      ".sme-kpi .bar{height:6px; background:var(--panel-2); border-radius:4px; margin-top:6px; overflow:hidden;} .sme-kpi .bar i{display:block; height:100%; background:var(--signal); border-radius:4px;}",
      ".sme-filters{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;} .sme-filters select.field, .sme-filters input.field{width:auto; flex:0 1 auto; font-size:12px; padding:4px 7px;}",
      ".sme-row{display:flex; gap:10px; align-items:flex-start; padding:9px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:6px; flex-wrap:wrap; cursor:pointer;} .sme-row:hover{border-color:color-mix(in srgb, var(--signal) 40%, var(--line));} .sme-row .t{flex:1 1 220px; min-width:0; font-weight:600; color:var(--ink); overflow-wrap:anywhere;} .sme-row .s{flex-basis:100%; font-family:var(--mono); font-size:11px; color:var(--ink-faint); overflow-wrap:anywhere;}",
      ".sme-row.on{border-color:var(--signal);} .sme-note{font-size:12px; color:var(--ink-dim); padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel-2,var(--panel)); margin:4px 0 12px; line-height:1.6;} .sme-note b{color:var(--ink);} .sme-note code{font-size:11px; overflow-wrap:anywhere;}",
      ".sme-empty{color:var(--ink-faint); padding:10px 2px;} .sme-pill{font-family:var(--mono); font-size:10px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--ink-dim); white-space:nowrap;}",
      ".sme-line{display:none; margin-top:4px; align-items:center; gap:8px; flex-wrap:wrap;} .sme-line.show{display:flex;}",
      "@media (max-width:640px){ .sme-table{min-width:0;} .sme-table td.v, .sme-table td.k{white-space:normal;} .sme-draft pre{padding-right:12px; padding-top:30px;} }"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- data ----------------------------------------------------------------------------------
  async function refresh() {
    const [s, b] = await Promise.all([jget("/api/sme/status?totals=1"), jget("/api/sme/reviews?brief=1&limit=10000")]);
    if (s) STATUS = s;
    if (b && Array.isArray(b.reviews)) {
      BRIEFS = b.reviews; BYPATH = new Map(); BYNAME = new Map();
      for (const r of BRIEFS) {
        for (const p of (r.paths || [])) {
          if (r.kind === "family") {
            // members carry paths; member_lines carry the member's cid
            const mem = (r.members || []).find(m => (m.paths || []).includes(p)) || null;
            const ml = mem ? (r.member_lines || []).find(x => x.member === mem.cid) || null : null;
            if (!BYPATH.has("gcode|" + p)) BYPATH.set("gcode|" + p, { ...r, member: ml });
            const nm = baseName(p.replace(/^[^:]+:/, "")); if (!BYNAME.has(nm)) BYNAME.set(nm, BYPATH.get("gcode|" + p));
          } else {
            BYPATH.set(r.kind + "|" + p, r);
            if (r.kind === "gcode") { const nm = baseName(p.replace(/^[^:]+:/, "")); BYNAME.set(nm, r); }
          }
        }
      }
    }
    decorateAll();
    paintSettings();
  }
  const briefFor = (kind, key) => BYPATH.get(kind + "|" + key) || null;

  // ---- the badge and the panel -------------------------------------------------------------------
  function badgeHtml(b, kind, key) {
    if (!b) return "";
    const line = b.member ? b.member.line : (b.summary || "");
    return '<button type="button" class="sme-badge ' + esc(b.verdict) + '" data-sme-kind="' + esc(kind) + '" data-sme-key="' + esc(key) + '" title="' + esc((b.kind === "family" ? "Family review: " : "SME review: ") + (b.summary || "")) + '">✦ SME <b>' + esc(VLABEL[b.verdict] || b.verdict) + '</b>' + (b.member && b.member.best ? " ★" : "") + '<span class="st">' + esc(line) + "</span></button>";
  }
  function copyText(btn, text) {
    const done = () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); };
    const fallback = () => { try { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); } catch { btn.textContent = "Select and copy"; } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  function draftBlock(label, text, id) {
    return '<div class="sme-draft"><div class="lbl">DRAFT · ' + esc(label) + ' · not applied by the Hub</div><pre data-draft="' + esc(id) + '">' + esc(text) + '</pre><button type="button" class="btn ghost sme-copy" data-copy="' + esc(id) + '">Copy</button></div>';
  }
  function renderReview(d, member) {
    const r = d.review || d.family_review, fr = d.family_review, own = d.review;
    if (!r) return '<div class="sme-empty">No review yet.</div>';
    let h = '<div class="sme-head"><span class="sme-v ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span><span>' + esc(r.summary) + '</span><button type="button" class="x" data-close="1" title="Close">×</button></div>';
    if (member) h += '<div class="sme-next">' + (member.best ? "★ " : "") + esc(member.line) + "</div>";
    if (r.kind === "family" && r.family) {
      h += '<div class="sme-sec">Family timeline · ' + (r.members || []).length + ' variants</div><div class="sme-tl">';
      for (const m of (r.member_lines || [])) {
        const mm = (r.members || []).find(x => x.cid === m.member) || {};
        h += '<div class="m' + (m.best ? " best" : "") + '"><span class="v">v' + m.v + (m.best ? " ★" : "") + '</span><span class="n">' + esc(m.name) + '</span><span class="l">' + esc(m.line.replace(/^v\d+ of \d+ - /, "")) + '</span>' + (mm.paths && mm.paths.length > 1 ? '<span class="o">also at ' + esc(mm.paths.slice(1).join(", ")) + "</span>" : "") + "</div>";
      }
      h += "</div>";
      if (r.family.best) h += '<div class="sme-next"><b>Best now:</b> ' + esc(r.family.best.member) + (r.family.best.why ? " — " + esc(r.family.best.why) : "") + "</div>";
      if (r.family.next_experiment) h += '<div class="sme-next"><b>Next experiment:</b> ' + esc(r.family.next_experiment.change) + (r.family.next_experiment.why ? " — " + esc(r.family.next_experiment.why) : "") + "</div>";
      if ((r.family.iterations || []).length) h += "<ul>" + r.family.iterations.map(it => "<li><b>" + esc(it.to) + "</b>: " + esc(it.effect) + (it.why ? " — " + esc(it.why) : "") + "</li>").join("") + "</ul>";
    }
    if ((r.settings || []).length) h += '<div class="sme-sec">Settings (Orca keys)</div><div class="sme-scroll"><table class="sme-table"><thead><tr><th>Setting</th><th>Now</th><th>Suggested</th><th>Why</th><th>Impact</th></tr></thead><tbody>' +
      r.settings.map(s => '<tr><td class="k">' + esc(s.key) + '</td><td class="f">' + esc(s.current == null ? "—" : s.current) + '</td><td class="v">' + esc(s.suggested) + "</td><td>" + esc(s.why) + '</td><td class="k">' + esc(s.impact) + "</td></tr>").join("") + "</tbody></table></div>";
    for (const p of (r.printer_tuning || [])) {
      h += '<div class="sme-sec">Printer tuning · ' + esc(p.printer) + '</div><div class="sme-scroll"><table class="sme-table"><thead><tr><th>Area</th><th>Parameter</th><th>Now</th><th>Suggested</th><th>Why</th></tr></thead><tbody>' +
        (p.items || []).map(it => '<tr><td class="k">' + esc(it.area) + '</td><td class="k">' + esc(it.param) + '</td><td class="f">' + esc(it.current == null ? "—" : it.current) + '</td><td class="v">' + esc(it.suggested) + "</td><td>" + esc(it.why) + "</td></tr>").join("") + "</tbody></table></div>";
    }
    if ((r.speed_quality || []).length) h += '<div class="sme-sec">Speed vs quality</div><ul>' + r.speed_quality.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    if ((r.risks || []).length) h += '<div class="sme-sec">Risks</div><ul>' + r.risks.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    const dr = r.drafts || {};
    if (dr.orca) h += '<div class="sme-sec">Draft Orca values</div>' + draftBlock("Orca", JSON.stringify(dr.orca, null, 2), r.id + ":orca");
    if (dr.klipper) h += '<div class="sme-sec">Draft Klipper config change</div>' + draftBlock("Klipper", dr.klipper, r.id + ":klipper");
    if ((r.evidence || []).length) h += '<div class="sme-sec">Evidence</div><ul>' + r.evidence.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    if ((r.gaps || []).length) h += '<div class="sme-sec">Not enough data</div><ul>' + r.gaps.map(g => "<li><b>" + esc(g.topic) + "</b>: " + esc(g.reason) + "</li>").join("") + "</ul>";
    if ((r.lessons_used || []).length || (r.lessons_created || []).length) h += '<div class="sme-sec">Lessons</div><div>' + (r.lessons_used || []).map(id => '<span class="sme-pill" title="applied">' + esc(id) + "</span> ").join("") + (r.lessons_created || []).map(id => '<span class="sme-pill" title="created by this review">+ ' + esc(id) + "</span> ").join("") + "</div>";
    if (own && fr && own !== r) h += '<div class="sme-note">This file is also part of a family review (' + esc(fr.name) + ").</div>";
    h += '<div class="sme-meta"><span>' + esc(r.from_lessons ? "from lessons, no model call" : "tier " + (r.tier || "?") + " · " + (r.model || r.reviewer || "?") + (r.escalated ? " (escalated from " + esc(r.escalated_from || "") + ")" : "")) + "</span><span>confidence " + esc(r.confidence) + "</span><span>" + esc(when(r.reviewed_at)) + "</span>" +
      (r.usage && r.usage.input_tokens != null ? "<span>" + esc(r.usage.input_tokens) + " in / " + esc(r.usage.output_tokens) + " out tokens" + (r.usage.cost_usd ? " · ~$" + Number(r.usage.cost_usd).toFixed(3) : "") + "</span>" : "") +
      (d.stale ? '<span style="color:var(--warn,#F5A524)">the file changed since this review</span>' : "") + (r.paths && r.paths.length > 1 ? "<span>also at " + esc(r.paths.filter(p => p !== r.key).slice(0, 4).join(", ")) + "</span>" : "") +
      '<span title="The Hub never applies a change; read the drafts and apply them yourself in Orca or on the printer.">advice, not a guarantee</span></div>';
    return h;
  }
  async function openPanel(host, kind, key) {
    let panel = host.querySelector(":scope > .sme-panel");
    if (panel) { panel.remove(); return; }
    panel = document.createElement("div"); panel.className = "sme-panel"; panel.innerHTML = '<div class="sme-empty">Loading the review…</div>';
    host.appendChild(panel);
    const d = await jget("/api/sme/reviews?kind=" + encodeURIComponent(kind) + "&key=" + encodeURIComponent(key));
    if (!panel.isConnected) return;
    panel.innerHTML = d ? renderReview(d, d.member || null) : '<div class="sme-empty">Could not load the review.</div>';
    wirePanel(panel);
  }
  function wirePanel(panel) {
    panel.addEventListener("click", e => {
      const c = e.target.closest("[data-copy]"); if (c) { const pre = panel.querySelector('pre[data-draft="' + CSS.escape(c.dataset.copy) + '"]'); if (pre) copyText(c, pre.textContent); return; }
      if (e.target.closest("[data-close]")) panel.remove();
    });
  }
  document.addEventListener("click", e => {
    const b = e.target.closest(".sme-badge[data-sme-kind]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const host = b.closest(".sme-hold") || b.parentElement;
    openPanel(host, b.dataset.smeKind, b.dataset.smeKey);
  }, true);

  // ---- decorations ----------------------------------------------------------------------------------
  const OBS = new Map();
  function observe(id, fn) {
    const el = document.getElementById(id); if (!el || OBS.has(id)) return !!el;
    const o = new MutationObserver(() => { o.disconnect(); try { fn(el); } finally { o.observe(el, { childList: true, subtree: true }); } });
    o.observe(el, { childList: true, subtree: true }); OBS.set(id, o); fn(el);
    return true;
  }
  function decorateModels(grid) {
    for (const card of grid.querySelectorAll(".mdl-card[data-rel]")) {
      const b = briefFor("3mf", card.dataset.rel);
      let hold = card.querySelector(":scope > .mdl-body > .sme-hold");
      if (!b) { if (hold) hold.remove(); continue; }
      if (hold && hold.dataset.v === b.reviewed_at + "") continue;
      if (!hold) { hold = document.createElement("div"); hold.className = "sme-hold"; const sub = card.querySelector(".mdl-sub"); if (sub) sub.after(hold); else card.querySelector(".mdl-body").prepend(hold); }
      hold.dataset.v = b.reviewed_at + ""; hold.innerHTML = badgeHtml(b, "3mf", card.dataset.rel);
    }
  }
  function decorateCosting(root) {
    for (const row of root.querySelectorAll(".cst-row[data-print], tr[data-print]")) {
      const nameEl = row.querySelector(".fn") || row.querySelector(".t");
      if (!nameEl) continue;
      const nm = baseName(nameEl.childNodes[0] ? nameEl.childNodes[0].textContent : nameEl.textContent);
      const b = BYNAME.get(nm);
      let hold = nameEl.querySelector(":scope > .sme-hold");
      if (!b) { if (hold) hold.remove(); continue; }
      if (hold && hold.dataset.v === b.reviewed_at + "") continue;
      if (!hold) { hold = document.createElement("div"); hold.className = "sme-hold"; nameEl.appendChild(hold); }
      const key = (b.paths || []).find(p => baseName(p.replace(/^[^:]+:/, "")) === nm) || b.key;
      hold.dataset.v = b.reviewed_at + ""; hold.innerHTML = badgeHtml(b, "gcode", key);
    }
  }
  let LINE = null;
  function decorateCard() {
    const meta = document.getElementById("jmeta"); if (!meta) return;
    if (!LINE) { LINE = document.createElement("div"); LINE.className = "sme-line sme-hold"; LINE.id = "smeline"; const after = document.getElementById("cstline") || document.getElementById("mgline") || meta; after.insertAdjacentElement("afterend", LINE);
      const jt = document.getElementById("jt"); if (jt) new MutationObserver(() => decorateCard()).observe(jt, { childList: true, characterData: true, subtree: true }); }
    const name = window.SELECTED;
    const key = name ? typeSlug() + ":" + name : null;
    const b = key ? briefFor("gcode", key) : null;
    if (!b) { LINE.className = "sme-line sme-hold"; LINE.innerHTML = ""; LINE.dataset.v = ""; return; }
    if (LINE.dataset.v === key + "|" + b.reviewed_at) return;
    LINE.dataset.v = key + "|" + b.reviewed_at; LINE.innerHTML = badgeHtml(b, "gcode", key); LINE.className = "sme-line sme-hold show";
  }
  function decorateAll() {
    observe("mdl-grid", decorateModels);
    observe("modview-costing", decorateCosting);
    decorateCard();
  }

  // ---- the SME tab ------------------------------------------------------------------------------------
  function mount(el) {
    EL = el; style();
    el.innerHTML = '<div class="sechead"><h2>SME</h2><span class="count" id="sme-count"></span></div>' +
      '<p class="subnote">A 3D-printing expert\'s second look at every gcode file, print family, 3MF project and printer - on a schedule, most-printed first, from Claude Code on your own subscription. Suggestions and DRAFT changes only: the Hub never applies anything.</p>' +
      '<div class="sme-tabs" role="tablist"><button class="sme-tab on" data-smeview="reviews" role="tab">Reviews</button><button class="sme-tab" data-smeview="printers" role="tab">Printers</button><button class="sme-tab" data-smeview="lessons" role="tab">Lessons</button></div>' +
      '<div id="sme-body"></div>';
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
  }
  async function onShow() { await refresh(); if (VIEW === "lessons") LESSONS = await jget("/api/sme/lessons?" + qs(LF)); render(); }
  const qs = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  function render() {
    if (!EL) return;
    const s = STATUS || {};
    EL.querySelector("#sme-count").textContent = (s.reviews || 0) + " review" + (s.reviews === 1 ? "" : "s") + " · " + (s.lessons || 0) + " lesson" + (s.lessons === 1 ? "" : "s") + (s.pending != null ? " · " + s.pending + " waiting" : "");
    EL.querySelectorAll(".sme-tab").forEach(t => t.classList.toggle("on", t.dataset.smeview === VIEW));
    const body = EL.querySelector("#sme-body");
    body.innerHTML = VIEW === "lessons" ? renderLessons() : renderReviews(VIEW === "printers");
    body.querySelectorAll(".sme-panel").forEach(wirePanel);
  }
  function renderProgress() {
    const s = STATUS || {}, t = s.totals || {};
    const kpi = (k, label) => { const x = t[k] || { reviewed: 0, total: 0 }; const pct = x.total ? Math.round(x.reviewed / x.total * 100) : 0; return '<div class="sme-kpi"><div class="k">' + esc(label) + '</div><div class="n">' + x.reviewed + " / " + x.total + '</div><div class="bar"><i style="width:' + pct + '%"></i></div></div>'; };
    const last = s.last_run;
    let h = '<div class="sme-prog">' + kpi("gcode", "gcode files") + kpi("family", "print families") + kpi("3mf", "3MF projects") + kpi("printer", "printers") + "</div>";
    h += '<div class="sme-note">' + (last ? "<b>Last run</b> " + esc(when(last.finished_at || last.at)) + ": " + last.reviewed + " reviewed (" + (last.from_lessons || 0) + " from lessons, " + (last.escalated || 0) + " escalated), " + (last.errors || 0) + " errors" + (last.models && Object.keys(last.models).length ? " · " + esc(Object.entries(last.models).map(([m, n]) => m + " ×" + n).join(", ")) : "") + (last.cost_usd ? " · ~$" + Number(last.cost_usd).toFixed(2) : "") : "<b>No run yet.</b> Install the schedule or run <code>node scripts/sme-runner.js</code> on the Hub PC (Settings → 3D-printing SME).") +
      (s.paused_until ? ' <span style="color:var(--warn,#F5A524)">Paused until ' + esc(when(s.paused_until)) + " (usage limit).</span>" : "") + (s.last_error ? '<div class="mono" style="font-family:var(--mono); font-size:11px; color:var(--bad,#e5484d)">last error: ' + esc(s.last_error.error) + (s.last_error.key ? " (" + esc(s.last_error.key) + ")" : "") + "</div>" : "") +
      (s.building ? '<div style="font-family:var(--mono); font-size:11px">hashing the shelf: ' + esc(JSON.stringify(s.hashing)) + "</div>" : "") + "</div>";
    return h;
  }
  function renderReviews(printersOnly) {
    let h = renderProgress();
    let list = BRIEFS.filter(r => printersOnly ? r.kind === "printer" : r.kind !== "printer");
    if (!printersOnly) h += '<div class="sme-filters"><select class="field" data-rf="kind"><option value="">any kind</option>' + ["gcode", "family", "3mf"].map(k => '<option value="' + k + '"' + (RF.kind === k ? " selected" : "") + ">" + k + "</option>").join("") + '</select><select class="field" data-rf="verdict"><option value="">any verdict</option>' + ["GO", "TUNE", "RISK"].map(v => '<option value="' + v + '"' + (RF.verdict === v ? " selected" : "") + ">" + v + "</option>").join("") + "</select></div>";
    if (!printersOnly) { if (RF.kind) list = list.filter(r => r.kind === RF.kind); if (RF.verdict) list = list.filter(r => r.verdict === RF.verdict); }
    if (!list.length) return h + '<div class="sme-empty">' + (printersOnly ? "No printer tuning reviews yet - they come after the most-printed files." : "No reviews yet.") + "</div>";
    for (const r of list) {
      h += '<div class="sme-row' + (OPEN === r.id ? " on" : "") + '" data-open="' + esc(r.id) + '" data-kind="' + esc(r.kind) + '" data-key="' + esc(r.key) + '"><span class="sme-v ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span><span class="t">' + esc(r.name) + (r.kind === "family" ? ' <span class="sme-pill">family · ' + (r.members || []).length + " variants</span>" : ' <span class="sme-pill">' + esc(r.kind) + "</span>") + (r.from_lessons ? ' <span class="sme-pill">from lessons</span>' : "") + "</span>" +
        '<span class="sme-pill">' + esc(r.from_lessons ? "lessons" : "tier " + (r.tier || "?") + " · " + (r.model || r.reviewer || "")) + '</span><span class="sme-pill">' + esc(when(r.reviewed_at)) + '</span><span class="s">' + esc(r.summary) + (r.paths && r.paths.length > 1 ? " · " + r.paths.length + " paths" : "") + "</span>" +
        (OPEN === r.id && FULL ? '<div class="sme-panel" style="flex-basis:100%">' + renderReview(FULL, null) + "</div>" : "") + "</div>";
    }
    return h;
  }
  function renderLessons() {
    const L = LESSONS || { lessons: [], tags: [] };
    let h = renderProgress();
    h += '<div class="sme-note"><b>Lessons</b> are condition → fix pairs a review found once. They are handed to every later review as known solutions, confirmed when applied, and raised or lowered by what the printers then did with the files that used them.</div>';
    h += '<div class="sme-filters"><input class="field" data-lf="type" placeholder="printer type (u1, kobra-s1)" value="' + esc(LF.type) + '"><input class="field" data-lf="material" placeholder="material (PLA)" value="' + esc(LF.material) + '"><select class="field" data-lf="tag"><option value="">any tag</option>' + (L.tags || []).map(t => '<option value="' + esc(t) + '"' + (LF.tag === t ? " selected" : "") + ">" + esc(t) + "</option>").join("") + '</select><button class="btn ghost" data-lf-apply>Filter</button></div>';
    if (!L.lessons.length) return h + '<div class="sme-empty">No lessons yet.</div>';
    h += '<div class="sme-scroll"><table class="sme-table"><thead><tr><th>Condition</th><th>Finding → change</th><th>Confidence</th><th>Confirmed</th><th>Outcomes</th><th>Sources</th></tr></thead><tbody>';
    for (const x of L.lessons) {
      const sg = x.signature || {};
      h += '<tr><td class="k">' + esc(sg.printer_type) + " · " + esc(sg.material) + (sg.tag ? " · " + esc(sg.tag) : "") + (sg.setting_keys || []).map(k => "<br>" + esc(k.key + (k.equals != null ? " = " + k.equals : "") + (k.min != null ? " ≥ " + k.min : "") + (k.max != null ? " ≤ " + k.max : ""))).join("") + ((sg.geometry_flags || []).length ? "<br>" + esc((sg.geometry_flags || []).join(", ")) : "") + "</td>" +
        "<td>" + esc(x.finding) + (x.change && x.change.text ? '<br><span style="color:var(--signal)">' + esc(x.change.text) + "</span>" : "") + (x.change && x.change.orca ? '<br><code style="font-size:11px">' + esc(JSON.stringify(x.change.orca)) + "</code>" : "") + "</td>" +
        '<td class="v">' + esc(x.confidence) + '</td><td class="v">' + esc(x.times_confirmed) + '×</td><td class="k">' + esc(((x.evidence || {}).outcomes || {}).done || 0) + " done / " + esc(((x.evidence || {}).outcomes || {}).failed || 0) + ' failed</td><td class="k">' + esc(x.source === "family-outcomes" ? "family outcomes" : "review") + (x.source_reviews || []).slice(0, 3).map(s => "<br>" + esc(s.name || s.id)).join("") + "</td></tr>";
    }
    return h + "</tbody></table></div>";
  }
  async function onClick(e) {
    const c = e.target.closest("[data-copy]"); if (c) { const pre = EL.querySelector('pre[data-draft="' + CSS.escape(c.dataset.copy) + '"]'); if (pre) copyText(c, pre.textContent); return; }
    if (e.target.closest("[data-close]")) { OPEN = null; FULL = null; render(); return; }
    const t = e.target.closest("[data-smeview]"); if (t) { VIEW = t.dataset.smeview; OPEN = null; if (VIEW === "lessons" && !LESSONS) LESSONS = await jget("/api/sme/lessons?" + qs(LF)); render(); return; }
    if (e.target.closest("[data-lf-apply]")) { EL.querySelectorAll("[data-lf]").forEach(i => { LF[i.dataset.lf] = i.value.trim(); }); LESSONS = await jget("/api/sme/lessons?" + qs(LF)); render(); return; }
    const row = e.target.closest(".sme-row[data-open]"); if (!row || e.target.closest(".sme-panel")) return;
    if (OPEN === row.dataset.open) { OPEN = null; FULL = null; render(); return; }
    OPEN = row.dataset.open; FULL = await jget("/api/sme/reviews?kind=" + encodeURIComponent(row.dataset.kind) + "&key=" + encodeURIComponent(row.dataset.key)); render();
  }
  function onChange(e) { const t = e.target; if (t.dataset.rf != null) { RF[t.dataset.rf] = t.value; render(); } }

  // ---- Settings ----------------------------------------------------------------------------------------
  let SET = null;
  function buildSettings() {
    const host = document.getElementById("setModules"); if (!host || SET) return;
    SET = document.createElement("div"); SET.id = "setSme";
    SET.innerHTML = '<label class="fl" style="margin-top:18px">3D-printing SME <span class="hint" id="smeHint">fork</span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">A reviewer that runs <b>on this PC</b> as a scheduled task, not inside the Hub: <code>scripts/sme-runner.js</code> asks the Hub what to review next (most-printed gcode first, then print families, 3MFs, printers, then anything new or changed), runs <b>Claude Code headless on your own subscription</b> (<code>claude -p</code>, never the API key above), and posts the review back. The cheapest model that can do each job is used (haiku / sonnet / opus by difficulty), with one escalation when an answer is weak. What leaves this PC per review: the slicer settings from the file, its outcome history, what is loaded in the printers, a whitelisted summary of a printer\'s Klipper settings, the measured geometry of a 3MF and the knowledge-base excerpt - never a gcode body, a mesh or a printer address. Nothing is ever applied: drafts are shown for you to copy. Details: docs/sme.md.</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px; align-items:center"><span class="hint">runner token</span><code id="smeToken" style="font-size:11.5px; overflow-wrap:anywhere">…</code><button class="btn ghost" id="smeTokCopy" style="font-size:11px; padding:3px 8px">Copy</button></div>' +
      '<div class="hint" style="margin-top:6px; max-width:640px" id="smeHow"></div>';
    host.appendChild(SET);
    SET.querySelector("#smeTokCopy").addEventListener("click", async () => { const t = await jget("/api/sme/token"); if (t && t.token) copyText(SET.querySelector("#smeTokCopy"), t.token); });
    jget("/api/sme/token").then(t => { const c = SET.querySelector("#smeToken"); if (c) c.textContent = t && t.token ? t.token.slice(0, 6) + "…" + t.token.slice(-4) + " (header X-SME-Token)" : "no token (restart the Hub once)"; });
  }
  function paintSettings() {
    if (!SET || !STATUS) return;
    const s = STATUS, last = s.last_run, sch = s.schedule || {};
    SET.querySelector("#smeHint").textContent = (s.reviews || 0) + " reviews · " + (s.lessons || 0) + " lessons" + (s.paused_until ? " · paused until " + when(s.paused_until) : "");
    SET.querySelector("#smeHow").innerHTML = "<b>Run now:</b> <code>" + esc(sch.hourly || "node scripts/sme-runner.js") + "</code> (<code>--dry-run</code> to see what would be sent). <b>Schedule</b> (hourly reviews + a monthly knowledge refresh, as you, only while logged on): <code>" + esc(sch.install || "") + "</code>; add <code>-Uninstall</code> to remove, <code>-Status</code> to check. <b>Pause:</b> uninstall the schedule, or set <code>paused_until</code> in <code>sme-runner.json</code>. " +
      (last ? "<b>Last run</b> " + esc(when(last.finished_at || last.at)) + ": " + last.reviewed + " reviewed, " + (last.errors || 0) + " errors" + (last.knowledge && last.knowledge.updated ? " · knowledge refreshed " + esc(last.knowledge.updated) : "") + "." : "<b>No run recorded yet.</b>");
  }
  function relabel() {
    const box = document.getElementById("setFeatures"); if (!box) return;
    const i = box.querySelector('input[data-feat="sme"]'); const t = i && i.nextSibling;
    if (t && t.nodeType === 3 && t.textContent.trim() === "sme") t.textContent = " 3D-printing SME: scheduled reviews of files, families, 3MFs & printers (fork)";
  }

  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.sme === false) return;
    style(); buildSettings();
    const box = document.getElementById("setFeatures");
    if (box) { new MutationObserver(relabel).observe(box, { childList: true }); relabel(); }
    await refresh();
    setInterval(refresh, 5 * 60 * 1000);
    // the Models grid and the Projects view mount at module registration;
    // if either is not there yet (script order), look again shortly
    setTimeout(decorateAll, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.HubModules.register("sme", { tab: "SME", mount, onShow });
})();
