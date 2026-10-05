# multiace (fork module): Print via multiACE

A Snapmaker U1 has four heads. A file sliced with five or more colours (SnapmakerOrca
emits bare `T4`, `T5`, … with the stock four-extruder profile) cannot go through the
Hub's normal send: two different colours on one head is a hard reject unless the file
pauses for a roll swap (`core/print.js`, upstream #3). On a U1 that
[multiACE](https://github.com/decay71/multiACE) feeds from Anycubic ACE units, the
engine can swap a head's filament mid-print. This module lets the Hub use that.

Feature flag `multiace`. Ships **on**, off in Lite, and only *does* anything for a
printer that probes as multiACE. Settings → Features switches it; `config.json`
`"features": { "multiace": false }` too.

## What the Hub does, and what it leaves to the engine

The Hub never rewrites gcode for this route and never re-implements the engine
(`preflight_core.py`'s own header warns a port "silently drifts"). It drives the
printer's **own** preflight API and shows what comes back:

| Step | Call | What happens |
|---|---|---|
| probe | `GET <printer>/multiace/api/version`, `GET /printer/objects/query?ace` | 200 and `ace.api_version` with major 1 → the printer is multiACE. Cached 10 min (2 min after a miss). Nothing changes for any other printer. |
| check | `POST <printer>/multiace/api/preflight` (multipart, the ORIGINAL library file) | The engine analyses on the printer and answers a report: file colours, live slots, three plans. Writes only a temp file, prints nothing. |
| show | — | The card shows the mapping table (file colour → ACE/slot swatch, the engine's tier, a CIEDE2000 ΔE), a plan picker, and per plan: swaps, est. added time, est. purge top-up, the spool moves a proposed plan needs. |
| print | `POST /printer/gcode/script` (identity map), then `POST <printer>/multiace/api/preflight/print {token, mode, remap}` | After a confirm dialog. The engine remaps, rewrites (`ACE_SWAP_HEAD` + `ACE_SET_PURGE` stamps, auto-load block), uploads under the original name and **starts** (`print=true`). The Hub polls `/preflight/print/status`. |
| too big | 413 from `/api/preflight` → `POST /api/preflight/inbox` | The U1 analyses on its own CPU (cap `MULTIACE_PREFLIGHT_MAX_MB`, 110 by default). The same file goes to the inbox and the card links to `http://<printer>/multiace/`, where the browser runs the preflight. Nothing prints without a click there. |

The three plans mean different things, and the card says so:

- **As sliced** (`slicer`): the engine's tier-major match of each file colour onto the
  slots that are loaded (`exact_hex`, `name_*`, `fuzzy`, then same-material `fallback`,
  `duplicate`, `no_slot`). Prints with the spools where they are. A row can be reassigned
  (`remap`) and goes to the engine verbatim.
- **Optimize** / **Layer**: a *proposed loadout*. In multi mode the engine's rewrite for
  these modes derives the slot from the head assignment alone (`ace = per-head counter,
  slot = head`, `preflight_core.rewrite_pipeline`) and never consults the live slots.
  The mapping rows (`tier: planned`) therefore say where each colour **must sit**. The
  Hub lists those as moves ("black, now ACE 1 slot 2 → ACE 0 slot 0, displaces orange")
  and **refuses to start** such a plan until `livedata` shows every planned slot holding
  that material and colour (same hex, or ΔE ≤ 5). Moving a spool means also updating its
  slot label in multiACE / FilamentHub; "Re-check loadout" re-reads `livedata` without a
  new upload, and flags the as-sliced plan stale when the slots changed.

The Hub suggests moves and never makes them: it touches no slot, spool, label, mode or
`ace.cfg`, and sends no `ACE_*` command. The only gcode it sends is the identity map.

### Why the identity extruder map

The engine's rewrite relies on *synthetic T % 4 == head* and stock's default
`extruder_map_table` (nothing in `ace.py` or `main.py` sets `SET_PRINT_EXTRUDER_MAP`).
A previous Hub-mapped print leaves a non-identity table behind (live on davinci
2026-10-04: `reprint_info.extruder_map_table [3,2,1,3,…]`). So before the engine's
print POST the Hub sends, over Moonraker, the exact macros `core/print.js` already uses:

```
SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0   … for 0..3
SET_PRINT_USED_EXTRUDERS EXTRUDERS=<heads the plan uses>
```

and no `SET_PRINT_PREFERENCES` (the engine prepends its own, `FORCE=1`). The switch is
in Settings (on by default); the suite proves the commands land before the print POST.

### Estimates (Hub-side, labelled as estimates)

- **Added time** = the engine's swap count × `swap_seconds` (Settings, default 150 s,
  allowed 30–600; upstream's README says a swap takes "up to 3 minutes").
- **Purge top-up**: the engine stamps `ACE_SET_PURGE LENGTH=mm` before each swap with
  `mm = clamp(0.45 × flush_matrix[from][to] / 2.405, 40, 150)` from the file's own
  `flush_volumes_matrix` (raw mm³, `flush_multiplier` inherited upward only), on top of
  the slicer's wipe tower (`post_process_virtual_toolheads.py` 1546–1558, 1666–1677).
  The Hub walks the toolchange sequence the way `_real_swap_count` does, sums that per
  swap, and charges the engine default (80 mm) for a pair it cannot name (a head's first
  load). Grams = mm × 2.405 × density (the file's, else 1.24) / 1000. The Hub's own swap
  count is shown beside the engine's when they differ.
- **ΔE** per row is CIEDE2000 between the file hex and the slot hex, advisory; the
  engine's tier is the verdict (its fuzzy match is RGB distance ≤ 30).

### Refusals (before anything is uploaded)

409 for printer state, 400 for the file. Printer offline, printing or paused (the fleet
snapshot, so a stale page cannot bypass it), `swap_in_progress`, ACE not `ready`, **Air
Print Detection on** (multiACE needs it off; reported, never changed), mode not `multi`,
a manual head (`livedata` 409), engine `api_version` major ≠ 1. File: Full Spectrum,
already multiACE-processed (first 512 KB carry `; multiACE processed:` /
`; multiACE auto-load:` — send those with the stock Print button), no `; Change Tool`
or `; LAYER_CHANGE` markers, a used material that no slot holds, TPU/TPE, nozzle
diameters that differ between the file and the heads. The print step re-checks the
state ones against fresh reads.

## Costing and the SME

A print started through this route is recorded in `multiace.json` (plan, swaps,
`est_added_sec`, `purge_mm`, `purge_g`, heads, engine job id, started/error) and
published as `multiace.jobinfo(printer, file)`. `modules/costing.js` copies it onto the
ledger row as `row.multiace` and, because `est_minutes` is the fallback when no actual
duration exists, adds the estimated swap time to it (`est_source: "slicer+multiace"`).
Actual seconds already contain the swaps. Purge grams are recorded, not priced: the
slicer's per-slot grams already include wipe-tower purge (`parser.js`), and a top-up
priced twice would be worse than one shown once.

`multiace.loadout(printer)` (from caches, no network) gives the SME's printer brief a
`MULTIACE LOADOUT` section: every ACE slot with material and colour, which head it
feeds, Air Print state; a file's outcome history names prints that went via multiACE
with their plan, swaps and purge estimate.

## API

- `GET /api/multiace[?refresh=1]` → `{ enabled, fork, settings, plans, printers:[{id, name, multiace, reason, web, api_version, mode, device_count, link}] }`
- `POST /api/multiace/settings {swap_seconds, default_plan, identity_map}`
- `GET /api/multiace/loadout?printer=N[&refresh=1]` → live slots, head_ctx, head_source, Air Print, manual; 404 for a non-multiACE printer
- `POST /api/multiace/preflight {file, printer, type}` → `{ jobId, size, link }`; the job's `result` is `{ report, facts, link, default_plan }` or `{ tooBig, detail, inbox, link }`
- `POST /api/multiace/recheck {token}` → `{ live_slots, moves, stale_slicer }`
- `POST /api/multiace/print {printer, token, mode, remap?, bed_mesh?, camera?, flow_cal?}` → `{ jobId, swaps, est_added_sec, purge_g, heads }`; 409 `needsMoves` with the list
- `POST /api/multiace/inbox {file, printer, type}` → `{ jobId, link }`
- `GET /api/multiace/job?job=` → `{ phase, sent, total, done, error, result, engine:{stage, percent} }`
- `GET /api/multiace/sent` → the last 100 records

The report's `rows[mode]`, `estimates[mode]`, `moves[mode]` and `hub` are the Hub's
additions; everything else is the engine's report as it came.

## Contract (what the mock is built from)

Upstream `multiace/docs/ENGINE_API.md`, `LOADOUT_API.md`, `SEND_TO_MULTIACE.md` and the
web backend `main.py` / `preflight_core.py` at 1.20b-pre (2026-10-03), checked against
davinci's installed build with read-only GETs on 2026-10-04:

| Read on davinci (web `1.00.1b+f026fc15`) | Result |
|---|---|
| `GET /multiace/api/version` | 200 `{web, moonraker_url, config_path, frontend_dir, printer:{device_name, machine_type, firmware_version}}` |
| `GET /multiace/api/preflight/livedata` | 200 `{live_slots:[{ace, slot, material, color}] ×8, head_ctx:{mode:"multi", head_nozzles, head_ace, bg_available, …}}` |
| `GET /printer/objects/query?ace` | `api_version 1, status ready, mode multi, device_count 2, swap_in_progress false, airprint_detection false, head_source{0..3}, head_manual{…}` |
| `GET /multiace/api/preflight/inbox` | 200 `{pending:false, name:null, size:0, ts:0}` (inbox support present, ≥ 0.99.8b) |
| `GET /printer/objects/list` | `gcode_macro T4…` present (stock), `ace` objects present |

`test/mock-multiace.js` answers those shapes plus `POST /api/preflight` (413 above a
size, 409 for a processed file, else a report whose plans use the same swap walk as
`_real_swap_count`), `/api/preflight/print` + `/status`, and the inbox. It is a shape
mock, not the engine: its optimize/layer layouts are a deterministic toy.

## Verification record

Recorded in the commit that introduced the module: `test/multiace-standalone.js`
(pure estimators against Sharma's CIEDE2000 pairs and a hand-walked purge sum; the
booted Hub against a multiACE mock and a plain mock: probe gating by `api_version`,
report → card model, plan switching, the refusal matrix, identity map before the print
POST, 413 → inbox, ledger annotation, SME brief, Lite and config off), its falsified
run (`U1HUB_MULTIACE_FALSIFY=1` flips the busy refusal) going red, the sibling fork
suites, the full harness, `scripts/check-core.js`, `scripts/check-index-js.js`, and a
Playwright pass over the card flow on a throwaway Hub with the mocks.

**Still UNVERIFIED (needs the real printer, idle, and the owner's hand):**

1. The first real preflight: `POST http://192.168.1.136/multiace/api/preflight` with a
   library file (analysis only, prints nothing) — confirms the report shape on the
   installed `1.00.1b` build matches the 1.20b-pre source the mock follows (`plans`,
   `mapping[].tier`, `events`), and how it treats SnapmakerOrca's four per-extruder
   `nozzle_diameter` entries for a 5–7 filament file (`nozzles`, `nozzles_mixed`).
2. `_PREFLIGHT_MAX_SIZE` on davinci against the 20 MB library files (200 or 413).
3. The first real print via this route — **only the owner starts it**: a small 5-colour
   file, as-sliced plan, with the touchscreen watched. Confirms the identity map is
   accepted before the engine's own `SET_PRINT_PREFERENCES … FORCE=1`, that the engine
   uploads under the original name (the fleet poller, costing and the logbook key on
   it), real swap seconds (then set `swap_seconds` from `multiace_event` timestamps in
   klippy.log), and whether the purge top-up estimate is in the right range.
4. The installed multiACE **firmware** version (`MULTIACE_VERSION` in
   `/home/lava/klipper/klippy/extras/ace.py`; the web says 1.00.1b, upstream main is
   1.20b-pre) — SSH, idle only.
5. Whether a stale non-identity `extruder_map_table` really would reach a
   multiACE-started print without the Hub's identity map (the design sends it
   regardless).

## Manual fallback

Run upstream's post-processor on the PC as an Orca post-processing script
(`post_process_virtual_toolheads.py --layer --live-lookup 192.168.1.136`), then upload
the processed file through the multiACE web page or Fluidd. Such a file carries
`; multiACE processed:`; the Hub refuses it on this route on purpose and the stock
Print button would reject its two-colours-one-head mapping, so it goes to the printer
directly.
