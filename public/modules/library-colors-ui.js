// public/modules/library-colors-ui.js — fork module (ryvin/u1hub), not upstream.
// Injected only when features["library-colors"] is on. No tab, two things on
// the library list:
//   * a row of color dots under each library file: the colors it needs, from
//     /api/library-palettes (the match module's endpoint, cached server-side by
//     size+mtime). If that endpoint is absent the list simply shows no dots.
//   * a "printable on" chip bar under the source filter: tick a printer and
//     the list keeps only library files whose every color sits within
//     MATCH_THRESHOLD of a distinct loaded head on it - the same greedy rule
//     the Match tab and the fleet cards use (core matchFile/loadedHeadList),
//     so all three agree.
// Nothing in core app.js is patched: the list is decorated after each render
// by a MutationObserver on #list, the way margin-ui.js watches the job card.
// Class names are lc-prefixed so they cannot restyle core (upstream's power
// row already owns .pdot).
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tparamSafe = () => (typeof window.tparam === "function" ? window.tparam() : "type=u1");

  let PALIDX = new Map();   // library file name -> [hex]
  let PRINTABLE = null;     // printer id the filter is set to, or null
  let LASTFILES = null;     // core FILES array the palettes were fetched for
  let FLEETNOW = [];
  let BARSIG = "";
  let OBS = null;

  function style() {
    if (document.getElementById("lccss")) return;
    const s = document.createElement("style");
    s.id = "lccss";
    s.textContent = [
      ".lcrow{margin-top:5px; display:flex; align-items:center; gap:4px;}",
      ".lcdot{width:11px; height:11px; border-radius:50%; border:1px solid var(--line); flex:none;}",
      ".lcn{font-family:var(--mono); font-size:9.5px; letter-spacing:.03em; color:var(--ink-faint); margin-left:3px;}",
      ".lcbar .lclead{font-family:var(--mono); font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); padding:2px 2px 2px 0;}",
      ".lcbar label.on{color:var(--signal); border-color:var(--signal);}",
      ".lchide{display:none !important;}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function currentFiles() { try { return FILES; } catch { return null; } }   // core's top-level let

  async function refreshPalIdx() {
    try {
      const r = await fetch("/api/library-palettes?" + tparamSafe(), { priority: "low" });
      if (!r.ok) return;
      const d = await r.json();
      PALIDX = new Map((d.files || []).map(f => [f.name, f.colors || []]));
      decorate(true);
    } catch {}
  }

  function printableOn(name, pid) {
    const colors = PALIDX.get(name); if (!colors || !colors.length) return false;
    const p = (FLEETNOW || []).find(x => x.id === pid); if (!p || !p.online) return false;
    if (typeof matchFile !== "function" || typeof loadedHeadList !== "function") return false;
    const m = matchFile(colors, loadedHeadList(p));
    return m.total > 0 && m.matched === m.total;
  }

  // Runs after every core renderList (observer) and after our own state
  // changes. The observer is paused while we write so we never see our own
  // mutations.
  function decorate(force) {
    const list = document.getElementById("list"); if (!list) return;
    const files = currentFiles();
    if (files && files !== LASTFILES) { LASTFILES = files; refreshPalIdx(); }
    if (OBS) OBS.disconnect();
    try {
      const old = list.querySelector(".lcempty"); if (old) old.remove();
      const rows = [...list.querySelectorAll(":scope > .job")];
      let visible = 0, libRows = 0;
      for (const b of rows) {
        const isLib = !b.classList.contains("onboard");
        const name = (b.querySelector(".jn") || {}).textContent || "";
        if (isLib) libRows++;
        if (isLib && (force || !b.dataset.lc)) {
          const had = b.querySelector(".lcrow"); if (had) had.remove();
          const pal = PALIDX.get(name) || [];
          if (pal.length) {
            const row = document.createElement("div");
            row.className = "lcrow"; row.title = pal.join(" ");
            row.innerHTML = pal.map(c => `<span class="lcdot" style="background:${esc(c)}"></span>`).join("") +
              `<span class="lcn">${pal.length} color${pal.length === 1 ? "" : "s"}</span>`;
            const jm = b.querySelector(".jm");
            if (jm) jm.after(row);
          }
          b.dataset.lc = "1";
        }
        const show = PRINTABLE === null || (isLib && printableOn(name, PRINTABLE));
        b.classList.toggle("lchide", !show);
        // the per-printer action strip, when open, is the row's next sibling
        const nx = b.nextElementSibling;
        if (nx && nx.classList.contains("actstrip")) nx.classList.toggle("lchide", !show);
        if (show) visible++;
      }
      if (PRINTABLE !== null && rows.length && !visible) {
        const pn = ((FLEETNOW || []).find(x => x.id === PRINTABLE) || {}).name || "that printer";
        const e = document.createElement("div");
        e.className = "empty-list lcempty";
        e.textContent = "Nothing in the library is printable on " + pn + " with the colors it has loaded right now.";
        list.appendChild(e);
      }
    } finally {
      if (OBS) OBS.observe(list, { childList: true });
    }
  }

  function renderBar() {
    const bar = document.getElementById("lcbar"); if (!bar) return;
    const online = (FLEETNOW || []).filter(p => p.online && (p.heads || []).some(h => h && h.loaded));
    if (PRINTABLE !== null && !online.some(p => p.id === PRINTABLE)) { PRINTABLE = null; decorate(); }
    const sig = online.map(p => p.id + ":" + p.name).join("|") + "#" + PRINTABLE;
    if (sig === BARSIG) return;
    BARSIG = sig;
    bar.innerHTML = "";
    if (!online.length) return;
    const lead = document.createElement("span"); lead.className = "lclead"; lead.textContent = "printable on"; bar.appendChild(lead);
    online.forEach(p => {
      const l = document.createElement("label"); l.className = PRINTABLE === p.id ? "on" : "off";
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = PRINTABLE === p.id;
      c.addEventListener("change", () => { PRINTABLE = c.checked ? p.id : null; BARSIG = ""; renderBar(); decorate(); });
      l.appendChild(c); l.appendChild(document.createTextNode(p.name));
      bar.appendChild(l);
    });
  }

  // Core's Settings feature list prints the raw key for anything it has no
  // label for; name the fork's flags there instead.
  const LABELS = {
    "printer-sync": "Copy new printer files into the library (fork)",
    "library-colors": "Library color dots & printable-on filter (fork)",
    bl2u1: "Convert to U1 via bl2u1 (fork)",
    timelapse: "Timelapse capture"
  };
  function relabelSettings(box) {
    for (const [k, txt] of Object.entries(LABELS)) {
      const i = box.querySelector(`input[data-feat="${k}"]`);
      const t = i && i.nextSibling;
      if (t && t.nodeType === 3 && t.textContent.trim() === k) t.textContent = " " + txt;
    }
  }

  function mount() {
    style();
    const src = document.getElementById("srcbar");
    if (src && !document.getElementById("lcbar")) {
      const bar = document.createElement("div");
      bar.className = "srcbar lcbar"; bar.id = "lcbar";
      bar.title = "Only files whose colors are all loaded on this printer right now";
      src.after(bar);
    }
    const list = document.getElementById("list");
    if (list) { OBS = new MutationObserver(() => decorate()); OBS.observe(list, { childList: true }); decorate(); }
    const box = document.getElementById("setFeatures");
    if (box) new MutationObserver(() => relabelSettings(box)).observe(box, { childList: true });
  }

  function onFleet(fleet) {
    FLEETNOW = Array.isArray(fleet) ? fleet : [];
    renderBar();
    if (PRINTABLE !== null) decorate();
  }

  window.HubModules.register("library-colors", { mount, onFleet });
})();
