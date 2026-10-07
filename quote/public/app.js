// quote/public/app.js — the public quote page. No framework, no inline code
// (the CSP allows only this file and Turnstile). Every server string reaches
// the page through textContent / attributes, never innerHTML.
// Flow: Turnstile -> upload (XHR, progress) -> /q/<token> -> poll while the
// Hub reads the model -> price, ready date, options (debounced) -> request
// (Turnstile again) -> status. The same page serves /q/<token> on reload.
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const S = { cfg: null, token: null, q: null, ts: { upload: null, request: null }, tok: { upload: null, request: null }, timer: null, pending: null, delArm: 0 };
  const usd = n => "$" + Number(n).toFixed(2);
  const CONF = { exact: "Based on a print we've made", good: "From your file's slicer data", rough: "Estimated from the shape - we'll confirm" };
  const STATUS = { new: "Requested - we'll reply by email.", quoted: "This is our price. We'll be in touch by email to go ahead.", accepted: "Accepted - we're on it.", declined: "We can't take this one, sorry.", closed: "Closed" };
  const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  async function api(path, init) {
    const r = await fetch(path, init); let b = null; try { b = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error((b && b.error) || "Something went wrong"), { status: r.status, paused: b && b.paused });
    return b;
  }
  function widget(slot, box) {
    const go = () => { S.ts[slot] = window.turnstile.render(box, { sitekey: S.cfg.siteKey, callback: t => { S.tok[slot] = t; }, "expired-callback": () => { S.tok[slot] = null; }, "error-callback": () => { S.tok[slot] = null; } }); };
    if (window.turnstile) return go();
    const iv = setInterval(() => { if (window.turnstile) { clearInterval(iv); go(); } }, 200);
  }
  // A Turnstile token is single-use: drop it and get a fresh challenge.
  const spent = slot => { S.tok[slot] = null; if (window.turnstile && S.ts[slot] != null) window.turnstile.reset(S.ts[slot]); };

  // ---- upload ----
  function upload(file) {
    const msg = $("upmsg");
    if (!/\.(stl|3mf)$/i.test(file.name)) { msg.textContent = "Please choose an .stl or .3mf file."; return; }
    if (file.size > S.cfg.maxMb * 1048576) { msg.textContent = "Files are limited to " + S.cfg.maxMb + " MB."; return; }
    if (!S.tok.upload) { msg.textContent = "Please complete the check below the box first."; return; }
    const x = new XMLHttpRequest();
    x.open("POST", "/upload");
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    x.setRequestHeader("X-Turnstile-Token", S.tok.upload);
    spent("upload");
    x.upload.onprogress = e => { if (e.lengthComputable) msg.textContent = "Uploading " + Math.round(e.loaded / e.total * 100) + " %"; };
    x.onload = () => {
      let b = null; try { b = JSON.parse(x.responseText); } catch {}
      if (x.status !== 200 || !b || !b.token) { msg.textContent = (b && b.error) || "Upload failed - please try again."; return; }
      S.token = b.token; history.replaceState(null, "", "/q/" + b.token);
      msg.textContent = "Reading your model…"; poll(Date.now());
    };
    x.onerror = () => { msg.textContent = "Upload failed - please check your connection."; };
    x.send(file);
  }
  async function poll(t0) {
    clearTimeout(S.timer);
    try {
      const q = await api("/api/q/" + S.token);
      if (q.phase === "analysing") {
        if (Date.now() - t0 > 120000) { $("upmsg").textContent = "This is taking longer than usual - reload this page in a minute."; return; }
        S.timer = setTimeout(() => poll(t0), 1500); return;
      }
      $("upmsg").textContent = ""; paint(q);
    } catch (e) { $("upmsg").textContent = e.status === 404 ? "This quote has expired. Upload the file again for a new one." : e.message; }
  }

  // ---- the quote ----
  function priceText(q) {
    if (q.final_price != null) return usd(q.final_price);
    if (q.error) return "We couldn't read this file";
    if (q.fits === false) return "Too big for our printers";
    if (q.price != null) return usd(q.price);
    if (q.price_low != null) return q.price_low === q.price_high ? usd(q.price_low) : usd(q.price_low) + " – " + usd(q.price_high);
    return "We'll price this one by hand";
  }
  function paint(q) {
    S.q = q;
    $("upload").hidden = q.status !== "quote";
    $("quote").hidden = false;
    $("price").textContent = priceText(q);
    const conf = $("conf");
    conf.textContent = q.final_price != null ? "Our quote for you" : (CONF[q.confidence] || "");
    conf.hidden = !conf.textContent;
    $("ready").textContent = q.ready_by ? "Ready by " + fmtDay(q.ready_by) : "";
    $("ready").hidden = !q.ready_by;
    const each = q.price != null && q.qty > 1 && q.each != null ? usd(q.each) + " each · " : "";
    $("valid").textContent = q.status === "quote" ? each + "Quote valid until " + fmtDay(q.valid_until) + "." + (q.confidence === "exact" ? "" : " We confirm the final price when you request it.") : "";
    const notes = [];
    if (q.error) notes.push(q.error + " Make sure it's a closed, solid model, or send it to us by email.");
    if (q.fits === false) notes.push("It doesn't fit on any of our printers in one piece. Request it anyway and we'll suggest options.");
    if (q.colour_changed) notes.push("The colour you picked just went out of stock, so we switched to " + q.colour + ".");
    if (q.files_deleted) notes.push("Your files are deleted.");
    $("note").hidden = !notes.length; $("note").textContent = notes.join(" ");
    $("ownernote").hidden = !q.notes_from_owner; $("ownernote").textContent = q.notes_from_owner || "";
    $("title").textContent = q.status === "quote" ? "Get a print quote" : "Your print quote";
    const editable = q.status === "quote" && !q.error;
    $("opts").hidden = !editable;
    $("reqform").hidden = q.status !== "quote";
    if (editable) paintOptions(q);
    const st = $("status");
    st.hidden = q.status === "quote";
    st.textContent = STATUS[q.status] || "";
    $("del").hidden = !!q.files_deleted;
  }
  function paintOptions(q) {
    const L = q.limits || {};
    $("qty").value = q.qty || 1;
    $("qty").max = L.qty_max || 100;
    const sw = $("swatches");
    sw.replaceChildren();
    if (q.multicolour) sw.appendChild(el("span", "fine", "Printed in its own colours"));
    else for (const p of L.palette || []) {
      const b = el("button", "sw" + (p.colour === q.colour && p.material === q.material ? " on" : ""));
      b.type = "button"; b.dataset.id = p.id; b.style.setProperty("--c", p.hex);
      b.title = p.material + " " + p.colour + (p.in_stock ? "" : " (out of stock)");
      b.setAttribute("aria-label", b.title); b.disabled = !p.in_stock;
      sw.appendChild(b);
    }
    if (!q.multicolour && q.colour) sw.appendChild(el("span", "fine swname", q.material + " · " + q.colour));
    document.querySelectorAll("[data-q]").forEach(b => { const on = b.dataset.q === q.quality; b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false"); });
    $("rush").checked = !!q.rush;
    $("rushlbl").textContent = "Rush ×" + (L.rush_multiplier || 1.5) + " - goes ahead of the queue";
  }
  function setOption(patch) {
    clearTimeout(S.pending);
    S.pending = setTimeout(async () => {
      try { paint(await api("/api/q/" + S.token + "/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })); }
      catch (e) { $("note").hidden = false; $("note").textContent = e.message; }
    }, 300);
  }

  // ---- wiring ----
  function wire() {
    const drop = $("drop"), file = $("file");
    file.addEventListener("change", () => { if (file.files.length) upload(file.files[0]); file.value = ""; });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer && e.dataTransfer.files.length) upload(e.dataTransfer.files[0]); });
    const qtyTo = n => { const max = Number($("qty").max) || 100, v = Math.max(1, Math.min(max, Math.round(Number(n) || 1))); $("qty").value = v; setOption({ qty: v }); };
    $("qminus").addEventListener("click", () => qtyTo(Number($("qty").value) - 1));
    $("qplus").addEventListener("click", () => qtyTo(Number($("qty").value) + 1));
    $("qty").addEventListener("change", () => qtyTo($("qty").value));
    $("swatches").addEventListener("click", e => { const b = e.target.closest("button[data-id]"); if (b && !b.disabled) setOption({ palette_id: b.dataset.id }); });
    document.querySelectorAll("[data-q]").forEach(b => b.addEventListener("click", () => setOption({ quality: b.dataset.q })));
    $("rush").addEventListener("change", () => setOption({ rush: $("rush").checked }));
    $("reqform").addEventListener("submit", async e => {
      e.preventDefault();
      const m = $("reqmsg");
      if (!S.tok.request) { m.textContent = "Please complete the check above the button first."; return; }
      const body = { name: $("name").value, email: $("email").value, notes: $("notes").value, turnstile: S.tok.request };
      $("reqbtn").disabled = true;
      const p = api("/api/q/" + S.token + "/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      spent("request");
      try { paint(await p); m.textContent = ""; } catch (err) { m.textContent = err.message; } finally { $("reqbtn").disabled = false; }
    });
    $("del").addEventListener("click", async () => {
      const b = $("del");
      if (Date.now() - S.delArm > 4000) { S.delArm = Date.now(); b.textContent = "Click again to delete your files"; return; }
      S.delArm = 0;
      try {
        await api("/api/q/" + S.token + "/delete", { method: "POST" });
        if (S.q && S.q.status === "quote") { $("quote").hidden = true; $("upload").hidden = false; history.replaceState(null, "", "/"); $("upmsg").textContent = "Your files are deleted."; S.token = null; }
        else { b.hidden = true; $("note").hidden = false; $("note").textContent = "Your files are deleted. Your request stays open."; }
      } catch (e) { b.textContent = e.message; }
    });
  }
  async function boot() {
    wire();
    try { S.cfg = await api("/api/config"); }
    catch (e) { $("upmsg").textContent = "Quotes are unavailable right now - please try again soon."; return; }
    $("maxmb").textContent = S.cfg.maxMb;
    widget("upload", $("ts-upload")); widget("request", $("ts-request"));
    const m = /^\/q\/([0-9a-f]{32})$/.exec(location.pathname);
    if (m) { S.token = m[1]; $("upmsg").textContent = "Loading your quote…"; poll(Date.now()); }
  }
  boot();
})();
