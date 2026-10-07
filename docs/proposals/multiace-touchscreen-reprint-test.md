# Test plan: make a touchscreen reprint of a multiACE file print the right colours

Date 2026-10-07. Owner runs the hardware steps on davinci; nothing here runs while a print
is on the bed except the read-only checks marked so.

## What we know (measured, davinci klippy.log)

- **The failure.** The touchscreen reprint of the VanGogh bookmark (2026-10-06 18:09 UTC)
  started with
  `SET_PRINT_TASK_PARAMETERS FILENAME="VanGogh…gcode" MAP_TABLE="[[0, 0], [1, 3], [2, 2], [3, 1], [4, 3]]"`
  — the touchscreen colour-matched the file's original 5-colour header onto the heads and
  mapped T1→head 3 and T3→head 1. The multiACE body uses T1/T2/T3 as **heads**, so yellow
  and blue swapped heads.
- **The working path.** The Hub's Reprint via multiACE (2026-10-07 13:54 UTC) sent
  `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=i MAP_EXTRUDER=i` ×4 and
  `SET_PRINT_USED_EXTRUDERS EXTRUDERS=1,2,3` **before** `SDCARD_PRINT_FILE`.
- **Order inside a touchscreen start.** The touchscreen's `SET_PRINT_TASK_PARAMETERS`
  (18:09:49.052) runs before `Starting SD card print` (.087); the file's own first line,
  multiACE's `SET_PRINT_PREFERENCES … FORCE=1`, runs after (.105) and is accepted. So a
  map set by the file's first lines would land **after** the touchscreen's map.
- **The map is read when used, not frozen at start.** `SM_PRINT_START_LINE` reads
  `printer.print_task_config['extruder_map_table'][index]` each call, and paxx's `SET_MAP`
  macro calls `SET_PRINT_EXTRUDER_MAP` at any time.
- **Unknown (the test settles it):** whether `SET_PRINT_EXTRUDER_MAP` is accepted *while
  printing* (multiACE needed `FORCE=1` for `SET_PRINT_PREFERENCES`, which hints the module
  refuses some changes mid-print), and whether the native T0-T3 handling honours a map
  changed after the print started.

## The fix being tested

Insert, right after multiACE's `SET_PRINT_PREFERENCES … FORCE=1` line of a processed file:

```
; multiACE: identity extruder map (a touchscreen reprint colour-maps the original header)
SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0
SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=1 MAP_EXTRUDER=1
SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=2 MAP_EXTRUDER=2
SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=3 MAP_EXTRUDER=3
SET_PRINT_USED_EXTRUDERS EXTRUDERS=<heads the file uses>
```

(If step 0 shows the command takes a `FORCE=1` parameter, add it to each line.)

## Step 0 — read-only, any time (no print effect)

1. On davinci over SSH, read how the module treats these commands mid-print:
   `grep -n "def cmd_SET_PRINT_EXTRUDER_MAP\|def cmd_SET_PRINT_USED_EXTRUDERS\|FORCE\|is_printing\|print_stats" /home/lava/klipper/klippy/extras/print_task_config.py`
   Record: does either command refuse while printing; does it take `FORCE`.
2. Note the installed multiACE engine version (`MULTIACE_VERSION` in
   `/home/lava/klipper/klippy/extras/ace.py`) for the record.
   *If step 0 shows a hard refusal with no FORCE, stop here: the in-file fix cannot work and
   the Hub's Reprint button stays the only correct path.*

## Step 1 — make a small processed test file (one short real print, ~10-15 min)

1. In Snapmaker Orca, slice **five 10 × 10 × 0.6 mm squares in a row, one colour each**,
   colours that are loaded in davinci's ACEs and visually distinct (e.g. black, white, red
   pink, orange, green), so a wrong head is obvious. Name it `mace-reprint-test.gcode`.
2. Hub → davinci card → **Check with multiACE** → **As sliced** → **Print via multiACE**.
   Watch it; this is a normal multiACE print. Note which square came out in which colour
   (expected: as sliced). It leaves the **processed** `mace-reprint-test.gcode` on davinci
   (and printer-sync copies it into the Hub library).

## Step 2 — the patched copy (desk work, Hub side)

1. Copy the processed file from the Hub library to `mace-reprint-test_idmap.gcode`.
2. Insert the block above right after its `SET_PRINT_PREFERENCES … FORCE=1` line (heads
   from the Hub card's reprint view for this file). Nothing else changes.
3. Upload it to davinci with the Hub's **Upload** (not Print).

## Step 3 — the test (davinci idle, owner at the printer)

1. Spools exactly as in step 1 (same slots).
2. On the **touchscreen**, start `mace-reprint-test_idmap.gcode`; accept whatever its
   colour-mapping screen proposes (that is the failure we are overriding).
3. While the first square prints, read (read-only):
   - `GET /printer/objects/query?print_task_config` → `extruder_map_table` should be
     `[0, 1, 2, 3, …]`.
   - davinci `klippylogs/klippy.log`: the touchscreen's `SET_PRINT_TASK_PARAMETERS … MAP_TABLE=`
     line, then the file's four `SET_PRINT_EXTRUDER_MAP` lines with **no error line** after
     them.
4. Watch every square: each must come out in the same colour as in step 1.
5. **Abort** (cancel on the touchscreen) at the first wrong colour or any error in the log.

## Pass / fail

- **Pass:** map reads identity mid-print, no errors, all five squares match step 1.
- **Fail (refused):** an error after `SET_PRINT_EXTRUDER_MAP`, or the map still shows the
  touchscreen's table → the in-file fix does not work on this firmware; keep using the
  Hub's Reprint via multiACE; record it in docs/multiace.md.
- **Fail (accepted but wrong colours):** the native tool change froze the map at start →
  same outcome as above.
- Optional control (only if the pass/fail is ambiguous): start the **unpatched**
  `mace-reprint-test.gcode` from the touchscreen; it should reproduce the wrong colours.

## Step 4 — if it passes, ship it

1. **Engine:** add the block to the processed-file writer in the multiACE web backend on
   davinci (the decay71 overlay, `ops/decay71_overlay` in E:\Code\multiACE; the
   preflight's "print preferences" prepend), with a test, deployed only with davinci idle;
   offer it upstream (decay71/multiACE).
2. **Hub:** the reprint view marks files that already carry the block ("touchscreen-safe");
   optionally a one-click "make touchscreen-safe" that patches an older processed file the
   same way and re-uploads it.
3. Record the result and the klippy.log lines in docs/multiace.md.

## Effort

Step 0: 5 min. Step 1: one ~15 min print. Step 2: 10 min. Step 3: ~15 min watched print.
Step 4: about half a day (engine change + test + deploy + Hub marker).
