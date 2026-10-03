# Project costing (fork module `costing`)

What a piece of client work cost, and what to charge for it. Built as the MVP
of [proposals/costing.md](proposals/costing.md) (research, alternatives, and
the reasoning are there; this file is the feature as shipped).

Server: `modules/costing.js`. Client: `public/modules/costing-ui.js` (the
**Projects** tab, a project dropdown on the job card, a Costing block in
Settings). Suite: `test/costing-standalone.js` (part of `npm run
test:standalone`). Feature flag `costing`, on by default, off in Lite.

## The five decisions (proposal C8)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Is a project one order or a long-running account? | A **project is long-running client work** that can span many prints and many Dispatch bundles; `project_id` lives on each ledger row, not on a bundle. | A small farm bills per client per piece of work, not per plate; putting the id on the row means a print can be moved after the fact and nothing in Dispatch has to change. A `bundle_id` is recorded on the row when Dispatch was driving, so a v2 bundle link needs no migration. |
| 2 | Are failed/cancelled prints charged to the project? | **Yes by default**, each row has a **"don't count"** toggle, and the `failure_pct` allowance is applied **only while a project has no failed rows**. | A real failed print is a real cost; hiding it makes every quote look better than the last job did. The toggle absorbs the one you choose to eat, and the allowance is for quoting before anything has failed, never on top of actual failures. |
| 3 | Electricity measured or typed? | **Typed average watts per printer**, no default; the ledger row already carries an `energy.kwh` slot that a metered value fills in v2. | The U1 has no published average draw (1150 W is its peak), so a default would be an invented number. A blank energy line that says "no watts" is honest; the Shelly Wh delta at print edges is the v2 sampler and drops straight into the same field. |
| 4 | Labour per print or as line items? | **Explicit line items only**, plus an optional `setup_minutes` per counted print that is **blank (off) by default**. | Most labour is per project (support removal for the batch, packing), not per plate. The per-print default exists for a farm that wants it, but nothing is charged the person did not type. |
| 5 | CSV + quote page, or invoices? | **CSV export and a printable quote page**; no invoice numbering, tax or currency. | Invoicing is a different feature with legal shape. The quote page prints to PDF from the browser and carries every line's source; the CSV is the bridge to whatever does the invoicing. |

## What is measured and what is estimated

Every number carries a `source`. The summary and the quote page print it beside
the amount so a reader never has to guess.

| Line | Measured when | Estimated when | Blank when |
|---|---|---|---|
| Time | `print.done` carries `durationSec` (Klipper's `print_duration`) — `time_source: "actual"`. A cancelled/error row reads `printDuration` from the fleet snapshot at that moment; failing that, the Hub's own clock since `print.started` (`"hub-clock"`). A row with no duration gets the matching history job's `print_duration` (`"history"`). | No actual: the slicer's `estimated printing time` from the library file (`"slicer"`) or from the printer's metadata (`"printer-meta"`). | Nothing has an estimate either. |
| Material grams | — | The slicer's per-slot grams from the library file (purge-inclusive, see `modules/resources.js`; `grams_source: "slicer"`); else the printer's metadata `filament_weight_total` (`"printer-meta"`); else the history job's `filament_used` millimetres x density (`"history"`). A cancelled row scales by the fleet's `progress` when it reported one, and is flagged `partial`. | No file, no metadata, no history job. |
| Material cost | The resources module deducted the print: each head's grams at **that roll's** `cost_per_roll / net_weight_g` — `source: "deduction"`. `partial` when a head had no roll or the roll had no price; `cost` is **null** when no roll was priced (never the flat rate in disguise). | No deduction (print cancelled, auto-deduct off, file not in the library, no rolls recorded): grams x the margin module's `cost_per_g` (`"flat"`), else the slicer's own `filament cost` (`"slicer"`). | No grams, or no rate and no slicer cost. |
| Machine | — | hours x (`purchase / life_hours` + `maint_per_hour`) from the printer's block in Settings (`source: "typed"`, `basis` names which halves exist). With a rate unset on a U1, the **suggested** value below fills it and the line is labelled `"suggested"` (or `"typed+suggested"` when mixed). | No time, or a non-U1 printer with no typed rates. |
| Energy | A row with `energy.kwh` set (`"metered"`, v2). | hours x `avg_watts` / 1000 (`"watts"`) x `kwh_rate`; `"suggested"` when the watts or the $/kWh came from a suggestion. | No watts for that printer (non-U1), or no `kwh_rate` and no suggestion. |
| Labour | — | line-item minutes (+ `setup_minutes` x counted prints) / 60 x `labor_rate`. | Minutes exist but no `labor_rate`. |

## Where each number comes from (the fallback chain)

The complaint that started this: the Projects tab showed eighteen prints as
`no grams · material — · direct —`. Measured on the live install
(2026-10-03): zero spools recorded, so every deduction had `grams 0` and the
miss "no spool recorded in that head"; the files had been sent from Orca
straight to the printers, so they were not in the library and the slicer read
found nothing; no smart plugs; no rates typed. Every blank had a reason, and
every reason had a cheaper source the Hub had not asked.

Per ledger row, in this order, each step filling only what is still blank and
labelling what it filled:

1. **The deduction** (`filament.deducted`, the rolls that were loaded): grams
   and price, `source: "deduction"`. Needs the file in the library and spools
   recorded in the heads.
2. **The library gcode** (head+tail parse): grams, slicer time estimate, the
   slicer's own cost. `grams_source: "slicer"`, `est_source: "slicer"`.
3. **The printer's own metadata**: `GET <printer>/server/files/metadata?filename=…`
   — a few hundred bytes of JSON Moonraker already holds for every file on the
   printer: `filament_weight_total` (g), `estimated_time` (s), `filament_type`
   per tool (`"PLA;PLA;PLA;PLA"`), `filament_total` (mm), `slicer`. Asked once
   at `print.done`, when the file is certainly still on the printer; cached per
   printer+file. `grams_source: "printer-meta"`, `est_source: "printer-meta"`.
   When only `filament_total` is present the millimetres are converted as in 4.
4. **The printer's job history**: `GET <printer>/server/history/list?limit=200&order=desc`.
   The job with the same file name whose `end_time` is within 30 minutes of
   the row's timestamp is that print; its `print_duration` fills a missing
   duration (`seconds_source: "history"`) and its `filament_used` (mm of
   filament actually extruded) fills missing grams (`grams_source:
   "history"`):

   ```
   grams = pi x (1.75 mm / 2)^2 x length x density
         = 0.02405 cm^3 per metre x density        (PLA 1.24 -> 2.98 g/m)
   ```

   Density by the first tool's `filament_type` (table below; a family match,
   so `PETG-CF` is PETG); an unknown material uses PLA's and the row carries
   `density_assumed: true`. Check: Moonraker reports `filament_total 40361.57`
   and `filament_weight_total 120.38` for the same file; the formula gives
   120.38 g.

Grams from 2-4 are priced at the margin module's flat `cost_per_g` (label
`"flat $/g"`), never at a roll price the Hub did not see used.

**Backfill.** Rows an older Hub left blank are filled the same way: once,
15 s after boot (`U1HUB_COSTING_BACKFILL_BOOT_MS`), and on demand from the
Projects tab button / `POST /api/costing/backfill`. One Moonraker GET at a
time, 1 s apart (`U1HUB_COSTING_BACKFILL_PAUSE_MS`), never a gcode body:
on 2026-09-14 bulk-downloading ~250 gcode files through Moonraker OOM-killed
it mid-print, and a backfill must not be able to do that. Each row asked
about is marked `autofill: { at, result, still_blank }` so the boot pass never
asks twice; the POST retries every blank row. The result is logged
(`costing: backfill 3 blank rows checked, 2 filled (1 from printer metadata,
1 from job history), 1 still blank, 4 GETs in 1643 ms`) and returned.

**A print reported done twice.** The live log showed `davinci done … after
64715 s` and the same file `after 65217 s` eight minutes later: the printer's
state went back to `printing` and to `complete` again with `print_duration`
still counting, and `core/events.js` honestly raised a second `print.done`.
Both events compute the same start (`at - seconds`); when a new `done` for
the same printer and file has a start within 10 minutes of an existing done
row's start, that row takes the longer duration, counts `done_twice`, and no
second print lands on the bill. (The resources module, upstream, still
deducts on each event; that is its ledger to fix.)

### Filament densities (g/cm^3)

| Material | Density | Source |
|---|---|---|
| PLA | 1.24 | 3D Print Metric filament density database, read 2026-10-03 — https://3dprintmetric.com/filament-density-database |
| PETG | 1.27 | same |
| ABS | 1.04 | same |
| ASA | 1.07 | same |
| TPU (95A) | 1.21 | same |
| anything else | 1.24 (PLA), flagged `density_assumed` | — |

These are the values slicers ship as defaults (Bitfab's density table lists
the same figures: https://bitfab.io/blog/the-densities-of-all-3d-printing-materials/).
A filled or silk blend can differ by a few percent; a spool's own data sheet
beats the table, and the deduction path (real rolls) beats both.

## Suggested values

Rates the person has not typed are costed from these, labelled `"suggested"`
on every line they touch. `GET /api/costing` returns them as `suggested`
with a `notes` entry per key; Settings shows each as the greyed placeholder
of its box with the note on hover, and **Use suggested values** writes them
into the blank boxes as real rates (typed ones are not touched). They apply
to printers of type `u1` only; a generic Klipper printer gets no printer
suggestion and its machine/energy lines stay blank until typed.

| Key | Value | Source (read 2026-10-03) | Nature |
|---|---|---|---|
| `kwh_rate` | $0.183 / kWh | EIA *Electric Power Monthly*, Table 5.6.A "Average Price of Electricity to Ultimate Customers by End-Use Sector, by State, July 2026 and 2025": U.S. Total residential **18.31** c/kWh (17.45 a year earlier) — https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a | measured, national average; a state ranges 13-53 c |
| `purchase` | $849 | Snapmaker US store product page: "Current Price: $849.00, Regular Price: $999.00" — https://us.snapmaker.com/products/snapmaker-u1-3d-printer | list price on the day; what you paid is better |
| `life_hours` | 5,000 h | Snapmaker's own guide "How to Calculate Your 3D Printing Costs": "A common lifespan estimate for a well-maintained printer is around 5,000 hours", formula "Depreciation per Hour = Printer Purchase Cost / Total Expected Lifespan in Hours" — https://blog.snapmaker.com/blog/how-to-calculate-your-3d-printing-costs/ . pea3d's 2026 longevity guide gives consumer FDM "5,000 to 10,000 printing hours" — https://pea3d.com/en/how-long-does-a-3d-printer-last-2026-guide/ | assumption, conservative end of the range |
| `maint_per_hour` | $0.10 / h | **ESTIMATE**, derived: U1 hot end (nozzle, heat break and heater are one part) $49.00 sale / $79.00 list — https://us.snapmaker.com/products/hot-end-for-snapmaker-u1 ; textured PEI plate $33.99 sale / $39.99 list — https://us.snapmaker.com/products/pei-steel-plate-textured-for-snapmaker-u1 ; intervals from pea3d (above): hardened-steel nozzles "can last over 1,000 hours", plates "every 6-12 months of heavy use", belts "every 3,000 hours". One hot end per ~1,000 print hours (the four heads share the extrusion time) $0.049/h + a plate per ~1,000 h $0.034/h + belts/fans allowance ~$0.02/h ≈ $0.10/h | estimate; replace with your own parts log |
| `avg_watts` | 150 W | **ESTIMATE**: no measured U1-while-printing figure is published. Official: "Max Input Power: 1150 W (220-240 V~), 400 W (100-120 V~)" (store page above) and the three parked toolheads draw "approximately 10-30 W in standby in total" — U1 FAQ, forum.snapmaker.com, 2025-08-28 — https://forum.snapmaker.com/t/u1-faq-official-info-summary/39648 . A comparable 120 V enclosed CoreXY (Bambu X1C) meters "Printing: 103-135W" on PLA (user holmes4, US) — https://forum.bambulab.com/t/power-consumption-data/4180 . ~120 W for a single active head and bed at 60 °C plus the parked heads ≈ 150 W | estimate; one smart-plug reading of a whole print beats it |

The energy line is the smallest of the four (150 W x 1 h x $0.183 = 2.7 c),
so an estimate there moves a quote by cents; the material and machine lines
are where typed numbers matter.

Life-hours progress: Settings shows each printer's print hours from its own
`GET /server/history/totals` (`total_print_time`, the same read
`modules/logbook.js` makes) against the suggested or typed life, so "how far
through its life is this machine" is visible beside the rate it feeds.

## Formulas

Per print (`costOf(print, rates)`, pure, exported):

```
hours    = seconds / 3600                       fallback est_minutes / 60
material = deduction cost                       fallback grams x cost_per_g, fallback slicer cost
machine  = hours x (purchase / life_hours + maint_per_hour)
energy   = kwh x kwh_rate,  kwh = metered      fallback hours x avg_watts / 1000
direct   = sum of the lines that are not blank  (null when all are)
```

Per project (`projectSummary(project, prints, rates)`, pure, exported; only
rows with `counted !== false` are summed):

```
direct    = sum of direct over counted rows       (failed rows included)
labor     = (sum item.minutes + setup_minutes x counted rows) / 60 x labor_rate
extras    = sum of hardware + packaging + shipping + other items
subtotal  = direct + labor + extras
failure   = direct x failure_pct          only while the project has NO failed rows
overhead  = subtotal x overhead_pct
cost      = subtotal + failure + overhead
margin    = charged - cost,  margin_pct = margin / charged
pieces    = sum of pieces over counted DONE rows (pieces from "x10" in the file name, editable)
```

Pricing helper (`pricing(summary, rates, floor)`, pure, exported). Nothing is
chosen; each method is a row, blank with a note when its rate is unset:

```
markup        = cost x (1 + markup_pct)
target margin = cost / (1 - margin_pct)
machine-hour  = hours x hour_rate + material + labor + extras
per-gram      = margin.quote(grams).min_plate      (the "Worth printing?" sell floor)
                each is then lifted to min_fee when one is set
listed        = (price + platform_fee_fixed) / (1 - platform_fee_pct)     so the NET is the price you picked
breaks (1/10/50 units): each = ((direct / pieces x n + labor + extras) x (1 + overhead_pct)) x (1 + markup_pct) / n
```

`grossUp` / `netOf` are exported and round-trip exactly.

## State

| File | Content | Cap |
|---|---|---|
| `prints.json` (beside config.json, gitignored) | `{ prints: [row…] }` — the ledger. Row: `id, at, printer_id, printer, file, type, outcome (done\|cancelled\|error), project_id, job_id, bundle_id, seconds, seconds_source (actual\|hub-clock\|history), est_minutes, est_source (slicer\|printer-meta), material { grams, grams_source (deduction\|slicer\|printer-meta\|history), material, density, density_assumed, filament_mm, cost, source, partial, progress, slicer_cost, heads[], misses[], deducted_g }, energy (null \| { kwh, source }), pieces, counted, note, autofill { at, result, still_blank }, done_twice, history_job`. | 5000 rows, oldest dropped. |
| `projects.json` (beside config.json, gitignored) | `{ clients: { id: { name, email, notes } }, projects: { id: { client_id, name, state, charged, deadline, notes, items: [{ id, kind, label, minutes \| cost }] } }, pending: { "type:file": project_id } }`. | — |
| `config.json` → `costing` | `kwh_rate, labor_rate, setup_minutes, failure_pct, overhead_pct, min_fee, markup_pct, margin_pct, hour_rate, platform_fee_pct, platform_fee_fixed, printers: { "<idx>": { purchase, life_hours, maint_per_hour, avg_watts } }`. Every key optional; absent = blank. | — |

Writes go through the same tmp+rename-with-fallback `save()` shape as
`modules/dispatch.js`, from handlers and event listeners only, never a timer.

How a print becomes a row: `print.started` remembers the file per printer;
`print.done` / `print.cancelled` write the row (the file's grams and estimate
come from a cached head+tail parse, off the loop); `print.error` writes one
only for a print this Hub watched start (Klipper raises `error` on an idle
machine too). The resources module's deduction arrives on
**`filament.deducted`** — the one line added to upstream's
`modules/resources.js`, emitted right after it has saved the deduction it was
already making. Costing never calls `deductFor` itself, so nothing is
deducted twice; a deduction that arrives before its row is stashed for ten
minutes and applied when the row lands.

A **pending** assignment (job card dropdown) is spent by the print that
*finishes*; a cancelled attempt lands in the project too and leaves the
assignment in place for the retry.

## API

All under `/api/costing`; absent (404) when the feature is off.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/costing` | `?refresh=1` re-reads print hours | rates, `suggested` (+ `notes`), `printer_names[]` (with `type`, `hours` from Moonraker totals), `keys`, `printer_keys`, `fork` |
| POST | `/api/costing/settings` | any rate keys; `""`/null unsets; `printers: { "<idx>": {…} }` | 400 names the offending key and its range |
| POST | `/api/costing/backfill` | | fills blank grams/time from the printers, paced; answers `{ checked, filled, meta, history, none, requests, min_gap_ms, ms }` when done; 409 while one runs |
| GET | `/api/costing/projects` | | `clients[]`, `projects[]` (each with a `summary` brief), `pending`, `unassigned[]` (newest 30), `unassigned_total`, `ledger_total`, `sources` (tally of every row's grams/time/material/machine/energy source), `blank_rows`, `backfill { running, last }` |
| POST | `/api/costing/clients`, `/clients/update`, `/clients/remove` | `{ name, email, notes }` / `{ id, … }` | 409 on removing a client that still has projects |
| POST | `/api/costing/projects`, `/projects/update`, `/projects/remove` | `{ name, client_id, state, charged, deadline, notes }` | removing a project frees its prints to unassigned |
| POST | `/api/costing/items`, `/items/remove` | `{ project_id, kind, label, minutes \| cost }` / `{ project_id, id }` | the full project view |
| GET | `/api/costing/prints` | `?unassigned=1&project=<id>&limit=` | rows newest first, each with `cost` |
| POST | `/api/costing/prints/assign` | `{ print_id, project_id \| null }` | |
| POST | `/api/costing/prints/update` | `{ print_id, counted, pieces, note }` | |
| POST | `/api/costing/pending` | `{ file, type, project_id \| null }` | the pending map |
| GET | `/api/costing/projects/:id` | | `project, client, summary, pricing, prints[]` |
| GET | `/api/costing/projects/:id.csv` | | UTF-8 BOM + one line per print and per item |
| GET | `/api/costing/projects/:id/quote` | | the printable page, server-rendered, every string escaped, no script |

Provides `costing.costOf(print, rates?)` and `costing.projectSummary(id)`.
Uses `margin.quote` (flat $/g and the per-gram floor) and `dispatch.jobs`
(job/bundle ids) at call time; both optional.

## Rebase footprint

Beyond the fork's usual table lines (`core/modules.js`, `core/app.js`,
`core/config.js` x2, `package.json`, `.gitignore`), this module adds **one
line inside `modules/resources.js` `deductFor()`**:

```js
if (ctx.events) ctx.events.emit("filament.deducted", rec);
```

Why not zero: the deduction record is the only place the Hub prices a print at
the loaded rolls' actual prices. The alternatives were to call `deductFor`
again (deducts the grams twice), to read `resources.json` and re-implement the
per-head arithmetic (a second copy of a rule that has already changed once),
or to poll `/api/resources/deductions` over HTTP from inside the same process.
One emit of a record that already exists is the smallest honest hook. If an
upstream release moves `deductFor`, the line goes wherever `store.save()` now
is; with the line missing the module still works, with material falling back
to the flat rate and saying so.

## Roadmap

- **v2**: Shelly Wh sampling at `print.started` / `print.done` into
  `energy.kwh` (`"metered"`); average watts learned from those samples; a
  `project_id` on Dispatch jobs and bundles so a bundle's prints auto-attach;
  the `quoted` state as an estimate-only project ("convert to bundle" makes
  the Dispatch bundle); charged-vs-cost history on the client page; manual
  ledger rows for prints the Hub did not watch.
- **v3**: Moonraker `/server/history/list` reconciliation per printer for
  prints the Hub never saw (started from the touchscreen while it was down) —
  the history read and the job matcher exist now for the backfill, so this
  is adding rows, not finding them; per-project failure-rate statistics
  feeding `failure_pct` from measurement; invoices, if they are ever wanted,
  as their own module on top of this ledger.

## Verification record

Recorded in the commits that introduced the module and the autofill
(`git log --grep "costing"`): the suite's pass count, the falsified run going
red (`U1HUB_COSTING_FALSIFY=1` flips the actual-seconds expectation on the
ledger row and the printer-metadata grams expectation), the full harness
total, `scripts/check-core.js`, `scripts/check-index-js.js` and
`test/printer-sync-standalone.js`. No live hardware gate is needed for the
ledger itself. The Moonraker reads (`/server/files/metadata`,
`/server/history/list`, `/server/history/totals`) are the same endpoints
`core/fleet.js`, `modules/models.js` and `modules/logbook.js` already use
against real printers; the first backfill on the deployed Hub should log
`costing: backfill N blank rows checked, …` and the Projects tab's tally
should show `printer metadata` / `printer history` grams on rows that were
blank.
