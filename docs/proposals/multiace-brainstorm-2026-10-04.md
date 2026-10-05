# Sending a >4-colour job to davinci through multiACE — brainstorm + design

Read-only research, 2026-10-04. Nothing was edited, restarted or sent to a printer.
snapdragon was printing (71 %) and was touched only with one `GET /printer/objects/list`;
davinci was `standby` and was read with small GETs only.

Scratch copies of everything read live or fetched upstream are in
`/tmp/claude-1000/-mnt-e-Code-u1hub/28174693-d8e3-41e8-979b-5eac95ef85d1/scratchpad/`
(`davinci/` = live config + state, `upstream/` = decay71/multiACE main @ 1.20b-pre).

Citation shorthand: `pp.py` = `upstream/post_process_virtual_toolheads.py`,
`pf.py` = `upstream/preflight_core.py`, `main.py` = `upstream/main.py` (web backend),
`ace.py` = `upstream/ace.py` (22 683 lines), `cfg` = `davinci/extended_ace.cfg`
(the file installed on davinci, fetched via `/server/files/config/extended/ace.cfg`).

---

## 0. The premise correction that changes everything

**The local `/mnt/e/Code/multiACE` checkout is two generations behind what davinci runs.**

| Thing | Version | Evidence |
|---|---|---|
| Local repo `/mnt/e/Code/multiACE` | **0.80b** (`multiace/VERSION`), README/CLAUDE.md say 0.81b | no `ACE_SWAP_HEAD` anywhere in its `ace.py` (3 174 lines); README calls in-print purge "future feature" |
| Installed on davinci | web **`1.00.1b+f026fc15`**, firmware 1.5.2 | `GET /multiace/api/version` (live) |
| Upstream `decay71/multiACE` main | **1.20b-pre** (pushed 2026-10-03); releases v1.11b 2026-09-29, v1.10b 2026-09-27 | `gh api repos/decay71/multiACE` + `multiace/VERSION`; `ace.py:19 MULTIACE_VERSION = "1.20b-pre"` |

Everything the user asked for — virtual tools T4..T15, in-print swaps, a preflight that maps
file colours to ACE slots — exists **only in the upstream line (≥0.99.8b)**, and davinci's installed
build already exposes that API (`/multiace/api/preflight/livedata` and `/multiace/api/preflight/inbox`
both answer 200 on davinci today). So the Hub feature must be designed against **upstream's
published contract** (`multiace/docs/ENGINE_API.md`, `LOADOUT_API.md`, `SEND_TO_MULTIACE.md`),
not against the local fork's `ace.py`/`multiace_web/`. The local fork's web console
(`multiace_web/src/multiace_web/server.py`: `/api/state`, `/api/command`, …) is **not** what answers
on davinci (its version string and route set are upstream's).

Exact installed **firmware** version is UNVERIFIED (the `ace` status object does not carry it);
see §5.

---

## 1. How multiACE actually works on davinci today

### 1.1 Hardware / topology (live)

- 2 × ACE Pro (protocol v1), `ace_device_count: 2` (`cfg:4`), `enable_ace_v2: true` (`cfg:5`), active device 1.
  Live: `GET /printer/objects/query?ace` → `device_count: 2, active_device: 1, mode: "multi", api_version: 1`.
- **`multi` mode = slot N of every ACE feeds head N through a splitter** (upstream README "ACE Connection
  Overview" diagram; `LOADOUT_API.md §4`: "Slot N feeds head N, across all units"). A colour can only
  reach head 2 if it sits in slot 2 of *some* ACE. With 2 ACEs each head has exactly **2** candidate spools.
- Live loadout (`GET /multiace/api/preflight/livedata`, all PLA, identity source `override` =
  `extended/multiace/slot_overrides.json`):

  | | slot 0 | slot 1 | slot 2 | slot 3 |
  |---|---|---|---|---|
  | ACE 0 | #fc8200 orange | #ffb282 peach (Polymaker) | #0f6b2e green | #1436c8 blue |
  | ACE 1 | #f55a7c pink **(T0 now)** | #631313 dark red **(T1 now)** | #000000 black **(T2 now)** | #ffffff white **(T3 now)** |

  `head_source` (ace_vars.cfg `ace__head_source`, mirrored in the `ace` object): heads 0–3 are
  currently fed from ACE 1 slots 0–3. `head_manual` all false. `head_nozzles` all 0.4
  (`livedata.head_ctx.head_nozzles`). `bg_available: true, bg_heads: []`.
- The Hub today sees only the 4 heads, via `print_task_config.filament_color_rgba`
  (`core/fleet.js:14-50 decodeHeads`): `GET localhost:4545/api/fleet` → davinci heads
  `#F55A7C, #631313, #000000, #FFFFFF`. The other four spools are invisible to the Hub.

### 1.2 How a swap is triggered in gcode

- The in-print command is **`ACE_SWAP_HEAD HEAD=<0..3> ACE=<0..3> [SLOT=n] [ANTI_OOZE=mm] [INITIAL=1]`**
  (`ENGINE_API.md §3`; implementation `ace.py:20063 cmd_ACE_SWAP_HEAD`). It unloads the head's current
  filament back into its ACE and loads the same-numbered slot of the target ACE. It is a **no-op when
  the head already holds that ACE/slot** (`ace.py:20151-20156`). It refuses manual heads, "ghost" heads
  (filament at sensor but no `head_source`), and an unavailable ACE (`ace.py:20100-20148`).
- The slicer never emits `ACE_SWAP_HEAD`. It emits bare **`T4..T15`**. Two ways to turn those into swaps:
  1. **Post-processor** `pp.py` (same engine the web preflight runs, `pf.py:1-30`): `rewrite()` (`pp.py:7-94`)
     rewrites `M104/M109 … T≥4` to `T{n%4}`, drops `SM_PRINT_PREEXTRUDE_FILAMENT INDEX≥4`, and expands each
     body `T<n>` (n≥4) into `T{n%4}` + `ACE_SWAP_HEAD HEAD={n%4} ACE={n//4} SLOT={n%4}` (`pp.py:33-38`).
     A later return to `T<h>` after that head was swapped gets a swap-back to ACE 0 (`pp.py:60-70`).
     Before that, `match_colors_to_slots()` (`pp.py:380`) builds a remap *slicer-T → synthetic-T
     (ace×4+slot)* so each file colour lands on the slot that physically holds it; `apply_remap`
     (`pp.py:2918`) rewrites the body first.
  2. **Manual**: insert `ACE_SWAP_HEAD HEAD=0 ACE=1` at a layer via Orca's custom-gcode-at-layer
     (upstream README "Option 1").
- Processed files get a header block (`pp.py:4113-4174 inject_auto_load_to_file`):
  ```
  ; multiACE auto-load: load N head(s)
  ; multiACE processed: format=4          (PP_FORMAT_VERSION, pp.py:1448)
  ACE_SET_PURGE RESET=1
  ACE_SWAP_HEAD HEAD=h ACE=a SLOT=s INITIAL=1   (one per used head)
  ; multiACE auto-load: end
  ```
  and `ACE_SET_PURGE LENGTH=<mm>` stamps before each body swap (`pp.py:3717`). At print start
  `ace.py:4271 _sniff_print_gcode_loads` reads the first 512 KB for those markers; a file already carrying
  them is **refused for re-processing** (`pf.py:947 build_report` → `PreflightRejected`, HTTP 409;
  `SEND_TO_MULTIACE.md` rule 1).
- **Nothing in multiACE touches the stock logical→physical map.** `grep SET_PRINT_EXTRUDER_MAP` finds
  nothing in `ace.py` or `main.py`. The engine relies on *synthetic T % 4 == head* and stock's default
  identity `extruder_map_table`. See risk R4.

### 1.3 Timing, purge, waste

- Lengths/speeds installed (`cfg:106-113`): `feed_speed 80`, `retract_speed 30`, `retract_length 1950`,
  `load_length 2100`; mid-print `swap_retract_length 900` (`cfg:141`), `swap_purge_length 0`
  (= stock 80 mm, `ENGINE_API.md` ACE_SET_PURGE), `purge_matrix: true` (`cfg:147`),
  `swap_default_temp 250` (`cfg:140`), `load_retry 3 / extrusion_retry 7 / unload_retry 3`.
  Tip forming per material: `[ace_tipform] mode: custom, pla: unloadtemp:220` (cfg tail).
- Nominal mechanics of one swap: 900 mm retract @ 30 mm/s ≈ 30 s + tip-form + heat + 2100 mm load
  @ 80 mm/s ≈ 26 s (sensor-stopped) + seat + flush 40–150 mm + retries. **Upstream README: "a single
  colour swap at up to 3 minutes … every change adds directly to print time"**; SME KB says the same
  (`sme/core/knowledge.md:109`). Parked/background swaps are head-mode only and experimental
  (`[ace_bg_swap]` section is commented out on davinci, `cfg:470+`; README "Parked position
  background swaps … not possible in multi mode with Ace hardware").
- Purge per pair (`pp.py:1545-1558, 1666 _matrix_purge_mm`):
  `mm = clamp(0.45 × flush_matrix[from][to] (mm³) / 2.405, 40, 150)` — a **top-up on top of the
  slicer's wipe tower** (which already purges the matrix volume). Grams ≈ `mm × 2.405 × density / 1000`
  (100 mm PLA ≈ 0.30 g). A flat 80 mm × 28 swaps ≈ 6.7 g; README reports the matrix saving
  "~110 g + ~1.5–2 h" on a long multi-colour print vs flat purging.
- Upstream README "Fit a larger purge bin"; KB `knowledge.md:112` already says "fit the larger purge bin".

### 1.4 Failure modes (from code and README)

- Load/unload fails → resumable **pause** with recovery steps (`ace.py:20166 _pause_for_recovery`;
  README "it recovers to a pause if it fails"). Events on `gcode_response`: `multiace_event
  swap_imminent / slot_ready / swap_done / swap_failed` with `status` tag (`ENGINE_API.md §5`).
- Print-start guard aborts loudly on a corrupt `head_source` (two heads on one slot, or slot≠head in multi)
  (`ace.py:4360-4420`). Stale `head_source` with no filament is cleared; filament with no source = ghost.
- **Air Print Detection must be off** (README Known Limitations; live `airprint_detection: false`).
  "Don't turn off automatic load in display". Unload all after install/upgrade.
- Stock "head-twin replenish" **rewrites `extruder_map_table` mid-print** on runout (`ace.py:1746`
  comment); multiACE's own `quad_replenish` is off on davinci (`cfg`, live `quad_replenish: false`).
- Local 0.81b README: feed-assist only on the start ACE and cross-ACE entangle false positives; upstream
  says lifted "v0.82+". Whether 1.00.1b still has the limitation: UNVERIFIED (R8).
- TPU/TPE: Normal Mode or a manual head (`ACE_SET_HEAD_MANUAL`); a manual head makes
  `livedata` answer **409** and disables slot matching (`LOADOUT_API.md §1`, `pp.py:4383`).

---

## 2. What a >4-colour U1 gcode looks like, and what multiACE needs

### 2.1 Real files in the Hub library (`/mnt/e/Code/u1hub/gcode`)

`GET localhost:4545/api/library-palettes` → 500 files, **7 with >4 colours** (6 "Starry Night"
switchplate variants with 7 colours, "Cube" 6-colour FS, "gato fuego" 5 colours).

`gato fuego_Front_160x160_PLA_3h2m.gcode` (12.9 MB):
```
; filament_colour = #000000;#FF0000;#FFFF00;#FFFFFF;#FF8000       (5 entries)
; filament_type   = PLA;PLA;PLA;PLA;PLA
; nozzle_diameter = 0.4,0.4,0.4,0.4                                 (4 = per EXTRUDER, not per filament)
; flush_volumes_matrix = 0,500,753,…  (5×5)      ; flush_multiplier = 1
; Change Tool1 -> Tool4 (layer 12)
M109 S220 T4
M400
T4
SM_PRINT_PREEXTRUDE_FILAMENT INDEX=4
```
`[U1-HF] Van Goghs starry night … 3h15m.gcode` (20.5 MB): 7 colours, body `T0..T6`, 7×7 flush
matrix, **0 pauses**, `printer_settings_id = Snapmaker U1 (0.4 nozzle) - HueForge`. The
`[HF-Pause-…]` / `[PAUSE]` siblings carry pauses — those are the user's current *stock* workflow
(swap the roll at an M600, Hub issue #3 path).

So: **SnapmakerOrca already emits bare `T4..Tn` for >4 filaments with the stock 4-extruder U1
profile.** No slicer profile with N extruders is needed. `parser.js:4-9` documents this ("T<n> is a
LOGICAL palette index"); `parseGcodeMap` reads all 7 colours (`parser.js:257`) and marks used ones by
grams > 0.

### 2.2 What stock firmware does with `T4` (both U1s, no ACE needed)

`gcode_macro T4..T31` = `SWITCH_OF_EXTENDED_EXTRUDER INDEX=n` exist on **snapdragon too** (one
`objects/list` read; snapdragon has no `ace` objects), and `print_task_config.extruder_map_table` has
**32 entries** (live davinci: `[0,1,2,3,0,0,…]`, `reprint_info.extruder_map_table: [3,2,1,3,…]`).
The Hub writes that table with `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=<t> MAP_EXTRUDER=<h>`
(`core/print.js:213`). Inference (UNVERIFIED, R5): `SWITCH_OF_EXTENDED_EXTRUDER INDEX=n` switches to
physical head `extruder_map_table[n]`, and a roll swap on that head only happens if the file pauses.

### 2.3 What the Hub does with such a file today

- UI: `defaultMapping` (`public/app.js:797-817`) greedily maps needed colours to nearest free loaded
  head; colours left over fall back to the first loaded head (`app.js:1958`); the card says
  "4/4 heads loaded · ~4 of 7 colors look close" (`app.js:1934-1940`).
- Server `/api/print` (`core/print.js:109-227`): two *different* colours on one head → `countPauses()`
  (`print.js:65-73`, counts `M600|M0|M1|M226|PAUSE`) → **400 hard reject** with no pause
  (`print.js:161`), or **409 confirm** with pauses (`print.js:158-160`, upstream fix 2.23.1 for
  dlgambill/u1hub#3). A multiACE-processed file has `ACE_SWAP_HEAD`, not `M600`, so **today it would
  be hard-rejected** — and even if let through, the Hub's non-identity `SET_PRINT_EXTRUDER_MAP` would
  fight the engine's slot==head assumption (R4).
- Nothing in core/modules/public knows about ACE (`grep -ril multiace core modules public` → only
  `core/network.js`, `core/config.js` hits are unrelated strings; the SME KB `knowledge.md:108-113`
  is the only real mention).

### 2.4 What multiACE needs the file to contain

From `pf.py:70 parse_meta`, `pf.py:1064 rewrite_pipeline`, `pp.py:96 parse_toolchanges`:
- `; filament_colour` / `; filament_type` per filament (used for matching; material is **never**
  substituted, `pp.py:300-316, 420-430`).
- `; Change Tool X -> Tool Y` comments (the "source of truth" for toolchanges, `pp.py:96-110`); a
  multi-colour file with neither those nor `; LAYER_CHANGE` is refused (`pf.py:1085-1098`).
- `; flush_volumes_matrix` + `; flush_multiplier` for per-pair purge (`pp.py:1565-1664`); without a
  matrix no stamps (engine default purge).
- `M73` lines for bg-window look-ahead (head mode only).
- Optional per-filament `; nozzle_diameter` (`LOADOUT_API.md §3`) — SnapmakerOrca writes 4
  per-extruder entries; uniform 0.4 on davinci so harmless (R9).
- Must be the **original export** (no `; multiACE processed:` marker).

Post-processing **is** needed (bare `T4` would go to stock's `SWITCH_OF_EXTENDED_EXTRUDER`, not to
the ACE). The repos checked have no post-processor of their own: `OrcaSlicer-FullSpectrum` only
distinguishes physical vs logical extruders (`src/libslic3r/GCode.cpp:3780
unique_extruder_count_for_gcode`); `bl2u1` produces N-filament 3MFs ("Unlimited Colors … swap
filament between colors", README) — upstream of this problem; `FilamentHub` has a "virtual ACE grid"
UI and a plugin that mirrors FilamentHub spools into `slot_overrides.json` labels
(`multiACE/multiace_plugins/filamenthub`, label-only). `Mnemonic3D/Snapmaker-U1-Orca-MultiACE-edition`
is "earlier experimental builds" and is pivoting to its own firmware (README) — not a dependency to
take.

---

## 3. Design options

| | (a) Hub-side mapper + gcode rewrite | (b) Hub drives multiACE's own preflight API (recommended) | (c) Slicer-profile route, Hub only validates |
|---|---|---|---|
| What | Re-implement `pp.py` in JS: match colours→slots, rewrite T4+→swaps, auto-load block, purge stamps, upload via existing `uploadWithProgress` | Hub uploads the **original** file to `POST <davinci>/multiace/api/preflight`, shows the engine's report (mapping tiers, plans, swap counts) on the job card, lets the user pick plan/remap, then `POST /api/preflight/print {token, mode, remap}` and polls `/api/preflight/print/status` | Keep Orca as is (it already emits T4+); user runs `pp.py` as an Orca post-processing script (`--layer --live-lookup 192.168.1.136`); Hub only validates the processed file and sends it with an identity map |
| Pros | Full Hub control (progress bar, job id, queue, filament memory); no Python on printer path | **Zero drift**: the numbers and the rewrite are the engine's, same bytes as the multiACE UI; format=4 stamps, anti-ooze, flow-cal relocation (`main.py:1358-1395`, issue #115) all handled; LAN-only, no auth; `api_version` gate; GPL arm's-length by HTTP (`ENGINE_API.md §1`) | Smallest Hub change; works with huge files (runs on the PC) |
| Cons | 4 600-line engine with hardware-paid lessons (`pp.py:1374-1448` comments) duplicated; `pf.py` header explicitly warns a JS port "silently drifts"; licence (GPL-3 code re-expressed) | On-printer analysis has a size cap (`_PREFLIGHT_MAX_SIZE`, `main.py:1282`; README "130–180 MB files … failing") — the 20 MB library files are probably fine, UNVERIFIED (R3); `print=true` starts immediately (no "upload only"); Hub cannot inject gcode between rewrite and start | User must run Python on the PC per slice; the Hub still has to teach `/api/print` that `ACE_SWAP_HEAD` files are legal and force the identity map; mapping is decided at slice time against a loadout that may change (`LOADOUT_API.md §7` argues against this) |
| Verdict | reject | **adopt** | keep as the documented manual fallback |

Option (b) variants: **(b1)** the Hub only POSTs to the inbox (`/api/preflight/inbox`) and links to
the multiACE UI — trivial but the Hub shows nothing useful; **(b2)** full drive as above. Recommend
**(b2) with (b1) as the automatic fallback** when the printer answers 413, and with the manual (c)
documented. A later (b3): run the engine locally in the Hub container by fetching the printer's own
sources from `GET /multiace/api/preflight/pysrc` (`main.py:1658`) — version-exact, no vendoring —
only if the user wants big files without opening the multiACE UI (needs python3 in the image, R7).

---

## 4. Recommended design: fork feature module `multiace`

### 4.1 Where it shows up (UI)

Dashboard printer card for any printer that **probes as multiACE** (module-level capability, cached
10 min like SME: `GET <url>/multiace/api/version` 200 **and** `objects/query?ace` has `api_version`):

1. **Loadout strip** under the 4 head swatches: a 2×4 grid "ACE 0 / ACE 1" from
   `livedata.live_slots`, head-column aligned (slot N under T{N+1}), the currently feeding spool
   outlined (from `ace.head_source`). Mirrors FilamentHub's grid idiom.
2. When the selected file needs >4 colours (or any colour not on the 4 heads) and the printer is
   multiACE: replace the normal `.cmap` mapping rows (`app.js:1949-1990`) with **"Print via multiACE"**
   block:
   - headline: `needs 7 colours · davinci has 8 loaded across 2 ACEs (all PLA)`
   - table, one row per file colour: swatch + `P<n> #hex PLA` → ACE/slot swatch chosen by the engine
     (`report.plans[mode].mapping[].t/ace/slot`, with the **tier** `exact_hex / name_* / fuzzy /
     fallback / duplicate / no_slot` from `pp.py:380-520`) → **ΔE** (CIEDE2000 computed in the Hub
     from the two hexes; advisory only — the engine's tier is the truth; the Hub's current
     weighted-RGB `colorDist` at `app.js:784` with threshold 165 and multiACE's RGB-euclid ≤30
     (`pf.py:36 DEFAULT_FUZZY`) will disagree at the margins, so show both honestly)
   - plan picker: `as sliced` / `layer (fewest swaps)` / `optimize (mid-layer)` with
     **swaps = N**, **est. added time ≈ N × swap_seconds** (setting, default 150 s, range 90–180;
     README "up to 3 minutes"), **est. purge top-up ≈ Σ clamp(0.45·M[a][b]/2.405, 40, 150) mm → g**
     computed by the Hub from the file's flush matrix along the plan's swap sequence
   - a "move spools" note when the engine's recommended loadout differs from what is loaded
     (`pp.py:3063 print_recommendation` / optimize plan) — never auto-moved
   - buttons: **Print via multiACE** (primary) · **Send to multiACE inbox** (hand-off) ·
     link `http://192.168.1.136/multiace/`
3. Job card SME badge line: "multiACE: 7 swaps ≈ +18 min, +4 g purge" once the report is cached.
4. Settings → Features: `multiace` toggle; card with `swap_seconds`, default plan, "verify identity
   extruder map before start" (on).

No bare `.main` class; client code lives in `public/modules/multiace-ui.js` and injects into the job
card like `advisor-ui.js` / `margin-ui.js` already do (`core/app.js:85,87`).

### 4.2 Validation (server, before anything is uploaded)

Refuse (400 with the reason) unless all hold:

| Check | Source |
|---|---|
| printer `state` ∈ {standby, complete, cancelled, error-idle}; `ace.swap_in_progress === false`; `ace.status === "ready"` | fleet snapshot + `objects/query?ace` |
| `ace.api_version === 1` (gate on major) | `ENGINE_API.md §6` |
| `ace.mode === "multi"` (head mode: pass through to the engine but mark untested) | live `mode` |
| `livedata` not 409 (no manual head) | `LOADOUT_API.md §1` |
| `airprint_detection === false` | README Known Limitations |
| file is not FS (`parser.isFS`) — FS blends need fixed physical heads (`parser.js:66-70`) | parser |
| file not already processed (`; multiACE processed:` / `; multiACE auto-load:` in first 512 KB) — else offer "send as-is with identity map" | `pp.py:1450 detect_processed` |
| every `filament_type` present in some `live_slots[].material` (case-insensitive) | `pp.py:299 check_material_availability` |
| no `TPU`/`TPE` type (route to Normal Mode / manual head instead) | README Q&A, KB `knowledge.md:72` |
| heads' `head_nozzles` all equal the file's `nozzle_diameter` | `LOADOUT_API.md §3` |
| needed ACE indices ≤ `device_count-1` | live |
| file has `; Change Tool` or `; LAYER_CHANGE` markers | `pf.py:1085` |
| optional: free-space on printer (`/server/files/…` not needed by the engine; it uploads itself) | — |

### 4.3 How the mapping reaches the printer

```
Hub                                   davinci (multiACE web, nginx /multiace/)        Klipper
POST /api/multiace/preflight ──▶ POST /multiace/api/preflight (multipart file) ──▶ report {token, plans, live_slots, missing_materials}
  (stream the library file; same uploadWithProgress shape, core/print.js:30)
user picks plan / edits a row ──▶ remap {slicerT: ace*4+slot}
POST /api/multiace/print      ──▶ 1) SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=i MAP_EXTRUDER=i (i=0..3)   ──▶ Moonraker gcode/script
                                  2) SET_PRINT_USED_EXTRUDERS EXTRUDERS=<heads used by the plan>
                                  3) POST /multiace/api/preflight/print {token, mode, remap, bed_mesh, camera, flow_cal}
                                     → engine: apply_remap → rewrite → inject_auto_load → prepend
                                       SET_PRINT_PREFERENCES … FORCE=1 → Moonraker upload print=true
GET /api/multiace/print-status ──▶ GET /multiace/api/preflight/print/status?job_id ──▶ {stage, percent, done, error}
```
Steps 1–2 are the identity-map insurance against a stale non-identity table (R4); they reuse the exact
macros `core/print.js:213-216` already sends. Step 3's body is `_PreflightPrint` (`main.py:1583-1606`).
The processed file lands in the printer's `gcodes` root under the original name; `hub.invalidatePrinterFiles()`
afterwards (as `print.js:210`). The fleet poller then sees `print.started` as usual, so costing/logbook/
notify work unchanged.

Fallbacks: 413 from `/api/preflight` → `POST /api/preflight/inbox` (same file) + toast "too big for the
printer's CPU; open multiACE to finish in the browser"; 409 "already processed" → offer plain send with
identity map; livedata 409 → "a head is manual; multiACE can't place colours".

### 4.4 Dry-run / preview

`POST /api/multiace/preflight` is itself the dry run (the engine writes only a temp file under its
preflight dir, `main.py:1296`). Everything on the card (mapping, swaps, time, purge) comes from that
call; nothing is uploaded to `gcodes` or started until **Print via multiACE** is clicked and confirmed
in a dialog that repeats: colours → slots, swaps, est. added time, purge grams, "Air Print Detection
off", "larger purge bin fitted?".

### 4.5 Safety

- Never while printing/paused/`swap_in_progress` (server-side, not just UI).
- Confirm dialog with the plan summary; `force` is never accepted for the material/TPU/airprint checks.
- Revert = nothing to revert: the engine never changes slot identities, head wiring or `ace.cfg`
  (`ENGINE_API.md §3`: mode is "switched by the user via the web UI; a host should read it … rather than
  switch it"). The only Hub-sent gcode is the identity map + used extruders, both overwritten at the next
  print. If the user aborts after upload, `CANCEL_PRINT` via the existing `/api/printctl`.
- Snapmaker safety rule from the skill `snapmaker-safety`: check `print_stats` first; the module's
  probe is 3 small GETs (version, ace object, livedata), cached.

### 4.6 SME / costing accounting

- At send time the module records `multiace.json[hash] = {printer, plan, swaps, est_added_sec,
  purge_topup_mm, purge_g, ts}` keyed by `fileContentHashAsync` (`core/print.js:92`) and
  `ctx.provide("multiace.jobinfo", hash => …)`.
- **Costing** (`modules/costing.js`, fork-owned): time is already *actual* `print.done durationSec`
  (`costing.js:54`), so swaps are costed automatically once the print ends; for *quotes/estimates*
  (`est_minutes`, `costing.js:230`) add `est_added_sec/60` when `multiace.jobinfo` exists. Grams: the
  slicer's per-slot grams already include wipe-tower purge (`parser.js:170-176`); add `purge_g`
  (top-up) as a separate "multiACE purge" line so it is visible, not buried.
- **SME** (`modules/sme.js`, fork-owned): extend the printer brief with the 8-slot loadout and the
  jobinfo line (today `printerBrief` lists 4 heads only, `modules/advisor.js:257-283`); the KB
  `knowledge.md:108-113` already carries the review rules (route via preflight, purge bin, Air Print off,
  flush matrix matters on davinci).
- Later: subscribe to Moonraker `gcode_response` for `multiace_event swap_done … seq=` and record real
  per-swap durations (`last_swap_result.ts` deltas) to calibrate `swap_seconds` from davinci's own history.

### 4.7 Module layout (fork rules, docs/FORK.md)

| File | Role |
|---|---|
| `modules/multiace.js` | probe/caps cache; `GET /api/multiace/printers`; `GET /api/multiace/loadout?printer=`; `POST /api/multiace/preflight {file, printer}`; `POST /api/multiace/print {printer, token, mode, remap, bed_mesh, camera, flow_cal}`; `GET /api/multiace/print-status`; `POST /api/multiace/inbox`; `ctx.provide("multiace.loadout")`, `ctx.provide("multiace.jobinfo")`; ΔE + purge/time estimators as pure exported functions |
| `public/modules/multiace-ui.js` | loadout grid, job-card block, plan picker, confirm dialog, Settings card |
| `test/mock-multiace.js` | FastAPI-shaped mock: `/multiace/api/version`, `/api/preflight/livedata` (incl. a 409 manual-head mode), `/api/preflight` (canned report for a 7-colour fixture; 413 above a size), `/api/preflight/print` + `/status`, `/api/preflight/inbox` (409 on processed); plus `mock-moonraker` state additions: `state.ace` object (`api_version, mode, swap_in_progress, airprint_detection, head_source, head_manual`), `gcode_macro T4` in `objects/list`, `print_task_config.extruder_map_table` |
| `test/multiace-standalone.js` | boots `server.js` against mock U1 + mock multiACE; asserts: probe only on the multiACE mock; 7-colour fixture → report rows with tiers; refusal matrix (printing, swap_in_progress, airprint on, manual head 409, TPU, missing material, FS file, processed file); **identity map + USED_EXTRUDERS appear in `state.gcodeScripts` before the print POST**; 413 → inbox fallback; estimator pure functions (purge clamp 40/150, grams); `U1HUB_MULTIACE_FALSIFY=1` flips the busy expectation and must go red |
| `docs/multiace.md` | contract, verification record, manual `pp.py` fallback recipe |
| one-liners | `core/modules.js` MODULE_TABLE, `core/app.js` CLIENT_TABLE, `core/config.js` MODULE_DEFAULTS (**off** until the live gate) + LITE_OFF, `package.json test:standalone`, `.gitignore multiace.json`, `docs/FORK.md` table row |

Fixture: a trimmed 7-colour gcode (header + `; Change Tool` lines + a few `T<n>` blocks + flush matrix)
built from `[U1-HF] Van Goghs starry night …` — not the 20 MB original.

---

## 5. Risks / unknowns (UNVERIFIED) and how to settle each

| # | Unknown | Settle with |
|---|---|---|
| R1 | Installed multiACE **firmware** version on davinci (web says 1.00.1b; upstream main is 1.20b-pre; the engine API may have grown since 1.00.1b, e.g. `remap`/`head_copies` params) | idle only: `ssh root@192.168.1.136 'grep -m1 MULTIACE_VERSION /home/lava/klipper/klippy/extras/ace.py'` or `curl -s 'http://192.168.1.136/server/files/list?root=logs'` then grep the klippy.log banner (`ace.py:3086-3089` logs version at startup); or tap `ACEG__Status` in Fluidd |
| R2 | Exact report JSON shape (`plans[mode]` keys, swap-count field names) on **this** build | first live test, user-approved, printer idle: `curl -F 'file=@gcode/gato fuego_Front_160x160_PLA_3h2m.gcode' http://192.168.1.136/multiace/api/preflight` — analysis only, writes a temp file, prints nothing (`main.py:1271-1300`) |
| R3 | `_PREFLIGHT_MAX_SIZE` on davinci (env `MULTIACE_PREFLIGHT_MAX_MB`) vs the 20 MB files | same POST with the 20 MB Starry Night file → 200 or 413 |
| R4 | Does a non-identity `extruder_map_table` from a previous Hub-mapped print persist into a multiACE-started print? (live now `[0,1,2,3]`, `reprint_info` `[3,2,1,3]`) | after the next Hub-mapped print on davinci finishes: `curl 'http://192.168.1.136/printer/objects/query?print_task_config' | jq .result.status.print_task_config.extruder_map_table`. Design sends the identity map regardless |
| R5 | Semantics of stock `SWITCH_OF_EXTENDED_EXTRUDER INDEX=n` (assumed: physical = `extruder_map_table[n]`, no automatic pause) | idle only: `ssh … 'grep -rn SWITCH_OF_EXTENDED_EXTRUDER /home/lava/klipper/klippy/extras/ | head'` |
| R6 | Real swap duration on davinci (README "up to 3 min") | `curl 'http://192.168.1.136/server/files/logs/multiace_state.log'` (if the logs root is served) and diff `swap_imminent`/`swap_done` timestamps; or the `multiace_event` lines in klippy.log |
| R7 | python3 in the Hub Docker image (only for the optional local-engine path b3) | `docker exec u1-print-hub python3 --version`; `grep -n FROM /mnt/e/Code/u1hub/Dockerfile` |
| R8 | Whether 1.00.1b still has the 0.81b "feed-assist only on the start ACE" limitation (affects which ACE should hold the most-used colour → plan choice) | README of the installed tag: `gh api repos/decay71/multiACE/contents/README.md?ref=v1.00.1b` (if tagged) |
| R9 | How the preflight treats SnapmakerOrca's 4 per-extruder `nozzle_diameter` entries for 7 filaments (`LOADOUT_API.md §3` wants per filament) | part of R2's response (`nozzles`, `nozzles_mixed`) |
| R10 | Whether a Hub-started `SET_PRINT_EXTRUDER_MAP` while idle is accepted before the engine's own `SET_PRINT_PREFERENCES … FORCE=1` (ordering/state gate, stock error 531 note in `main.py:1361-1365`) | mock first; then one live run with a 2-colour test file |
| R11 | Is the FilamentHub plugin's slot-label mirror (`slot_overrides.json`, source `override`) what the user wants the Hub to trust, or should the Hub cross-check FilamentHub's `/fleet/api/ace-state`? | ask (Q5) |

## 6. Questions for the user (only ones that change the design)

1. **Hub-driven or hand-off?** One click in the Hub that uses multiACE's preflight API end-to-end
   (recommended, ~2× the work), or just "Send to multiACE inbox" + link to `http://192.168.1.136/multiace/`?
2. **Start immediately?** multiACE's `/api/preflight/print` uploads with `print=true` (starts at once).
   The Hub's normal flow has *Upload* vs *Print*. Is "Print via multiACE" always a start, or do you need
   an upload-only path (which means the local-engine variant b3 + python3 in the image)?
3. **Default plan**: as sliced, layer (fewest swaps), or optimize (mid-layer swaps)? Drives the default
   and the quote estimates.
4. **Big files**: when the printer answers 413, fall back to the inbox + browser preflight (no new
   dependency), or run the engine inside the Hub (python3 in the image, sources fetched from
   `/multiace/api/preflight/pysrc`)?
5. **Loadout truth**: trust `livedata` (slot identities from `slot_overrides.json`, which the FilamentHub
   plugin writes), or also show/compare FilamentHub's view?
6. **Local fork**: the Hub should target upstream's `api_version 1` contract. Is the `/mnt/e/Code/multiACE`
   fork (0.80b) still meant to be deployed anywhere, or is davinci now on upstream releases (the
   `ACEH__Update_Check/Apply` macros and `update_url_base` in `cfg` suggest the latter)?
7. **Should the Hub ever suggest re-slotting spools** ("move white to ACE 0 slot 3 to save 6 swaps") on the
   card, and record the move in FilamentHub, or stay silent and print with what is loaded?

## 7. Sources

- Live, read-only, 2026-10-04: `http://192.168.1.136` → `/printer/info`, `/printer/objects/list`,
  `/printer/objects/query?ace|print_task_config|configfile=config`, `/server/files/config/{extended/ace.cfg,
  extended/multiace/ace_vars.cfg, extended/multiace/slot_overrides.json, persistent/multiace_spools.json,
  printer.cfg, …}`, `/multiace/api/{version,state,preflight/livedata,preflight/inbox}`;
  `http://192.168.1.158/printer/objects/list` (one read, printing); `http://localhost:4545/api/{fleet,
  library-palettes,version}`.
- Hub: `core/print.js`, `parser.js`, `core/library.js:591-660`, `core/fleet.js:14-50`,
  `core/config.js:179-200`, `core/modules.js:113-160`, `core/app.js:78-90`, `public/app.js:783-817,
  962-985, 1895-1990`, `modules/advisor.js:257-283`, `modules/costing.js`, `docs/FORK.md`,
  `test/printer-sync-standalone.js`, `test/mock-moonraker.js`, `sme/core/knowledge.md:108-113,210,234-235`.
- Local multiACE fork: `README.md`, `CLAUDE.md`, `multiace/VERSION`, `multiace/klipper/extras/ace.py`,
  `multiace/config/extended/ace.cfg`, `ops/decay71_overlay/`.
- Upstream: https://github.com/decay71/multiACE (README; `multiace/docs/ENGINE_API.md`, `LOADOUT_API.md`,
  `SEND_TO_MULTIACE.md`; `multiace/tools/post_process_virtual_toolheads.py`;
  `multiace/web/backend/{main.py,preflight_core.py}`; `multiace/klipper/extras/ace.py`).
- https://github.com/dlgambill/u1hub/issues/3 (stock >4-colour path via pauses, fixed 2.23.1).
- https://github.com/Mnemonic3D/Snapmaker-U1-Orca-MultiACE-edition (README: experimental, pivoting).
