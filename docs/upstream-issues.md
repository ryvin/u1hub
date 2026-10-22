# Upstream issues found from the fork (not filed)

Bugs in dlgambill/u1hub code that the fork carries a minimal, marked
(`fork (ryvin/u1hub)`) touch point for. Each entry is ready to paste into an
upstream issue. When upstream ships a fix, drop the fork touch point in the
merge and delete the entry. Checked against upstream `origin/main` at
2.45.4 (`e08ffd2`) on 2026-10-21: neither is fixed there.

Fork checks for both: `node test/fork-ui-standalone.js`.

---

## 1. Desktop top bar overflows left, under the sidebar (Dash cannot be clicked)

**Where:** `public/index.html` inline CSS, `.topbar{display:flex; justify-content:flex-end; ...}` with no `flex-wrap`, and `.viewtabs{display:flex; margin-right:auto}`. `gold.css` only lets them wrap under `max-width:880px`.

**What happens:** above 880 px the top bar is a single nowrap row aligned to the
right. When the view tabs + version badge + update chip + FS Mixer + Settings
are wider than `.main` (capped at 980 px except on the four grid views at
≥1500 px), the negative free space overflows on the *start* side, i.e. to the
left, under the sticky 312 px sidebar. The Dash tab sits beneath the sidebar's
header and cannot be clicked (`elementFromPoint` at its centre returns `.side .head`),
and the shrunk gear buttons let the "update: v2.45.x" chip paint over
"FS Mixer".

**Reproduce:** stock 2.44.0/2.45.4 with all default features, window 1100 px
wide: Dash's left edge is at x≈243, the sidebar ends at 312. With three more
tabs (any extra client module that adds a tab) it happens at 1400 px too.

**Suggested fix (what the fork ships, in `gold.css`):**

```css
@media (min-width:881px){
  .topbar{flex-wrap:wrap; row-gap:8px;}
  .viewtabs{flex-wrap:wrap; row-gap:6px; min-width:0;}
}
```

Verified in Chromium at 1100, 1400 and 1920 px (every top-bar control
clickable, no horizontal scroll) and 390 px (phone layout unchanged).

---

## 2. A missing thumbnail is re-requested on every list re-render

**Where:** `public/app.js` `lazyImg()` (library and queue rows) and the printing
card's `cthumb` in `renderFleet()`.

**What happens:** `renderList()` runs on every `loadFiles()` and every
`loadPrinterFiles()` (each every 15 s) and `loadQueue()` re-renders the queue;
the fleet re-renders on each tick. Each render creates a fresh
`<img src=...>`. A URL that answered 404 has no cache entry (the 404 carries no
`Cache-Control`), so the browser asks again every time; `onerror` only hides
that one element. `THUMB_SEEN` makes it worse for the library: once a URL was
seen it is rendered with `src` directly instead of waiting for the observer.

**Measured:** three thumbless gcodes plus two printer-only files in the
library and one printing file without a thumbnail: 68 failed thumbnail
requests in 2 minutes (≈680 per 20 min; a user saw ≈520 per 20 min).

**Suggested fix (what the fork ships):** remember failed URLs for the page's
life and render them as a hidden placeholder without `src`. A new file version
has a new `?v=mtime` URL and is tried again.

```js
const THUMB_MISS = new Set();
function thumbMiss(img){ THUMB_MISS.add(img.getAttribute("src")); img.style.display="none"; }
function thumbTag(cls, url){
  return THUMB_MISS.has(url) ? `<img class="${cls}" alt="" style="display:none">`
    : `<img class="${cls}" loading="lazy" decoding="async" src="${url}" onerror="thumbMiss(this)">`;
}
// lazyImg: THUMB_MISS.has(url) -> thumbTag(); both branches use onerror="thumbMiss(this)"
// renderFleet: the cthumb <img> becomes ${thumbTag("cthumb", `/api/pthumb?...`)}
```

An alternative or complement on the server: send the `/api/thumb?v=` 404 with
a short `Cache-Control: max-age`, so the browser cache absorbs repeats.
