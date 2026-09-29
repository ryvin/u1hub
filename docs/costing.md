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
| Time | `print.done` carries `durationSec` (Klipper's `print_duration`) — `time_source: "actual"`. A cancelled/error row reads `printDuration` from the fleet snapshot at that moment; failing that, the Hub's own clock since `print.started` (`"hub-clock"`). | No actual: the slicer's `estimated printing time` (`"slicer"`). | The file has no estimate either. |
| Material grams | — | Always the slicer's per-slot grams (purge-inclusive, see `modules/resources.js`; `total filament used [g]` or the slot sum). A cancelled row scales by the fleet's `progress` when it reported one, and is flagged `partial`. | The file has no filament amounts. |
| Material cost | The resources module deducted the print: each head's grams at **that roll's** `cost_per_roll / net_weight_g` — `source: "deduction"`. `partial` when a head had no roll or the roll had no price; `cost` is **null** when no roll was priced (never the flat rate in disguise). | No deduction (print cancelled, auto-deduct off, file not in the library, no rolls recorded): grams x the margin module's `cost_per_g` (`"flat"`), else the slicer's own `filament cost` (`"slicer"`). | No grams, or no rate and no slicer cost. |
| Machine | — | hours x (`purchase / life_hours` + `maint_per_hour`) from the printer's block in Settings (`"depreciation+maintenance"`, or whichever half is set). | No time, or neither printer rate set. |
| Energy | A row with `energy.kwh` set (`"metered"`, v2). | hours x `avg_watts` / 1000 (`"watts"`) x `kwh_rate`. | No watts for that printer, or no `kwh_rate` (then the kWh shows, the cost does not). |
| Labour | — | line-item minutes (+ `setup_minutes` x counted prints) / 60 x `labor_rate`. | Minutes exist but no `labor_rate`. |

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
| `prints.json` (beside config.json, gitignored) | `{ prints: [row…] }` — the ledger. Row: `id, at, printer_id, printer, file, type, outcome (done\|cancelled\|error), project_id, job_id, bundle_id, seconds, seconds_source, est_minutes, material { grams, cost, source, partial, progress, slicer_cost, heads[], misses[], deducted_g }, energy (null \| { kwh, source }), pieces, counted, note`. | 5000 rows, oldest dropped. |
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
| GET | `/api/costing` | | rates (+ `printer_names`, `keys`, `printer_keys`, `fork`) |
| POST | `/api/costing/settings` | any rate keys; `""`/null unsets; `printers: { "<idx>": {…} }` | 400 names the offending key and its range |
| GET | `/api/costing/projects` | | `clients[]`, `projects[]` (each with a `summary` brief), `pending`, `unassigned[]` (newest 30), `unassigned_total`, `ledger_total` |
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
  prints started from the touchscreen while the Hub was down; per-project
  failure-rate statistics feeding `failure_pct` from measurement; invoices,
  if they are ever wanted, as their own module on top of this ledger.

## Verification record

Recorded in the commit that introduced the module (`git log --grep
"feat(costing)"`): the suite's pass count, the falsified run going red
(`U1HUB_COSTING_FALSIFY=1` flips the actual-seconds expectation on the ledger
row), the full harness total, `scripts/check-core.js`,
`scripts/check-index-js.js` and `test/printer-sync-standalone.js`. No live
hardware gate is needed: the module only listens to events the Hub already
raises and writes its own two files.
