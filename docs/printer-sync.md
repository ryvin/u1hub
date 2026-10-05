# printer-sync (fork module): the library keeps itself

A file that reaches a printer some other way (Orca sending straight to the machine,
a USB stick, another tool) shows up in the Hub only as a "printer only" row. You can
manage that row but can never pick it as a job. `printer-sync` closes that gap: every
`U1HUB_SYNC_MS` (default 60 s) it compares each printer's own listing with the
library and copies anything the library lacks.

Feature flag `printer-sync`. It ships **on** since its live gate passed on
2026-10-05 (see [FORK.md](FORK.md) → Live gates).

## Rules

1. One file at a time, with `U1HUB_SYNC_PAUSE_MS` (default 2 s) between files. Never a burst.
2. It never pulls from a printer that is printing or paused. A printer whose state is
   unknown or offline counts as busy.
3. It never overwrites. If the library already has a file with the same name but
   different bytes, that file is left alone and reported once under `skipped`.
4. The byte count is checked against the printer's listing before the copy takes
   its final name. A short or long copy is deleted, not kept.
5. Files in printer subfolders are ignored, because the library is flat.
6. No synchronous filesystem calls. The pass runs off a timer, and upstream found on
   2026-09-26 that a timer doing `statSync` on a share can stall the whole Hub.

## API

- `GET /api/printer-sync` returns `{ enabled, fork, intervalMs, pauseMs, lastRun, running,
  synced[], errors[], skipped{} }`.
- `POST /api/printer-sync/run` runs one pass now and returns `{ copied[], skipped[],
  busy[], offline[] }` when it finishes. The fork suite drives the module this way,
  so no check waits on the timer.

## Why the rules: 2026-09-14

To seed the Hub library, 444 gcode files were pulled from two U1s through
Moonraker's HTTP file API, back to back. After about 250 files, snapdragon's
kernel OOM-killed Moonraker (961 MB of RAM). This happened twelve minutes into a
print. Klipper kept printing, but the API, the Hub card and every poller went dark.
Nothing on the U1 restarts Moonraker: busybox init has no supervisor. It had to be
restarted by hand, without first reading the print state, because the only thing
that reports the print state was the thing that was dead.

Moonraker's memory grows while it serves large files in a burst, and the U1 has no
headroom. The pull had no pause between files and did not re-check the print state
before each file. Rules 1 and 2 exist because of that.

**First run on a farm with many printer-only files:** the first pass copies all of
them. That is still one at a time, but it is a long sequence. If a printer holds
hundreds, seed the library over SSH first (`cat` the files), or start with
`U1HUB_SYNC_PAUSE_MS=10000` and watch Moonraker's memory.
