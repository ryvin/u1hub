# Hub slicing with the owner's Snapmaker Orca profiles — research + design

Date 2026-10-05. Read-only research; no repo edits, no container restarts, no printer touched.
One feasibility slice was run into a scratch folder (`C:\Users\raul\AppData\Local\Temp\u1hub-slice-test`).
Scratch tools: `scratchpad/orca/flatten.js` (profile resolver), `scratchpad/orca/gate.ps1` (the owner's gate run, NOT executed).

## 0. Verdict in five lines

1. **Engine: the installed Windows Snapmaker Orca 2.4.0 CLI, driven by a small host-side worker** (Windows node, scheduled task at logon, long-polls the Hub). The Hub (Docker, Linux) resolves the owner's profiles itself from a read-only mount of `%APPDATA%\Snapmaker_Orca` and hands the worker fully flattened JSON; the worker only spawns the exe and copies gcode into the library.
2. **The CLI does not accept the owner's user profiles as they are**: they lack `"type"`, carry only delta keys, inherit renamed presets, and (the three big tuned ones) store 2.2-era per-flow arrays. The resolver fixes all four; the fourth is the probable cause of the one crash measured today.
3. **Supports**: default = exactly what the 3MF already says (project settings + per-object settings + painted enforcers/blockers all pass through the CLI untouched). The Hub only *adds* an override when the owner picks one, and never removes painted supports.
4. **Live gate still open**: the single allowed slice crashed (0xC0000005 at profile load, 2.15 s) *before* the shape fix; `gate.ps1` re-runs the same command with the fixed profile and is the owner's first step. Nothing ships ON before it passes.
5. **Linux-in-container (Snapmaker Orca 2.4.0 AppImage + xvfb)** is viable as a later drop-in behind the same worker contract; not first, because it needs an unofficial patched build or `--allow-newer-file`, xvfb, a ~1 GB second image, and gains nothing the Windows path lacks.

## 1. Measured facts

| Fact | Evidence |
|---|---|
| Live Orca = **E:\Program Files\Snapmaker_Orca\snapmaker-orca.exe, ProductVersion 2.4.0** (DLL 2026-09-17). `C:\Program Files\Snapmaker_Orca` is a stale 2.2.1-base install (Dec 2025). Hub config already points at E: (`data/config.json` → `slicer.orcaExe`). | `Get-CimInstance Win32_Process` showed all 5 running `snapmaker-orca.exe` from E:; `VersionInfo` → `ProductVersion : 2.4.0`; `user_backup-v2.4.0` dated 2026-09-22 |
| Snapmaker Orca reports `"version": "01.10.01.50"` in `Snapmaker_Orca.conf` — a legacy BambuStudio constant, not the product version. It is the reason upstream u1hub wrote off this CLI (`modules/slicing.js:3-5`). | Snapmaker/OrcaSlicer PR #839 body: `Version Check: File Version 2.3.0.6 not supported by current cli version 01.10.01.50` |
| **`--allow-newer-file` bypasses that version check on 2.4.0.** | my run's log: `the first file is a 3mf, version 2.3.0.6, got plate count 1` after the flag; CLI source `if (!allow_newer_file && (...maj/min...))` (`/mnt/e/Code/OrcaSlicer-FullSpectrum/src/Snapmaker_Orca.cpp:1425`) |
| PR #839 (version check) is still **open**; PR #947 (null-GUI crashes in `PartPlate::expand_plate_extruders` / `generate_plate_name_texture`) **merged 2026-09-30 into main for 2.4.1** — the 2.4.0 release still carries those crashes for some files. | `gh api repos/Snapmaker/OrcaSlicer/pulls/947` → `merged_at 2026-09-30`; #839 `merged_at null`; #839 comment 2026-10-02 |
| The GUI being open does **not** swallow a `--slice` run on 2.4.0: with 5 GUI instances open the CLI parsed args, loaded the 3MF and the machine profile. (Upstream's "single-instance forwarding eats CLI runs" note at `slicing.js:33-34` was about plain Orca 2.4.2.) | `slice.out` reached `loaded machine config ... inherits Snapmaker U1 (0.4 nozzle)` |
| `--help` prints nothing on both installs (exit 0, only a boost trace + sentry lines). The flag reference below therefore comes from source, not `--help`. | `scratchpad/orca/help-e.txt` (4 lines) |
| User profiles: 17 process, 8 machine, 211 filament files in `C:\Users\raul\AppData\Roaming\Snapmaker_Orca\user\default\`. **No `"type"` key, delta keys only, `"from": "User"`, `"inherits": <system name>`.** | e.g. HueForge process = 12 keys; Flexi-tuned = 324 keys |
| Snapmaker renamed its U1 presets (`0.20 Standard @…` → `0.20mm Standard @…`); the bundle resolves this with `renamed_from`. 12 of 17 user processes inherit the old names. | `resources/profiles/Snapmaker/process/0.20mm Standard @Snapmaker U1 (0.4 nozzle).json`: `"renamed_from": "0.20 Standard @…;0.20 Strength @…"` |
| Three tuned processes (Flexi-tuned, DisplayBoxes, Community BP; all `version 2.2.53.2`) store **39 speed/accel keys as 2-element arrays** (`process_flow_support: ["standard","high_flow"]`); the 2.3.6 GUI writes them as scalars into project_settings.config. | `flatten.js` diff: 47 shape mismatches vs the 3MF's own settings; 0 for the machine profile |
| Profile bundles: `%APPDATA%\system\Snapmaker.json` and `E:\...\resources\profiles\Snapmaker.json` are both `02.03.03.03`; `OrcaFilamentLibrary` `02.03.01.10`. The owner's filaments inherit `Generic PETG` etc. which resolve through `Snapmaker/filament/Generic PETG.json → Generic PETG @U1 base → fdm_filament_petg_category → fdm_filament_common`. | `flatten.js` chain output |
| Kobra S1: Snapmaker Orca ships the Anycubic bundle (`Anycubic Kobra S1 0.4 nozzle.json`, `0.20mm Standard @Anycubic Kobra S1 0.4 nozzle.json`); the owner's two Kobra processes inherit from it. | `ls E:\...\resources\profiles\Anycubic\{machine,process}` |
| Snapmaker publishes **Linux AppImage + flatpak** for 2.3.6, 2.4.0 (`Snapmaker_Orca_Linux_AppImage_Ubuntu2404_V2.4.0.AppImage`). Community: `djgringoboy2003/snapmaker-orca-cli` = 2.4.0 AppImage with #839 + PartPlate guards, run "headless under xvfb-run"; `3DCreationsByChad/orca-auto` (plain Orca, Xvfb :99, U1 multicolor, Moonraker queue). | GitHub releases API; both READMEs |
| Windows node is available for a native host worker: `E:\Program Files\nodejs\node.exe` v24.18.0. Precedent for a host helper: `scripts/sme-runner.js` + `scripts/sme-schedule-install.ps1` (WSL node via `wsl.exe`, Scheduled Tasks, `X-SME-Token`). | `where.exe node`; `scripts/sme-schedule-install.ps1:12-17` |
| Hub library pickup is automatic: `core/library.js` re-walks a type folder when its dir mtime moves, else every 15 s (`LIB_TTL_MS`, `core/library.js:117,163`). Gcode folders: `E:\Code\u1hub\gcode` (U1, 530 files) and `gcode\kobra-s1` (12). | `docker-compose.yml` volumes; `data/config.json` types |
| 3MF support data: process keys in `Metadata/project_settings.config`; per-object/part overrides in `Metadata/model_settings.config` (`<metadata key="enable_support" …>`); painted enforcers/blockers as the `paint_supports` triangle attribute in `3D/3dmodel.model` and `support_enforcer`/`support_blocker` volume types. Checked three library U1 files: all `enable_support 0`, `support_type tree(auto)`, threshold 30/35, no paint. | `bbs_3mf.cpp:277` (`CUSTOM_SUPPORTS_ATTR = "paint_supports"`), `:2651-2666`; `unzip -p … \| grep` |
| bl2u1 "carries supports" only by template choice: if the Bambu project's `different_settings_to_system` mentions `enable_support` it merges onto `u1_template_supports.3mf`, else `u1_template.3mf`; geometry (incl. paint attributes) is re-serialised from the parsed model. | `/mnt/e/Code/bl2u1/app.py:973-978` |
| Orca gcode carries what the Hub needs: `; total filament used [g]`, `; filament used [g] = a, b, c, d`, `; estimated printing time (normal mode)`, the full config tail (`; enable_support = …`, `; support_type = …`), and `;TYPE:<feature>` markers per extrusion block (parser.js already reads the first three: `parser.js:175-246`). | `gcode/10x10 Left Grid … .gcode` (Snapmaker Orca 2.2.4) |
| The CLI writes a structured **`<outputdir>/result.json`** (`error_string`, code) on every exit path — the worker reads that, not the log. | `Snapmaker_Orca.cpp:405-424` (`record_exit_reson`) |

### 1.1 The one test slice (verbatim)

Inputs: `tapo.3mf` = copy of `E:\3d\Snapmaker-U1\Snapmaker U1 - Tapo Camera Mount\U1 Tapo Camera Mount (Orca).3mf` (159 KB, native U1 project saved by 2.3.6, `0.20 Standard`, supports off). Profiles flattened by `flatten.js` **without** the shape fix: process `0.20 Standard @Snapmaker U1 (0.4 nozzle) - Flexi-tuned` (332 keys), machine `Snapmaker U1 (0.4 nozzle) - Calibrated Zoffest_04` (88 keys), filament `Elegoo PETG Rapid Black` (113 keys). Fresh `--datadir`.

```
E:\Program Files\Snapmaker_Orca\snapmaker-orca.exe --debug 3 --allow-newer-file --datadir <W>\datadir
  --load-settings "<W>\machine.json;<W>\process.json" --load-filaments "<W>\filament.json"
  --slice 0 --outputdir <W>\out <W>\tapo.3mf           (W = C:\Users\raul\AppData\Local\Temp\u1hub-slice-test)
```

Verified: `powershell Start-Process … -Wait` -> `exit=-1073741819 ms=2152` (0xC0000005), `out\` empty, `slice.err` empty, last log line
`Slic3r::CLI::run … :load setting file C:\Users\raul\AppData\Local\Temp\u1hub-slice-test\process.json, with rule 1`.
Sequence before the fault: version check passed (`got plate count 1`), 3MF parsed, `loaded machine config … name User, inherits Snapmaker U1 (0.4 nozzle)`.

Prediction scored: I wrote down 55 % clean / 30 % crash-in-PartPlate / 15 % config error. Outcome: crash, but earlier than predicted (profile load, not PartPlate) — a data-shape fault, not the known null-GUI one.

Diagnosis (no second exe run; the budget was one slice): the machine profile (0 shape mismatches, 4 unknown keys) loaded; the process profile (47 keys array-where-scalar, 9 unknown keys) faulted. Unknown keys did not hurt the machine file, so the arrays are the leading hypothesis. `flatten.js` now coerces to the shape of a project_settings.config the current app wrote (`SHAPE_ORACLE`): `remaining shape mismatches: 0`. **UNVERIFIED — to confirm, run (owner, any time, GUI may stay open): `powershell -ExecutionPolicy Bypass -File <scratchpad>\orca\gate.ps1`** and expect `exit=0`, `out\plate_1.gcode`, `result.json` code 0. If it still faults, the next bisect is the same command with `--load-settings "<W>\machine.json"` only.

### 1.2 CLI reference (from the Snapmaker-lineage source in the owner's fork; the flags the design uses)

`--slice N` (0 = all plates → `plate_1.gcode, plate_2.gcode…`; N = that plate), `--outputdir DIR`, `--load-settings "machine.json;process.json"` (one machine + one process, each needs `type`,`name`,`from`), `--load-filaments "f1.json;f2.json;…"` (position = extruder slot 1..n), `--allow-newer-file`, `--datadir DIR`, `--debug 0-5`, `--arrange 1`, `--export-3mf out.3mf` (slice_info with per-plate prediction/weight), `--export-settings out.json`, `--uptodate`, `--load-filament-ids`, `--skip-objects`, `--clone-objects` (loose-STL path only; projects use zip surgery as upstream does), `--pipe`. Priority: command line > loaded settings > 3MF (`Snapmaker_Orca.cpp:6129`). Definitions: `src/libslic3r/PrintConfig.cpp:7836-8306`; exit codes `src/libslic3r/Utils.hpp` (e.g. `CLI_FILE_VERSION_NOT_SUPPORTED -24`); `-1073741819` = Windows access violation.

How loaded settings interact with the 3MF (`Snapmaker_Orca.cpp:1700-1830, 2228-2420`):
- `from` must be `system`/`User`; a `User` file's **system name = its `inherits`**; the process's `compatible_printers` must contain the *machine's system name* or the run exits `CLI_PROCESS_NOT_COMPATIBLE` (`:2256-2300`). So keep `inherits` (direct parent) on every flattened file and `compatible_printers` on the process.
- Loaded keys are applied **on top of the 3MF's embedded full config** (`update_full_config`, `:2395-2420`; `inherits/compatible_*/name/from/type/version` skipped). A delta-only user file would therefore keep the 3MF's layer height etc. — flattening to the full key set is what makes "slice with HueForge" mean HueForge.
- The CLI's own `inherits` fallback reads `resources/profiles/BBL/{machine,process,filament}_full/` (`:1787, 2048, 2089, 2159`) — those directories do not exist in the Snapmaker install, so the CLI never resolves Snapmaker vendor inheritance itself.

## 2. Engine options

### (a) Windows Snapmaker Orca CLI + host worker — RECOMMENDED
- Exactly the binary and bundle the owner tunes in; profiles read live; no second slicer to keep in version lock-step.
- Hub (container) cannot exec it, so a worker on the PC does: `scripts/slice-worker.js` run by **Windows node** (`E:\Program Files\nodejs\node.exe`), registered by `scripts/slice-worker-install.ps1` as a Scheduled Task "U1 Hub slice worker" (At logon, Interactive, `-MultipleInstances IgnoreNew`, restart on failure) — same shape as the SME tasks. It long-polls `GET /api/slicing/next` with `X-Slice-Token`, spawns the exe with piped stdio (upstream's hardware-verified spawn discipline, `slicing.js:28-34`), reads `result.json`, copies gcode into the type folder, `POST /api/slicing/jobs/:id/result`.
- Measured cost of a failed start: 2.1 s. Slice time for the test file: UNVERIFIED (gate).
- Known 2.4.0 CLI defects and the mitigations: version check → `--allow-newer-file` (verified); PartPlate null crashes on some files (fixed in 2.4.1 main, #947) → surface `0xC0000005` honestly on the card with "retry after Orca updates to 2.4.1"; `--help` silent → irrelevant.

### (b) Linux Snapmaker Orca inside Docker
- Feasible: official `…AppImage_Ubuntu2404_V2.4.0.AppImage` (version parity with the GUI), `--appimage-extract`, `xvfb-run`, `shm_size 1g`, libwebkit2gtk/gstreamer; profiles via a read-only mount of `/mnt/c/Users/raul/AppData/Roaming/Snapmaker_Orca` and `/mnt/e/Program Files/Snapmaker_Orca/resources/profiles`; the same resolver.
- Costs: a second image (~1 GB; the Hub image is `node:22-alpine`, keep it that way), xvfb, the same #839/#947 defects (or an unofficial patched AppImage), nobody on this host has run it. Keep as the drop-in behind the same worker contract (section 5): a container worker that pulls jobs is indistinguishable to the Hub.

### (c) Others
- **Open in Orca + watch folder** (upstream `POST /api/slice/open-in-orca`, `slicing.js:715-760`; Models tab `Open in Orca`): keeps working for painting/manual work; it is not "slicing in the Hub".
- **Owner's fork `OrcaSlicer-FullSpectrum`** (0.9.4 lineage, mixed-colour): a custom build could carry #839/#947 and a CLI inherits fix, but it is 1.x-era and would have to be rebased onto 2.4.x first — not a path for this feature.
- **Plain OrcaSlicer 2.4.2** (upstream's Phase-1 engine): not installed here; its U1 profiles are not the owner's Snapmaker-bundle ones (`process_flow_support`, `dithering_local_z_*` keys would be unknown). Rejected.

## 3. Profiles: resolution, listing, sync, auto-pick

**Resolver (pure Node, in the Hub, unit-tested; `flatten.js` is the prototype):**
1. Search order by name: `user/default/<type>/<name>.json` → `%APPDATA%/system/<vendor>/<type>/` → `resources/profiles/<vendor>/<type>/`; match the filename, then the `name` field, then `renamed_from` (`;`-separated).
2. Walk `inherits` to the root, merge child over parent, drop `instantiation/setting_id/different_settings_to_system`, set `type`, `name`, `from: "User"`, keep the user's direct `inherits`, keep `compatible_printers`, set `print_settings_id`/`printer_settings_id`/`filament_settings_id`.
3. Shape-normalise to the app's schema: oracle = `Metadata/project_settings.config` of the newest library 3MF written by the running Orca version (its `version` field; the worker reports the exe version); array-where-scalar → element 0 (`standard` flow). Re-derive the oracle when the exe version changes.
4. Emit the three (machine, process, 1-4 filament) JSONs into the job payload; the worker writes them to its temp dir. The Hub never writes into `%APPDATA%`.

Mounts to add to `docker-compose.override.yml` (gitignored, host-specific — document in `docs/slicing.md`):
`/mnt/c/Users/raul/AppData/Roaming/Snapmaker_Orca:/app/data/orca:ro` and `/mnt/e/Program Files/Snapmaker_Orca/resources/profiles:/app/data/orca-bundle:ro`.

**Listing / UX.** `GET /api/slicing/profiles?type=u1|kobra-s1` → processes whose resolved `compatible_printers` ∩ {machines of that type's `printer_model`} ≠ ∅, each as `{ id: full name, label, base, layer_height, updated }` where label strips the `@Snapmaker U1 (0.4 nozzle)` and the layer prefix: "HueForge (0.08 Extra Fine)", "Flexi-tuned (0.20 Standard)", "flexi (0.16mm Standard)", "Lithophane", "Miniatures", "DisplayBoxes", "Multiboard (Strength)", … and for the Kobra "Conservative", "Standard - Copy". Machines likewise ("Snapmaker U1" base, "HueForge", "Calibrated Zoffest_04", "PETG Offset", "PETG VG", "Miniatures"); default machine = the user variant whose suffix equals the process suffix (HueForge↔HueForge, Miniatures↔Miniatures), else the system base. `updated` from the `.info` `updated_time`.

**Sync.** Read live from the mount on each listing (17+8+211 small files), cached 60 s, invalidated by the directory mtime. No snapshot to drift; "profiles as of <mtime>" shown on the dialog. One-way: the Hub never writes profiles.

**Filaments per head.** Default = the printer's loaded spools (spools/match modules already know vendor, type, colour per head): match a user filament profile by name, else by `filament_vendor`+`filament_type`, else fall back to the project's own `filament_settings_id[i]` resolved by name, else `Generic <type>`. Pass exactly the 3MF's slot count (U1: pad to 4, as upstream's `padFilamentArrays` does). Show the 4 chips with the chosen profile per head; editable.

**Auto-pick (rules first, SME optional).** Score and preselect: path/name contains `hueforge` or the 3MF's 3dmodel `Application` metadata says HueForge → HueForge (process + machine); `flexi` → Flexi-tuned; `litho` → Lithophane; `mini`/`miniature` → Miniatures; `multiboard` → Multiboard; `display box`/`box` → DisplayBoxes; else if the file's `print_settings_id` is one of the owner's → that; else the base `0.20mm Standard`. The dialog always shows why ("picked HueForge: file name"). SME tier-2 suggestion (`modules/advisor.js` already measures geometry and asks for settings; `/api/advisor/model`) can be offered as a button, not run by default (advisor rule 1: nothing leaves until pressed).

## 4. Supports

**How it is decided today, in order of precedence inside Orca:**
1. Painted support **enforcers/blockers** (`paint_supports` per triangle, `3D/3dmodel.model`) and enforcer/blocker modifier volumes — honoured whenever supports are enabled; blockers also cut auto supports.
2. **Per-object / per-part overrides** in `Metadata/model_settings.config` (`enable_support`, `support_type`, `support_threshold_angle`, …).
3. **Process-level keys** in `Metadata/project_settings.config` (or the loaded process): `enable_support` (0/1), `support_type` (`normal(auto)|tree(auto)|normal(manual)|tree(manual)` — `(manual)` = painted regions only), `support_style`, `support_threshold_angle` (30 in the Snapmaker bundle; the owner's PETG VG file carries 35), `support_on_build_plate_only`, `support_filament`/`support_interface_filament` (0 = same head), `support_object_xy_distance`, `support_top_z_distance`, `support_critical_regions_only`, `support_remove_small_overhang`. The owner's profiles all ship `enable_support 0`, `tree(auto)`, 30°.
4. bl2u1 conversions: supports "carried" only as the template choice above; the converted file's keys are then the template's.

**Hub handling:**
- Default **"Keep the file's"**: pass nothing; the CLI uses the 3MF (plus the chosen process — note a process override *replaces* the project-level support keys, so when the owner picks a process the Hub copies the 3MF's own `enable_support/support_type/threshold/on_build_plate_only` back on top unless an explicit choice says otherwise; per-object and painted data are untouched either way).
- Choices → explicit keys appended to the flattened process (priority 2) so the applied-echo (`; enable_support = …` in the gcode tail, upstream `slicing.js:530-553`) can prove them: **None** `enable_support=0`; **Tree (auto)** `enable_support=1, support_type=tree(auto)`; **Normal (auto)** `… normal(auto)`; **Build-plate only** adds `support_on_build_plate_only=1`; **Painted only** `support_type=tree(manual)` (offered only when paint is present). Threshold angle and support head exposed under "advanced".
- Needs-support hint from measured geometry (`modules/mesh3mf.js facts3mf`, surfaced by the advisor as `OVERHANGS: steep_pct / flat_unsupported_pct / floating_instances / bed_contact_pct`, `advisor.js:160-161`; the SME tiers already treat `steep_pct ≥ 25`, `flat_unsupported_pct ≥ 10`, `bed_contact_pct ≤ 20` as hard cases, `sme/core/tiers.js:24`): if the file has supports off and any of those thresholds trips, the dialog shows "⚠ 31 % of the surface overhangs >30°, supports are OFF in this file" and preselects nothing — the owner decides.
- **Painted supports are never removed**: the Hub never rewrites `3D/3dmodel.model`; "None" only sets `enable_support=0` (Orca then ignores paint), and the dialog says "this file has painted supports; None disables them for this slice only".
- After the slice: support material = Σ extrusion in `;TYPE:Support` / `;TYPE:Support interface` blocks × cross-section × `; filament_density`, from a streaming pass over the gcode (relative-E per the U1 flavour — confirm `M83` in the file; absolute-E fallback by delta). Shown as "supports: 4.1 g of 61 g (7 %)", plus the applied-echo chips. Time share is not in the header; show grams only (derive it, or omit it).

## 5. End-to-end flow

Models card (`public/modules/models-ui.js:295`) gains **Slice** beside *Open in Orca* →
dialog: printer (snapdragon/davinci/kobrakai → type), process (auto-picked, reason shown), machine variant, supports, plate (all / N from `platesFromModelSettings`, `mesh3mf.js:174`), heads (4 filament chips from loaded spools), copies →
`POST /api/slicing/jobs` → Hub validates, resolves profiles, queues → worker pulls, slices, writes `<name>[ -pN].gcode` into `gcode/` or `gcode/kobra-s1/` (never overwrite: non-colliding names, write `.part` then rename, as upstream and printer-sync do) → job card on the Slice tab (upstream `slicing-ui.js` pattern: states queued/preparing/slicing/moving/done/error, log tail, applied-echo, plates) → result: est. time + grams from the header (`parser.js:238`), support grams, **cost estimate** from the costing rates (expose `ctx.provide("costing.estimate")`, `modules/costing.js`), buttons: **Send to Dispatch** (`HubModules.fileAction`, `dispatch-ui.js:1419`), **Print on <printer>** (the library job card), **Print via multiACE** on davinci when the file uses >4 heads (`POST /api/multiace/preflight` then `/print`, `multiace.js:516-590`), **Advisor review** (GO/CHECK/STOP against the real loadout, `modules/advisor.js`), and the SME picks the file up on its next scheduled pass. A 3MF converted by bl2u1 slices like any other (its copy lives under `converted_u1/`).

Multi-plate: `--slice 0` → one gcode per plate, each its own job-card row (upstream already sorts/names `-pN`). Kobra S1: same dialog, Anycubic bundle profiles, output folder `kobra-s1`; a U1-saved 3MF retargeted to the Kobra needs `--arrange 1` (bed 220 vs 270) and is a gate item. Bambu-lineage 3MFs: run bl2u1 first (existing button), or upstream's U1-ify transplant (`slicing.js:186-219`) — keep both.

## 6. Recommended module layout (fork rules: feature module, one-line core entries, no version bump, standalone suite, no bare `.main`)

- `modules/slicing-orca.js` — fork module, feature flag `slicing-orca` (default **off** until the gate passes; `LITE_OFF`). Routes: `GET /api/slicing/profiles`, `GET /api/slicing/oracle`, `POST /api/slicing/jobs`, `GET /api/slicing/jobs`, `GET /api/slicing/next` (worker long-poll, token), `POST /api/slicing/jobs/:id/result`, `POST /api/slicing/jobs/:id/log`, `GET /api/slicing/status` (worker last-seen, exe version, mounts found), `GET /api/slicing/token`. Reuses upstream's zip helpers/transplant/clone by `require("./slicing.js")` (exports at `slicing.js:773`) rather than copying them; does **not** register upstream's routes (`slicing` stays off).
- `modules/orca-profiles.js` — the resolver (pure; reads the two mounts; exported for tests).
- `modules/gcode-features.js` — streaming `;TYPE:` extrusion summary (pure).
- `public/modules/slicing-orca-ui.js` — the Slice dialog on Models cards + the job list (own CSS prefix `.slo-`).
- `scripts/slice-worker.js` (Windows node), `scripts/slice-worker-install.ps1` (task install/uninstall/status), config `slicing: { orcaExe, token, roots: [{rel:"downloads/",host:"E:\\Downloads\\"},{rel:"",host:"E:\\3d\\"}], timeoutMs: 900000 }`.
- Tests: `test/slicing-orca-standalone.js` with `test/fake-orca-worker.js` (modes: ok / crash-0xC0000005 / version-refused / not-compatible / eaten / twoplate / timeout) and fixtures of three real user profiles + one bundle subset; **rule-6 falsify**: feed a 2.2-style array profile to the resolver with the oracle and assert zero mismatches, then remove the oracle and assert the mismatch count is 47 (a resolver that cannot fail is no resolver); feed a profile inheriting an unknown name and assert a loud 422, never a silent default.
- Safety: one job at a time (worker lock + Hub queue), per-job timeout kill, 3MF size cap for transfer (worker reads the file from the mapped host path, nothing is uploaded), temp dir per job cleaned, never writes under `E:\3d`/`E:\Downloads`, gcode never overwritten, jobs persisted (`slicejobs-orca.json`, gitignored), restart marks in-flight jobs error honestly (upstream pattern `slicing.js:329-340`).
- Docs: `docs/slicing.md` + rows in `docs/FORK.md` (feature table, diff table, live-gate table) + `core/config.js` / `core/modules.js` / `core/app.js` one-liners.

**Live gate plan (owner-run, in order):** (1) `gate.ps1` → exit 0 + `plate_1.gcode`; record ms. (2) Same file, HueForge process + HueForge machine; check `; layer_height = 0.08` and `; z_offset` in the tail. (3) A painted-support 3MF from the library with "Keep the file's" → `;TYPE:Support` blocks present. (4) A 4-colour native U1 project with heads from davinci's loadout → gcode `; filament_settings_id` matches. (5) A Kobra S1 project → `gcode/kobra-s1`, kobrakai lists it. (6) First real print of (1) on an idle U1, owner-started. Flip the default on in the commit that records these.

## 7. Risks / UNVERIFIED / questions

UNVERIFIED (commands given):
- The shape fix cures the 0xC0000005: `gate.ps1` (above).
- Snapmaker Orca 2.4.0's PartPlate crash (#947) on larger projects: run the gate on `E:\3d\converted_u1\0.4NOZZLE_AMS_5COLORS_Dragon+Dynasty (1)_U1.3mf` (open in the GUI right now; copy to the scratch folder first).
- `;TYPE:Support` / `;TYPE:Support interface` spelling in 2.4.0 output: `grep -c "^;TYPE:Support" <first supported gcode>`.
- Relative E in U1 gcode: `grep -m1 "^M83" <gcode>`.
- Orca auto-update changing the schema mid-stream: the worker reports `ProductVersion`; the Hub re-derives the oracle; add to the status card.
- Linux path: `docker run --shm-size 1g <ubuntu24 + AppImage> xvfb-run ./AppRun --allow-newer-file --slice 0 …` — never run here.

Risks: Snapmaker's CLI is not a supported surface (two open/just-merged crash fixes); the `01.10.01.50` constant may change meaning in 2.4.1 (keep `--allow-newer-file`, drop when #839 lands); the per-flow array format may return in a future bundle (the oracle handles either direction); the worker runs only while the owner is logged on (same as the SME); `E:` is a Windows mount, so gcode copies can hit transient `EACCES` (printer-sync saw it; retry once).

Questions for the owner (each changes the design):
1. Is it acceptable that slicing only works while this PC is logged on and Orca installed on E: (worker), or should it also work with the PC asleep (then the Linux container is the primary, not the fallback)?
2. When you pick a process (e.g. HueForge) for a file that already carries its own support/brim choices, should the file's choices win (proposed) or the profile's?
3. Heads: default to the printer's loaded spools (proposed) or to the colours the project defines?
4. Should the Hub ever use the SME/advisor to pick the profile automatically, or only the name rules with a visible reason (proposed)?
5. Is a sliced gcode allowed to land in the library without a review step, or should every Hub-sliced file get the advisor's GO/CHECK/STOP before "Print" is enabled?


## 8. Gate results measured by the lead, 2026-10-05 (supersede the guesses above)

Scratch folder: C:/Users/raul/AppData/Local/Temp/u1hub-slice-test (probe.ps1 runs one slice: -Tag -Exe -Data -File [-Settings]).

| Engine | Input | Result |
|---|---|---|
| Snapmaker Orca 2.4.0 (E:/Program Files/Snapmaker_Orca) | tapo.3mf, Fable's flattened machine+process | exit -1073741819 (access violation) in ~2.1 s |
| Snapmaker Orca 2.4.0 | tapo.3mf, NO --load-settings | same crash: the profiles are NOT the cause |
| Snapmaker Orca 2.4.0 | cube.3mf (bl2u1 Cube (2)_U1), empty or real (copied) datadir | same crash, last log line "plate 1, object bbox" (PartPlate) |
| Snapmaker Orca 2.3.6 portable | tapo.3mf, none / user profiles | same crash: the PartPlate CLI bug predates 2.4.0; fix is PR #947, merged for 2.4.1, NOT released (latest release v2.4.0, 2026-09-21) |
| Upstream OrcaSlicer 2.4.2 portable (SoftFever) | cube.3mf, no profiles | exit 0, 4.1 s, plate_1.gcode 1.29 MB |
| Upstream OrcaSlicer 2.4.2 | cube.3mf + user's Snapmaker machine.json (Calibrated Zoffest_04) | exit -100: "machine_start_gcode Parsing error at line 11: Not a variable name {if chamber_cooling_mode==0}" - Snapmaker-only variable |
| Upstream OrcaSlicer 2.4.2 | cube.3mf + UPSTREAM U1 (0.4 nozzle) machine (flattened chain fdm_klipper > fdm_toolchanger > fdm_U1 > U1) + user's flattened "0.20 Standard - Flexi-tuned" process | exit 0, 5.1 s; header: print_settings_id = ...Flexi-tuned, layer 0.2, outer_wall_speed 210, infill 8%, 2 walls, 17m 18s, 7.15 g |

Owner decisions (2026-10-05): engine on THIS PC via a helper (logged-on, like the SME); the 3MF's own support/brim choices win over the profile's; heads default to what is loaded on the chosen printer; show the GO/CHECK/STOP pre-flight on Hub-sliced files but do not block Print.

OPEN question to the owner (asked, not answered at compaction): build now on upstream OrcaSlicer 2.4.2 (upstream U1 machine profile + the owner's machine deltas ported where compatible, owner's process profiles resolved) and switch to Snapmaker 2.4.1 when it ships and its CLI passes, OR wait for Snapmaker 2.4.1. Caveat either way: paxx12 printers have only run Snapmaker-Orca gcode; diff the start-gcode blocks and gate the first prints with small watched test pieces.
