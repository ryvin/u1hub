// public/modules/multiace-ui.js — "Print via multiACE" on the dashboard.
// Fork module (ryvin/u1hub), injected only when features.multiace is on.
// Server half: modules/multiace.js; the design: docs/multiace.md.
//
// Three places, no tab:
//   * Every printer card that probes as multiACE gets a loadout strip under
//     its four head swatches: one row per ACE, slot N under head T(N+1) (multi
//     mode: slot N feeds head N), the slot feeding each head outlined.
//   * When the selected file needs more than the heads can give (more than
//     four colours, or a colour no loaded head is close to) the card's stock
//     per-colour mapping rows and its Upload / Print buttons give way to the
//     multiACE block: Check with multiACE (the engine's own preflight, run on
//     the printer) -> the report as a mapping table with tiers and dE, a plan
//     picker (as sliced / optimize / layer) with swaps, est. added time and
//     est. purge top-up per plan, the spool moves a proposed plan needs
//     (suggested, never made), Print via multiACE behind a confirm dialog,
//     Send to inbox, and the link to the printer's multiACE page. A file that
//     fits the heads keeps the stock flow and offers the multiACE check as a
//     small link.
//   * Settings: seconds per swap, the default plan, the identity-map switch.
// Plus one line under the job card's meta once a report exists for the
// selected file. renderFleet() rebuilds every card on each poll, so the
// block is state in JS and re-inserted by a MutationObserver on #fleet, the
// way the cameras and the fork's other modules survive the rebuild.
"use strict";
(function () {
  if (window.HUB_FEATURES && window.HUB_FEATURES.multiace === false) return;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); const d = await r.json().catch(() => null); return { ok: r.ok, status: r.status, d }; } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d };
    } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }
  const typeSlug = () => (typeof window.activeType === "function" && window.activeType().slug) || "u1";
  const MATCH = 165;   // app.js MATCH_THRESHOLD, the same advisory "looks close" the head grid uses
  function dist(a, b) {
    if (typeof window.colorDist === "function") return window.colorDist(a, b);
    const h = x => { const m = /^#?([0-9a-f]{6})$/i.exec(String(x || "").trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const pa = h(a), pb = h(b); if (!pa || !pb) return 1e9;
    const rm = (pa[0] + pb[0]) / 2, dr = pa[0] - pb[0], dg = pa[1] - pb[1], db = pa[2] - pb[2];
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  const mins = s => { const m = Math.round((s || 0) / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min"; };
  const TIER = { exact_hex: "exact", name_exact: "by name", name_base: "by name", name_canon: "by name", fuzzy: "close", fallback: "fallback", duplicate: "shares a slot", no_slot: "no slot", planned: "proposed", copy: "copy" };
  const PLAN = { slicer: "As sliced", optimize: "Optimize", layer: "Layer" };
  const PLAN_HINT = { slicer: "prints with the spools exactly where they are", optimize: "fewest swaps, mid-layer swaps allowed; a proposed loadout", layer: "swaps only at layer changes; a proposed loadout" };

  function style() {
    if (document.getElementById("macecss")) return;
    const s = document.createElement("style");
    s.id = "macecss";
    s.textContent = [
      ".mace{display:flex; flex-direction:column; gap:8px; padding-top:10px; border-top:1px solid var(--line-soft);}",
      ".macehdr{display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-faint);}",
      ".macehdr a{margin-left:auto; color:var(--ink-faint); text-decoration:none; letter-spacing:0; text-transform:none; font-size:11px;}",
      ".macehdr a:hover{color:var(--signal);}",
      ".macegrid{display:grid; grid-template-columns:repeat(4,1fr); gap:6px;}",
      ".macerow{display:contents;}",
      ".macesw{position:relative; height:22px; border-radius:5px; border:1px solid rgba(255,255,255,.18); box-sizing:border-box;}",
      ".macesw.feed{box-shadow:0 0 0 2px var(--signal); border-color:var(--signal);}",
      ".macesw.empty{background:transparent; border-style:dashed; opacity:.5;}",
      ".macesw .macest{position:absolute; left:3px; bottom:2px; font-family:var(--mono); font-size:9px; line-height:1; color:#fff; background:rgba(0,0,0,.62); padding:1px 3px; border-radius:3px; pointer-events:none;}",
      ".macecap{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".macejob{display:flex; flex-direction:column; gap:8px;}",
      ".macemsg{font-size:12.5px; color:var(--ink-dim); line-height:1.5; overflow-wrap:anywhere;}",
      ".macemsg b{color:var(--ink);}",
      ".macemsg.err{color:var(--bad);}",
      ".macemsg.ok{color:var(--ok);}",
      ".macebtns{display:flex; gap:8px; flex-wrap:wrap; align-items:center;}",
      ".macebtns .btn{font-size:12px; padding:5px 11px;}",
      ".macebtns a.macelink{font-size:11.5px; color:var(--ink-faint); text-decoration:none;}",
      ".macebtns a.macelink:hover{color:var(--signal);}",
      ".maceplans{display:flex; gap:6px; flex-wrap:wrap;}",
      ".maceplan{font:inherit; font-size:11.5px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); background:var(--panel-2); color:var(--ink-dim); cursor:pointer;}",
      ".maceplan.on{border-color:var(--signal); color:var(--ink); box-shadow:0 0 0 1px var(--signal);}",
      ".maceplan:disabled{opacity:.45; cursor:not-allowed;}",
      ".maceest{font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); line-height:1.6; overflow-wrap:anywhere;}",
      ".maceest b{color:var(--ink);}",
      ".macetbl{display:flex; flex-direction:column; gap:5px;}",
      ".macetr{display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-family:var(--mono); font-size:11px; color:var(--ink-dim);}",
      ".macetr .fsw{width:18px; height:18px; border-radius:4px; border:1px solid rgba(255,255,255,.18); flex:none;}",
      ".macetr .fsw.none{background:transparent; border-style:dashed;}",
      ".macetr .macet{width:92px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}",
      ".macetr .macearrow{color:var(--ink-faint);}",
      ".macetier{font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid var(--line-soft); color:var(--ink-faint);}",
      ".macetier.good{color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, var(--line));}",
      ".macetier.warn{color:var(--busy,#f0c33c); border-color:color-mix(in srgb, var(--busy,#f0c33c) 40%, var(--line));}",
      ".macetier.bad{color:var(--bad); border-color:color-mix(in srgb, var(--bad) 40%, var(--line));}",
      ".macede{color:var(--ink-faint);}",
      ".macemoves{font-size:12px; color:var(--ink-dim); line-height:1.55; padding:8px 10px; border:1px dashed color-mix(in srgb, var(--busy,#f0c33c) 50%, var(--line)); border-radius:var(--r-sm,6px);}",
      ".macemoves b{color:var(--ink);}",
      ".macemoves .msw{display:inline-block; width:11px; height:11px; border-radius:3px; border:1px solid rgba(255,255,255,.25); vertical-align:-1px; margin-right:3px;}",
      ".macebar{height:5px; background:var(--panel-2); border-radius:3px; overflow:hidden;}",
      ".macebar i{display:block; height:100%; background:var(--signal); transition:width .2s;}",
      ".macemodal .modalbox{max-width:620px;}",
      ".macemodal .macesum{display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:13px; margin:10px 0;}",
      ".macemodal .macesum .k{font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); padding-top:2px;}",
      ".macemodal .macechk{font-size:12px; color:var(--ink-dim); line-height:1.6; margin:8px 0;}",
      ".macemodal .macefoot{display:flex; gap:8px; justify-content:flex-end; margin-top:12px;}",
      ".maceline{display:none; margin-top:6px; font-family:var(--mono); font-size:11.5px; line-height:1.7; color:var(--ink-dim);}",
      ".maceline.show{display:block;}",
      ".maceline b{color:var(--ink);}",
      "@media (max-width:400px){ .macegrid{grid-template-columns:repeat(2,1fr);} .macetr .macet{width:70px;} }"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- state ----------------------------------------------------------------------------
  let INFO = null;                 // GET /api/multiace
  const LOADOUT = new Map();       // pid -> { at, d }
  const JOB = new Map();           // pid|file -> { phase, plan, report, facts, link, msg, pct, moves, live, stale, job, result, forced }
  const FORCED = new Set();        // pids where the person asked for multiACE on a file that fits the heads
  const key = (pid, file) => pid + "|" + file;
  const stateFor = (pid, file) => { const k = key(pid, file); if (!JOB.has(k)) JOB.set(k, { phase: "idle", plan: (INFO && INFO.settings.default_plan) || "optimize" }); return JOB.get(k); };
  const printerInfo = pid => (INFO && INFO.printers.find(p => p.id === pid)) || null;
  const fleetOf = pid => (window.FLEET || []).find(p => p.id === pid) || null;

  async function loadInfo(refresh) {
    const r = await jget("/api/multiace" + (refresh ? "?refresh=1" : ""));
    if (r.ok && r.d) { INFO = r.d; paintSettings(); decorate(); }
  }
  async function loadLoadout(pid, refresh) {
    const hit = LOADOUT.get(pid);
    if (hit && !refresh && Date.now() - hit.at < 20000) return hit.d;
    const r = await jget("/api/multiace/loadout?printer=" + pid + (refresh ? "&refresh=1" : ""));
    LOADOUT.set(pid, { at: Date.now(), d: r.ok ? r.d : null });
    decorate();
    return r.ok ? r.d : null;
  }

  // ---- what the selected file needs ----------------------------------------------------
  function need() { const m = window.MAP; return m && Array.isArray(m.palette) ? m.palette.filter(s => s.used) : []; }
  function needsMultiace(pid) {
    const m = window.MAP, fe = fleetOf(pid);
    if (!window.SELECTED || !m || m.isFS || !fe) return false;
    const n = need(); if (!n.length) return false;
    if (FORCED.has(pid)) return true;
    const heads = (fe.heads || []).filter(h => h && h.loaded);
    if (n.length > (m.physicalHeads || 4)) return true;
    return n.some(c => !heads.some(h => h.hex && c.hex && dist(c.hex, h.hex) < MATCH));
  }

  // ---- render ---------------------------------------------------------------------------
  function loadoutHtml(pid, lo) {
    if (!lo) return '<div class="macecap">reading the ACE loadout…</div>';
    if (lo.manual) return '<div class="macecap">a head is in manual bypass - multiACE cannot place colours</div>';
    const feeding = {}; for (const [h, src] of Object.entries(lo.head_source || {})) if (src && src.ace_index != null) feeding[src.ace_index + "," + src.slot] = Number(h);
    const n = Math.max(1, lo.device_count || 1);
    let rows = "";
    for (let a = 0; a < n; a++) {
      rows += '<div class="macerow">';
      for (let s = 0; s < 4; s++) {
        const slot = (lo.live_slots || []).find(x => x.ace === a && x.slot === s);
        const f = feeding[a + "," + s];
        if (!slot) rows += '<span class="macesw empty" title="ACE ' + a + ' slot ' + s + ' · empty or unlabelled"><span class="macest">A' + a + '</span></span>';
        else rows += '<span class="macesw' + (f != null ? " feed" : "") + '" style="background:' + esc(slot.color) + '" title="ACE ' + a + ' slot ' + s + ' · ' + esc(slot.material) + ' ' + esc(slot.color) + (f != null ? ' · feeding T' + (f + 1) : "") + '"><span class="macest">A' + a + '</span></span>';
      }
      rows += "</div>";
    }
    const mats = [...new Set((lo.live_slots || []).map(s => s.material).filter(Boolean))];
    return '<div class="macegrid">' + rows + '</div><div class="macecap">' + (lo.live_slots || []).length + ' slots across ' + n + ' ACE' + (n === 1 ? "" : "s") + (mats.length ? ' · ' + esc(mats.join(", ")) : "") + (lo.airprint_detection ? ' · <span style="color:var(--bad)">Air Print Detection ON</span>' : "") + '</div>';
  }
  function rowsHtml(st, mode) {
    const rows = (st.report.rows || {})[mode] || [];
    if (!rows.length) return "";
    return '<div class="macetbl">' + rows.map(r => {
      const cls = r.tier === "exact_hex" ? "good" : (/^name_|fuzzy|planned/.test(r.tier) ? "" : (r.tier === "fallback" || r.tier === "duplicate" ? "warn" : "bad"));
      return '<div class="macetr"><span class="fsw" style="background:' + esc(r.hex || "#3a3f49") + '"></span><span class="macet" title="P' + (r.t + 1) + ' ' + esc(r.hex) + ' ' + esc(r.material) + '">P' + (r.t + 1) + ' ' + esc(r.hex) + ' ' + esc(r.material) + '</span><span class="macearrow">→</span>' +
        (r.slot_hex ? '<span class="fsw" style="background:' + esc(r.slot_hex) + '"></span><span>ACE ' + r.ace + ' · slot ' + r.slot + '</span>' : '<span class="fsw none"></span><span>no slot</span>') +
        '<span class="macetier ' + cls + '">' + esc(TIER[r.tier] || r.tier) + '</span>' + (r.dE != null ? '<span class="macede" title="CIEDE2000 between the file colour and the slot colour (advisory; the tier is the engine\'s verdict)">ΔE ' + r.dE.toFixed(1) + '</span>' : "") + '</div>';
    }).join("") + "</div>";
  }
  function movesHtml(moves, slicerSwaps, planSwaps) {
    if (!moves || !moves.length) return "";
    const saved = slicerSwaps != null && planSwaps != null ? slicerSwaps - planSwaps : null;
    return '<div class="macemoves"><b>Move ' + moves.length + ' spool' + (moves.length === 1 ? "" : "s") + ' first</b>' + (saved != null && saved > 0 ? ' to save ' + saved + ' swap' + (saved === 1 ? "" : "s") + ' vs as sliced' : "") + ' - the Hub never moves anything; after moving, update the slot label in multiACE / FilamentHub and re-check.<br>' +
      moves.map(m => '<span class="msw" style="background:' + esc(m.hex) + '"></span>' + esc(m.hex) + ' ' + esc(m.material) + (m.from ? ' (now ACE ' + m.from.ace + ' slot ' + m.from.slot + ')' : ' (not loaded)') + ' → <b>ACE ' + m.to.ace + ' slot ' + m.to.slot + '</b>' + (m.displaces ? ' <span style="color:var(--ink-faint)">(displaces ' + esc(m.displaces.color) + ')</span>' : "")).join("<br>") + "</div>";
  }
  function estHtml(st, mode) {
    const e = (st.report.estimates || {})[mode];
    if (!e || !e.feasible) return '<div class="maceest">not feasible' + (e && e.reason ? ": " + esc(e.reason) : "") + "</div>";
    return '<div class="maceest"><b>' + e.swaps + '</b> swap' + (e.swaps === 1 ? "" : "s") + ' ≈ <b>+' + mins(e.est_added_sec) + '</b> · purge top-up ≈ <b>' + e.purge_g + ' g</b> (' + e.purge_mm + ' mm' +
      (e.pairs_known || e.pairs_default ? '; ' + e.pairs_known + ' pair' + (e.pairs_known === 1 ? "" : "s") + ' from the flush matrix, ' + e.pairs_default + ' engine default' : "") + ') · ' + e.swap_seconds + ' s per swap' + (e.sim_swaps !== e.swaps ? ' · Hub walk counts ' + e.sim_swaps : "") + '</div>';
  }
  function jobHtml(pid, st, fe, fits) {
    const pi = printerInfo(pid) || {}, lo = (LOADOUT.get(pid) || {}).d;
    const n = need();
    const link = st.link || pi.link;
    const head = (lo && !lo.manual) ? ('Needs <b>' + n.length + '</b> colour' + (n.length === 1 ? "" : "s") + ' · <b>' + esc(fe.name) + '</b> holds ' + (lo.live_slots || []).length + ' across ' + (lo.device_count || 1) + ' ACE' + ((lo.device_count || 1) === 1 ? "" : "s")) : ('Needs <b>' + n.length + '</b> colour' + (n.length === 1 ? "" : "s"));
    const linkA = link ? '<a class="macelink" href="' + esc(link) + '" target="_blank" rel="noopener" title="The printer\'s own multiACE page (LAN only)">multiACE page ↗</a>' : "";
    const inboxBtn = '<button class="btn ghost" data-mace="inbox" data-pid="' + pid + '" title="Hand the original file to the printer\'s multiACE inbox; its web page finishes the preflight in the browser">Send to inbox</button>';
    if (st.phase === "idle") return '<div class="macemsg">' + head + (fits ? ' · <span style="color:var(--ink-faint)">this file fits the heads; the stock Print works too</span>' : "") + '</div><div class="macebtns"><button class="btn primary" data-mace="check" data-pid="' + pid + '">Check with multiACE</button>' + inboxBtn + linkA + (fits ? '<a class="macelink" href="#" data-mace="unforce" data-pid="' + pid + '">back to the stock mapping</a>' : "") + '</div>';
    if (st.phase === "checking") return '<div class="macemsg">' + esc(st.msg || "Working…") + '</div><div class="macebar"><i style="width:' + (st.pct || 0) + '%"></i></div>';
    if (st.phase === "inbox") return '<div class="macemsg ' + (st.err ? "err" : "ok") + '">' + esc(st.msg || "") + '</div><div class="macebtns">' + linkA + '<button class="btn ghost" data-mace="reset" data-pid="' + pid + '">Back</button></div>';
    if (st.phase === "error") return '<div class="macemsg err">' + esc(st.msg || "failed") + '</div><div class="macebtns"><button class="btn ghost" data-mace="reset" data-pid="' + pid + '">Try again</button>' + inboxBtn + linkA + '</div>';
    if (st.phase === "printing") return '<div class="macemsg">' + esc(st.msg || "Starting…") + '</div><div class="macebar"><i style="width:' + (st.pct || 0) + '%"></i></div>';
    if (st.phase === "done") return '<div class="macemsg ok">' + esc(st.msg || "Started") + '</div><div class="macebtns"><button class="btn ghost" data-mace="reset" data-pid="' + pid + '">OK</button></div>';
    // report
    const rep = st.report, mode = st.plan, plans = rep.plans || {}, est = rep.estimates || {};
    const missing = rep.missing_materials || [];
    let h = '<div class="macemsg">' + head + ' · ' + (rep.slicer_colors || []).length + ' colour' + ((rep.slicer_colors || []).length === 1 ? "" : "s") + ' matched' + (rep.nozzles_mixed ? ' · <span style="color:var(--bad)">mixed nozzles</span>' : "") + '</div>';
    if (missing.length) h += '<div class="macemsg err">No loaded slot holds ' + esc(missing.join(", ")) + ' - load it, then check again.</div>';
    h += '<div class="maceplans">' + ["slicer", "optimize", "layer"].map(m => { const p = plans[m]; const ok = p && p.feasible; return '<button class="maceplan' + (m === mode ? " on" : "") + '" data-mace="plan" data-pid="' + pid + '" data-plan="' + m + '"' + (ok ? "" : " disabled") + ' title="' + esc(PLAN_HINT[m] + (ok ? "" : (p && p.reason ? " - " + p.reason : " - not feasible"))) + '">' + PLAN[m] + (ok ? ' · ' + p.swaps + ' swap' + (p.swaps === 1 ? "" : "s") : "") + '</button>'; }).join("") + '</div>';
    h += estHtml(st, mode);
    h += rowsHtml(st, mode);
    const moves = (st.moves || rep.moves || {})[mode] || [];
    h += movesHtml(moves, plans.slicer && plans.slicer.feasible ? plans.slicer.swaps : null, plans[mode] ? plans[mode].swaps : null);
    if (st.stale) h += '<div class="macecap">the loadout changed since this check; the as-sliced plan is stale - run the check again before printing it</div>';
    const canPrint = plans[mode] && plans[mode].feasible && !moves.length && !missing.length && !(st.stale && mode === "slicer");
    h += '<div class="macebtns"><button class="btn primary" data-mace="print" data-pid="' + pid + '"' + (canPrint ? "" : " disabled") + '>Print via multiACE</button>' + (moves.length || st.stale ? '<button class="btn ghost" data-mace="recheck" data-pid="' + pid + '">Re-check loadout</button>' : "") + inboxBtn + linkA + '<a class="macelink" href="#" data-mace="reset" data-pid="' + pid + '">discard</a></div>';
    return h;
  }

  function decorate() {
    const fleet = document.getElementById("fleet");
    if (!fleet || !INFO) return;
    style();
    for (const pi of INFO.printers) {
      if (!pi.multiace) continue;
      const st = document.getElementById("pst-" + pi.id), card = st && st.closest(".pcard");
      if (!card || card.querySelector(".mace")) continue;
      const fe = fleetOf(pi.id);
      if (!fe || !fe.online) continue;
      const busy = fe.state === "printing" || fe.state === "paused";
      const lo = LOADOUT.get(pi.id);
      if (!lo || Date.now() - lo.at > 30000) loadLoadout(pi.id, false);
      const block = document.createElement("div");
      block.className = "mace";
      block.dataset.pid = String(pi.id);
      let html = '<div class="macehdr"><span>multiACE' + (pi.web ? ' · ' + esc(pi.web.replace(/\+.*$/, "")) : "") + '</span>' + (pi.link ? '<a href="' + esc(pi.link) + '" target="_blank" rel="noopener">open ↗</a>' : "") + '</div>' + loadoutHtml(pi.id, lo && lo.d);
      const file = window.SELECTED;
      const wants = !busy && file && needsMultiace(pi.id);
      const fits = wants && FORCED.has(pi.id) && !(need().length > ((window.MAP || {}).physicalHeads || 4));
      if (wants) {
        const s = stateFor(pi.id, file);
        html += '<div class="macejob">' + jobHtml(pi.id, s, fe, fits) + '</div>';
        card.querySelectorAll(".cmap, .foot button[data-id]").forEach(el => { el.style.display = "none"; });
        const foot = card.querySelector(".foot");
        if (foot && !foot.querySelector(".macefootnote")) { const n = document.createElement("span"); n.className = "macefootnote macecap"; n.textContent = "stock send hidden: this job goes through multiACE"; foot.prepend(n); }
      } else if (!busy && file && need().length && !(window.MAP || {}).isFS) {
        html += '<div class="macecap"><a href="#" data-mace="force" data-pid="' + pi.id + '" style="color:inherit">check with multiACE instead</a> (this file fits the heads)</div>';
      }
      block.innerHTML = html;
      const heads = card.querySelector(".heads"), foot = card.querySelector(".foot");
      if (heads) heads.insertAdjacentElement("afterend", block); else if (foot) foot.insertAdjacentElement("beforebegin", block); else card.appendChild(block);
    }
    paintLine();
  }
  function rerender(pid) { const b = document.querySelector('.mace[data-pid="' + pid + '"]'); if (b) b.remove(); const c = document.querySelector('.pcard .macefootnote'); if (c) c.remove(); decorate(); }

  // ---- actions --------------------------------------------------------------------------
  async function poll(jobId, onTick) {
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const r = await jget("/api/multiace/job?job=" + encodeURIComponent(jobId));
      if (!r.ok) return { error: (r.d && r.d.error) || "status poll failed" };
      if (onTick) onTick(r.d);
      if (r.d.done) return r.d;
    }
  }
  async function check(pid) {
    const file = window.SELECTED; if (!file) return;
    const st = stateFor(pid, file);
    st.phase = "checking"; st.msg = "Starting…"; st.pct = 0; rerender(pid);
    const r = await jpost("/api/multiace/preflight", { file, printer: pid, type: typeSlug() });
    if (!r.ok) { st.phase = "error"; st.msg = (r.d && r.d.error) || ("HTTP " + r.status); rerender(pid); return; }
    st.link = r.d.link;
    const d = await poll(r.d.jobId, j => {
      if (j.phase === "upload" && j.total) { st.pct = Math.min(100, Math.round(j.sent / j.total * 100)); st.msg = "Uploading to the printer " + st.pct + "%" + (st.pct >= 100 ? " · analysing on the printer…" : ""); }
      else if (j.phase === "inbox") { st.msg = "Too big for the printer's preflight - handing it to the inbox…"; }
      rerender(pid);
    });
    if (d.error && !(d.result && d.result.tooBig && d.result.inbox)) { st.phase = "error"; st.msg = d.error; rerender(pid); return; }
    if (d.result && d.result.tooBig) {
      st.phase = "inbox"; st.err = !d.result.inbox;
      st.msg = d.result.inbox ? "Too big for the printer's on-board preflight (" + d.result.detail.replace(/\..*$/, "") + "). The file is in the multiACE inbox: open the multiACE page to finish the check in your browser; nothing prints until you confirm there." : "Too big for the printer's preflight, and the inbox refused it: " + (d.result.inboxError || "");
      rerender(pid); return;
    }
    st.report = d.result.report; st.facts = d.result.facts; st.moves = d.result.report.moves; st.stale = false;
    const dp = d.result.default_plan || st.plan, plans = st.report.plans || {};
    st.plan = plans[dp] && plans[dp].feasible ? dp : (["optimize", "layer", "slicer"].find(m => plans[m] && plans[m].feasible) || "slicer");
    st.phase = "report"; rerender(pid);
  }
  async function recheck(pid) {
    const st = stateFor(pid, window.SELECTED); if (!st.report) return;
    const r = await jpost("/api/multiace/recheck", { token: st.report.token });
    if (!r.ok) { st.phase = "error"; st.msg = (r.d && r.d.error) || "re-check failed"; rerender(pid); return; }
    st.moves = r.d.moves; st.stale = !!r.d.stale_slicer; st.report.live_slots = r.d.live_slots;
    LOADOUT.delete(pid); rerender(pid);
  }
  async function inbox(pid) {
    const file = window.SELECTED; if (!file) return;
    const st = stateFor(pid, file);
    st.phase = "checking"; st.msg = "Sending to the multiACE inbox…"; st.pct = 0; rerender(pid);
    const r = await jpost("/api/multiace/inbox", { file, printer: pid, type: typeSlug() });
    if (!r.ok) { st.phase = "error"; st.msg = (r.d && r.d.error) || ("HTTP " + r.status); rerender(pid); return; }
    st.link = r.d.link;
    const d = await poll(r.d.jobId, j => { if (j.total) { st.pct = Math.min(100, Math.round(j.sent / j.total * 100)); st.msg = "Sending to the inbox " + st.pct + "%"; rerender(pid); } });
    st.phase = "inbox"; st.err = !!d.error;
    st.msg = d.error ? "The inbox refused it: " + d.error : "In the multiACE inbox (one slot, newest wins). Open the multiACE page: it runs the preflight in your browser and nothing prints until you confirm there.";
    rerender(pid);
  }
  function confirmDialog(pid, st) {
    return new Promise(resolve => {
      const fe = fleetOf(pid) || {}, mode = st.plan, rep = st.report, e = (rep.estimates || {})[mode] || {}, rows = (rep.rows || {})[mode] || [];
      const lo = (LOADOUT.get(pid) || {}).d || {};
      let m = document.getElementById("macemodal");
      if (!m) { m = document.createElement("div"); m.id = "macemodal"; m.className = "modal macemodal"; document.body.appendChild(m); }
      m.innerHTML = '<div class="modalbox"><div class="modalhdr"><span>Print via multiACE on ' + esc(fe.name || "") + '</span><button class="modalx" data-x="1" title="Close">×</button></div>' +
        '<div class="macesum"><span class="k">file</span><span>' + esc(window.SELECTED) + '</span><span class="k">plan</span><span>' + esc(PLAN[mode]) + ' · ' + esc(PLAN_HINT[mode]) + '</span>' +
        '<span class="k">swaps</span><span><b>' + e.swaps + '</b> ≈ +' + mins(e.est_added_sec) + ' (' + e.swap_seconds + ' s each)</span><span class="k">purge</span><span>≈ ' + e.purge_g + ' g top-up (' + e.purge_mm + ' mm) on top of the wipe tower</span>' +
        '<span class="k">colours</span><span>' + rows.map(r => '<span class="msw" style="display:inline-block;width:11px;height:11px;border-radius:3px;border:1px solid rgba(255,255,255,.25);vertical-align:-1px;background:' + esc(r.hex) + '"></span>' + esc(r.hex) + ' → ACE ' + r.ace + ' slot ' + r.slot + ' <span style="color:var(--ink-faint)">' + esc(TIER[r.tier] || r.tier) + '</span>').join("<br>") + '</span></div>' +
        '<div class="macechk">Starts at once - the engine uploads with print=true; there is no upload-only path.<br>Air Print Detection: ' + (lo.airprint_detection ? '<span style="color:var(--bad)">ON - multiACE needs it off</span>' : '<span style="color:var(--ok)">off</span>') +
        '<br>Identity extruder map (T→T) is sent first' + (INFO && INFO.settings && INFO.settings.identity_map === false ? ' <span style="color:var(--bad)">(switched off in Settings)</span>' : "") + '.<br>Fitted the larger purge bin? Every swap flushes into it.</div>' +
        '<div class="macefoot"><button class="btn ghost" data-x="1">Cancel</button><button class="btn primary" data-go="1">Print</button></div></div>';
      const close = v => { m.classList.remove("show"); m.onclick = null; resolve(v); };
      m.onclick = ev => { if (ev.target === m || ev.target.closest("[data-x]")) close(false); else if (ev.target.closest("[data-go]")) close(true); };
      m.classList.add("show");
    });
  }
  async function print(pid) {
    const st = stateFor(pid, window.SELECTED); if (!st.report) return;
    if (!(await confirmDialog(pid, st))) return;
    const mode = st.plan;
    st.phase = "printing"; st.msg = "Sending the identity extruder map…"; st.pct = 5; rerender(pid);
    const r = await jpost("/api/multiace/print", { printer: pid, token: st.report.token, mode });
    if (!r.ok) {
      if (r.d && r.d.needsMoves) { st.phase = "report"; st.moves = { ...(st.moves || st.report.moves || {}), [mode]: r.d.moves }; rerender(pid); return; }
      st.phase = "error"; st.msg = (r.d && r.d.error) || ("HTTP " + r.status); rerender(pid); return;
    }
    const d = await poll(r.d.jobId, j => {
      if (j.phase === "identity") { st.msg = "Sending the identity extruder map…"; st.pct = 5; }
      else if (j.phase === "engine") { const en = j.engine || {}; st.pct = 10 + Math.round((en.percent || 0) * 0.9); st.msg = "multiACE is rewriting and uploading" + (en.stage ? " · " + en.stage : "") + " " + Math.round(en.percent || 0) + "%"; }
      rerender(pid);
    });
    if (d.error) { st.phase = "error"; st.msg = d.error; rerender(pid); return; }
    st.phase = "done"; st.msg = "Printing on " + d.result.printer + " via multiACE · " + PLAN[mode] + " · " + d.result.swaps + " swap" + (d.result.swaps === 1 ? "" : "s") + " ≈ +" + mins(d.result.est_added_sec) + " · ~" + d.result.purge_g + " g purge";
    rerender(pid);
    if (typeof window.loadFleet === "function") window.loadFleet();
  }

  function onClick(e) {
    const t = e.target.closest("[data-mace]"); if (!t) return;
    const pid = Number(t.dataset.pid), act = t.dataset.mace;
    if (t.tagName === "A") e.preventDefault();
    if (act === "check") check(pid);
    else if (act === "inbox") inbox(pid);
    else if (act === "print") print(pid);
    else if (act === "recheck") recheck(pid);
    else if (act === "plan") { const st = stateFor(pid, window.SELECTED); st.plan = t.dataset.plan; rerender(pid); }
    else if (act === "reset") { JOB.delete(key(pid, window.SELECTED)); rerender(pid); }
    else if (act === "force") { FORCED.add(pid); rerender(pid); }
    else if (act === "unforce") { FORCED.delete(pid); JOB.delete(key(pid, window.SELECTED)); rerender(pid); }
  }

  // ---- job card line ---------------------------------------------------------------------
  let LINE = null;
  function paintLine() {
    const meta = document.getElementById("jmeta"); if (!meta) return;
    if (!LINE) { LINE = document.createElement("div"); LINE.className = "maceline"; LINE.id = "maceline"; meta.insertAdjacentElement("afterend", LINE); }
    const file = window.SELECTED;
    const parts = [];
    if (file && INFO) for (const pi of INFO.printers) {
      const st = JOB.get(key(pi.id, file)); if (!st || !st.report) continue;
      const e = (st.report.estimates || {})[st.plan]; if (!e || !e.feasible) continue;
      parts.push('<span>multiACE · <b>' + esc(pi.name) + '</b>: ' + esc(PLAN[st.plan]) + ' · <b>' + e.swaps + '</b> swap' + (e.swaps === 1 ? "" : "s") + ' ≈ +' + mins(e.est_added_sec) + ' · ~' + e.purge_g + ' g purge</span>');
    }
    LINE.innerHTML = parts.join('<span style="color:var(--ink-faint)">  ·  </span>');
    LINE.className = "maceline" + (parts.length ? " show" : "");
  }

  // ---- Settings -------------------------------------------------------------------------
  let SET = null;
  function buildSettings() {
    const host = document.getElementById("setModules");
    if (!host || SET) return;
    SET = document.createElement("div");
    SET.id = "setMultiace";
    SET.innerHTML = '<label class="fl" style="margin-top:18px">multiACE <span class="hint" id="maceHint"></span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">A printer that answers <code>/multiace/api/version</code> and carries an <code>ace</code> object with engine api_version 1 gets a loadout strip and, for a file that needs more than its four heads, "Check with multiACE": the printer\'s own preflight analyses the original file and the card shows its mapping, the plans and what each would cost in swaps, time and purge. Printing goes through the engine (it uploads and starts); the Hub only sends the identity extruder map first. Spool moves are suggested, never made.</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px; align-items:center">' +
      '<span class="hint">seconds per swap</span><input class="field" id="maceSwap" type="number" min="30" max="600" step="5" style="max-width:100px" title="Estimate only: upstream says a swap takes up to 3 minutes">' +
      '<span class="hint">default plan</span><select class="field" id="macePlan" style="max-width:150px"><option value="optimize">Optimize</option><option value="layer">Layer</option><option value="slicer">As sliced</option></select>' +
      '<label class="hint" style="display:flex; align-items:center; gap:5px"><input type="checkbox" id="maceId"> send identity extruder map first</label>' +
      '<button class="btn ghost" id="maceSave">Save</button><span class="pstatus" id="maceMsg"></span></div>';
    host.appendChild(SET);
    SET.querySelector("#maceSave").addEventListener("click", async () => {
      const r = await jpost("/api/multiace/settings", { swap_seconds: SET.querySelector("#maceSwap").value, default_plan: SET.querySelector("#macePlan").value, identity_map: SET.querySelector("#maceId").checked });
      const m = SET.querySelector("#maceMsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      if (INFO) INFO.settings = r.d;
      paintSettings(); m.className = "pstatus ok"; m.textContent = "Saved. Estimates on open reports refresh on the next check.";
    });
  }
  function paintSettings() {
    if (!SET || !INFO) return;
    const s = INFO.settings || {};
    SET.querySelector("#maceSwap").value = s.swap_seconds;
    SET.querySelector("#macePlan").value = s.default_plan;
    SET.querySelector("#maceId").checked = s.identity_map !== false;
    const on = INFO.printers.filter(p => p.multiace);
    SET.querySelector("#maceHint").textContent = on.length ? on.map(p => p.name + " (" + (p.web || "").replace(/\+.*$/, "") + ")").join(", ") : "no printer answers as multiACE";
  }

  function init() {
    style();
    buildSettings();
    const fleet = document.getElementById("fleet");
    if (fleet) { new MutationObserver(() => decorate()).observe(fleet, { childList: true }); fleet.addEventListener("click", onClick); }
    const jt = document.getElementById("jt");
    if (jt) new MutationObserver(() => { document.querySelectorAll(".mace").forEach(b => b.remove()); document.querySelectorAll(".macefootnote").forEach(b => b.remove()); decorate(); }).observe(jt, { childList: true, characterData: true, subtree: true });
    loadInfo(false);
    setInterval(() => loadInfo(false), 60000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
