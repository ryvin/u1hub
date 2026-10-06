# Project costing (fork module `costing`)

What a piece of client work cost, and what to charge for it. Built as the MVP
of [proposals/costing.md](proposals/costing.md) (research, alternatives, and
the reasoning are there; this file is the feature as shipped).

Server: `modules/costing.js` (the ledger, projects, import, routes) and
`modules/costing-report.js` (the pure report, its CSV and its printable
page). Client: `public/modules/costing-ui.js` (the **Projects** tab with its
three views Projects / Prints / Reports, a project dropdown on the job card,
a Costing block in Settings). Suite: `test/costing-standalone.js` (part of
`npm run test:standalone`). Feature flag `costing`, on by default, off in Lite.

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
   recorded in the heads. A deduction that took **0 g and priced nothing** (no
   spool recorded in any head) carries no price, so the row is priced by the
   steps below and flagged `deduction_empty` (2026-10-06: five live rows had
   shown a blank material cost for this reason). A deduction that did take
   grams from a roll with no price stays blank, never the flat rate in
   disguise.
   **A multiACE print** (row.multiace) is priced colour by colour instead:
   each colour's grams at the price of the roll the shelf matches for it
   (`resources.priceFor`, the rollup's own colour matcher), `source: "rolls"`,
   only when every colour with grams found a priced roll. Its colours are not
   its heads, so the head-by-head deduction is kept on the row as
   `material.deduction_ignored` and never prices it. Without priced rolls it
   falls through to the flat rate / slicer cost like any other row, and
   `material.heads` still says which ACE slot each colour printed from.
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

## Importing every printer's job history

The ledger started on the day costing was deployed (19 rows on the live
install, 2026-10-03), but each printer's Moonraker keeps its own job history
much further back (`GET /server/history/list`), and a print started from the
printer's screen while the Hub was down never raised a `print.done` at all.
The **import** reads that history into the ledger:

- **When.** At boot, after the backfill above (`U1HUB_COSTING_IMPORT_BOOT_MS`,
  default 15 s; 0 = off); then every hour (`U1HUB_COSTING_IMPORT_MS`, default
  3,600,000 ms; 0 = off); and on demand from the Projects tab button /
  `POST /api/costing/import` (`{ full: true }` to page to the end).
- **How.** `GET /server/history/list?limit=100&start=<offset>&order=desc`,
  newest first, one page at a time through the same paced GET as the
  backfill (1 s apart, `U1HUB_COSTING_BACKFILL_PAUSE_MS`), never a gcode
  body. The page size is `U1HUB_COSTING_IMPORT_PAGE` (default 100), at most
  100 pages per printer per run. A run stops at the first page that holds
  nothing new, so the hourly run costs one request per printer; the first run
  on a fresh ledger pages to the end by itself. An offline printer (the fleet
  says so) is skipped and tried next run; a printer whose history errors is
  reported as such.
- **Any printer type.** The import keys nothing on the U1: a Kobra S1 on
  Rinkhals (Moonraker on :7125, no `print_task_config`) imports the same way,
  and its rows carry the printer's Hub type (`type: "kobra-s1"`), so reports
  and the Prints list can filter and group by it.
- **Once each.** Every imported row carries `history_job` (Moonraker's
  `job_id`); a job whose `printer + job_id` is already in the ledger is
  counted `known` and left alone, so a second run adds nothing.
- **The Hub's own rows win.** A job the Hub DID watch (same printer, same
  file, its end within 10 minutes of the row's `at`, or its start within 5
  minutes of `at - seconds`; the closest row whose outcome agrees) is not
  added: that row gains the `job_id` and any blank the job can fill, and
  keeps its actual seconds, its deduction and its project. A job that ended
  inside the last 2 minutes (`U1HUB_COSTING_IMPORT_SETTLE_MS`) is left for
  the next run, because the Hub's own `print.done` for it is still on its
  way and must be the row that lands.
- **What a row gets.** `at` = the job's `end_time`; `seconds` =
  `print_duration` (`"history"`); `est_minutes` from
  `metadata.estimated_time` (`"printer-meta"`); grams from
  `metadata.filament_weight_total` (`"printer-meta"`) - for a cancelled or
  failed job scaled by the share of the estimated time it ran
  (`material.progress`, `partial`) when both are known - else
  `filament_used` millimetres x density (`"history"`); the material from
  `metadata.filament_type`; pieces from the file name; `source: "history"`,
  `history_status` = Moonraker's own word. Status → outcome: `completed` →
  done, `cancelled` → cancelled, `error` / `klippy_shutdown` /
  `klippy_disconnect` / `interrupted` / `server_exit` (and anything unknown)
  → error; `in_progress` is skipped. **Exception:** a `cancelled` job that
  used ≥ 99 % of the file's own `metadata.filament_total` is **done** -
  Rinkhals (the Kobra S1 jailbreak) records finished prints as cancelled
  (kobrakai, 2026-10-04: 0 `completed` in 127 jobs; 37 `cancelled` jobs at
  100 % filament and 1.0x the slicer time). `history_status` keeps the
  printer's word. Rows imported before this rule are fixed by a full import
  (`POST /api/costing/import {"full":true}`). Imported rows are unassigned; the
  Prints view assigns them in bulk or by file name.
- **The cap.** After a merge the ledger is sorted by `at` and cut to
  `LEDGER_MAX` = **10,000** rows, oldest first (`U1HUB_COSTING_LEDGER_MAX`
  to change it). Three printers at five prints a day is ~5,500 rows a year,
  so that is about two years of a busy farm; at ~1 KB a row the file, which
  is rewritten whole on every assignment, stays near 10 MB. The result says
  how many rows were dropped.

Each run is logged (`costing: import 412 jobs imported, 19 matched to rows
the Hub watched, 0 already known, 1 skipped, offline: kobrakai; 6 GETs over
6 pages in 7120 ms`) and returned; `GET /api/costing/import` shows the last
one.

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
into the blank boxes as real rates (typed ones are not touched). The printer
block is keyed by **printer type** (`suggested.by_type`, with
`suggested.printers` / `applies_to: "u1"` kept for the U1): a type with no
block gets no printer suggestion and its machine/energy lines stay blank
until typed.

| Type | Key | Value | Source (read 2026-10-03) |
|---|---|---|---|
| `kobra-s1` (Anycubic Kobra S1, Rinkhals) | `purchase` | $401 | store.anycubic.com Kobra S1 product page: "Sale price $401.00", "Regular price $631.00" — https://store.anycubic.com/products/kobra-s1 |
| `kobra-s1` | `life_hours` | 5,000 h | the generic figure from Snapmaker's cost guide below; no Kobra-specific figure published |
| `kobra-s1` | `maint_per_hour`, `avg_watts` | **no suggestion** | no citable parts prices or intervals. A search snippet of Igor's Lab's Kobra S1 Combo review reports **180 W printing PLA** (205/55 °C), 25.6 W standby and a 1050 W heating peak, but the page itself could not be read (HTTP 403, twice) and a figure that could not be read at source is not shipped as a rate. Type it yourself if you trust it: Settings → printer row → average watts. |

The U1 figures:

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

## Reports

`report(rows, projects, clients, rates, { from, to, groupBy, tz_offset_min })`
in `modules/costing-report.js` (pure, exported from `costing.js` too) takes
the ledger rows inside `[from, to)` (epoch ms; either edge optional) and
groups them by **client, project, printer, type** (printer type), **month,
material** or **outcome**. Per group, over the counted rows:

```
prints, done, failed, counted, uncounted, pieces
hours, grams, material, machine, energy, direct      sums of costOf, null when nothing is known
failure_cost   = direct of the counted rows that are not done
failure_share  = failure_cost / direct x 100
coverage       = per line (time, grams, material, machine, energy): how many
                 rows are actual, estimated or blank, and actual_pct
```

"Actual" is a measurement: time from the printer's clock (`actual`,
`hub-clock`, `history`), grams from the loaded rolls or the filament actually
extruded (`deduction`, `history`), material priced from the rolls
(`deduction`), machine and energy from typed rates (`typed`, `watts`,
`metered`). Slicer and metadata figures and suggested rates are "estimated".

Grouped by **client or project** the groups line up with projects, so the
project-level lines are real per group (`aligned: true`): labour = line
items *created* inside the range plus setup minutes per counted print,
extras, the failure allowance and overhead, all through `projectSummary`
over the rows in range; `cost` = direct + those; `charged` counts in the
range that holds the project's **newest print** (a project with no prints
puts it in the range holding its creation), `margin` and `margin_pct` from
it. A project with no print in range but an item created in it still appears.
Grouped any other way those columns are null and `cost` is the print cost
(material + machine + energy): a project's labour or charge has no honest
share per printer or month, and the page says so rather than spreading it.

Months are keyed in the caller's clock: `tz_offset_min` is JavaScript's
`getTimezoneOffset()` (the UI sends it); 0 = UTC. Month groups come in
order; every other grouping by cost, biggest first.

The Reports view (Projects tab → Reports) offers the presets this month,
last month, year to date, last 12 months, all time and a custom range -
computed in the browser and sent as `from`/`to` - a KPI row, a bar per group
(one hue, the tail past twelve folded into "other"; plain markup, no
library), the table with totals, **Export CSV** (`GET
/api/costing/report.csv?…`, one line per group plus `TOTAL`) and **Print
report** (`GET /api/costing/report/print?…`, server-rendered, every string
escaped, no script, like the quote page).

## The Prints view

Every ledger row, newest first, paged server-side (`GET /api/costing/prints`
below) with filters for date range, printer, type, outcome, assigned /
unassigned, project, client, source (watched by the Hub / imported) and a
file-name search (`*` wildcard, case-insensitive). Rows are multi-selected
(per row or the page at once) and acted on in bulk: assign to a project or
unassign, don't count, count. **Assign by file name** previews how many
prints match a pattern (and lists a sample) before assigning them all; by
default only unassigned prints are touched. The job card's pending
assignment is unchanged: the next finished print of that file still lands in
the project picked there.

## State

| File | Content | Cap |
|---|---|---|
| `prints.json` (beside config.json, gitignored) | `{ prints: [row…] }` — the ledger, in `at` order. Row: `id, at, printer_id, printer, file, type, outcome (done\|cancelled\|error), project_id, job_id, bundle_id, seconds, seconds_source (actual\|hub-clock\|history), est_minutes, est_source (slicer\|printer-meta), material { grams, grams_source (deduction\|slicer\|printer-meta\|history), material, density, density_assumed, filament_mm, cost, source, partial, progress, slicer_cost, heads[], misses[], deducted_g }, energy (null \| { kwh, source }), pieces, counted, note, autofill { at, result, still_blank }, done_twice, history_job, history_status, source ("history" on an imported row; absent on one the Hub watched), imported_at`. | 10,000 rows (`U1HUB_COSTING_LEDGER_MAX`), oldest dropped; see "The cap" above. |
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
| POST | `/api/costing/import` | `{ full }` | reads every printer's job history into the ledger, paced; answers `{ printers[] { idx, name, type, status (ok\|offline\|error\|capped), pages, seen, imported, matched, known, skipped }, imported, matched, known, skipped, pages, requests, errors, offline[], dropped, ms, min_gap_ms }` when done; 409 while one runs |
| GET | `/api/costing/import` | | `{ running, last, interval_ms, boot_ms, page, settle_ms }` |
| GET | `/api/costing/projects` | | `clients[]`, `projects[]` (each with a `summary` brief), `pending`, `unassigned[]` (newest 30), `unassigned_total`, `ledger_total`, `imported_rows`, `sources` (tally of every row's grams/time/material/machine/energy source), `blank_rows`, `backfill { running, last }`, `import { running, last, interval_ms, page }` |
| POST | `/api/costing/clients`, `/clients/update`, `/clients/remove` | `{ name, email, notes }` / `{ id, … }` | 409 on removing a client that still has projects |
| POST | `/api/costing/projects`, `/projects/update`, `/projects/remove` | `{ name, client_id, state, charged, deadline, notes }` | removing a project frees its prints to unassigned |
| POST | `/api/costing/items`, `/items/remove` | `{ project_id, kind, label, minutes \| cost }` / `{ project_id, id }` | the full project view |
| GET | `/api/costing/prints` | `?from&to&printer&type&outcome&assigned=1\|0&project&client&q&source=hub\|history&offset&limit` (`unassigned=1` = `assigned=0`; `from`/`to` epoch ms or an ISO date, `[from, to)`; `printer` index or name; `q` substring of the file name, `*` wildcard; `limit` 1-1000, default 200) | `prints[]` newest first, each with `cost`; `total` (matching rows), `offset`, `limit`, `ledger_total`, `ledger_max`, `filters` (as parsed), `facets { printers[], types[], materials[], outcomes[] }` |
| POST | `/api/costing/prints/assign` | `{ print_id, project_id \| null }` | |
| POST | `/api/costing/prints/update` | `{ print_id, counted, pieces, note }` | |
| POST | `/api/costing/prints/bulk` | `{ print_ids[], project_id \| null, counted }` (either key; at most 10,000 ids) | `{ updated, missing }` |
| POST | `/api/costing/prints/match` | `{ pattern, project_id \| null, only_unassigned (default true), apply (default false) }` | `{ preview, matched, sample[] }`; with `apply`, `applied` too |
| GET | `/api/costing/report` | `?from&to&group_by=client\|project\|printer\|type\|month\|material\|outcome&tz_offset_min` | the report above plus `groupings[]`; 400 on an unknown grouping |
| GET | `/api/costing/report.csv` | same | UTF-8 BOM + one line per group + `TOTAL` |
| GET | `/api/costing/report/print` | same | the printable page, server-rendered, every string escaped, no script |
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

And **one `ctx.provide("resources.priceFor", …)` line** at the end of
`register()` (2026-10-06): a multiACE print's colours priced from the roll the
shelf matches, through resources' own `matchSpool` and `readShelf`, so the
colour-matching rule (ΔE ceiling, colour map, orphan handling) stays in one
place. Missing, multiACE rows simply keep the flat / slicer price.

## Roadmap

- **v2**: Shelly Wh sampling at `print.started` / `print.done` into
  `energy.kwh` (`"metered"`); average watts learned from those samples; a
  `project_id` on Dispatch jobs and bundles so a bundle's prints auto-attach;
  the `quoted` state as an estimate-only project ("convert to bundle" makes
  the Dispatch bundle); charged-vs-cost history on the client page; manual
  ledger rows for prints the Hub did not watch.
- ~~**v3**: Moonraker `/server/history/list` reconciliation per printer for
  prints the Hub never saw~~ — shipped as the import above. Still open:
  per-project failure-rate statistics feeding `failure_pct` from measurement
  (the report's `failure_share` is the raw number); invoices, if they are
  ever wanted, as their own module on top of this ledger; a cheaper save
  than rewriting the whole ledger file on every assignment once it nears the
  cap.

## Verification record

Recorded in the commits that introduced the module, the autofill and the
import/reports (`git log --grep "costing"`): the suite's pass count, the
falsified run going red (`U1HUB_COSTING_FALSIFY=1` flips the actual-seconds
expectation on the ledger row, the printer-metadata grams expectation, the
"second import brings nothing" expectation and one report total), the full
harness total, `scripts/check-core.js`, `scripts/check-index-js.js` and
`test/printer-sync-standalone.js`. No live hardware gate is needed for the
ledger itself. The Moonraker reads (`/server/files/metadata`,
`/server/history/list`, `/server/history/totals`) are the same endpoints
`core/fleet.js`, `modules/models.js` and `modules/logbook.js` already use
against real printers; the first backfill on the deployed Hub should log
`costing: backfill N blank rows checked, …`, the first import `costing:
import N jobs imported, …`, and the Projects tab's tally should show
`printer metadata` / `printer history` grams on rows that were blank. The
import's paging, pacing, dedupe and cap are exercised in the suite against a
U1 mock, a generic-Moonraker mock typed `kobra-s1` and an unreachable
printer; the Prints view and the Reports view were clicked through in a
browser (Playwright) against a throwaway Hub seeded the same way.
