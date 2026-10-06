# ryvin/u1hub — what this fork adds, and how it stays rebased

This is a fork of [dlgambill/u1hub](https://github.com/dlgambill/u1hub). Everything
upstream ships is here unchanged. The fork adds three switches, all of them
feature modules, so that the diff against upstream stays small and every
upstream release rebases in a few minutes. (`timelapse` was a fork switch
until upstream 2.40 shipped its own; it is upstream's now.)

## What the fork adds

| Feature flag | Default | Lite | What it does |
|---|---|---|---|
| `printer-sync` | on | off | Copies gcode that lands on a printer some other way (Orca straight to the machine, USB) into the Hub library, one file at a time, never while that printer is printing. See [printer-sync.md](printer-sync.md). |
| `library-colors` | on | off | Color dots under each library row, and a "printable on" chip bar that filters the library to files whose colors are all loaded on a chosen printer right now. Client only. It reads the match module's `/api/library-palettes`. |
| `costing` | on | off | A print ledger (every finished, cancelled or failed print with its actual duration and its filament priced from the rolls that were loaded, else from the file, the printer's own metadata or its job history; plus every printer's own Moonraker job history imported, hourly, for prints the Hub never watched), clients and projects with line items, a cost summary where every line names its source, cited suggested rates per printer type for what you have not typed, a pricing helper, a filterable Prints list with bulk assignment, cost reports by client / project / printer / type / month / material / outcome with CSV and a printable page, and a printable quote page. Projects tab (Projects, Prints, Reports), a project dropdown on the job card, rates in Settings. See [costing.md](costing.md). |
| `multiace` | on | off | "Print via multiACE" for a U1 that [multiACE](https://github.com/decay71/multiACE) feeds from Anycubic ACE units (probed per printer: `/multiace/api/version` + `ace.api_version` 1). A loadout strip on the card; for a file that needs more than the four heads, the printer's **own** preflight analyses the original file and the card shows its mapping (tiers, ΔE), three plans with swaps / est. added time / est. purge top-up, and the spool moves a proposed plan needs (suggested, never made). Print = identity extruder map, then the engine rewrites, uploads and starts; 413 → the multiACE inbox + link. Records plan/swaps/purge on the costing ledger row; the SME's printer brief gets the ACE slots. See [multiace.md](multiace.md). |
| `bl2u1` | on | off | The Models tab's **Convert to U1** goes to the owner's [bl2u1 converter](https://github.com/ryvin/bambu-to-snapmaker-converter) (`bambu-to-u1-converter` on :8090) instead of upstream's template merge: the card's path is mapped to the host path bl2u1 mounts, bl2u1 writes `<name>_U1.3mf` to its own output folder (inside the models root here, so the copy appears on the tab). Not reachable, or not a Bambu file: upstream's template convert answers as before. Registered before `models` so its route runs first. See [bl2u1.md](bl2u1.md). |
| `sme` | on | off | A 3D-printing expert's scheduled review of every gcode file, family of variants, 3MF and printer — most-printed first — by Claude Code headless on the owner's own subscription (the runner on this PC, never the API key), routed to the cheapest model per difficulty, with lessons learned shared across projects and DRAFT Orca / Klipper changes a person applies by hand. ✦ SME badges on 3MF cards, print rows and the job card; an SME tab (reviews, printers, lessons); the runner token in Settings. The core (`sme/core/`) has no Hub dependency. See [sme.md](sme.md). |

Switch any of them from Settings → Features, or in `config.json`:

```json
"features": { "printer-sync": true }
```

`printer-sync` ships on: its live hardware gate passed on 2026-10-05 (recorded below).

## The whole diff against upstream

| File | Change |
|---|---|
| `modules/printer-sync.js`, `modules/costing.js`, `modules/costing-report.js`, `modules/sme.js`, `modules/multiace.js`, `modules/bl2u1.js` | new, server modules (`costing-report.js` is the pure report/CSV/printable-page half of costing, required by `costing.js`; not a feature module of its own) |
| `public/modules/library-colors-ui.js`, `public/modules/costing-ui.js`, `public/modules/sme-ui.js`, `public/modules/multiace-ui.js` | new, client modules |
| `sme/core/` (agent.md, knowledge.md, schema/tiers/lessons/family/claude/store/review.js, cli.js, CONTEXT.md) | new, the SME core: project-agnostic, no Hub dependency, shared state in `SME_HOME` |
| `scripts/sme-runner.js`, `scripts/sme-local-sources.js`, `scripts/sme-schedule-install.ps1` | new, the SME runner (host side) and its scheduled tasks |
| `test/printer-sync-standalone.js`, `test/costing-standalone.js`, `test/sme-core-standalone.js`, `test/sme-standalone.js`, `test/multiace-standalone.js`, `test/bl2u1-standalone.js`, `test/fake-claude.js`, `test/mock-multiace.js` | new, fork suites (part of `npm run test:standalone`), the fake `claude` CLI and the multiACE web-backend mock |
| `docs/FORK.md`, `docs/printer-sync.md`, `docs/costing.md`, `docs/sme.md`, `docs/multiace.md`, `docs/proposals/costing.md` | new |
| `core/modules.js` | +4 `MODULE_TABLE` entries |
| `core/app.js` | +4 `CLIENT_TABLE` entries |
| `core/config.js` | 5 keys in `MODULE_DEFAULTS` (`printer-sync`, `library-colors`, `costing`, `sme`, `multiace`), 5 in `LITE_OFF` |
| `modules/costing.js` | `ctx.provide("costing.prints", …)`: the ledger rows, read-only, for the SME's ranking and outcome history; in `record()`, `ctx.use("multiace.jobinfo")` copies a multiACE send onto the row (`row.multiace`) and adds its estimated swap time to `est_minutes` (fork-owned file, so not an upstream diff) |
| `modules/sme.js` | `loadoutLines()` appends the ACE slots from `ctx.use("multiace.loadout")`; `outcomeLines()` names prints that went via multiACE (fork-owned) |
| `Dockerfile`, `test/run-tests.js` `stageHub()` | `COPY sme ./sme` and its mirror in the harness: `modules/sme.js` requires `sme/core/` |
| `modules/resources.js` | +1 line in `deductFor()`: `ctx.events.emit("filament.deducted", rec)` after the deduction is saved, so the costing ledger prices a print from the record resources already made instead of deducting again. Reasoning in [costing.md](costing.md#rebase-footprint). |
| `test/mock-moonraker.js` | +4 routes and 6 state fields: `GET /server/files/gcodes/<name>` serves a stored file's bytes (printer-sync); `GET /server/files/metadata` answers from `state.metadata` and logs `state.metaRequests` when a test sets them (costing), placed before upstream's blank answer so every other test is unchanged; `GET /server/history/list` honours `start`, `order`, `since` and `before` and logs `state.historyRequests` (costing import paging) - with none of those parameters the answer is upstream's; `objects/query?configfile` answers `state.configfile` and logs `state.configRequests`, `GET /printer/info` answers `state.softwareVersion`, `GET /server/files/list?root=config` answers `state.configFiles` (sme), all three absent/empty for every other test; `objects/query?ace` answers `state.ace` and `/multiace/*` is delegated to `state.multiace` (test/mock-multiace.js) when a test sets them, 404 as before otherwise (multiace) |
| `test/run-tests.js` | `U1HUB_HARNESS_SKIP_SLICE=1` lets a clone without upstream's private slice fixtures run the rest of the harness. The skip is printed. |
| `package.json` | the fork suites are appended to `test:standalone` |
| `.gitignore` | `docker-compose.override.yml`, `data/` (Docker deploy state); `projects.json`, `prints.json` (costing state); `sme.json`, `sme-lessons.json`, `sme-runner.*`, `sme/knowledge.md.bak` (sme state); `multiace.json` (multiace state) |

`git diff origin/main..ryvin --stat` is the source of truth. If this table and
that command disagree, the command is right.

## Versioning

The fork **keeps upstream's version number exactly**, with no suffix and no bump:

- The harness requires `^2\.\d+\.\d+$`, so a suffix fails it.
- `modules/updates.js` treats `-anything` as a prerelease, which would nag straight away.
- A bump would hide upstream's next release from the in-app update notice.

To tell the fork apart, look at `GET /api/printer-sync` → `"fork": "ryvin/u1hub"` (when
the module is on), the Hub log line `printer-sync (ryvin/u1hub fork module) armed`,
and `git describe --always` for the deployed commit.

## Branches and remotes

- `origin` = `dlgambill/u1hub` (read-only for us). `fork` = `ryvin/u1hub`.
- `fork/main` is a plain mirror of upstream. The fork's work lives on **`ryvin`**.
- `backup/local-2.28.0-617655c` holds the pre-fork local commit. That commit called
  itself 2.28.0, which collided with upstream's own published v2.28.0.

## Taking an upstream release

```bash
git fetch origin
git switch ryvin && git rebase origin/main
# expected conflicts, all one-liners: core/config.js MODULE_DEFAULTS / LITE_OFF,
# the tails of MODULE_TABLE (core/modules.js) and CLIENT_TABLE (core/app.js),
# the one emit line in modules/resources.js deductFor() (keep it right after
# store.save()), rarely package.json "test:standalone" or .gitignore
npm ci
U1HUB_HARNESS_SKIP_SLICE=1 npm test     # read the printed total, then "N passed, 0 failed"
npm run test:standalone
node scripts/check-core.js && node scripts/check-index-js.js
git push --force-with-lease fork ryvin
git push fork origin/main:main          # keep the mirror current
```

Harness totals move with every upstream release, so this file does not record
them. Record the number the command printed in the commit that took the release.

## Deploying (this host: Docker, `u1-print-hub` on :4545)

A Hub restart does not touch Klipper or Moonraker on the printers. It does drop
the `print.done` of any print that finishes **inside** the restart window: no
notification, no spool deduction, no logbook entry. Dispatch re-adopts running
jobs within about 10 s. So restart when no printer is within ~15 min of finishing:

```bash
docker compose build && docker compose up -d
curl -s localhost:4545/api/version        # upstream's version string
curl -s localhost:4545/api/fleet          # every printing machine still printing
```

## Live gates

| Gate | Status |
|---|---|
| printer-sync against real printers | **passed 2026-10-05.** First pass on the live Hub: 24 files copied (13 from davinci incl. 108-163 MB gcodes, 11 from kobrakai), davinci's Moonraker answered `/server/info` 200 on every 10 s check during the pass, the printing snapdragon was listed busy and left alone, one same-name/different-bytes file was skipped (`Eye Tree Tray`). Two copies failed their final rename with `EACCES` on the Windows-mounted gcode folder (a fresh file briefly locked) and both succeeded on the next pass a minute later; no `.part` left. Default flipped to on in this commit. Moonraker RSS was not measured (no SSH used). |
| library-colors in a real browser against the live fleet | see the commit that introduced it |
| sme | no hardware gate needed: it reads three small JSON endpoints per printer (`objects/query?configfile=settings`, `/printer/info`, `/server/files/list?root=config`), cached ten minutes, and never writes to a printer. Run on the deployed Hub since 2026-10-04 (dry run, real runs, schedule installed: hourly at :50, `SME_BATCH=1` since 2026-10-05 to cut tokens to 25%). |
| multiace | **passed on davinci 2026-10-05/06**. A real preflight of a 22 MB 5-colour file returned the mock's report shape. The owner started the first real As-sliced print, and it completed (history `000131`, costing row annotated). The measured swap took 192 s, now the configured `swap_seconds`. The estimator over-counts swaps when the heads already hold the right spools: it estimated 5 swaps and 1 physically happened. Details are in docs/multiace.md "Verification record". Still open: the 413/inbox path on a larger file, and the firmware version over SSH. |
| costing | no hardware gate needed: it listens to events the Hub already raises, writes its own two files, and reads three Moonraker JSON endpoints that core and other modules already read live. The mock lifecycle (standby → printing → complete, printing → cancelled, done-twice, metadata and history backfill, the paged job-history import against a U1 mock, a generic-Moonraker mock typed `kobra-s1` and an unreachable printer) is in `test/costing-standalone.js`; on the deployed Hub the first boot should log `costing: backfill N blank rows checked, …` then `costing: import N jobs imported, …` (one page per printer per hour afterwards), blank rows should show `printer metadata` / `printer history` grams on the Projects tab, and the Prints view should list every past job from all three printers' histories marked "imported". **Deployed-Hub check still to run** (first boot after this lands): the import log line and the row count on the Prints view against `GET <printer>/server/history/list?limit=1` `count` per printer. |
