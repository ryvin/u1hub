# 3D-printing SME knowledge base — print-farm review context

**Last refreshed: 2026-10-04** (all sources read on that date unless stated). Next scheduled refresh: monthly.

**Scope.** Two Snapmaker U1 toolchangers (4 toolheads, SnapmakerOrca profiles) running **paxx12's Snapmaker U1 Extended Firmware, not stock** — `snapdragon` on v1.6.0-paxx12-22 (base 1.6.0.267), `davinci` on v1.5.2-paxx12-21 (base 1.5.2.13) with the **multiACE** extension feeding it from an Anycubic ACE (measured read-only on the printers 2026-10-04 by the lead; see §2b). One Anycubic Kobra S1 + ACE Pro running Rinkhals (Moonraker shim over Anycubic "GoKlipper"). Mostly PLA (incl. Snapmaker PLA SnapSpeed), some PETG and TPU, multi-colour with prime tower. Products sold: display pieces, flexi animals, bookmarks, signage. Priorities: quality, reliability, speed.

**How to use.** Each numbered section is self-contained and carries its own `[Sn]` source tags into §10, so a section can be refreshed without touching the others. Numbers taken from profile JSONs are the *shipped defaults* in the named release on the read date, not a recommendation. Anything marked **UNVERIFIED** could not be confirmed from a primary source and must not be presented to the user as fact. When reviewing a job: check §2/§3 machine limits first, then §6 filament limits, then §7 playbook, then §8 failure table.

---

## 1. Version snapshot (quick reference)

| Thing | Current (2026-10-04) | Source |
|---|---|---|
| Snapmaker U1 firmware — **installed** | `snapdragon`: **v1.6.0-paxx12-22** (base 1.6.0.267_20260815150420, released 2026-09-07); `davinci`: **v1.5.2-paxx12-21** (base 1.5.2.13_20260722102206, released 2026-08-02) + multiACE | lead's on-printer read 2026-10-04; [S10][S50] |
| Snapmaker U1 firmware — stock latest | **V2.0.0** (2026-09-15, official wiki); V1.6.0 (2026-08-25) | [S51] |
| paxx12 Extended Firmware — latest | stable **v1.6.0-paxx12-22** (2026-09-07); rolling `v2.0.0-paxx12-develop` on base 2.0.0.205 (2026-09-09, pre-release); repo 1,022 stars, last push 2026-10-01 | [S10][S50] |
| multiACE (davinci) | **v1.11b** (2026-09-29); v1.20b-pre (2026-10-03); installed version on davinci **UNVERIFIED** | [S57] |
| SnapmakerOrca | **v2.4.0** (2026-09-21); V2.3.6 (2026-08-31); v2.3.5 (2026-07-15); v2.3.4 (2026-06-11) | [S2] |
| OrcaSlicer (upstream) | **v2.4.2** (2026-07-07); 2.4.1 (06-28); 2.4.0 (06-20); 2.3.2 (03-23) | [S19] |
| Rinkhals | **20260901_01** (2026-09-01); prior stable 20260716_02, 20260606_02 | [S13] |
| Kobra S1 stock firmware supported by Rinkhals | 2.7.0.9, 2.7.2.7 | [S14] |
| Klipper (upstream) | adaptive-PA fix is in Klipper **0.13.0 (20250411)**; U1 and GoKlipper are vendor forks, not upstream | [S29] |

---

## 2. Snapmaker U1

> **Read first.** Both U1s run paxx12 Extended Firmware on **base 1.6.0 / 1.5.2**, not stock V2.0.0. Anything below tagged **[stock ≥2.0.0 only]** is unavailable on this farm until the base is bumped (paxx12's rolling build tracks 2.0.0.205 but is a pre-release). §2b covers the extended firmware itself.

### 2.1 Hardware limits (official spec sheet Ver. 2025.09 and specs page) [S1][S3]
- Build 270 × 270 × 270 mm; max toolhead speed 500 mm/s; max acceleration 20,000 mm/s²; 4 toolheads; tool change ≈5 s (SnapmakerOrca machine profile sets `machine_tool_change_time` = 5) [S4].
- Hot end: stainless 0.4 mm standard, 300 °C max; "Max Flow for Hot End: 32 mm³/s" is footnoted as measured with **Snapmaker ABS at 280 °C**, i.e. not a PLA figure. Bed: PEI, 100 °C max. Main + auxiliary part-cooling fans.
- Materials: PLA, PETG, TPU, PVA, PCTG without cover; ABS/ASA/PA/PC/PET with Top Cover; CF/GF-filled with Top Cover + hardened nozzle.
- Sensors/automation: mesh bed leveling, accelerometer input-shaping calibration, pressure-advance ("flow") calibration, automatic toolhead-offset calibration, RFID, auto-feed, backup spool mode, air-print/run-out/power-loss detection, toolhead-swap error detection, plate presence/obstruction detection.

### 2.2 Hotend / nozzle options (official hotend guide) [S8][S9]
- Standard: 0.4 mm stainless. Optional: hardened-steel 0.2 / 0.4 / 0.6 / 0.8 mm, all rated 300 °C. Official store lists "Hot End for Snapmaker U1" with 0.2/0.4/0.6/0.8 hardened options (price seen in search snippet only — UNVERIFIED).
- **Liber High-Flow hotend** (Snapmaker × Phaetus, launched 2026-09-22): hardened-steel DLC nozzle; Snapmaker claims +66 % flow on PLA, +87 % ABS, +43 % PETG HF vs the stainless hotend; USD 34.99 each / ≈119 for four. Requires firmware **≥ V2.0.0** and SnapmakerOrca **≥ 2.4.0** — **[stock ≥2.0.0 only]: not usable on snapdragon (1.6.0) or davinci (1.5.2) today**; stock V1.6.0 only added the "0.4 mm high-flow nozzle option" in toolhead info, the full flow-type gating is a 2.0.0 feature per the hotend guide. Set hotend type on touchscreen (Settings > Maintenance > Toolhead Info). **Not recommended** for CF/GF/wood-filled or any TPU. Files sliced "high flow" only print on a high-flow hotend (printer blocks a mismatch) — so do not slice with the `high_flow` process set for this farm.
- Rules from the guide: all four nozzles must be the same diameter in one job; 0.2 mm + TPU 95A HF not recommended; Dynamic Flow Calibration is unreliable at 0.2 mm; after any hotend change re-run **Multi-toolhead Offset Calibration** and **Heated Bed Leveling**. Hardened/multi-diameter support needs SnapmakerOrca ≥ 2.3.1 and firmware ≥ V1.3.0 [S7].

### 2.3 Enclosure / temperatures [S11]
- Official Top Cover: passive heat retention "up to 50 °C" with bed at 100 °C in 25 °C ambient within 30 min; internal-circulation (sealed, G3 + carbon + H12 HEPA) or external-exhaust mode; needs firmware ≥ V1.5.2 Beta (both farm printers qualify: base 1.5.2.13 and 1.6.0); pre-order USD 149, US delivery Nov 1–15 2026. No active chamber heater in stock firmware (paxx12 adds optional DragonBreath/Panda Breath 300 W heater support, §2b). PLA/PETG/TPU should run in exhaust mode (SnapmakerOrca start G-code switches `SET_PURIFIER_MODE` by `chamber_cooling_mode`) [S4]. The V2.0.0 fix for "waited for chamber heat while cover in exhaust mode" is **[stock ≥2.0.0 only]** — on 1.5.2/1.6.0 expect that wait if a cover is fitted.

### 2.4 Stock firmware timeline (newest first; dates from the official wiki [S51], notes from [S6][S7][S10])
- **V2.0.0 (2026-09-15)** **[stock ≥2.0.0 only — not on this farm]:** rainbow filament display; French; High-Flow hotend type gating; fixes: waited for chamber heat while cover in exhaust mode, `#`-prefixed G-code names crashing the system, LAN feed artifacts, wrong control-page coordinates; reduced "Timer too close" occurrences; pogo-pin false-pause fix. Wiki: calibration/leveling data retained, no recalibration needed after upgrade. SnapmakerOrca 2.4.0 release notes recommend firmware ≥ 2.0.0 [S2].
- **V1.6.0 (2026-08-25)** = snapdragon's base: 0.4 mm high-flow nozzle option in toolhead info; selectable filament types on the Filament Details page; AI issue report after print (cloud mode only); improved tip-forming on unload ("reducing the chance of failure caused by filament expansion"); faster load/unload; fixed Z 0.1 mm jog not responding; fixed resumed cloud jobs re-checking unused channels; top-cover wizard display fix (upstream changelog quoted in the paxx12 v1.6.0-paxx12-22 release [S10]).
- **V1.5.2 (2026-07-30)** = davinci's base (paxx12 shipped build `.13`): fixes over-squished first layer introduced in 1.5.0 and false nozzle-diameter-mismatch warnings; nozzle heater left on after load/unload fixed; full Top Cover support (wizard, Vibration Compensation recalibration prompt, fan control, usage statistics; needs SnapmakerOrca ≥ 2.3.5). paxx12 advised a **full calibration** after moving to 1.5.2 from any earlier 1.5.x [S10]. **V1.5.1 (07-03):** first layer over-compressed when bed leveling off. **V1.5.0 (07-01):** Top Cover features, auto-refill with different colours, TPU 90A + PLA Silk types, German/Hebrew.
- **V1.4.1 (06-11)** run-out/AI/RFID fixes; **V1.4.0 (05-25)** Skip Objects up to 64, LED-off; **V1.3.0 (04-14)** multiple nozzle diameters 0.2/0.4/0.6/0.8, hidden SSID; **V1.2.0 (03-23)** Skip Objects on screen, Ethernet, **Root (SSH) access**; **V1.1.1 (02-09)** bed-flatness deviation detection, PETG HF / TPU 95A HF types; **V1.1.0 (01-26)** selective flow calibration per toolhead, Z motor current up; **V1.0.0 (2025-12-31)** AI spaghetti/foreign-object detection, homing calibration; V0.9.4 (2025-12-16); V0.9.0 (2025-11-06). (The releasebot aggregator [S6] shows some of these a few days later; the wiki dates above are authoritative.)
- Firmware sources published 2026-03-30: `Snapmaker/u1-klipper`, `u1-moonraker`, `u1-fluidd` (≈20 % Klipper / >15 % Moonraker modified; proprietary modules behind defined interfaces) [S5].
- Not on this farm until base 2.0.0: Liber high-flow gating, rainbow display, the exhaust-mode chamber-wait fix, the 2.0.0 "Timer too close" and pogo-pin improvements. Not on davinci (1.5.2) specifically: V1.6.0's improved tip forming, faster load/unload, and SnapmakerOrca 2.3.6 time-lapse export (needs fw ≥ 1.6.0 [S2]).

### 2.5 SnapmakerOrca changes that matter [S2]
- **2.4.0 (09-21):** (release notes "recommend" firmware ≥ 2.0.0 — this farm is on 1.6.0/1.5.2; the standard-flow path still slices, only high-flow features are gated) High-Flow hotend parameters for selected filaments/processes (process presets carry `process_flow_support: [standard, high_flow]` with second speed set — **do not pick high_flow on this farm**); six new filaments (Snapmaker TPU, PEBA 90A, PLA Glow 0.6/0.8, PLA Rainbow, Support for PLA 0.2, PETG-CF 0.6/0.8); quality-tier presets merged into "Standard"; default value for small-area flow-compensation model; fixed Tree-Hybrid slicing hang at 70 % when base spacing 0; fixed multi-colour G-code colour loss.
- **2.3.6 (08-31):** time-lapse export (fw ≥ 1.6.0 — snapdragon yes, davinci no); spaghetti/foreign-object detection preferences; colour-mixing match mapping + "0.10mm Color Mixing" preset; PLA Full Spectrum; multi-filament bed temp now uses the **higher** value.
- **2.3.5 (07-15):** Top Cover controls; filament sync from printer; wipe tower gets an outer-wall opening; PVA added; PLA-CF/TPU profiles retuned; wipe-tower usage estimate and brim overlap fixes.
- **Open regression, issue #908 (filed 2026-09-23):** 2.3.5/2.3.6/2.4.0 insert a *dry* XY scrub inside `; CP TOOLCHANGE WIPE` (retract → dry moves → unretract). Fine PLA→PLA, but PLA↔PETG jobs smear and build up on the prime tower until failure; 2.3.4 does not emit it. Workaround reported: strip the dry moves from the G-code. **Review rule:** flag any mixed PLA+PETG job sliced with ≥ 2.3.5 [S12].

### 2.6 Shipped profile defaults (SnapmakerOrca main branch, read via GitHub API 2026-10-04) [S4]
- Machine `Snapmaker U1 (0.4 nozzle)`: retraction 1.5 mm @ 30 mm/s, Z-hop 0.4 "Auto Lift", wipe on, `retract_length_toolchange` 10 mm, `nozzle_type` hardened_steel, layer height 0.08–0.32, pause = M600. Tool-change macro: lift Z, wait `M109` for next tool temp, `M400`, `T<n>`, then `SM_PRINT_PREEXTRUDE_FILAMENT INDEX=n` (ooze purge); PVA drops accel to 3000. Start G-code runs `SM_PRINT_AUTO_FEED` + `SM_PRINT_FLOW_CALIBRATE` per used extruder, bed obstruction and toolhead-swap checks.
- Process `0.20mm Standard`: outer wall 200 mm/s (500 high-flow), inner 300 (600), sparse infill 270 (600), solid infill 250 (600); outer-wall accel 5000, default accel 10,000, first layer 50 mm/s @ 500 accel, travel 500 mm/s; wall order inner/outer/infill; seam **aligned**; wall generator **classic**; elephant-foot 0.1 mm; overhang slowdowns 50/30/10 mm/s; `support_type` tree(auto); `only_one_wall_top` 1.
- Prime tower defaults: enabled, width 30 mm, `prime_volume` 45 mm³, `wipe_tower_wall_type` **rib** with extra rib length 8, brim 5 mm, `ooze_prevention` 1 with `standby_temperature_delta` −150, `preheat_time` 30 s.
- Filament (Snapmaker PLA SnapSpeed @U1): 220 °C, bed 60/65 textured, **`filament_max_volumetric_speed` 12 mm³/s**, `filament_minimal_purge_on_wipe_tower` 15 mm³, PA 0.02 but `enable_pressure_advance` 0 (printer's own flow cal applies PA), min layer time 4 s. PLA Matte 220/12; PLA Silk 230, 12, retraction 0.4, flow 0.98, 8 s layer time; PLA-CF 230, 15, retraction 2; ASA 255 °C / bed 110, 8 mm³/s, fan 15 %, PA 0.04 enabled; TPU 95A HF category 200–250 °C, bed 35, PA off, min purge 15.

### 2.7 Official calibration procedures [S8][S37][S38]
1. Touchscreen Settings > Maintenance > Device Calibration: **Heated Bed Leveling**, **Vibration Compensation** (accelerometer input shaping), **Multi-toolhead Offset Calibration** (~15–20 min; re-run after hotend swap, nozzle collisions, or layer shifts between tools).
2. **Dynamic Flow Calibration** (Start > Next > Dynamic Flow Calibration before a job): measures and stores a pressure-advance value per extruder; V1.1.0 added per-toolhead selective runs. Not for 0.2 mm nozzles.
3. Because PA is set on-printer, leave `enable_pressure_advance` off in Orca for Snapmaker filaments unless deliberately overriding.

### 2.8 Community knowledge (label as community when quoting) [S36][S10][S39]
- Prime-tower waste: users run width 20–30 mm, `prime_volume` 15–18 mm³, minimal purge 10 mm³ (vs the 15 mm³ shipped for Snapmaker PLA; a 60 mm³ default was reported for some profiles). Keep rib wall and brim on tall multi-colour parts; the tower tipping is the usual failure.
- TPU on U1: direct drive works with 95A; users report success at 20–35 mm/s walls and 20–35 % fan; unloading TPU can throw an error (pulls through feeder); Snapmaker says load/unload TPU **manually**, not with auto-feed [S33]. On davinci, multiACE says TPU/TPE must go through **Normal Mode** (stock side feeders, no ACE) or a manual head [S57].

---

## 2b. paxx12 Snapmaker U1 Extended Firmware (what the farm actually runs)

Repo `paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware` (GPL-3.0, 1,022 stars, default branch `develop`, last push 2026-10-01, 64 open issues; docs at snapmakeru1-extended-firmware.pages.dev). Independent of Snapmaker; "damage attributable to custom firmware is not covered under warranty"; **reproduce any bug on stock before contacting Snapmaker support** [S50][S52].

### 2b.1 Version mapping (paxx12 tag → Snapmaker base) [S10][S50]
| paxx12 tag | Published | Base stock build | Notes |
|---|---|---|---|
| v1.6.0-paxx12-22 (**snapdragon**) | 2026-09-07 | 1.6.0 (`fullversion` hard-coded per PR #720; printer reports 1.6.0.267_20260815150420) | Firmware Upgrade Channel setting; DragonBreath heater; Bypass MCU (Disconnected); top-cover fans as `fan_generic`; SpoolLink "Force Generic Vendor"; Fluidd 1.37.4 / Mainsail 2.19.0; restored five PRs silently reverted by the 1.6.0 bump |
| v1.5.2-paxx12-21 (**davinci**) | 2026-08-02 | 1.5.2 build `.13` (printer reports 1.5.2.13_20260722102206) | SpoolLink + Filament Manager (`/filament/`); firmware-upgrade imposter blocking Snapmaker auto-update; camera res/fps settings; Fluidd 1.37.2 / Mainsail 2.18.2; **warns that SSH-installed extensions like multiACE/HelixScreen can break the firmware** |
| v1.4.1-paxx12-19/20 | 2026-06-11 / 06-23 | 1.4.1 | — |
| rolling `v2.0.0-paxx12-develop-<sha>` | 2026-09-09 (re-published on every push) | 2.0.0.205 | pre-release; adds HelixScreen as selectable GUI, "Max Speed" tweak tiers, OpenRFID OpenTag3D, DragonBreath 1.1.19; "not on a printer you depend on" |

Upgrade/downgrade = same USB path as stock (`Settings > About > Firmware Version > Local Update`, FAT32 `.bin`), or Firmware Config "Download from URL / Upload". Revert to stock by flashing Snapmaker's `.bin` from the wiki. The `Firmware Upgrade Channel` (`[components] upgrade: none|stable|testing|develop`) only matters when signed in to Snapmaker Cloud; `none` fails the check locally with no network call [S53].

### 2b.2 What it changes vs stock
- Root/SSH (`root`/`snapmaker`, `lava`/`snapmaker`; toggle in Firmware Config or stock Settings > Maintenance > Root Access), Fluidd **or** Mainsail at `http://<ip>/`, Firmware Config web UI at `http://<ip>/firmware-config/` (needs **Advanced Mode** on the touchscreen), remote screen `/screen/`, hardware-accelerated camera stack (WebRTC, RTSP optional, USB cam `/webcam2/`, internal fixed 1080p for AI detection), timelapse, Prometheus exporter `:9101`, Tailscale, OctoEverywhere, Apprise notifications, Spoolman/SpoolLink/OpenRFID, AFC-Lite stub (AFC panels in Fluidd mapping E0–E3 to `AUTO_FEEDING`), chamber-heater integration (DragonBreath/Panda Breath as `heater_generic`, `M141`/`M191` work), faulty-toolhead bypasses, Klipper tweaks [S52][S54][S55][S56].
- Stock behaviours **kept**: Snapmaker's Klipper/Moonraker forks, touchscreen UI (unless HelixScreen is chosen), AI detection, RFID, cloud. Stock resets `/etc` on every boot; `/home/lava/printer_data` always persists; `touch /oem/.debug` persists `/etc` changes but **every firmware upgrade deletes it** [S58].

### 2b.3 How overrides are meant to be done (do not edit printer.cfg) [S54][S55][S52]
- Drop files into **`extended/klipper/*.cfg`** and **`extended/moonraker/*.cfg`** (via the Fluidd/Mainsail Configuration tab); they are auto-included, persist across reboots and upgrades; keep the `00_keep.cfg` placeholders; "Invalid configuration will prevent Klipper/Moonraker from starting"; restart the service after edits. This matches what the lead saw on both printers (`extended/klipper/*.cfg`, `extended/moonraker/*.cfg`).
- Print-lifecycle hooks: define `[gcode_macro _PRINT_START_<NAME>]`, `_PRINT_END_<NAME>`, `_CANCEL_PRINT_<NAME>` in `extended/klipper/`; START hooks run after the stock macro, END/CANCEL before it; ordering is alphabetical by file then section, use numeric prefixes. No stock macro edits needed.
- Firmware-level settings live in **`extended/extended2.cfg`** (`[web] frontend/firmware_config/remote_screen`, `[camera] internal/usb/rtsp`, `[components] rfid|upgrade|gui|chamber heater`, `[remote_access] ssh/vpn/cloud`, `[monitoring]`) — reboot to apply; the lead's `[web] frontend fluidd, firmware_config true` and `[camera] internal paxx12` are the documented defaults. Tweaks/troubleshooting toggles install files into `extended/klipper/` or `extended/moonraker/` rather than writing extended2.cfg, and **can only be set from the Firmware Config UI**.
- Recovery ladder: `extended-recover.txt` on USB (resets `extended/`, backs up to `extended.backup.N`) → `full-recover.txt` (also clears `/oem/.debug`, persisted data, rebuilds overlays) → reflash. **SSH-installed extensions (multiACE, HelixScreen) write outside this mechanism; neither recovery file is guaranteed to undo them** [S52][S10].

### 2b.4 Features relevant to tuning/reviewing jobs [S56][S54][S52]
- **Klipper Tweaks** (Firmware Config > Tweaks, experimental): *TMC AutoTune* (TMC2240 PWM/StallGuard/CoolStep retune; risk of heat/skipped steps), *TMC Reduced Current* (X/Y 1.2 A → 1.0 A; layer-shift risk), *Max Speed* (rolling build only, PR #682; `Balanced` 600 mm/s / 22,000 mm/s² / tool-change 550 mm/s, `Aggressive` 750 / 25,000 / 700 — "beyond what the machine is specified for", needs calibrated docks, belts and `SHAPER_CALIBRATE`; cannot combine with Reduced Current), *Object Processing for adaptive mesh*, *AFC Stub*. Open issues #685 (TMC AutoTune + Reduced Current → "Homing Calibration Failed" on 1.5.2 and 1.6.0) argue for leaving both **off** on production printers.
- **Faulty Toolhead Bypass**: *Bypass Thermistor* (error `0003-0523-0000-0002`, MCU alive) or *Bypass MCU (Disconnected)* (dead board/cable; that toolhead is fully inert). Lets a 3-tool job run while a head is out for repair; disable after repair.
- Top-cover exhaust/circulation fans exposed as `fan_generic` (`SET_FAN_SPEED`) from 1.6.0-paxx12-22.
- Camera: `internal: paxx12` is what AI detection and timelapse use; `Disabled` also stops the touchscreen GUI launcher. Timelapse "green flash" regression reported on the 1.6.x builds (#736, open, several confirmations).
- SpoolLink/Spoolman: UID-based (`Extra Fields > Card UID`), not OpenSpool `spool_id`; use Snapmaker's RFID detection rather than OpenRFID for reliable resolution; per-spool pressure-advance schema (`pressure_advance_matrix`, PR #649) shared with multiACE.
- Chamber heater (DragonBreath recommended, Panda Breath to be removed): **requires extra mainboard cooling** — RK3562 throttles at 85 °C and documented mid-print failures exist; mains heater, never unattended [S59].

### 2b.5 multiACE on davinci (Anycubic ACE feeding a U1) [S57]
- Project `decay71/multiACE` (GPL-3.0, 176 stars, last push 2026-10-03; grew from BlackFrogKok/SnapAce): up to 4 ACE Pro / ACE 2 Pro units, web UI at `http://<ip>/multiace/`, web preflight, per-pair purge taken from the slicer flush matrix, spool management, ACE Refill, tip forming instead of a cutter, RFID read/write (ACE2-Open community firmware), Fluidd cam-panel embed. Installed files match the lead's finding: `config/extended/ace.cfg` (all `[ace]` settings + macros), `extended/multiace/ace_vars.cfg`, uninstall script at `/home/lava/printer_data/config/extended/multiace/uninstall_multiace.sh`; `persistent/multiace_spools.json` is its spool store (name not found in the README — **UNVERIFIED** mapping).
- **It patches live Klipper files** (`/home/lava/klipper/klippy/extras/filament_feed.py`, switch-sensor, `kinematics/extruder.py`; stock backed up as `*_pre_multiace.py`). README: "**Before Snapmaker firmware updates: run `uninstall_multiace.sh` first, install the update, then reinstall**" — this is the main upgrade hazard for davinci. A paxx12-managed package (PR #151 by Tareku99, test build 2026-09-30) is being built so the rolling Extended Firmware installs/updates it; not in a stable paxx12 release yet.
- Author's own framing: "Beta software", "NO AMS-like solution with 1000s of reliable swaps"; a swap takes **up to ~3 minutes** (tip forming + bowden + retries) and happens off the park position, so every swap adds print time; parked background swaps are experimental and can contaminate the print. Known limitations: **Air Print Detection must be off**; don't disable automatic load on the display; unload all heads after install/upgrade (`ACEC__Unload_All` clears display filament info); cardboard spools jam. TPU/TPE: Normal Mode or manual head only. `ACEF__Mode_Normal` returns to stock feeding.
- Review implications for davinci jobs: a job that uses virtual tools `T4..T15` must go through the multiACE post-processor or web preflight; expect purge waste comparable to a single-nozzle MMU on those swaps (fit the larger purge bin); keep Air Print Detection off only on davinci; flush matrix in Orca now matters on davinci (unlike a pure 4-tool U1 job).
- Related: `Mnemonic3D/Snapmaker-U1-Orca-MultiACE-edition` (Orca 2.4.2 fork with MultiACE tool mapping, v2.4.2-mnemonic3d.1 2026-09-03; author says the published builds are "earlier experimental builds") and `DnG-Crafts/U1-Ace` (separate ACE mod that ships its own extended-firmware builds incl. 2.0.0.205, uses `extended/mods/ace_device.cfg`) — neither is what davinci runs.

### 2b.6 Known issues worth knowing (open on 2026-10-04 unless stated) [S60]
- #698: **first boot after flashing** 1.5.2-paxx12-21 / 1.6.0-paxx12-22-pre hung at splash and ground the A/B slot metadata into "No bootable slots" on one unit (reporter recovered via UART); stock updates on the same unit never did. Treat firmware flashes as a maintenance-window task with a stock `.bin` on a USB stick ready.
- #761: toolhead-dock error on the first swap of a print after updating to current stable; the reporter's fix was cleaning contact pins and ultimately a factory reset to stock. Clean pogo pins with IPA before blaming firmware.
- #685: TMC AutoTune / Reduced Current cause homing-calibration failures (1.5.2 and 1.6.0).
- #629 / #650: bed-mesh/heightmap not shown in Fluidd/Mainsail once a print starts (since 1.5.2-paxx12-21) — cosmetic, mesh still applied.
- #683: Mainsail speed factor only sticks on the tool that started the print; resets on each tool change. Set speed in the slicer, not live.
- #709: `Option 'enabled' is not valid in section 'afc'` halts Klipper — stale AFC-Lite include after an upgrade; remove `extended/klipper/afc.cfg` or toggle the stub off.
- #543: `0003-0522-0000-0002` on unload traced to a community Spoolman `SAVE_VARIABLE … VALUE=""` config, not the firmware (closed-by-explanation 2026-06).
- #736: timelapse green-flash on 1.6.x; #716 Moonraker inotify warning on `config`; #532 native ACE integration still a feature request (multiACE package is the interim path).

---

## 3. Anycubic Kobra S1 + ACE Pro + Rinkhals

### 3.1 Hardware [S15][S16][S17]
- CoreXY, 250 × 250 × 250 mm, enclosed but **not heated**, 600 mm/s max (300 recommended), 20,000 mm/s², quick-release hotend 320 °C max; LeviQ 3.0 leveling; ≤44 dB quiet mode. Bed 120 °C and nozzle sizes 0.25/0.6/0.8 appear on reseller pages (SimplyPrint/3DJake) — UNVERIFIED against Anycubic.
- **ACE Pro:** 4 slots, 230 W, **55 °C max drying**, temperature readout only (no humidity sensor), RFID for Anycubic spools, two units → 8 colours. **ACE 2 Pro:** 65 °C drying, 50 mm/s feed (vs 25), up to four units (16 colours), Kobra S1 listed as compatible. A Rinkhals issue snippet says stock fw 2.7.0.7 added "second-generation material box" support — UNVERIFIED.
- Waste reality: 3DWithUs measured **183 g of purge for a 10.9 g multi-colour Benchy** on the stock Combo [S18]. This is the opposite of the U1's economics.

### 3.2 Rinkhals (overlay, not a replacement) [S13][S14][S20]
- Project moved to `rinkhals-community/Rinkhals` (old repo deprecated 2026-07-01). Latest stable **20260901_01**. Installs from a FAT32 USB folder; stock UI stays; SSH `root` / `rockchip`; web portal `http://<ip>:8090` ("will change"); Mainsail and Fluidd included (ports 4409/4408 per DeepWiki — secondary source).
- It talks to Anycubic's **GoKlipper** through a Moonraker shim: macros, `printer.cfg` and object lists are *not* vanilla Klipper. README: "We strongly advise against modifying the stock printer configuration." `FIRMWARE_RESTART`/`RESTART` are refused (they deadlock GoKlipper). Kobra X (new C++ Klipper base) unsupported.
- Fixes since June: KS1 2.7.2.7 NaN crash avoided via `[printer] minimum_cruise_ratio 0.05` override (side effect: `max_accel_to_decel` 20000→19000); live Z-offset in Mainsail restored; OrcaSlicer `; filament_colour_type` line stripped (crashed GoKlipper); over-quoted FILENAME from Orca 2.4.2 normalised; correct ACE slot fed when a middle gate is empty; ACE hot-plug; chamber heater exposed on S1 when the printer reports one.
- **Known issues (20260901_01):** bed-mesh script calls a macro missing on the S1 family and parks the nozzle off the silicone pad (can ooze); a saved mesh is not always shown in the UI; Spoolman mapping lost after ACE status rebuilds.
- Orca-usage guide: connect by IP; Orca ships presets for Kobra 3 and Kobra S1; "Timer too close" on detailed arcs → raise max deviation / disable dynamic cooling; avoid floods of `M106` with tight moves.

### 3.3 Orca profile for Kobra S1 (upstream OrcaSlicer, read 2026-10-04) [S21]
- Machine: 600 mm/s, X/Y accel 10,000, extruding/travel accel 20,000, jerk 9, retraction 0.8 mm @ 40, Z-hop 0.4 slope, `single_extruder_multi_material` 1, `change_filament_gcode` is `; FLUSH_START … T[next_extruder] … ; FLUSH_END` with the actual purge handled by firmware (added PR #11650, merged 2025-12-19).
- Process 0.20 Standard: outer 200, inner 300, infill 270, travel 300; prime tower 35 mm, `prime_volume` 20, `flush_into_support` 1, `wipe_tower_max_purge_speed` 90; seam aligned, scarf off. Anycubic PLA: 205 °C, bed 55, 12 mm³/s, PA 0.035 enabled, min purge 15.
- **Caveat (OrcaSlicer #12659, open since 2026-03-06):** on non-Bambu printers "Purge to infill", "Purge to this object" and prime-tower volume do not reduce the `[flush_volume]` placeholder, so firmware-driven ACE purges may not shrink even when the preview says they do [S22].

---

## 4. Orca Slicer: current features and keys [S19][S23][S24][S25][S26][S27][S28]
- **2.4.0** (06-20): Z Anti-Aliasing contouring (`zaa_enabled`, `zaa_min_z`, `zaa_minimize_perimeter_height`), **Machine Input Shaping** (set X/Y freq + damping in Printer settings, emits Klipper/RRF/Marlin G-code), bridging overhaul, optimized gyroid, per-feature filament, Troubleshoot Center, native Moonraker host, Orca Cloud, Expert mode, "always travel to wipe tower before Tx on multi-toolhead", temperature-aware filament compatibility warnings, fuzzy-skin ripple, elephant-foot for solid layers, Arachne max-resolution/deviation exposed, extra bridge layers (`enable_extra_bridge_layer`: external_bridge_only recommended), send as `.gcode.3mf`.
- **2.4.1** (06-28): per-filament `chamber_minimal_temperature`; skirt/brim rework (fixes By-Object skirt regression); Windows ARM64. **2.4.2** (07-07): preset repair after renamed profiles; `{layer_z}` in filament end G-code with prime tower; prime-tower rotate crash fix.
- Seams: `seam_position` aligned / aligned_back / nearest / back / random; "Aligned Back, Aligned, or Back work the best" with seam painting / Precise Seam. Scarf: `seam_slope_type`, `seam_slope_conditional` (+ `scarf_angle_threshold`), `seam_slope_start_height`, `seam_slope_entire_loop`, `seam_slope_min_length`, `seam_slope_steps` (10), `seam_slope_inner_walls`, `scarf_joint_speed` (<100 mm/s), `scarf_joint_flow_ratio` (100 %). Use on smooth curved shells (figures, vases), not on sharp-cornered signage.
- Walls: `wall_generator` classic | arachne (`wall_transition_angle`, `wall_transition_filter_deviation`, `wall_transition_length`, `wall_distribution_count`, `min_bead_width`); `precise_outer_wall`, `precise_z_height`, `only_one_wall_top`.
- Supports: `support_type` normal/tree (auto/manual); `support_style` default, grid, snug, organic, tree_slim, tree_strong, tree_hybrid; tree branch keys `tree_support_branch_diameter[_organic]`, `tree_support_branch_angle[_organic]`.
- Multi-material: `enable_prime_tower`, `prime_tower_width`, `prime_tower_brim_width`, `prime_volume`, `wipe_tower_wall_type` rectangle/cone/rib, `wipe_tower_extra_rib_length`, `wipe_tower_no_sparse_layers`, `wipe_tower_max_purge_speed`; `flush_into_infill` / `flush_into_support` / `flush_into_objects` (need prime tower on); `flush_multiplier`; `filament_minimal_purge_on_wipe_tower`; `ooze_prevention`, `standby_temperature_delta`, `preheat_time` (M104 ahead of Tx).
- Flow: `filament_max_volumetric_speed` (hard cap on speed; wiki: calibrate per brand *and colour*; reduce 10–20 % after calibration). Adaptive PA: `adaptive_pressure_advance`, `adaptive_pressure_advance_overhangs` (experimental), `adaptive_pressure_advance_bridges`, plus a measurements table (PA, flow mm³/s, accel) — Klipper-tested only; needs Klipper ≥ 0.13.0 (or dev ≥ 2024-07-11) for artifact-free dynamic PA; pointless if you print at one speed/accel; most benefit on high-flow CoreXY.
- Calibration suite order (wiki): Temperature → Volumetric speed → Pressure advance (incl. adaptive) → Flow ratio → Retraction → Tolerance → Cornering (jerk/JD/SCV) → Input shaping (+ VFA). Volumetric test default 5→20 mm³/s step 0.5: `max = start + height × step`. Retraction tower default 0→2 mm step 0.1 (direct drive); read `Calib_Retraction_tower` comments; clean from the start → 0.2–0.4 mm suffices; stringy at top → dry filament / check nozzle seating. Input-shaping test uses the ringing tower at e.g. 20,000 mm/s² / 200 mm/s and avoids filaments under 10 mm³/s; prefer the printer's accelerometer when it has one (U1 does); recalibrate yearly or after mechanical change.

---

## 5. Klipper tuning order and current methods [S29][S30][S31][S32][S24]
1. **Mechanics first** (belts, frame, nozzle seated) — any later number depends on it.
2. **Extruder `rotation_distance`:** mark filament ~70 mm from extruder, `G91` / `G1 E50 F60` (slow on purpose), `new = old × actual / requested`, 3 decimals. On vendor machines (U1, GoKlipper) you cannot edit this; use Orca **flow ratio** per filament instead.
3. **Temperature tower** for the filament (raise toward the top of range when chasing flow).
4. **Input shaper:** `SHAPER_CALIBRATE` with accelerometer (U1 does this from the touchscreen); recommended `max_accel` is "only a theoretical maximum"; shaper default `mzv`; options zv, mzv, zvd, ei, 2hump_ei, 3hump_ei; manual method = ringing tower, MZV first, EI if clearly better; **disable PA during the test** (`SET_PRESSURE_ADVANCE ADVANCE=0`). Do not auto-calibrate daily (wear).
5. **Pressure advance:** `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=1 ACCEL=500`, `TUNING_TOWER COMMAND=SET_PRESSURE_ADVANCE PARAMETER=ADVANCE START=0 FACTOR=.005` (direct drive), disable dynamic acceleration control and scarf seams in the slicer, 100 mm/s hollow square; typical 0.050–1.000 (>0.2 risks extruder skipping on DD); re-tune per filament spool/nozzle. `pressure_advance_smooth_time` default 0.040 s (max 0.2). Then Orca adaptive PA if speeds/accels vary widely. On U1 use Dynamic Flow Calibration rather than tuning towers.
6. **Max volumetric speed** per filament (Orca test), then cap in filament profile.
7. **Cornering:** `square_corner_velocity` default 5 mm/s, `minimum_cruise_ratio` default 0.5; raise SCV only with the Orca cornering test (Klipper note: larger SCV mainly affects flow-rate stability, not just ringing). Rinkhals forces `minimum_cruise_ratio` 0.05 on KS1 2.7.2.7.
8. **Retraction** last (tower; direct drive 0.2–1.5 mm; TPU minimal or off).
9. Re-check **first layer / Z-offset** after any hotend, plate or offset change.

---

## 6. Filaments (state as of 2026-10) [S33][S34][S35][S40][S41][S42][S43][S44][S45][S46][S47]

| Material | Nozzle °C | Bed °C | Max flow guide (0.4 mm) | Drying | Notes |
|---|---|---|---|---|---|
| **Snapmaker PLA SnapSpeed** | 190–210 classic / 210–230 high-speed (U1 profile 220) | 25–60 (profile 60/65) | Profile cap **12 mm³/s** standard hotend; Liber "+66 %" | 55 °C 6 h | RFID on U1; 100–300 mm/s marketing; Tg 59 °C |
| Generic high-speed PLA (Polymaker PolySonic, Bambu PLA Basic, Elegoo Rapid PLA+, SUNLU PLA Meta) | 190–230 | 25–60 | PolySonic: 24 mm³/s practical, 29 peak @ 230 °C (vendor test) | 55 °C 6 h | Sold as 250–300 mm/s class; still cap by your own volumetric test |
| PLA Matte / Silk | Matte 220 (U1 profile); Silk 230, TDS 190–240 | 60–65 | 12 mm³/s (U1 profiles) | 55 °C 6 h | Silk: gloss rises with slower speed/higher temp; flow 0.98, retraction 0.4; matte PLA hides layers, more brittle (community consensus, no TDS) |
| PLA-CF | 230 (210–250) | 65 | 15 mm³/s (U1) | 55 °C 6 h | Hardened nozzle; retraction 2 mm in profile; no high-flow hotend |
| PETG (standard, Snapmaker TDS) | 190–240 | 25–70 | ~8–12 typical (calibrate) | 55 °C 6 h; 65 °C if soaked | Glue/separation layer on smooth PEI; Prusa: PETG "may be too strong" on smooth PEI |
| **PETG HF** (Snapmaker / Bambu) | 240–260 / 230–260 | 60–80 / 65–75 | Bambu TDS prints specimens at 200 mm/s; Bambu profile 18–21 mm³/s (reseller snippet, UNVERIFIED) | 65 °C 6–8 h | Fan 20–40 % (Snapmaker) / 0–60 % (Bambu); chamber 35–50 °C ok; retraction 1–3 mm @30 (Snapmaker) / 0.8–1.4 (Bambu) |
| **TPU 95A HF** (Snapmaker / Bambu) | 200–250 / 220–240 | 25–50 / 30–35 | Bambu TDS: 140 mm/s specimens; "< 200 mm/s"; U1 profile PA off | 65 °C 6 h / 70 °C 8 h | Manual load on U1; not through AMS/ACE-type feeders; reduce or disable retraction; saturated water uptake 1.08 % (Bambu) |
| TPU 90A (Snapmaker) | 200–250 (profile) | 35 | low; print slow | 65 °C 6 h | U1 officially 90A and harder only |
| ASA (Polymaker/Snapmaker) | 230–260 / 255 | 75–95 / 110 | 8 mm³/s (U1 profile) | 70 °C 7 h (Polymaker); Prusa 80 °C 4 h | Needs enclosure (Top Cover); fan 0–15 %; Tg 98 °C |

- Hygroscopicity ranking (Prusa KB, CNC Kitchen): PLA least, PETG/ASA noticeable, TPU/PA/PVA worst. Prusa drying table: PLA 45 °C 6 h, PETG 55 °C 6 h, TPU 60 °C 4–6 h, ASA 80 °C 4 h. CNC Kitchen: heat (dehydrator/oven) beats vacuum; spools **re-absorb almost all moisture within ~5 days in open air**; a desiccant cabinet removed 70–80 % of removable moisture over 12 days and PETG/ASA showed the clearest wet-vs-dry quality difference; hydrolysis makes wet PETG brittle and stringy. Wet symptoms: popping, rough matte surface, stringing, weak layers.
- Notable 2025–26 additions in the SnapmakerOrca library: Snapmaker PLA Full Spectrum (gradient, 0.2/0.6 nozzles, 0.1 mm layers), PLA Rainbow, PLA Glow (0.6/0.8), PEBA 90A, PETG-CF, PETG Translucent, Support for PLA (0.2), TPU 90A. Bambu TPU 95A HF, PETG HF and PLA "HF" lines define the current "high-speed" tier; Elegoo Rapid PLA+, SUNLU PLA Meta, Polymaker PolySonic are the common third-party equivalents (review-site claims; not TDS-verified beyond PolySonic).
- Colour-change implications: dark→light needs the most purge; Orca flush matrix is per pair. On the U1 a colour change is a *tool* change (≈5 s, only a small pre-extrude), so flush volume mostly affects the prime tower, not a purge chute; on the Kobra S1 every change is a full single-nozzle purge (see §3.1 waste figure).

---

## 7. Speed-vs-quality playbook

**Small parts (flexi animals, bookmarks, keychains)**
- Flow is rarely the limit; minimum layer time is. Keep `slow_down_layer_time` ≥ 4 s (PLA) / 8 s (silk, TPU) and print several parts per plate so the fan has time to work; use `print_sequence` by-object only if parts fit the U1 extruder clearance (radius 72.5 mm, height 27.5 mm per profile) [S4].
- Articulated prints: 0.16–0.2 mm layers, `only_one_wall_top`, `precise_outer_wall`, tree supports off, bridge `enable_extra_bridge_layer` external_bridge_only; check joint clearance ≥ 0.3 mm with the tolerance test. Flexi in TPU: 20–40 mm/s, PA off, retraction ≤ 1 mm, fan 20–35 %, dry it first.
- Bookmarks/text: seam **back** or painted; scarf off on sharp text edges; 0.12 mm layers for lettering legibility; ironing optional on flat faces.

**Large display pieces / signage**
- These hit the hotend flow cap: at 0.2 mm × 0.42 mm, 200 mm/s is ≈17 mm³/s, already above the 12 mm³/s shipped cap for Snapmaker PLA — Orca silently slows walls. Options: calibrate volumetric speed per spool (expect PLA 15–24 on a healthy stainless hotend, vendor-dependent), or fit Liber high-flow hotends and use the "high_flow" process set (outer 500 / inner 600 in the 0.20 preset).
- Quality levers: scarf seams on curved shells, `seam_position` aligned_back, ZAA on sloped tops, outer-wall accel ≤ 5000 (profile), VFA-free outer-wall speed from the VFA test.
- Warping: PEI textured plate at 60–65 °C PLA / 70–80 PETG, brim 5 mm or mouse ears on sharp corners, no drafts; ASA only with Top Cover (50 °C chamber). Prusa: lower Z slightly and clean with ≥ 90 % IPA; acetone only on smooth PEI and only monthly [S48][S49].

**Multi-colour waste reduction**
- U1: prime tower is the only waste. Shipped: width 30, `prime_volume` 45, rib wall. Community-proven: width 20–30, prime volume 15–18, `filament_minimal_purge_on_wipe_tower` 10–15, `wipe_tower_no_sparse_layers` on for tall parts with few colour layers, `flush_into_support`/`flush_into_infill` on. Keep **rib** + brim on anything over ~100 mm tall; keep `ooze_prevention` on with the −150 standby delta. Avoid PLA+PETG in one job on SnapmakerOrca ≥ 2.3.5 until #908 is fixed.
- Kobra S1: order colours dark-last where possible, use per-pair flush volumes, `flush_into_support`, fewer colour layers; expect purge mass to dwarf part mass; don't trust the preview's reduced flush (#12659).

**Reliability checklist before a sellable batch**
First layer verified on this plate today; nozzle wiper/pad clean (U1 pre-extrudes onto the pad); filament dried ≤ 48 h ago or in a sealed box; toolhead offset calibration current (U1) after any hotend work; Dynamic Flow Calibration ticked for new spools; Kobra on supported stock firmware + Rinkhals 20260901_01; no PLA+PETG mix on U1 until #908 closes; on the U1s no `high_flow` process set (base < 2.0.0) and TMC AutoTune / Reduced Current / Max Speed tweaks off; on davinci, Air Print Detection off (multiACE) and every ACE-fed job routed through the multiACE preflight/post-processor.

---

## 8. Failure modes → likely cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Blob/smear at every tool change (U1) | Dry CP TOOLCHANGE WIPE regression (#908) with mixed materials; ooze from inactive tool | Same material per job, or strip dry moves; keep `ooze_prevention` on; clean wiper pads |
| Prime tower leans / collapses | Thin tower, rectangle wall, no brim | `wipe_tower_wall_type` rib, brim 5, width ≥ 25, don't drop prime volume below ~15 |
| Walls under-extruded on big flat parts at speed | Over the filament's max volumetric speed; wet filament | Calibrate `filament_max_volumetric_speed`; raise temp to top of range; high-flow hotend |
| Ringing / VFA on walls | Input shaper stale after move/hotend swap; outer-wall speed in MRR band | Re-run Vibration Compensation; VFA test; set outer wall outside the artifact band |
| Corner bulge or seam gap | PA wrong for this spool | U1: Dynamic Flow Calibration per spool; Kobra: Orca PA pattern test, enable PA 0.03–0.05 |
| Stringing | Wet filament first; retraction second; temp too high | Dry (PLA 45–55, PETG 55–65, TPU 60–65 °C); retraction tower; lower temp 5 °C |
| First layer over-squished (U1) | Fw 1.5.0 bug; bed leveling off | Update ≥ 1.5.2 Beta/2.0.0; enable Heated Bed Leveling; re-level |
| Nothing sticks / PETG rips PEI | Oils; PETG on smooth PEI | IPA ≥ 90 %, dish soap for stubborn; glue-stick release layer for PETG on smooth PEI; textured PEI needs lower Z |
| Warping corners (PLA/PETG) | Drafts, low bed temp, over-cooling first layers, no brim | Brim/mouse ears, bed +5 °C, draft shield, fan 10–20 % on first layers |
| TPU jams / won't load (U1) | Auto-feed with flexible filament; 0.2 nozzle; high speed | Manual load; 0.4 mm+; ≤ 40 mm/s; retraction ≤ 1 mm; dry at 65 °C |
| "Timer too close" | Host overloaded by dense G-code / fan command floods; on paxx12, extra services or a hot RK3562 (chamber heater) | U1: base 1.5.0+ helps, 2.0.0 more (not on this farm yet); disable unneeded paxx12 services (exporter, RTSP, USB cam); Kobra: raise max deviation, disable dynamic cooling, fewer M106 toggles |
| U1 (paxx12): "Homing Calibration Failed" / X-Y anomaly at print start | TMC AutoTune or TMC Reduced Current tweak enabled (#685) | Firmware Config > Tweaks: disable both, re-home |
| U1 (paxx12): Klipper halted, `Option 'enabled' is not valid in section 'afc'` | Stale AFC-Lite include after upgrade (#709) | Remove `extended/klipper/afc.cfg` or toggle AFC Stub off; `extended-recover.txt` if it won't start |
| U1 (paxx12): first tool swap docks wrong, print shifted after resume | Dirty/greased toolhead pogo pins; dock offsets stale (#761) | IPA-clean pins, re-run Multi-toolhead Offset Calibration; compare on stock before filing |
| U1 (paxx12): speed override reverts after a tool change | Mainsail speed factor applies per tool (#683) | Set speeds in the slicer |
| U1 (paxx12): stuck at splash after flashing | First-boot hang corrupting A/B slot metadata (#698) | Keep a stock `.bin` on USB; flash only in a maintenance window; UART recovery otherwise |
| davinci (multiACE): load fails / pauses mid-swap | Tip-forming or bowden quirk, cardboard spool, loose splitter; Air Print Detection on | Retry params, plastic spools, seat PTFE/splitters, Air Print Detection off; `ACEC__Unload_All` after install |
| davinci (multiACE): Klipper breaks after a firmware update | multiACE's patched `filament_feed.py`/`extruder.py` overwritten | Uninstall multiACE → update → reinstall (README order) |
| Kobra: Mainsail never connects after fw 2.7.2.7 | GoKlipper NaN bug | Rinkhals ≥ 20260606_02 (minimum_cruise_ratio override) |
| Kobra: Orca print crashes at start | `; filament_colour_type` header / quoted FILENAME | Rinkhals ≥ 20260901_01 |
| Kobra: wrong ACE slot fed | Empty middle gate desync | Rinkhals ≥ 20260716_02 |
| Kobra: bed mesh hangs or nozzle oozes on pad | Script doesn't home / missing S1 macro (known issue) | Home first; watch for fix in next Rinkhals release |
| Clogs after high-temp → PLA switch (U1 Liber) | Residue carbonising | Cold-pull routine in hotend guide (flush with PLA, cool to 85 °C, pull) |

---

## 9. What changed recently (2025-Q4 → 2026-10) worth knowing
- 2026-10-03 multiACE v1.20b-pre (ACE Pro community firmware tag reads, transport watchdog, paxx12-managed package contract); 2026-09-29 multiACE v1.11b; 2026-09-27 v1.10b (per-pair purge from the slicer flush matrix, PA per spool, 2.0.0/1.6.0 support).
- 2026-09-09 paxx12 rolling build moves to base 2.0.0.205 with HelixScreen and the Max Speed tweak (pre-release); 2026-09-07 paxx12 v1.6.0-paxx12-22 stable (snapdragon); 2026-08-02 v1.5.2-paxx12-21 (davinci).
- 2026-09-22 Liber High-Flow hotend for U1 (needs fw 2.0.0 + SnapmakerOrca 2.4.0 — not usable on this farm's 1.6.0/1.5.2 bases); 2026-09-21 SnapmakerOrca 2.4.0; 2026-09-15 stock U1 firmware 2.0.0 (wiki date); 2026-08-25 stock 1.6.0.
- 2026-09-23 SnapmakerOrca issue #908: PLA↔PETG tool-change regression since 2.3.5 (open).
- 2026-09-01 Rinkhals 20260901_01 fixes Orca single-colour crashes and ACE crash loop; project now under rinkhals-community (old repo deprecated 2026-07-01).
- 2026-07 U1 Top Cover support (fw 1.5.x) and SnapmakerOrca Top Cover controls; cover ships Nov 2026 at USD 149 pre-order.
- 2026-06/07 OrcaSlicer 2.4.0–2.4.2: ZAA, Machine Input Shaping, bridging overhaul, Orca Cloud, native Moonraker host, `chamber_minimal_temperature`.
- 2026-04-14 U1 fw 1.3.0 multi-diameter nozzles; 2026-03-23 fw 1.2.0 root SSH + firmware sources on GitHub (03-30); 2025-12-31 fw 1.0.0 AI spaghetti detection.
- 2025-12-19 OrcaSlicer upstream added Kobra S1 filament-change G-code (PR #11650); 2026-03 #12659 flush placeholder bug on non-Bambu printers (open).
- Anycubic ACE 2 Pro (65 °C, 50 mm/s feed, 16 colours) is listed compatible with Kobra S1; Kobra S1 stock firmware 2.7.2.7 is the newest Rinkhals supports; Anycubic's own changelog for it — UNVERIFIED.
- Klipper 0.13.0 (2025-04-11) is the floor for artifact-free adaptive PA; vendor forks (U1, GoKlipper) may or may not carry the fix — UNVERIFIED for both.

---

## 10. Sources (URL — title — date read)
- [S1] https://c.cdnmp.net/828809388/content/Info/Snapmaker/Snapmaker%20U1%20Specifications.pdf — Snapmaker U1 Specifications (Ver. 2025.09) — 2026-10-04
- [S2] https://github.com/Snapmaker/OrcaSlicer/releases — Snapmaker Orca releases v2.3.3…v2.4.0 (bodies via GitHub API) — 2026-10-04
- [S3] https://www.snapmaker.com/en-US/snapmaker-u1/specs — Snapmaker U1 specs page — 2026-10-04
- [S4] https://github.com/Snapmaker/OrcaSlicer/tree/main/resources/profiles/Snapmaker — U1 machine/process/filament profile JSONs (GitHub API) — 2026-10-04
- [S5] https://www.snapmaker.com/blog/snapmaker-u1-firmware-now-on-github/ — Snapmaker U1 Firmware: Now on GitHub (2026-03-30) — 2026-10-04
- [S6] https://releasebot.io/updates/snapmaker/u1-firmware — U1 Firmware Updates (aggregator quoting official notes) — 2026-10-04
- [S7] https://forum.snapmaker.com/t/support-center-firmware-software-app-updates/40300 (pages 1–2) — Snapmaker official update thread — 2026-10-04
- [S8] https://wiki.snapmaker.com/en/snapmaker_u1/hot_end_guide — U1 Hotend User Guide — 2026-10-04
- [S9] https://www.snapmaker.com/blog/introducing-the-snapmaker-x-phaetus-libertm-high-flow-hotend-for-u1/ — Liber High Flow Hotend launch — 2026-10-04
- [S10] https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/releases — paxx12 Extended Firmware releases (v1.6.0-paxx12-22, v1.5.2-paxx12-21, rolling bodies via GitHub API) — 2026-10-04
- [S50] https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware — repo metadata (stars, push date, license, default branch) and README via GitHub API — 2026-10-04
- [S51] https://wiki.snapmaker.com/en/snapmaker_u1/firmware/release_notes — Snapmaker U1 Firmware Release Notes (official version/date list, scraped from page HTML) — 2026-10-04
- [S52] https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/blob/develop/docs/firmware_config.md and docs/install.md, docs/index.md, docs/ssh_access.md — Firmware Configuration / install / feature index / SSH — 2026-10-04
- [S53] …/docs/firmware_upgrade.md — Firmware Upgrade Channels — 2026-10-04
- [S54] …/docs/klipper_includes.md — Klipper and Moonraker Custom Includes — 2026-10-04
- [S55] …/docs/klipper_hooks.md — Klipper Print Hooks — 2026-10-04
- [S56] …/docs/tweaks.md, docs/faulty_toolhead.md, docs/afc-lite.md, docs/camera_support.md, docs/helixscreen.md — Tweaks / Faulty Toolhead Bypass / AFC-Lite / Camera / HelixScreen — 2026-10-04
- [S57] https://github.com/decay71/multiACE — multiACE README, tree, releases (v1.11b 2026-09-29, v1.20b-pre 2026-10-03), open issues; plus https://github.com/Mnemonic3D/Snapmaker-U1-Orca-MultiACE-edition and https://github.com/DnG-Crafts/U1-Ace for disambiguation — 2026-10-04
- [S58] …/docs/data_persistence.md — Data Persistence (`/oem/.debug`, upgrades wipe it) — 2026-10-04
- [S59] …/docs/panda_breath.md — DragonBreath & Panda Breath Chamber Heater (mainboard-overheating warning) — 2026-10-04
- [S60] https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/issues — issues #698, #761, #685, #629, #650, #683, #709, #543, #736, #716, #532, #332, #662 read via GitHub API — 2026-10-04
- [S11] https://us.snapmaker.com/products/top-cover-for-snapmaker-u1 — Top Cover for Snapmaker U1 — 2026-10-04
- [S12] https://github.com/Snapmaker/OrcaSlicer/issues/908 — Dry CP TOOLCHANGE WIPE regression — 2026-10-04
- [S13] https://github.com/rinkhals-community/Rinkhals/releases — Rinkhals releases (bodies via GitHub API) — 2026-10-04
- [S14] https://github.com/rinkhals-community/Rinkhals — Rinkhals README (supported firmware table) — 2026-10-04
- [S15] https://store.anycubic.com/products/kobra-s1-combo — Anycubic Kobra S1 Combo — 2026-10-04
- [S16] https://store.anycubic.com/products/anycubic-ace-pro — Anycubic ACE Pro — 2026-10-04
- [S17] https://store.anycubic.com/products/ace-2-pro — Anycubic ACE 2 Pro — 2026-10-04
- [S18] https://3dwithus.com/anycubic-kobra-s1-combo-review-3d-printer-tests-tips-and-settings — 3DWithUs Kobra S1 Combo review (purge waste figure; search snippet) — 2026-10-04
- [S19] https://github.com/OrcaSlicer/OrcaSlicer/releases — OrcaSlicer releases (dates via GitHub API) — 2026-10-04
- [S20] https://rinkhals-community.github.io/Rinkhals/guides/orca-slicer-usage/ — Rinkhals OrcaSlicer usage guide — 2026-10-04
- [S21] https://github.com/OrcaSlicer/OrcaSlicer/tree/main/resources/profiles/Anycubic — Kobra S1 machine/process/filament JSONs (GitHub API); PR #11650 — 2026-10-04
- [S22] https://github.com/OrcaSlicer/OrcaSlicer/issues/12659 — flush_volume placeholders on non-Bambu printers — 2026-10-04
- [S23] https://www.orcaslicer.com/wiki/releases/release_2_4_0_alpha — OrcaSlicer 2.4.0 alpha notes — 2026-10-04
- [S24] https://github.com/OrcaSlicer/OrcaSlicer.wiki.git — Orca wiki clone: calibration/*.md (adaptive PA, volumetric, input shaping, retraction, cornering, VFA), releases/release_2_4_1.md, release_2_4_2.md — 2026-10-04
- [S25] https://github.com/OrcaSlicer/OrcaSlicer/wiki/quality_settings_seam — Seam settings — 2026-10-04
- [S26] https://www.orcaslicer.com/wiki/print_settings/multimaterial/multimaterial_settings_prime_tower — Prime tower settings — 2026-10-04
- [S27] https://www.orcaslicer.com/wiki/print_settings/multimaterial/multimaterial_settings_ooze_prevention — Ooze prevention — 2026-10-04
- [S28] https://www.orcaslicer.com/wiki/print_settings/support/support_settings_support — Support settings (search snippet + wiki clone support_settings_tree.md) — 2026-10-04
- [S29] Orca wiki calibration/adaptive_pressure_advance_calib.md (Klipper 0.13.0 note) — 2026-10-04
- [S30] https://www.klipper3d.org/Config_Reference.html — Klipper config reference ([printer], [extruder], [input_shaper]) — 2026-10-04
- [S31] https://www.klipper3d.org/Pressure_Advance.html — Klipper Pressure advance — 2026-10-04
- [S32] https://www.klipper3d.org/Resonance_Compensation.html and https://www.klipper3d.org/Measuring_Resonances.html and https://www.klipper3d.org/Rotation_Distance.html — Klipper docs — 2026-10-04
- [S33] https://us.snapmaker.com/products/tpu-95a-hf-filament — Snapmaker TPU 95A HF — 2026-10-04
- [S34] https://www.snapmaker.com/en/filaments/pla/snap-speed-pla — Snapmaker SnapSpeed PLA — 2026-10-04
- [S35] https://s3.us-west-2.amazonaws.com/snapmaker.com/download/manual/Snapmaker+PETG+HF+User+Guide+V1.0.0.pdf — Snapmaker PETG HF User Guide — 2026-10-04
- [S36] https://forum.snapmaker.com/t/u1-how-to-minimize-prime-tower-in-orca/40721 — community prime tower thread — 2026-10-04
- [S37] https://forum.snapmaker.com/t/snapmaker-u1-official-video-guides/39977 — official video guides (calibration menu paths; search snippet) — 2026-10-04
- [S38] https://forum.snapmaker.com/t/wie-man-dynamic-flow-calibration-wirklich-nutzt/41169 — Dynamic Flow Calibration thread (search snippet) — 2026-10-04
- [S39] https://forum.snapmaker.com/t/printing-with-tpu-on-the-u1/42035 — Printing with TPU on the U1 — 2026-10-04
- [S40] https://store.bblcdn.com/3a230e260a3a47c2b0db0156e07eef91.pdf — Bambu PETG HF TDS — 2026-10-04
- [S41] https://store.bblcdn.eu/s8/default/16df21baf482453999b3dbb61cc110e7/Bambu_TPU_95A_HF_Technical_Data_Sheet.pdf — Bambu TPU 95A HF TDS — 2026-10-04
- [S42] https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/pla/polylite-tm-pla — PolyLite PLA TDS — 2026-10-04
- [S43] https://wiki.polymaker.com/polymaker-products/more-about-our-products/documents/technical-data-sheets/abs-asa/polymaker-tm-asa — Polymaker ASA TDS — 2026-10-04
- [S44] https://shop.polymaker.com/products/polysonic-pla — PolySonic PLA (flow figures from search snippet; page body truncated) — 2026-10-04
- [S45] https://s3.us-west-2.amazonaws.com/snapmaker.com/download/manual/Snapmaker+Silk+PLA+Technical+Data+Sheet+V1.0.0.pdf — Snapmaker Silk PLA TDS — 2026-10-04
- [S46] https://help.prusa3d.com/article/drying-filament_332086 — Prusa KB: Drying filament — 2026-10-04
- [S47] https://www.cnckitchen.com/blog/cyo43tzz88uqge65xgwz0wv8yvv3rs (2020-04-25) and https://www.cnckitchen.com/blog/sunlu-filadc-i10-review (2026-09-12) — CNC Kitchen drying articles — 2026-10-04
- [S48] https://help.prusa3d.com/article/warping_2011 — Prusa KB: Warping — 2026-10-04
- [S49] https://help.prusa3d.com/en/article/first-layer-issues_1804/ — Prusa KB: First layer issues — 2026-10-04
- Snapmaker PETG (standard) TDS numbers (190–240 °C, 55 °C 6 h) and SnapSpeed FAQ (support.snapmaker.com article 32572395896215 returned HTTP 403 twice) came from search snippets only — treat as **secondary**.
