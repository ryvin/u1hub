# Estimate page — design (fork module `estimate`)

Date 2026-10-06. Fork ryvin/u1hub, branch `ryvin`. Owner-approved in conversation, section by section.

## 1. Purpose

Upload an STL or 3MF and get, before anything is printed, an estimate of grams, print time, the true cost
(material, machine, energy, labour, failure, overhead), what to charge, and a customer quote, as a page and as
PDF / CSV / Excel reports. Audience: **both** the owner (internal breakdown) and customers (clean quote) from
the same upload. Estimates can be **saved and linked to a costing client/project**, and compared with the
actual cost once the job prints.

Decisions (owner, 2026-10-06): audience both; accuracy staged (instant geometry estimate now, exact slice in
Phase 2); formats PDF + CSV + Excel; saved and linkable to client/project; "printed before?" matching with an
option to use the past print's numbers as exact.

## 2. Phases

- **Phase 1 (this spec):** the tab, geometry estimate (calibrated), exact numbers from an already-sliced 3MF,
  "printed before?" matching, pricing, saving/linking, quote vs actual, the three report formats.
- **Phase 2 (later spec):** "Slice for exact" through a host-side helper running upstream OrcaSlicer 2.4.2
  with the owner's flattened profiles (docs/proposals/slicing/SLICING-DESIGN.md). Phase 1 ships the button
  disabled ("needs the slicing helper") and the job-queue contract stub only. This also answers the open
  slicing-engine question as "build on OrcaSlicer 2.4.2 now".

## 3. Architecture

Fork module per docs/FORK.md: `modules/estimate.js` (routes, state, wiring) + `public/modules/estimate-ui.js`
(the tab), one line each in `core/modules.js` MODULE_TABLE, `core/app.js` CLIENT_TABLE, `core/config.js`
MODULE_DEFAULTS (on) / LITE_OFF. Pure units under `modules/estimate/`:

| Unit | Responsibility | Reuses |
|---|---|---|
| `stl.js` | binary + ASCII STL → the same measurement shape as `mesh3mf.measure()` (bbox, area, volume, steep/flat/mild %, bed contact, tris); streams, 200 MB cap | `mesh3mf.js` measure logic |
| `geometry.js` | facts + preset → grams (shell, infill, supports, purge) and an uncertainty band | — |
| `sliced.js` | a 3MF that carries Orca slice results (`Metadata/slice_info.config` prediction/weight, `Metadata/plate_N.gcode`) → exact time, grams per filament, per plate | `slicing.js` zip reader, `parser.js` |
| `calibrate.js` | fits the geometry factors and the grams→minutes rate per printer type (U1 / Kobra S1) and colour mode (single / multi) from library data; records n and the error band; cached, refit when the library changes | `parser.js`, `models` index |
| `match.js` | "printed before?" candidates from the costing ledger and the gcode library | `sme/core/family.js` `familyName` |
| `price.js` | builds a costing-summary-shaped object and calls costing's `pricing()`; recommended price | `costing.js` `costOf`/`pricing`, `margin.quote` |
| `report.js` | printable HTML (PDF via the browser), CSV, XLSX (two sheets: Quote, Breakdown) | `slicing.js` zip writer, costing `csvCell` |

State: `estimates.json` beside config.json (gitignored), uploads under `data/estimates/<id>/` (stored by
generated id, never by the uploaded name). Unsaved estimates and their files are pruned after 30 days.

## 4. The numbers

### 4.1 Sources, always labelled
`geometry ±X%` · `exact (sliced 3MF)` · `exact (printed before: <file>, <date>)` · Phase 2 `exact (sliced here)`.
The report states which source was used.

### 4.2 Geometry grams
`grams = density × (area × shell_mm + max(0, volume − area × shell_mm) × infill + support_allowance) + purge`
- shell_mm = walls × line width (0.42) + top/bottom contribution folded into the calibrated factor;
  infill from the preset (Standard 2 walls / 15 %; HueForge and Flexi presets from the owner's process
  profiles' wall/infill values; all overridable).
- support_allowance from mesh3mf `steep_pct` and `flat_unsupported_pct` × footprint (calibrated factor).
- purge for >1 colour: per tool change, from the calibration set's multi-colour files.
- density by material (costing's density table).

### 4.3 Time
`minutes = grams × rate[printerType][colourMode]` (fitted), + multi-colour tool changes, + multiACE swaps ×
`swap_seconds` (192 s on davinci) when colours > 4.

### 4.4 Calibration
- Grams factors: fitted on library 3MFs that also carry slice results (exact grams known) — mesh facts vs
  sliced grams. Time rates: fitted on library gcode (`; total filament used [g]`, estimated time).
- Stored with n, median absolute % error → the "±X %" band. Below a minimum n (20) built-in defaults are
  used and the band is widened to ±40 %, shown as such.

### 4.5 Printed before?
1. Same file: upload content hash = a library 3MF (models index) → follow that model's family to its gcode.
2. Same family: `familyName(upload) == familyName(ledger row / library gcode)`, ranked by name similarity.
3. Height check: the candidate gcode's `; max_z_height` within 2 % of the uploaded model's height (the
   tallest part, as placed on the bed) → "likely the same"; otherwise "same name, different size". A
   candidate with no `max_z_height` (old or non-Orca gcode) is "name match, size unchecked".
Panel: up to 5 candidates — thumbnail (`/api/pthumb`), file, printer, last date, times printed, success rate,
actual time (mean of successful runs) and grams. "Use these numbers" switches the source; the candidate's
failure rate replaces the general failure allowance. Reversible.

### 4.6 Cost and price
Cost layers from costing rates: material (grams × material $/g: matched priced roll, else flat), machine
(depreciation + maintenance × hours, per printer), energy (watts × hours × $/kWh), labour (setup + post
minutes × costing's `labor_rate`; setup defaults to costing's `setup_minutes`), failure allowance
(`failure_pct`, or the matched candidate's own failure rate), overhead (`overhead_pct`). The cost is
computed by costing's own `costOf`/summary code on a synthetic ledger row, so the two can never disagree. Unset rates are named as blanks, never $0.
Pricing: costing's methods (markup, target margin, machine-hour, per-gram floor), quantity breaks 1/5/10/25,
platform-fee gross-up, min fee. **Recommended price** = max(per-gram floor, markup price) × rush multiplier.

### 4.7 Page contents
Model (thumbnail: 3MF's own / STL SVG top+side outline; size; fits which beds; parts/copies; colours) ·
Print (grams per material, time, plates, supports yes/maybe/no with %, brim advice from aspect ratio,
multiACE needed) · Cost (internal) · Price · Schedule (printer-hours, earliest finish per printer from the
current queue) · Inputs (qty, material, colours, preset, infill, labour minutes, rush) · Printed before.

## 5. API (`/api/estimate`, behind the Hub password when set)
- `POST /upload` (multipart, 1..n files, .stl/.3mf, 200 MB each) → `{ id, jobId }`; `GET /job?id=`
- `GET /:id` → facts, numbers with source, cost layers, pricing, candidates
- `POST /:id/inputs` → recompute (no re-upload)
- `POST /:id/source {source, candidate?}`
- `POST /:id/save {client_id?, project_id?, note?}`; `GET /` saved list
- `GET /:id/report?format=pdf|csv|xlsx&view=quote|internal`
- `DELETE /:id`
Quote vs actual: a saved estimate linked to a project shows "quoted $X / actual $Y" on the project from the
costing summary.

## 6. Errors and security
Refuse with a reason: wrong type, empty, corrupt, >200 MB, 3MF without a mesh, a model bigger than every
bed. Zip reads bounded (mesh3mf MAX_BYTES; per-entry inflate cap). Uploaded names only ever displayed,
escaped. Reports escape every string; CSV/XLSX cells starting `= + - @` are neutralised. Calibration short on
data → defaults + wide band, said on the page.

## 7. Testing
`test/estimate-standalone.js` (+ `U1HUB_ESTIMATE_FALSIFY`, rule 6), in `npm run test:standalone`:
- STL binary + ASCII 20 mm cube: volume 8.000 cm³, area 24.00 cm² (hand); hollow box; overhang fixture → steep %.
- 3MF fixture with slice results → exact time/grams.
- geometry grams on the cube for a known preset (hand-computed).
- calibration on a seeded set with a known slope; n < 20 → defaults + ±40 %.
- matching: family hit, height check refusing a look-alike, same-hash hit.
- pricing equals costing's own `pricing()` for the same summary.
- XLSX re-read (zip valid, sheet names, key cells); CSV formula neutralising; quote view hides internals.
- booted Hub: upload → job → estimate → inputs → source → save → report ×3; refusals.
Plus the full harness, a Playwright pass over the real tab, and a live check: upload the Dragon Dynasty model
and confirm it finds the 2026-10-05 print.

## 8. Out of scope (Phase 1)
Real slicing (Phase 2); customer-facing public link / emailing; per-object part splitting beyond what the
3MF already defines; automatic plate arrangement for quantity (quantity scales numbers; copies-per-plate is an
input).
