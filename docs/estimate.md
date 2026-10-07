# Estimate (fork module `estimate`)

Fork module (ryvin/u1hub). Design: [superpowers/specs/2026-10-06-estimate-design.md](superpowers/specs/2026-10-06-estimate-design.md);
plan: [superpowers/plans/2026-10-06-estimate.md](superpowers/plans/2026-10-06-estimate.md).

An **Estimate** tab. Drop an STL or a 3MF and get, before anything is printed:
grams, print time, the cost layers, what to charge, whether the model was printed
before (and its real numbers), and the result as a customer **quote** or an
**internal** breakdown, as PDF (the browser prints the page), CSV or Excel. An
estimate can be saved and linked to a costing client and project; the saved list
shows what was quoted next to the project's actual cost.

## Where the numbers come from

Every estimate says which source it used, on the page and in every report.

| Source | Grams | Time | When |
|---|---|---|---|
| **geometry** | the mesh measured (`mesh3mf.measure`; STL through `estimate/stl.js`): surface × wall thickness + the rest at the preset's infill + a support allowance from the downward-facing share of the surface, × the calibrated `k` | the per-profile-family fit on those grams | always, when the mesh can be measured |
| **sliced** | the 3MF's own slice: `Metadata/slice_info.config` `weight` (per filament `used_g`), or embedded `Metadata/plate_N.gcode` (exact) | embedded gcode: exact; slice info: the fit (the designer's `prediction` is shown as "their slicer, their printer") | when every file carries slice info |
| **printed** | an earlier print of the same model (see below): the ledger's grams | the ledger's actual time (mean of the successful runs); its success rate replaces the failure allowance | when a candidate exists and you press "Use these numbers" |

A 3MF whose mesh is past mesh3mf's 160 MB budget (the live Dragon Dynasty 3MF is
48 MB zipped and past it unzipped) but carries slice info is estimated from its
slice, with a warning; geometry is not offered for it. An estimate with nothing
measurable shows blanks, never $0.

### Accuracy (measured on this library, 2026-10-06)

Time from grams, `minutes = a · grams^b`, trimmed log-log fit per profile family
(from `; print_settings_id`) and colour mode, median absolute error:

| Fit | n | a | b | error |
|---|---|---|---|---|
| standard, single colour | 110 | 4.810 | 0.836 | ±33 % |
| standard, multi-colour | 231 | 6.403 | 0.840 | ±29 % |
| hueforge, multi-colour | 45 | 14.619 | 0.742 | ±24 % |
| flexi, multi-colour | 10 | 18.683 | 0.736 | ±6 % |

A straight grams→minutes line missed by a median 43 % (single) and was wrecked by
one outlier (multi); adding the model's height did not help (34 % / 30 %). These
are the built-in defaults; the module refits them from the live library 60 s after
boot and then daily (`estimate-calibration.json`), keeping a fit only when it has
at least 20 files, and logs `estimate: calibrated - …` with n and error per key.
The same pass fits the geometry grams scalar `k` (single / multi) against up to 60
library 3MFs that carry slice-info weight.

Known weak spot: flat multi-colour prints (HueForge-like). The live Dragon Dynasty
5-colour print (1.6 mm tall, 17 g) is estimated at about 1 h 10 min by the
standard-multi fit and took 3 h 10 min; the printed-before match is what gives
the right number there.

## Printed before?

Files group by a family key: the SME's `familyName()` (variants of one print are
attempts at the same model) plus what an upload's name carries that a gcode's does
not: the mesh extension, a trailing colour word (`_pink`), MakerWorld / bl2u1's
`0.4NOZZLE_AMS_5COLORS_…_U1` wrapper. An exact key ranks above a containment match
("dragon dynasty" inside "dragon dynasty front 100x400", two words or more). An
upload that is byte-for-byte a Models-library file (same size, same sha1) also
brings that file's own name's family. Each candidate shows times printed, success
rate, actual time, grams and a size check: the gcode's `; max_z_height` within 2 %
of the model's height is "same size"; otherwise "different size"; no measured
height or no gcode height is "size unchecked".

## Cost and price

The estimate is one synthetic ledger row (grams × qty, minutes × qty, qty pieces)
run through costing's own `projectSummary()` and `pricing()` with the costing
rates, so a quote and the Projects tab cannot disagree. Labour minutes are a
labour item; `failure_pct` is replaced by (1 − success rate) when an earlier print
is used. **Recommended price** = the higher of cost + markup and the per-gram floor
(margin module's `sell_per_g`), × the rush multiplier. Quantity breaks are
costing's (1 / 10 / 50, cost + markup). A rate that is not set is named as a blank.

## Inputs

qty (1-10000), material (density from costing's table), preset (Standard 2 walls
15 %, Strong 4 walls 30 %, HueForge solid, Flexi), infill override, supports
(auto / on / off), labour minutes, rush (0.5-5×), colours override, printer (else
the first one whose bed fits). Bed sizes: Snapmaker U1 270 × 270 × 270 mm,
Anycubic Kobra S1 250 × 250 × 250 mm (makers' spec pages, checked 2026-10-06); a
printer type not listed is "size unchecked".

## API

- `GET /api/estimate/info` → presets, materials, upload cap, calibration
- `POST /api/estimate/upload[?id=]` raw body, `Content-Type: application/octet-stream`, `X-File-Name` (URL-encoded) → `{ id, file_id, jobId }`; 400 wrong type / empty; 413 over the cap
- `GET /api/estimate/job?job=` → `{ phase, done, error }`
- `GET /api/estimate/:id` → the estimate view
- `POST /api/estimate/:id/inputs {qty, material, preset, walls, infill, supports, labor_minutes, rush, printer_id, colours}` → view; 400 names the bad field
- `POST /api/estimate/:id/source {source: geometry|sliced|printed, key}` → view; 400 when not available
- `POST /api/estimate/:id/save {client_id, project_id, note}` → view
- `GET /api/estimate` → the saved list with quoted and actual
- `GET /api/estimate/:id/report?format=pdf|csv|xlsx&view=quote|internal`
- `GET /api/estimate/:id/thumb?file_id=` → the 3MF's own PNG
- `DELETE /api/estimate/:id`
- Public quotes (the **Quote requests** and **Public quotes** cards, and the key-gated
  `/api/quote-backend/*` the public page calls): see [quote.md](quote.md). A public
  quote is an estimate with `public: true`; it never appears in the saved list, and
  its retention is 7 days unrequested / closed + 30 days instead of the 30-day
  unsaved rule.

## State

| File | What |
|---|---|
| `estimates.json` | estimates (files' measured facts, slice info, candidates, inputs, source, saved, links) |
| `estimates/<id>/<file_id>.<ext>` | the uploads, stored by generated id, never by the uploaded name; unsaved estimates are pruned after 30 days |
| `estimate-calibration.json` | the live time fits and grams `k` |

All gitignored. Env: `U1HUB_ESTIMATE_MAX_MB` (upload cap, default 200),
`U1HUB_ESTIMATE_MESH_MAX_MB` (mesh parse budget, default mesh3mf's 160),
`U1HUB_ESTIMATE_CALIBRATE_BOOT_MS` (0 = no calibration, tests).

## Verification record

- `test/estimate-standalone.js` (pure units against hand-computed answers, then the
  booted Hub: upload → estimate → inputs → sources → save → reports → size cap →
  restart → an unmeasurable 3MF with slice info), its falsified run red
  (`U1HUB_ESTIMATE_FALSIFY=1`), three consecutive green runs.
- XLSX loaded in openpyxl (Quote and Breakdown sheets, values in place); not opened
  in Excel from here.
- Playwright on a throwaway Hub (see docs/FORK.md "Live gates").
- Final review (Opus): 0 critical, 7 important, all fixed with a test each, shown red
  with the fix removed (per-piece / per-file matching, slice as default, 0 g never
  priced, own-key ids, capped async 3MF reads + yielding STL parse, cached library
  facts, re-wound inward meshes); suite 97/0 three times, harness 967/0.
- Live on :4545 (image 412f034aa399, ryvin ada41c1), 2026-10-06: the real
  `0.4NOZZLE_AMS_5COLORS_Dragon+Dynasty_U1.3mf` (48 MB) -> source "sliced", 17.17 g,
  5 colours, multiACE note, time 70 min ±29 %; printed-before: the pink gcode, actual
  190 min, 15.86 g; recommended $2.06 (per-gram floor); quote PDF / CSV / XLSX 200;
  library scan 545 gcodes read once (cached by size + mtime). Test estimate deleted.
