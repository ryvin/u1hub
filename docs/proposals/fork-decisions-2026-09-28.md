# DECISIONS - porting local 2.28.0 (printer-sync + palette bar) onto upstream 2.38.0 as a module

Read-only analysis, 2026-09-28. Evidence is `file:line` on `origin/main` (2345c89) unless
stated. Nothing was edited, committed, pushed or restarted. Anything not measured is
marked UNVERIFIED with the command that settles it.

## Situation (measured)

- Local `main` = c371cfe + 617655c (2.28.0 feature commit) + 10bc662 (.gitignore). Backup
  branch `backup/local-2.28.0-617655c` exists.
- `origin/main` = 2345c89 (2.38.0), 20 commits past c371cfe; 54 files, +5339/-350.
- `fork` remote exists: `git ls-remote --heads fork` -> `2345c89 refs/heads/main` (already a
  verbatim upstream mirror).
- Live: container `u1-print-hub` (image `u1hub-u1-print-hub:latest`, up 2 days) answers
  `/api/version` -> `{"version":"2.28.0"}`. `/api/fleet`: snapdragon printing 0% of a 4h27m
  file, davinci printing 90% of a 20h31m file (~2 h left), kobrakai OFFLINE. No ffmpeg in the
  image (`docker exec u1-print-hub sh -c 'command -v ffmpeg'` -> "no ffmpeg").
- `git merge-tree --write-tree origin/main backup/local-2.28.0-617655c` -> 9 conflicted
  files, all mechanical (see "Rebase" at the end).

## 1. Overlap with upstream 2.29-2.38: none

- `git grep -i "printer-sync|printable on|palbar|palrow|PALIDX" origin/main -- core modules public`
  -> zero hits for our features. The only `.pdot` upstream is the power-row dot
  (`public/index.html:347`, `public/app.js:2335`) - a CSS class collision with ours, not a
  feature overlap.
- The only printer-file readers upstream are printer->printer transfer (`core/library.js:474
  streamTransfer`, GET from source then multipart upload to destination), DELETE
  (`core/library.js:428`) and thumbnail fetch (`core/thumbs.js:179`). No printer->library pull.
- `/api/library-palettes` still exists upstream (`core/library.js:708`, inside
  `onModule("match")`), so the palette dots keep their data source unchanged.

Keep: all of printer-sync.js, the palette dots, the printable-on bar.
Change: rename our `.pdot` to something unique (e.g. `.psdot`) so it cannot restyle the power
dot (our rule adds a border; upstream's `.powerrow .pdot` sets none).
Drop from the port: the tip-footer removal. Upstream 2.38 still ships it
(`git grep -c "tipfoot" origin/main -- public/index.html` -> 5). It is not module-able as an
HTML deletion and it is the maintainer's tip link. If you still want it hidden on your farm,
the client module can inject `.tipfoot{display:none}` - one line, zero core diff.

## 2. Packaging "as a module": yes, with a 4-line core footprint

Upstream's module system, measured:

- Server modules: static `MODULE_TABLE` in `core/modules.js:22-69`; each file exports
  `register(ctx)`. `ctx` (`core/modules.js:117-160`) gives `app`, `hublog`, `fleet()`,
  `gcodeFolderFor`, `fileStat`, `printers`, `cfg`, `events`, `provide/use`. Our module already
  uses only that surface - it ports unchanged.
- Feature flags: `computeFeatures()` at `core/config.js:114-125` merges `config.json`
  `features` over `MODULE_DEFAULTS` **only for keys already in MODULE_DEFAULTS**
  (`if (k in f) f[k] = user[k] !== false`). A module not listed there can never be switched
  off and never appears in Settings. So the one-token `"printer-sync": ...` in
  `MODULE_DEFAULTS` (`core/config.js:100`) is required, not optional.
- Client modules: `CLIENT_TABLE` in `core/app.js:78-90` maps feature -> `/modules/<x>-ui.js`;
  `serveIndex` (`core/app.js:128-131`) injects a `<script>` for each enabled feature at the
  `<!-- @client-modules -->` marker and folds the file into the cache stamp. A client module
  calls `HubModules.register(name, { tab?, mount(el), onShow(), onFleet(fleet), fileAction })`
  (`public/app.js:1131-1163`); `fleetTick` pushes every fleet poll to `onFleet`. There is no
  list-render hook, but app.js is a classic script, so its top-level `function`s and `let`s
  (`renderList` :249, `matchFile` :973, `loadedHeadList` :967, `tparam` :50, `esc` :201,
  `FLEET`, `FILES`) are reachable by bare name from a later classic script; `margin-ui.js:99`
  already uses a `MutationObserver` on the job card the same way. Rows carry no `data-name`
  attribute (`public/app.js:285-300`), only `.jn` text = the file name.

Target layout (fork branch vs origin/main):

| File | Change | Rebase risk |
|---|---|---|
| `modules/printer-sync.js` | NEW, ported as-is (+ `.psdot` note n/a; + `fork` field in GET /api/printer-sync, see Q3) | none |
| `public/modules/printer-sync-ui.js` | NEW. Holds everything from our app.js/index.html diff: `refreshPalIdx`, `printableOn`, the bar (create `#palbar` after `#srcbar` in `mount`), row dots + filter applied after render by wrapping the global `renderList` (`const orig=renderList; renderList=function(){orig(); decorate();}`) or a `MutationObserver` on `#list`; injects its own `<style>` like `logbook-ui.js:36`; re-labels the Settings checkbox (`LBL[k]||k` at `public/app.js:2554` shows the raw key otherwise); registers `HubModules.register("printer-sync",{onFleet})` to redraw the bar on fleet ticks | none |
| `core/modules.js` | +1 line in `MODULE_TABLE` (before `updates`) | trivial, only when upstream appends there |
| `core/config.js` | +1 token in `MODULE_DEFAULTS` (:100), +1 token in `LITE_OFF` (:108) | conflicts every time upstream adds a module; 10-second resolve |
| `core/app.js` | +1 line in `CLIENT_TABLE` (:78) | same |
| `test/mock-moonraker.js` | keep our 12-line GET `/server/files/gcodes/<name>` hunk (auto-merged cleanly) | low |
| `test/printer-sync-standalone.js` | NEW: the SYNC section moved out of run-tests.js. It must boot its own Hub (`spawn(process.execPath,["server.js"],{env:{U1HUB_DIR:tmp,U1HUB_PORT:...}})` - `startHub` at `test/run-tests.js:145` is file-local, not exported) and `createMock("u1")` from `test/mock-moonraker.js` (exported). The mock is `.state.printState`/`.state.files` driven, same as our section already is | none |
| `package.json` | append `&& node test/printer-sync-standalone.js` to `test:standalone` | rare |
| `test/run-tests.js` | keep ONLY the `U1HUB_HARNESS_SKIP_SLICE` hunk (this clone has no private fixtures; without it the whole harness throws at :1892). Drop the SYNC and PAGE sections | low (mid-file, auto-merged this time) |
| `.gitignore` | append our 5 lines (Q6) | trivial |
| `docs/printer-sync.md` + `docs/FORK.md` | NEW: feature doc, fork rules, rebase recipe, harness count note | none |
| `README.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, `MISTAKES.md`, `server.js`, `public/index.html`, `public/app.js`, `update.json`, `package-lock.json` | **untouched** (take upstream) | none |

Net fork diff vs upstream: 4 new files, 4 one-line core edits, 1 mock hunk, 1 harness hunk,
1 package.json line, 5 gitignore lines.

## 3. Version: leave 2.38.0 exactly as upstream; never suffix, never bump

- Harness `test/run-tests.js:842`: `ok(/^2\.\d+\.\d+$/.test(EXPECTED_VERSION), "package.json version is sane")`
  -> `2.38.0+ryvin.1` or `2.38.0-ryvin.1` fails the harness. `:841` also pins server.js /
  index.html / package.json equal, `:2905-2907` pins update.json equal to package.json.
- `modules/updates.js:61-78 cmpVersion`: anything after `-` is a prerelease and sorts BELOW
  the core, so `2.38.0-ryvin` nags immediately against upstream's manifest.
- The checker fetches upstream's manifest by default (`modules/updates.js:33`
  `raw.githubusercontent.com/dlgambill/u1hub/main/update.json`). At `2.38.0` it is quiet now
  and nags on upstream's next release - exactly the "check latest updates" behaviour wanted.
  Bumping to 2.39.0 would silence upstream's 2.39.0.
- Not touching the four version files removes 5 of the 9 merge conflicts and keeps rule 4
  trivially true. Upstream now has `scripts/bump-version.js` for the atomic bump; we simply
  never run it.
- Fork identity goes elsewhere: `hublog("info","printer-sync (ryvin/u1hub fork) registered")`
  and `fork: "ryvin/u1hub"` in GET `/api/printer-sync`; provenance = `git describe --always`
  and the image tag (`u1hub-u1-print-hub:2.38.0-ryvin.1` is fine - Docker tags are not in the
  harness).

## 4. Default: OFF in MODULE_DEFAULTS until the live gate passes; in LITE_OFF

- Upstream convention: every new module ships `true` (models, margin, logbook at
  `core/config.js:100`) EXCEPT `slicing: false`, with the stated reason "the CLI path has no
  live hardware gate yet (Rule #1)" (`core/config.js:105-106`).
- printer-sync writes into the gcode library and pulls files through Moonraker on every
  printer - the same class of thing that OOM-killed Moonraker mid-print on 2026-09-14. Its
  mock harness is green; its live gate (Q10) has not been run. That is the slicing situation,
  so ship `"printer-sync": false`, flip to `true` in the commit that records the gate.
- LITE_OFF (`core/config.js:108`, "Lite = core + camera + power + dispatch") should include it:
  a Lite farm has no library-management ambitions.
- Deploy consequence: the first production pass copies every flat onboard file the library
  lacks (library currently 500 rows). Onboard counts are UNVERIFIED - the live Hub did not
  answer `/api/printer-files` in 20 s; measure when kobrakai is back with:
  `curl -s -m 60 "http://localhost:4545/api/printer-files?type=u1"` and compare names against
  `/api/files?type=u1`. If it is hundreds of files, seed over SSH (`cat`) first as the
  2026-09-14 entry recommends, or run the first pass with `U1HUB_SYNC_PAUSE_MS=10000` while
  watching Moonraker RSS.

## 5. MISTAKES.md entry: drop from the fork

Upstream's rule (CLAUDE.md "Only mistakes made in THIS repo") is about Danny's lanes; the
incident was a scratch script against your farm, not this codebase, and it already lives in
your ledger (module header cites "LESSONS 2026-09-14") and in the module's own header comment
(rules 1-5). Keeping it means a conflict on every upstream MISTAKES.md edit for no reader.
Put the two-paragraph version in `docs/printer-sync.md` under "Why the rules".

## 6. 10bc662 .gitignore: still needed, still correct

`git show origin/main:.gitignore | tail -25` has neither `docker-compose.override.yml` nor
`data/`, while upstream's own `docker-compose.yml` tells Docker users to `mkdir -p data gcode`
inside the clone. Conflict is both-keep. This is also the one PR-worthy hunk (Q7).

## 7. Upstream PR: not the module; maybe the two small fixes, issue first

- `gh pr list -R dlgambill/u1hub --state all` -> empty. Zero PRs in the repo's history; no
  CONTRIBUTING; README/CLAUDE.md never mention contributions
  (`git grep -i "pull request|contribut" origin/main -- README.md CLAUDE.md` -> only a CHANGELOG
  aside). The maintainer cuts releases through his own Claude lanes with a harness-count
  ritual (`scripts/bump-version.js` takes HARNESS_OLD/HARNESS_NEW).
- Do not open a cold module PR. Open an ISSUE describing printer-sync (what it does, the five
  rules, harness + live-gate evidence) and ask if he wants it; PR only on a yes, in his style
  (section in run-tests.js, count bump, CHANGELOG line), after Q10 passes.
- Two small, obviously-correct PR candidates: (a) `.gitignore` `data/` +
  `docker-compose.override.yml`; (b) `timelapse` missing from `MODULE_DEFAULTS` so it can never
  be disabled and captures with no `sf3dTimelapse` config (Q9). File (b) as an issue, not a PR
  - it is his pipeline.

## 8. Issues #3/#4/#5: confirmed

- #4 (dehart007-eng, camera freeze + 4K columns): maintainer commented 2026-09-25 "Both things
  are in v2.35.0"; commit fed42f4 body matches. Still OPEN.
- #5 (Makerworld import): commit 2345c89 "2.38.0: Convert to U1 on the Models tab (issue #5)";
  no comment on the issue after his 2026-09-25 "hang tight". Still OPEN.
- #3 (>4 colours): maintainer comment says fixed in 2.23.1; still OPEN.
Nothing to post now. Only worthwhile later: on #4, one line "confirmed on a 3-printer farm
running 2.38.0 with cameras on for N hours" - after you have actually run that.

## 9. Container rebuild: what a restart interrupts, and when

What a Hub restart does NOT touch: Klipper/Moonraker, the prints, the library on disk.

What it does interrupt:
- Dispatch: nothing lost. The 10 s tick re-adopts any printing machine holding a queued job
  (`modules/dispatch.js:1044-1068`, "a machine already printing when Dispatch/the Hub started
  gets adopted").
- Fleet events: "The first snapshot after boot only seeds memory" (`core/events.js:21`). A
  print that finishes INSIDE the restart window emits no `print.done` -> no ntfy, no spool
  auto-decrement, no logbook entry. So do not restart when a print is minutes from ending.
- Timelapse: the running 2.28.0 container has the 2.27 fetch-only module, so nothing is being
  captured now and nothing is lost by restarting. AFTER 2.38 boots, the module (present in
  `MODULE_TABLE` but ABSENT from `MODULE_DEFAULTS`, hence unconditionally on and impossible to
  disable via config - `core/config.js:100,123`) runs a 6 s "boot catch-up"
  (`modules/timelapse.js:728-745`) that starts chamber-camera capture for every printer already
  printing, with no `sf3dTimelapse` config gate on `capStart` (`:691`, `:361`). It opens a
  camera socket per printing printer, polls print_stats, writes JPEG frames to
  `data/timelapse-frames/`, and on `print.done` spawns `ffmpeg` (`:451`) - absent from the
  alpine image, so assembly fails open. On your farm that is camera load and disk for nothing.
  Fork-local fix (2 tokens): add `timelapse: true` to `MODULE_DEFAULTS`, then
  `"features": {"timelapse": false}` in `data/config.json`. Report upstream as an issue.
- Deploy plumbing: Dockerfile and docker-compose.yml unchanged since merge base
  (`git diff c371cfe origin/main -- Dockerfile docker-compose.yml` -> empty); package.json diff
  is the version line only (no new deps); all new files are under `modules/` and
  `public/modules/` (`git diff --name-status c371cfe origin/main | grep ^A`), which the
  existing COPY lines cover; `sf3d-logo.png` is only referenced via `config.example.json`
  relative to `U1HUB_DIR`, not a COPY gap. New state files (advisor.json, margin.json,
  models-attrs/links.json, logbook.json, timelapse-frames/, timelapse-pending/) all resolve
  under `BASE_DIR = U1HUB_DIR` (`core/log.js:47`) = `/app/data` bind mount - covered. No
  migration code added (`git diff c371cfe origin/main -- core modules server.js | grep -i migrat`
  -> empty). New features default ON: margin, logbook (harmless), timelapse (see above).

When/how:
1. `docker compose build` now (does not touch the running container).
2. `docker compose up -d` in a window where neither printer is within ~15 min of finishing:
   either now (snapdragon 0% of 4h27m, davinci ~2 h out) or right after davinci completes.
   Downtime is the container swap (~10-20 s).
3. Verify: `curl -s localhost:4545/api/version` -> `{"version":"2.38.0"}`;
   `docker logs u1-print-hub | grep -c "failed to register"` -> 0; `/api/fleet` shows both
   machines printing (adoption); `/api/printer-sync` -> 404 until the feature is turned on.

## 10. printer-sync live gate: minimal, safe, on an idle printer only

Precondition: a printer that is idle by two routes (Hub `/api/fleet` state `standby`/`complete`
with no active file AND Fluidd) - davinci after its current print (~2 h), or kobrakai when it
is back online. Never the machine at 0% of a 4.5 h print as the pull source.

1. Throwaway Hub, not production: `U1HUB_DIR=/tmp/u1gate U1HUB_PORT=4546 node server.js`
   (or a second compose project name) with a config listing BOTH snapdragon (printing) and the
   idle printer, `"features": {"printer-sync": true}`, empty gcode folder.
2. Baseline Moonraker RSS on the idle printer over SSH (`ps -o rss,args -C python3`; follow
   the `snapmaker-safety` skill's print-state check first).
3. Upload ONE small gcode (< 100 KB, a name not in the library) to the idle printer through
   Fluidd. One file is nothing like the 250-file burst that OOM'd it.
4. `curl -X POST localhost:4546/api/printer-sync/run` -> expect `copied:[<name>]`,
   `busy:["snapdragon"]`, `offline:[...]`; the file exists in the tmp library at the exact byte
   size from `/server/files/list`; no `.part` left.
5. POST again -> `copied:[]`. GET `/api/printer-sync` lists the copy with the printer name.
6. Re-check RSS (expect no meaningful growth). Then delete the test file from the printer.
7. Record the result in docs/FORK.md; flip the default to `true` in that commit.

## Rebase / port steps (measured conflicts)

`git merge-tree --write-tree origin/main backup/local-2.28.0-617655c` conflicts in exactly:
`.gitignore` (both-keep), `CLAUDE.md` (harness count 730->750 vs upstream 971), `core/config.js`
(MODULE_DEFAULTS one-liner), `docs/CHANGELOG.md` (both-keep), `package-lock.json`,
`package.json`, `public/index.html` (only the two version lines), `server.js`, `update.json`.
Auto-merged: MISTAKES.md, README.md, core/modules.js, public/app.js, test/mock-moonraker.js,
test/run-tests.js.

Do NOT cherry-pick 617655c wholesale. Port by hand:

```
git fetch origin fork
git switch -c ryvin origin/main                       # integration branch; fork/main stays a mirror
git checkout backup/local-2.28.0-617655c -- modules/printer-sync.js test/mock-moonraker.js
git show backup/local-2.28.0-617655c -- test/run-tests.js | git apply --include='test/run-tests.js' -   # then delete the SYNC/PAGE sections, keep SKIP_SLICE
# hand edits: core/modules.js (+1), core/config.js (+2 tokens, printer-sync:false + LITE_OFF; optionally timelapse:true),
#             core/app.js CLIENT_TABLE (+1), .gitignore (+5), package.json test:standalone (+1)
# new files: public/modules/printer-sync-ui.js (from the app.js/index.html diff of 617655c),
#            test/printer-sync-standalone.js (SYNC section + own Hub/mock boot), docs/printer-sync.md, docs/FORK.md
npm ci
U1HUB_HARNESS_SKIP_SLICE=1 npm test        # expect 971 - 34 = 937 passed, 0 failed  (UNVERIFIED: run it)
node test/printer-sync-standalone.js       # expect the 13 SYNC checks green, and shown red once with the busy rule commented out (rule 6)
node scripts/check-index-js.js && node scripts/check-core.js
git push -u fork ryvin
gh repo edit ryvin/u1hub --default-branch ryvin        # optional; keeps fork/main = upstream
```

Each later upstream release: `git fetch origin && git rebase origin/main` on `ryvin`; expect
conflicts only in `core/config.js` (2 lines), `core/modules.js` / `core/app.js` (table tails)
and, rarely, `package.json` scripts or `.gitignore`.

## Open / UNVERIFIED

- Onboard-not-in-library file counts (drives Q4 deploy risk):
  `curl -s -m 60 "http://localhost:4545/api/printer-files?type=u1"` once kobrakai answers.
- Harness total after the port (937 expected with SKIP_SLICE): `U1HUB_HARNESS_SKIP_SLICE=1 npm test`.
- Whether the timelapse module's capture actually starts against your cameras on 2.38 (it
  should, by code): after deploy, `docker logs u1-print-hub | grep "timelapse: capture started"`.
