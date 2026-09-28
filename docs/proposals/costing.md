# Project costing for prints — research + brainstorm

Scope: U1 Print Hub, `origin/main` at **v2.38.0** (local `main` is at 2.28.0 and was
not used). Read-only; nothing edited, committed or restarted. Sections A and B are
evidence (web sources cited by URL; code facts quoted from `git show origin/main:<path>`).
Section C is my recommendation. Anything I could not open is marked **UNVERIFIED**.

---

## Part A — Research (cited)

### A1. What goes into an accurate FDM print cost

The community formula is consistent across calculators and farm-software vendors:

    cost = material + electricity + machine time (depreciation + maintenance)
         + labour + failure allowance + packaging/shipping + overhead
    price = cost + margin, then grossed up for platform fees

| Component | How it is computed | Source |
|---|---|---|
| Material | grams × (spool price ÷ spool net weight). ~€0.02/g for €19.99/kg PLA; some add a ~1.1 "material efficiency" factor for waste. Each spool's *own* price should drive it — Spoolman-based calculators compute `used_g / spool_weight × spool.price` per spool. | [Flashforge guide](https://www.flashforge.com/blogs/news/3d-printing-cost-calculator-guide), [vechiato/spoolman-multi-spool-cost-calculator](https://github.com/vechiato/spoolman-multi-spool-cost-calculator) |
| Multi-material waste | Purge/flush, prime/wipe tower and failed prints. "If you're using a $25 spool but purging 50% of it, you are effectively paying $50 per kg"; purge can outweigh the model. | [XDA](https://www.xda-developers.com/multicolor-3d-printing-real-cost-waste-management/), [Snapmaker blog on purge](https://www.snapmaker.com/blog/what-is-purge-in-3d-printing/), [Prusa wipe tower](https://help.prusa3d.com/article/wipe-tower_125010) |
| Electricity | watts × hours × $/kWh. Desktop printers 100–150 W; enclosed/heated-chamber 200–400 W. **Snapmaker U1 spec: "Max Input Power: 1150 W (220-240 V~), 400 W (100-120V~)"** — that is a *peak*, not an average; average draw must be measured. | [Flashforge guide](https://www.flashforge.com/blogs/news/3d-printing-cost-calculator-guide), [Snapmaker U1 specs](https://www.snapmaker.com/snapmaker-u1/specs) |
| Depreciation | purchase price ÷ expected life hours. Examples: $2,000 / 5,000 h = $0.40/h; "$399 printer over 3,000 hours is $0.13/hr". | [JLC3DP](https://jlc3dp.com/blog/3d-printing-cost-calculator-how-to-estimate-3d-printing-cost), [LayerMath hourly rate](https://layermath.com/blog/3d-printing-hourly-rate) |
| Maintenance / consumables | nozzles, plates, belts as a per-hour reserve: "$0.05–$0.15 per print hour". | [LayerMath hourly rate](https://layermath.com/blog/3d-printing-hourly-rate) |
| Failure allowance | "If roughly 1 in 20 prints fails, set this to 5%"; "every 20 good hours also has roughly 1 wasted hour hidden inside it". | [Flashforge](https://www.flashforge.com/blogs/news/3d-printing-cost-calculator-guide), [LayerMath](https://layermath.com/blog/3d-printing-hourly-rate) |
| Labour | minutes × hourly rate; typical small job 5–15 min prep + 5–30 min post; LayerMath suggests $25–45/h for CAD/setup/post-processing and keeps it **separate** from machine time. | [Flashforge](https://www.flashforge.com/blogs/news/3d-printing-cost-calculator-guide), [LayerMath](https://layermath.com/blog/3d-printing-hourly-rate) |
| Platform fees | Etsy 2026: $0.20 listing, 6.5% transaction on item+shipping, US payment processing 3% + $0.25; offsite ads 12–15% when they apply. Effective ~9–10%. (Etsy's own fee page returned 403 to my fetch — figures are from third-party guides.) | [Craftybase](https://craftybase.com/blog/the-complete-guide-to-etsy-fees), [3dprintcostcalc](https://www.3dprintcostcalc.com/) |

### A2. Pricing methods farms and makers actually use

- **Cost-plus markup**: "150–300% markup on total cost … After Etsy's 6.5% transaction fee and payment processing, a 200% markup typically yields a 30–40% net margin." ([CraftsTrack](https://craftstrack.app/blog/how-to-price-3d-prints), [3D PrintForce](https://3dprintforce.com/blog/how-to-price-3d-prints))
- **True-margin math** (not markup): `price = cost / (1 − target_margin)`. PrintMargin's whole pitch. ([Gh0stW33d/PrintMargin](https://github.com/Gh0stW33d/PrintMargin))
- **Machine-hour rate**: "$2–4 per print hour for machine time" for seller FDM, "$5–8/hr" pro FDM, plus material, labour, fees. ([LayerMath](https://layermath.com/blog/3d-printing-hourly-rate))
- **Per-gram rate**: what the Hub already does (`sell_per_g`); calculators default £0.025/g cost. ([PrintCalc](https://printgauge.com/cost/3d-print-price-calculator/))
- **Minimum order fee**: "$10–15 is a fair minimum" to cover setup on low-material jobs. ([LayerMath](https://layermath.com/blog/3d-printing-hourly-rate))
- **Quantity breaks / rush fees**: present in quote engines as multipliers; no authoritative percentages found — treat as farm-specific settings.

### A3. Existing tools and what to take from them

| Tool | Cost model | Client/project grouping? | Takeaway |
|---|---|---|---|
| Orca/Bambu/Prusa slicers | Write `; filament used [g]` per extruder, `; filament cost`, `; total filament used [g]`, `; total filament cost`, `; estimated printing time`. Orca has per-feature lines incl. `; flush filament used [g]` (**UNVERIFIED upstream** — GitHub code search returned 0 for both Orca repos; the claim is from the search summary of [Orca issue #13005](https://github.com/OrcaSlicer/OrcaSlicer/issues/13005)). | No | The Hub already parses these (Part B). |
| Moonraker history | `GET /server/history/list`, `/job?uid=`, `/totals`. Job has `filament_used` (**mm**), `print_duration`, `total_duration` (s), `status` ∈ in_progress/completed/cancelled/error/klippy_shutdown/klippy_disconnect/interrupted, `metadata` (`filament_weight_total` g, `filament_weights` per tool, `estimated_time` s), `auxiliary_data` incl. Spoolman `spool_ids`. | No | Actual duration and actual filament per completed job, per printer. |
| Spoolman | Spool: `price`, `initial_weight`, `spool_weight`, `used_weight`, `remaining_weight`; Filament: `price`, `weight`, `density`. | No | The Hub imports `price`→`cost_per_roll` already. |
| OctoPrint Cost / CostEstimation plugins | cost per hour + per metre/kg; CostEstimation adds maintenance + depreciation. | No | Same three knobs; nothing per project. |
| PrintFarmHQ (paid, beta) | "true COGS, factoring in materials, printer depreciation, labor time, and commercial software licenses". | Orders/jobs | Confirms the component list. |
| 3D Print Manager (paid cloud, €0–39.99/mo) | "filament, electricity, machine time and failed prints", custom labour + markup; work orders connect **customer → items → specs → schedule**; quote/invoice PDF. | **Yes** (customer → work order) | Closest to the ask; the shape to borrow. |
| PrintFleet | "bill of materials for every print including filament consumed, machine time, electricity rate, and hourly rate". | Orders | BOM-per-print framing. |
| AutoFarm3D | "add print jobs to an order and track them as a group". | Orders | Order = group of jobs, like a Dispatch bundle. |
| PrintMargin, PrintQuote3D, 3D-Printing-Quote-Engine, Orhugo calculator (open source) | Same formula; PrintQuote3D saves quotes per customer; Orhugo exports quote as txt/PDF. | Partial | Nothing worth vendoring; the arithmetic is 40 lines. |

Sources: [SimplyPrint farms](https://simplyprint.io/print-farms), [PrintFarmHQ](https://printfarmhq.io/), [3dprintmanager.eu](https://3dprintmanager.eu/), [PrintFleet](https://www.printfleet.app/), [AutoFarm3D](https://www.3dque.com/autofarm3d), [OctoPrint CostEstimation](https://plugins.octoprint.org/plugins/costestimation/), [Moonraker history API](https://moonraker.readthedocs.io/en/latest/external_api/history/), [Moonraker metadata](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/), [Spoolman models.py](https://raw.githubusercontent.com/Donkie/Spoolman/master/spoolman/api/v1/models.py), [PrintQuote3D](https://github.com/g4l4xy/PrintQuote3D), [3D-Printing-Quote-Engine](https://github.com/Machine-Shop-Suite/3D-Printing-Quote-Engine).

### A4. Where the accurate numbers come from — slicer estimate vs actual

1. **Slicer estimate** (available before printing): grams per extruder, time. Orca charges flush to the extruder doing the purge, so per-slot grams *already include* purge — verified in this repo, see B2.
2. **Actual duration**: Moonraker `print_duration` per job, or the Hub's own `print.done` event which carries `durationSec` from the fleet snapshot.
3. **Actual filament**: Moonraker `filament_used` is **mm**, so grams need density × π(d/2)² per tool — and the per-tool split is not in the job record (only totals; Moonraker issue [#878](https://github.com/Arksine/moonraker/issues/878) reports inaccurate `filament_used` with T1 on multi-tool). Spoolman `used_weight` deltas are the alternative when Spoolman is the source of truth.
4. **Actual electricity**: a metered plug. The Hub already reads Shelly `aenergy.total` (Wh) — a before/after delta per print is a real kWh number, not a wattage guess.

Practical ranking for this farm: **slicer grams (purge-inclusive) at the actual spool's price** is the best material number (Moonraker's mm total is worse for a 4-toolhead machine); **`print.done.durationSec`** for time; **Shelly Wh delta** when a plug exists, else wattage × hours.

---

## Part B — What the codebase already has (origin/main v2.38.0)

All paths below are on `origin/main`; line numbers from `git show origin/main:<path>`.

### B1. Cost/price data that exists today

| Data | Where | Shape | Notes |
|---|---|---|---|
| Sell floor + flat filament cost | `modules/margin.js:34` `DEFAULTS = { sell_per_g: 0.12, cost_per_g: 0.02 }`; stored in `config.json` under `cfg.margin` | two numbers | **One farm-wide $/g**, not per spool. |
| Quote per file | `margin.quote()` (`modules/margin.js:50-64`): `cost = g × cost_per_g`, `min_plate = g × sell_per_g`, `min_unit = /qty from filename`, `per_hour` | pure fn, also `ctx.provide("margin.quote")` | Inputs are the file's slicer grams + `estimated printing time`. |
| "Sells for" rows (v2.29) | `margin.json` → `{ prices: { "u1:<file>": { price, pieces, grams, hours, cost, revenue, per_hour, per_g, margin, margin_pct, min_unit, below_floor, at } } }` | one row **per file**, latest wins, cap 2000 | Endpoints `/api/margin`, `/settings`, `/quote`, `/price`, `/price/remove`, `/table`, `/table.csv` (CSV = v2.30.1). `ctx.provide("margin.table")`. |
| Per-spool price and net weight | `resources.json` `inv[spool_id] = { remaining_g, net_weight_g, cost_per_roll, purchase_url, … }` (`modules/resources.js:206,740`) | per spool | Spoolman import writes `price → cost_per_roll`, `remaining_weight`, `weight` (`modules/spoolman.js:70-73`). |
| **Actual per-print material cost** | `resources.js:881-931 deductFor(ev)` on `print.done`: per head, grams from the file's parsed slots (through the printer's `mapTable`) → `cost = grams/net × cost_per_roll`; appends to `store.state.deductions` | `{ at, printer, printer_id, file, entries:[{spool_id,color_name,head,grams,before,after,empty,cost}], misses, grams, cost, cost_partial }` | **Capped at 200 records** (`DEDUCT_LOG_MAX`), undo-able, `GET /api/resources/deductions`. `cost` is `null` when a roll has no price — "never a guessed number". Cancelled prints deduct nothing. |
| Slicer per-slot cost | `parser.js:178,232` reads `; filament cost` per slot → `slicer_cost`; `total_cost` from `; total filament cost`; `tool_changes` from `; total filament change` | per file | Only meaningful if the slicer profile has prices set. |
| Print time estimate | `parser.js:301,330 estMinutes` from `estimated printing time (normal mode)` | per file | |
| Actual duration | `core/events.js:10,86` `print.done { printer, id, filename, durationSec }` (`durationSec: p.printDuration`) | per finished print | Also `print.cancelled`, `print.error`, `print.paused`, `print.started`. |
| Printer lifetime hours | `modules/logbook.js:117-121` fetches Moonraker `/server/history/totals` → `job_totals.total_print_time`, stores `L.hours[i]` | per printer | Proof the U1 firmware serves Moonraker history. Per-job `/server/history/list` **UNVERIFIED on U1**. |
| Metered power | `modules/power.js:42-48` Shelly `apower` (W) and `aenergy.total` (Wh) | per printer, live only | Not sampled or stored at print edges. |
| Print log | `printlog.json` = `{ "<slug>": { "<file>": <last-start ms> }, "__filaments": { <hash>: { file, type, ts, spools } } }` (`core/records.js:19-47`) | per file, last start only | **No per-print grams, time or outcome.** It is a "last printed" stamp, not a ledger. |
| Dispatch jobs / bundles | `modules/dispatch.js:1241-1249` job `{ id, file, type, qty, remaining, deadline, priority, bundle_id, multi, state, created, history:[{printer,ended,result:"complete"}], printing_on }`; bundle `{ id, name, deadline }` (`:1282`) | per job | Finished jobs **leave** `dispatch.json` (v2.14, `:340-386`) and `job.history` is "consumed by nobody". Only `result: "complete"` is ever written. Bundle = the nearest thing to a "project" today. |
| Logbook | `logbook.json` entries/tasks; comment `:33` "Deliberately not here: parts inventory, costs, work orders" | | Explicitly scoped costs out. |

### B2. Multi-material purge is already handled

`modules/resources.js:25-31`: "PURGE IS NOT ADDED ANYWHERE. Verified 2026-08-31 against real Orca 2.3.5 output: an 88-tool-change job reconciles to 0.01 g and a 1002-tool-change job to 0.01 g. Orca charges flush extrusion to the slot doing the purging, so per-slot grams already include it." `parser.js` keeps `unaccounted_g` as an integrity check only. So per-slot slicer grams are purge-inclusive material for costing; do not add a purge factor on top.

### B3. Module and state conventions (for the design)

- Feature modules: static `MODULE_TABLE` in `core/modules.js:22-71`; each exports `register(ctx)`; `ctx` gives `app, express, hublog, baseDir, cfg (live getter), saveConfig, fileInfo, fileStat, fleet, loadout, spoolShelf, events, printers, types, provide/use`. Cross-module data goes through `ctx.provide(key, fn)` / `ctx.use(key)` resolved at call time.
- Flags: `core/config.js:100 MODULE_DEFAULTS` (add `costing: true`), `:108 LITE_OFF` (add `"costing"` — margin is off in Lite too).
- UI: `core/app.js:79-88` maps module → `/modules/<name>-ui.js`; client calls `window.HubModules.register(name, { tab, mount, onShow })` (`public/app.js:1131-1143`); `margin-ui.js` shows how to hang a line under the job card (`jmeta` / `setMargin`).
- State files: plain JSON beside `config.json`, gitignored (`.gitignore` lists `margin.json`, `logbook.json`, `resources.json`…), written with `fs.writeFileSync` directly (logbook `:97` "Direct write, not tmp+rename: the state dir may be a share"). `Object.freeze`d defaults; numbers validated at the route with a 400 and a human sentence.
- Harness: `test/run-tests.js` (4579 lines, 750 checks); the margin section (`:4210-4289`) is the template — pure-function checks via `require(...)`, endpoint checks via `jget/jpost`, a `.gitignore` regex check, and a check that the UI script is injected when the flag is on. Rule 6: every new check shown red first.
- Docker: `Dockerfile:22-24` already copies `core`, `modules`, `public` — a new module needs no COPY change.

### B4. Inputs per print: have vs missing

| Input | Status |
|---|---|
| Slicer grams per slot (purge-inclusive), file time estimate, slicer cost | **Have** (`parser.js`, `ctx.fileInfo`, resources cache) |
| Actual grams per head at the actual spool's price | **Have, but only in the 200-deep deductions ring** and `null` when a roll is unpriced |
| Actual duration | **Have** on `print.done` (`durationSec`) — not stored anywhere |
| Outcome (done / cancelled / error) | **Have** as events — not stored per print |
| Which printer | Have (event `id`) |
| Electricity | **Missing**: no `$/kWh`, no per-printer watts; Shelly Wh is live-only, never sampled at start/done |
| Depreciation / maintenance per printer | **Missing**: no purchase price, life hours, or per-hour reserve anywhere |
| Labour rate / minutes | **Missing** |
| Failure allowance % / overhead % / platform fee % | **Missing** |
| Client, project, item assignment | **Missing** (bundles have a `name` and `deadline` only) |
| Reprints / failures tied to a job | **Missing** (`job.history` only ever gets `"complete"`) |
| A durable per-print ledger | **Missing** (`printlog.json` is last-start-per-file; deductions cap at 200) |

---

## Part C — Brainstorm and recommendation (mine)

### C1. Three approaches

**A. Tags on what exists.** Add a `project` string to margin rows and deduction records; a Projects view groups by tag.
- + Two days of work, no new state file.
- − Margin rows are per *file* (latest wins), deductions are a 200-deep ring, cancelled prints leave no record: totals silently decay and never include failures. Cannot carry labour, hardware or shipping. Dead end.

**B. Client → Project → Items, fed by a per-print ledger.** New module `costing` owning `projects.json` (clients, projects, line items) and `prints.json` (an append-only ledger written on `print.done` / `print.cancelled` / `print.error`, with actual duration, actual grams-and-cost from the deduction, slicer estimate as fallback). Prints attach to a project by dropdown on the job card, by `project_id` on a Dispatch job/bundle, or after the fact in the Projects tab. Rates live in `cfg.costing`.
- + Every number is either measured or a labelled estimate; failures are real rows, not a guess; non-print items are first-class; export is a flat CSV.
- − Two new state files and a ledger that grows (cap at e.g. 5,000 prints, oldest rolled into project totals).

**C. Quote-first.** A quote (items, quantities, rates) converts into a Dispatch bundle; the project *is* the quote; actuals reconcile against it.
- + Matches how a shop sells: quote, accept, print, invoice, compare.
- − Needs B's ledger underneath anyway, plus quote states, acceptance, revisions. Bigger surface than the ask.

**Recommendation: B now, with the two hooks C needs (a `project_id` on Dispatch bundles and a "quote" that is just a project in `state: "quoted"` with estimated items). C becomes a later phase, not a rewrite.**

### C2. Data model (`projects.json`, gitignored)

```jsonc
{
  "clients":  { "cl_x": { "id": "cl_x", "name": "Acme Toys", "email": "", "notes": "", "created": 0 } },
  "projects": { "pr_y": { "id": "pr_y", "client_id": "cl_x", "name": "Spring order", "state": "open|quoted|delivered|closed",
                          "charged": 240.00,            // what was/will be invoiced (null until set)
                          "deadline": null, "bundle_ids": ["bdl_…"], "notes": "", "created": 0,
                          "items": [                      // non-print line items
                            { "id": "it_1", "kind": "labor",    "label": "Support removal", "minutes": 45 },
                            { "id": "it_2", "kind": "hardware", "label": "M3 inserts x40", "cost": 6.20 },
                            { "id": "it_3", "kind": "shipping", "label": "UPS", "cost": 14.10 } ] } }
}
```

`prints.json` — the ledger, one row per finished/cancelled/errored print, written by the `print.*` listeners:

```jsonc
{ "id": "pt_…", "at": 0, "printer_id": 3, "printer": "U1-4", "file": "Frog x10.gcode", "type": "u1",
  "outcome": "done|cancelled|error", "project_id": "pr_y" | null, "job_id": "job_…" | null,
  "seconds": 64577,                          // actual, from print.done.durationSec
  "est_minutes": 1076,                       // slicer, from ctx.fileInfo
  "material": { "grams": 297.1, "cost": 5.94, "partial": false, "source": "deduction|slicer|flat",
                "heads": [ { "head": 0, "spool_id": "…", "grams": 120.3, "cost": 2.41 } ] },
  "energy":   { "kwh": 0.81, "cost": 0.12, "source": "metered|watts" } | null,
  "pieces": 10                               // qtyFromName(file), editable
}
```

Rules: cancelled/error prints get the **same** material row (they consumed filament — today `deductFor` skips them; the ledger should record grams from `slicer × progress` or the file total with a `partial: true` flag, and decide separately whether to deduct inventory). Reprints are simply more rows on the same project, so the project's real cost includes them; a `counted: false` toggle lets Danny absorb one into farm overhead instead of the client.

### C3. Cost model

Rates in `cfg.costing` (Settings block, all optional; an unset rate leaves that line **blank**, never zero — the resources module's "never a guessed number" rule):

```jsonc
"costing": { "kwh_rate": 0.16, "labor_rate": 30, "failure_pct": 5, "overhead_pct": 10,
             "min_fee": 10, "platform_fee_pct": 9.5, "platform_fee_fixed": 0.45,
             "printers": { "3": { "purchase": 1099, "life_hours": 5000, "maint_per_hour": 0.10, "avg_watts": null } } }
```

Per print (pure function, `costing.costOf(print, rates)`):

```
material  = Σ_heads grams_h × cost_per_roll_h / net_weight_g_h        (deduction)   — fallback grams × cfg.margin.cost_per_g (flat) — fallback slicer_cost
hours     = seconds / 3600                                            — fallback est_minutes / 60
machine   = hours × (purchase / life_hours + maint_per_hour)
energy    = metered_kwh × kwh_rate                                    — fallback hours × avg_watts / 1000 × kwh_rate
direct    = material + machine + energy
```

Per project:

```
prints    = Σ direct over ledger rows with counted ≠ false     (includes failed/cancelled rows)
labor     = Σ item.minutes / 60 × labor_rate  (+ per-print setup_minutes default, if set)
extras    = Σ hardware + packaging + shipping items
subtotal  = prints + labor + extras
failure   = (quoting only) direct_estimate × failure_pct       — omitted once actual failed rows exist
overhead  = subtotal × overhead_pct
cost      = subtotal + failure + overhead
```

Every line carries `source` so the summary can say "material: actual (3 of 4 heads priced)" or "energy: estimated at 250 W". `avg_watts` has **no default**: the U1's published figure is a 1150 W peak, so the Settings hint should say "measure it: Shelly Wh delta over one print ÷ hours" — the Hub already reads `aenergy.total`, so a v2 sampler at `print.started`/`print.done` turns this into a measured number per print.

### C4. Pricing helper (side by side, per project and per item)

| Method | Formula | Why show it |
|---|---|---|
| Markup | `cost × (1 + markup_pct)` | what most Etsy guides teach (150–300%) |
| Target margin | `cost / (1 − margin_pct)` | the number that actually preserves margin (PrintMargin) |
| Machine-hour | `hours × hour_rate + material + labor + extras` | LayerMath's $2–4/h framing; catches long-and-light plates |
| Per-gram floor | `grams × cfg.margin.sell_per_g / pieces` | Danny's existing rule — reuse `margin.quote` via `ctx.use("margin.quote")` |
| Minimum fee | `max(price, min_fee)` | setup on tiny jobs |
| Platform gross-up | `(price + fixed) / (1 − fee_pct)` | so the net after Etsy is the price you chose |
| Quantity breaks | per-unit price at 1 / 10 / 50 from the same cost, with labour amortised | one table, no extra state |

Beside them: **"sells for"** from `margin.table` for any file in the project (via `ctx.use("margin.table")`), and **charged vs cost → margin %** once `charged` is set. Nothing decides; the person picks, like margin.js.

### C5. UI

- **Projects tab** (`HubModules.register("costing", { tab: "Projects", … })`): client list → project list → project page with three blocks in the Logbook's order-of-need: summary (cost / suggested prices / charged / margin, each line with its `source`), the print ledger for this project (with "move to…", "don't count"), line items. Buttons: Export CSV (`/api/costing/projects/:id.csv`), Print quote (a printable HTML page — no PDF library).
- **Job card**: one row under the margin line — `project ▾` (recent projects first, "+ new"). Selecting stores `pending[type:file] = project_id`, so the next `print.done` for that file lands in the project; also settable on a Dispatch job/bundle (`project_id` field on `POST /api/dispatch/jobs`, `/bundles` — a small change in dispatch.js).
- **Unassigned prints** strip at the top of the tab: the last N ledger rows with no project, assignable in one tap. This is the honest path for a farm that starts prints from the printer's own screen.
- **Settings**: a "Costing" block for the rates above and a per-printer table (purchase, life hours, maintenance/h, average watts).

### C6. As a feature module

- `modules/costing.js` (server), `public/modules/costing-ui.js` (client), state `projects.json` + `prints.json` (add both to `.gitignore` and to `CLAUDE.md` rule 5's list), flag `costing` in `MODULE_DEFAULTS` and `LITE_OFF`, entry in `core/app.js` UI map, `MODULE_TABLE` entry **after** `resources` and `margin` (it `use`s `margin.quote`, `margin.table`, and listens on `print.*`).
- Endpoints: `GET/POST /api/costing` (rates), `GET /api/costing/projects`, `POST /api/costing/clients`, `POST /api/costing/projects`, `POST /api/costing/projects/update`, `POST /api/costing/items`, `POST /api/costing/prints/assign { print_id, project_id }`, `POST /api/costing/pending { file, type, project_id }`, `GET /api/costing/projects/:id` (summary + pricing), `GET /api/costing/projects/:id.csv`, `GET /api/costing/prints?unassigned=1`.
- Provides: `costing.costOf`, `costing.projectSummary`. Uses: `margin.quote`, `margin.table`, `resources.deductFor` result (the ledger should take the deduction record the resources listener already produced — simplest: resources emits `ctx.events.emit("filament.deducted", rec)` after `deductFor`, or costing calls `ctx.use("resources.deductFor")` itself; the former avoids a double deduction).
- Harness (new section, each shown red first): `costOf` on a fixture print with all sources (deduction / flat / slicer; metered / watts / none) and the **known-bad** cases — unpriced roll → `material.cost === null && partial`, no watts → `energy === null`, negative rate → 400; project summary math on three prints incl. one cancelled; pricing helper equals hand-computed numbers; gross-up round-trips; `print.done` on the mock fleet writes a ledger row with the real `durationSec`; assign/move/uncount; CSV header + one line per print; `projects.json`/`prints.json` gitignored; UI script injected when on and absent under `U1HUB_PROFILE=lite`; `HubModules.register("costing"` present in the client file.

### C7. Roadmap

- **MVP (one release)**: ledger on `print.*` events; clients/projects/items; rates; `costOf` + project summary with sources; job-card dropdown + unassigned strip; CSV export; harness section.
- **v2**: `project_id` on Dispatch jobs/bundles (auto-attach); Shelly Wh sampling at `print.started`/`print.done`; per-printer wattage learned from samples; quote state (`quoted` project = estimates only, "convert to bundle" creates the Dispatch bundle); printable quote/invoice page; charged-vs-cost history on the client page.
- **v3**: Moonraker `/server/history/list` reconciliation per printer (actual `print_duration`, `filament_used`) for prints the Hub did not watch; per-project failure-rate stats feeding `failure_pct` from measurement instead of a setting.

### C8. Open questions (each changes the design)

1. **Is a project one order (= a Dispatch bundle with a deadline) or a long-running account that spans many bundles?** Decides whether `project_id` lives on the bundle or the job, and whether bundles are auto-created from projects.
2. **Should failed/cancelled prints be charged to the client's project by default, or absorbed farm-wide?** Decides the default of `counted` on error rows and whether `failure_pct` is applied when actual failures exist.
3. **Do you want electricity measured (Shelly per printer) or is a typed wattage good enough?** Measured needs the sampler in v2 and a plug per printer; typed needs a number nobody has published for the U1 (only the 1150 W peak).
4. **Labour: a per-print default (setup minutes per plate) or only explicit line items?** Affects whether small orders get labour automatically.
5. **Output: CSV plus a printable quote page, or real invoices (numbering, tax, currency)?** The latter is a different feature.
