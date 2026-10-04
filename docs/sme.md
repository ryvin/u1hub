# 3D-printing SME (fork module `sme`)

A resident print engineer's second look at everything the farm prints: every
gcode file, every family of variants of one model, every 3MF on the shelf and
every printer's Klipper setup, reviewed on a schedule — most-printed first —
by **Claude Code running headless on this PC with the owner's own
subscription**, never the Anthropic API key the AI pre-flight uses. Every
review is advice with **DRAFT** changes (Orca values, Klipper config diffs)
a person reads and applies by hand. Nothing is ever applied: no file, no
printer, no queue, no config write beyond the module's own token.

Two halves, with a clean seam so the core can serve every other 3D-printing
project on this PC (see [sme/core/CONTEXT.md](../sme/core/CONTEXT.md)):

| Half | Where | What |
|---|---|---|
| **Core** (project-agnostic, pure Node, no Hub) | `sme/core/` | `agent.md` (the reviewer's prompt and output schema), `knowledge.md` (dated, cited facts; refreshed monthly), the review schema + validator, the tier router, lessons (match / merge / confidence), family analysis, the `claude -p` wrapper, the shared store (`SME_HOME`), the pipeline, a CLI |
| **Adapter** (u1hub) | `modules/sme.js`, `public/modules/sme-ui.js`, `scripts/sme-runner.js`, `scripts/sme-local-sources.js` | the queue, the context builder, the review store and UI; the runner that bridges Hub ⇄ core and adds runner-side local sources |

Feature flag `sme`, on by default, off in Lite. Suites: `test/sme-core-standalone.js`
(core, no Hub) and `test/sme-standalone.js` (Hub + runner, a fake `claude`),
both in `npm run test:standalone`.

## What leaves this PC, and when

Only when the runner runs (hourly task, or by hand), and only text:

- **gcode / family**: the file name(s), the slicer settings Orca wrote into
  the file (the same whitelisted keys the AI pre-flight sends), the filaments
  it was sliced for, its outcome history from the print ledger (done /
  cancelled / error counts, actual vs estimated time), what the Hub has
  recorded in the printers' heads, a whitelisted summary of each printer's
  Klipper settings (sections and keys a tuning review reads; no macros, no
  pins, no addresses), and for a family the table of what changed between
  variants and how outcomes moved.
- **3MF**: the geometry the Hub measures from the meshes (size, overhangs,
  floating undersides, bed contact, painted faces, volume), the designer's
  profile keys, the print history, the loadout, and the *name* of the plate
  image (the picture itself is not sent; the model has no tools in a review).
- **printer**: the Klipper summary above, the firmware version line
  (`/printer/info`), whether `config/extended/` (paxx12 Extended Firmware
  overlays) and multiACE files exist (a file listing, not their contents),
  the loadout and failure statistics from the ledger.
- **always**: the knowledge-base excerpt (`sme/core/knowledge.md`, which is
  public research), the matched lessons, and runner-side local sources for
  tier 2+ (below). Never a gcode body, a mesh, a photo, a printer address,
  the token, or anything from `config.json`.

The context is capped at 30 KB of text per target (`GET /api/sme/context`
shows exactly what would be sent; `node scripts/sme-runner.js --dry-run`
builds the prompts and sends nothing).

## Priority order (the queue)

`GET /api/sme/queue` lists **unique targets** — identity is content, not
path — in this order, skipping anything already reviewed at its current
content and anything that errored in the last 6 h:

1. gcode files and **families** by completed prints, most first (ledger counts over every path of the content);
2. 3MFs by how often gcode sliced from them was printed (the Models tab's own name-and-link matching, fed from the ledger), most first;
3. one tuning review per reachable printer;
4. anything new and never printed: gcode, then families, then 3MFs, newest first;
5. anything **changed** since its review: a re-sliced file (new content id), a family with a new variant or new outcomes, a printer whose Klipper settings changed.

Progress (`totals`) counts unique targets per kind, not paths.

### Identity: duplicates are one review

- **gcode**: `sha1(size, first 64 KB, last 256 KB)` — the header (slicer, date, filaments, estimate, thumbnail) and Orca's whole config block, the bytes `advisor.js` / `costing.js` already read. Two slices that agree on all of that are the same slice; a re-slice (new date, new settings) is new content. A copy in another type folder is the same target with two paths.
- **3MF**: `sha1(size, the zip's central directory)` — the directory is a per-entry manifest of CRC32 + sizes, so it changes with any byte of any entry and is byte-identical for a re-download or a renamed copy (`model (1).3mf`). One ~64 KB tail read per file — the bytes `models.js` reads for a thumbnail — so the 222 GB shelf is never hashed in full. Measured 2026-10-04: 2,256 files under `E:\3d`, 184 under `E:\Downloads`.
- Ids are cached by path + size + mtime in `sme.json`, so a queue build only reads files that changed; the first build of a big shelf runs in the background and `GET /api/sme/queue` answers `building: true` with progress until it is done (the runner waits up to `SME_QUEUE_WAIT_MS`).
- Reviews show every path (`paths`, "also at …"); `GET /api/sme/reviews?kind=gcode&key=<any path>` resolves to the content's review.

### Families: variants as an iteration history

Gcode files whose names normalise to the same model (`_PLA_6h16m` / `_9h21m`
tails, `v2` / `v3`, ` (1)`, `- Copy`, plate counts stripped; `sme/core/family.js`
`familyName`) are a **family**, reviewed once as a timeline: members in the
order they were first printed, the settings that changed between each pair
(only keys that differ, from the config blocks), and how the outcomes moved
(failure rate; actual vs estimate at equal reliability). The reviewer says
which changes helped and which hurt, which variant is currently best (and
why, with the numbers), and **one** next experiment. Every member gets a
status line ("v3 of 5 — superseded by v4: fixed stringing via retraction
0.8→1.2"), shown on its print rows and the job card; the ★ marks the current
best. A family is re-reviewed when a member appears or new outcomes land —
not on a timer.

Improvements the outcomes back become **lessons** by themselves (condition =
the family's printer type and material plus the changed key at its old value;
change = the new value; confidence 0.5 + 0.1 per backing print, capped 0.9);
regressions become "avoid" lessons. The reviewer's own verdict on a step must
agree with the numbers for the lesson to be minted.

Only gcode forms families (that is where outcomes exist); 3MFs are deduplicated
by content but reviewed one by one.

### Deeper than the Models tab

Upstream's shelf index stops four folders down. Measured 2026-10-04 on
`E:\3d`: 487 of 2,256 files sit deeper (486 of them under `Yosh/…`, e.g.
`Yosh/Aug26/Collectibles/Call of Duty 4/Mini Poster/x.3mf`). The SME walks
to `U1HUB_SME_MODELS_DEPTH` (default 8) so those are reviewed too; their
review shows on the SME tab (a card only exists for files the Models tab
lists).

**Mount layout for the container.** Mount `E:\3d` *as* the models root
(`cfg.models.folder`), not under it: an extra level would push 191 more
files past upstream's four and change every designer column. Put
`E:\Downloads` *inside* it as `<root>/downloads` (a nested read-only bind
mount) and add `"models": { "wrappers": ["downloads"] }` to `config.json`
so `models.js` treats that folder as a format folder (group), not as a
designer. Folders starting with `_` (e.g. `_organize`) are skipped by both
walks.

## Model routing: the cheapest model that can do it (`sme/core/tiers.js`)

| Tier | Model (default, env) | When |
|---|---|---|
| 1 | `haiku` (`SME_MODEL_TIER1`) | routine gcode: one material, no prime tower / tool changes, ≥ 3 completed prints (`tier1.min_done`), no cancels or errors, median actual / estimate within 0.8–1.25 (`tier1.time_ratio`); or every open issue covered by confirmed lessons |
| 2 | `sonnet` (`SME_MODEL_TIER2`) | everything else: most gcode and 3MF reviews, families with clean outcomes |
| 3 | `opus` (`SME_MODEL_TIER3`) | printer tuning (Klipper drafts); ≥ 2 failed prints (`tier3.min_failures`); 3MFs with steep overhang ≥ 25 %, floating underside ≥ 10 %, bed contact < 20 % of footprint or floating parts; actual time < 0.6× or > 1.5× the estimate; families with repeated failures or conflicting outcomes; the monthly knowledge refresh |

`SME_MODEL=<alias>` forces one model for everything. `fable` is used only
when an env names it. The thresholds are the one `THRESHOLDS` object in
`sme/core/tiers.js`. An alias the CLI rejects (not offered, retired) falls
back once (`fable→opus`, `opus→sonnet`, `haiku→sonnet`) and the review
records the model that actually answered (`model`, `reviewer` = the model id
from the CLI's `modelUsage`), plus token usage and cost when the CLI's JSON
reports them (`usage`, `total_cost_usd`).

**Escalation** (one per target per run, never past tier 3): the answer fails
the schema, or rates its own `confidence` low. A "not enough data" gap does
NOT escalate: on the first real runs (2026-10-04) 3 of 4 tier-2 reviews
escalated on gaps such as "no cancel reason recorded" or "no roll recorded for
the loaded heads", and opus then reported the same gaps - missing data, which
a bigger model cannot supply. Gaps stay on the review as the list of data
worth feeding the SME next. The record says `escalated` and `escalated_from`.

**Lean prompts.** Tier 1 sends only the file / settings / outcome / loadout
sections and the knowledge sections that match the material and printer type
(§6 filament rows for the material; §2 + §2b for a U1, §3 for the Kobra).
Tiers 2–3 send every section and the whole knowledge base (under 60 KB,
else matching sections plus the dated header).

## Lessons learned (`sme/core/lessons.js`, `SME_HOME/lessons.json`)

A lesson is one condition → fix pair: `{ id, signature { printer_type,
material, tag, setting_keys [{ key, min, max, equals }], geometry_flags },
finding, change { text, orca, klipper }, evidence { reviews, outcomes { done,
failed } }, times_confirmed, last_seen, confidence, created, source }`.

- **Before** a review the target's facts (printer types, materials, symptom
  tags derived from the outcomes and geometry: `failures`, `cancelled`,
  `overhang`, `floating`, `small_bed_contact`, `slow_vs_estimate`,
  `fast_vs_estimate`, `multi_color`, `mixed_materials`) and its settings are
  matched against every lesson (`matchLessons`, pure). Matches go to the
  reviewer as **KNOWN SOLUTIONS** to apply and cite. If every issue is covered
  by a confirmed lesson the target is tier 1; if every issue is covered by an
  *exact* lesson confirmed ≥ 3× at confidence ≥ 0.7 there is **no model
  call**: the review is built from the lessons and labelled "from lessons".
- **After** a review, `new_lessons` are merged (dedupe by signature; an
  overlapping signature — same tag and material, compatible printer type,
  shared setting key — merges and widens the range rather than creating a
  near-duplicate; one review cannot create two near-duplicates either),
  `confirmed_lessons` / `lessons_used` bump `times_confirmed` (+0.1
  confidence, cap 0.95), and family outcomes mint lessons as above.
- **Outcome feedback**: when a later print of a file whose review used a
  lesson finishes (`print.done`) or fails (`print.cancelled` / `print.error`,
  from the ledger's own events), that lesson's confidence moves +0.05 / −0.1
  (floor 0.05) and its outcome counts update.

**One source of truth across projects.** The lessons live in
`SME_HOME/lessons.json` (env `SME_HOME`, default `/mnt/e/Code/print-sme-data`,
created on first write by `sme/core/store.js`, never by a checkout), written
only through the core. The Hub keeps a **mirror** (`sme-lessons.json` beside
`config.json`) for its tab and for matching at context time; the runner
replaces the mirror from the store on every run (`POST /api/sme/lessons/sync`)
after applying the feedback the Hub queued (`GET /api/sme/lessons/feedback`).
The core also keeps a **review cache** (`SME_HOME/reviews/<kind>-<hash>.json`):
the same content reviewed from any project is served from it (`--force`
skips it).

## The runner (`scripts/sme-runner.js`)

```
node scripts/sme-runner.js                          # the next SME_BATCH (4) targets
node scripts/sme-runner.js --dry-run                # build the prompts, call and store nothing
node scripts/sme-runner.js --kind gcode --key "u1:file.gcode" [--force]
node scripts/sme-runner.js --refresh-knowledge      # monthly: rewrite knowledge.md with web research
```

Per target: `GET /api/sme/context` → add local sources → `sme/core/review.js`
(`reviewContext`: cache → lessons → prompt → `claude -p` → validate →
escalate once → merge lessons) → `POST /api/sme/reviews` (with
`X-SME-Token`). Then `POST /api/sme/runs` and the lessons sync.

- **`claude -p` flags** (checked against `claude --help` 2.1.289 and the CLI
  reference, without spending a prompt): `-p --output-format json --model
  <alias> --no-session-persistence --permission-prompts none
  --permission-mode dontAsk --disable-slash-commands --strict-mcp-config
  --mcp-config '{"mcpServers":{}}' --append-system-prompt <agent.md>
  --tools "" --max-turns 3`; the prompt goes on **stdin** (`cat file | claude
  -p`, no argv limit). The refresh uses `--tools WebSearch,WebFetch
  --allowedTools WebSearch,WebFetch --max-turns 80`; a `photo` target
  `--tools Read --add-dir <stills>`. **Never `--bare`**: bare mode reads only
  `ANTHROPIC_API_KEY`, not the subscription login.
- **Usage limits**: a usage-limit / rate-limit answer stops the batch, writes
  `paused_until` (parsed from "resets at 3pm" / "resets in 2 hours", else
  +60 min) to `sme-runner.json` and the Hub, and exits 0; later runs exit at
  once until it passes. To pause by hand: set `paused_until` in
  `sme-runner.json`, or uninstall the schedule.
- **Lock**: `sme-runner.lock` (pid + time); a live lock makes a second start
  exit 0; a lock older than 3 h or from a dead pid is taken over.
- **Errors**: a target whose answer is garbage twice (one escalation) or
  whose context fails is recorded (`POST /api/sme/errors`) and left out of
  the queue for 6 h (`U1HUB_SME_ERROR_BACKOFF_MS`); nothing is stored.
- **Log**: `sme-runner.log`; state `sme-runner.json`; all three beside the
  repo (`SME_STATE_DIR`), gitignored.
- **Token**: `SME_TOKEN`, else `GET /api/sme/token` from the Hub on the same
  PC. The token is generated at first boot into `config.json` → `sme.token`
  (never echoed by `/api/config`), shown in Settings → 3D-printing SME, and
  required on every write (`POST /api/sme/reviews|errors|runs|lessons/sync`),
  because the Hub is reachable on the LAN without a login.

### Local sources (runner-side, read-only, optional)

The runner runs on the host, so it can read the owner's other projects; each
is skipped when its path is missing (`scripts/sme-local-sources.js`):

| Source | Env | Used for |
|---|---|---|
| `/mnt/e/Code/printer_configs/` (`<printer>_working.cfg`, `_current.cfg`, `_backup_*.cfg`) | `SME_PRINTER_CONFIGS` | printer reviews: the same whitelisted sections as the live summary, plus the differences against the live printer (the live printer wins and the prompt says so) |
| `/mnt/e/Code/multiACE/README.md` | `SME_MULTIACE_DIR` | printer reviews of a printer with multiACE (davinci): the README's known issues (ACE_MODE_NORMAL, the ACE USB reset cycle) |
| Spoolman `http://localhost:7912` (`GET /api/v1/spool`) | `SPOOLMAN_URL` | gcode / family / 3MF reviews: which materials and vendors are actually in stock (no prices there) |
| `/mnt/e/Code/bl2u1/` | `SME_BL2U1_DIR` | 3MF reviews of a converted or Bambu-born project: the converter's artefacts (re-centred 256→230 mm bed, filament remaps) |
| `printcat/` | — | not read: its catalog lives in a Docker volume, and the zip-directory content id above already answers "same file" in one small read |

Local sources ride along for tier 2+ only; a tier-1 routine review stays lean.

### Schedule (Windows, `scripts/sme-schedule-install.ps1`)

```
powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1            # install
powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1 -Status    # check
powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1 -Uninstall # remove
```

Two tasks as the current user, only while logged on (the subscription login
lives in that user's WSL home): **"U1 Hub SME review"** hourly at :50 (a minute no other task on this PC uses;
the Channel-* and Snapmaker-* Claude jobs sit on :00-:45), running
`wsl.exe -e bash -lc "cd /mnt/e/Code/u1hub && node scripts/sme-runner.js"`,
and **"U1 Hub SME knowledge refresh"** on the 1st of every month at 03:50
with `--refresh-knowledge`. Written, not run, in the commit that introduced
it (**UNVERIFIED** on Windows — to confirm: run the install line, then
`-Status`).

## The knowledge base (`sme/core/knowledge.md`)

Dated, cited facts the reviewer must prefer over its memory: the U1 and
paxx12's Extended Firmware (§2, §2b, with multiACE), the Kobra S1 + ACE +
Rinkhals (§3), Orca keys (§4), Klipper tuning order (§5), filaments (§6), the
speed-vs-quality playbook (§7), failure modes (§8), what changed recently
(§9), sources (§10). Items marked UNVERIFIED must never be stated as fact in
a review (the agent prompt says so). The monthly refresh asks the tier-3
model, with web tools, to rewrite it in place keeping citations and the
`Last refreshed:` header; the old file is kept as `knowledge.md.bak`; an
answer that lacks the title, the date, five sections, any URL, or is under
half the current size is rejected and the file left alone. A shared copy in
`SME_HOME/knowledge.md` (once a refresh writes one) wins over the repo's.

## The UI (`public/modules/sme-ui.js`)

- **✦ SME badge** on every 3MF card (Models tab), every print row (Projects
  → Prints, project pages) and the Dash job card for the selected gcode: the
  verdict and the one-line summary (a family member shows its own status
  line and ★ when it is the current best). A click opens the review inline:
  settings table (now → suggested → why → impact), printer tuning, speed vs
  quality, risks, evidence, lessons used, the family timeline with the next
  experiment, and the **DRAFT** blocks with a Copy button each.
- **SME tab**: progress per kind (reviewed / unique targets), last run with
  its models and cost, the review list (filter by kind / verdict), a Printers
  view, and **Lessons** (filter by printer type / material / tag; confidence,
  times confirmed, outcomes after use, source reviews).
- **Settings → 3D-printing SME**: what leaves the PC, the runner token
  (copy), how to run and schedule the runner, the last run and pause state.

Nothing in core `app.js`, `models-ui.js` or `costing-ui.js` is patched; the
badges are added after those render (MutationObserver), with `sme-`
prefixed classes.

## API

All under `/api/sme`; absent (404) when the feature is off. Writes need
`X-SME-Token`.

| Method | Path | Answer |
|---|---|---|
| GET | `/queue?limit&refresh=1` | `items[]` (kind, key, content_hash, paths, prints, state, reason, family members/best), `totals` per kind (reviewed / total unique), `unique_targets`, `paths`, `excluded`, `building` + `progress` while hashing |
| GET | `/context?kind&key` | the context contract (CONTEXT.md): `sections`, `order`, `facts`, `settings`, `text` (≤ 30 KB), `tier`, matched `lessons`, `lesson_only` + `lesson_review`, family `members` / `iterations`, printer `firmware` |
| GET | `/reviews?kind&key` | the review for a path (a family member gets `family_review` + `member`), `stale` |
| GET | `/reviews?kind&verdict&brief=1&limit&offset` | the list (brief: paths, verdict, summary, tier, model, from_lessons, member lines) |
| POST | `/reviews` | `{ kind, key, content_hash, review, reviewer, model, tier, escalated, usage, lessons_created, lessons_matched, from_lessons, from_cache … }` → validated (schema, size ≤ 64 KB), 409 if the content changed, stored under the content id with every path |
| POST | `/errors` | records a failure; the target backs off |
| POST | `/runs` | a run record (reviewed, models, cost, pause, knowledge meta) |
| GET | `/lessons?type&material&tag` | the mirror, with source reviews resolved |
| GET | `/lessons/feedback?after` | outcome feedback the Hub queued for the shared store |
| POST | `/lessons/sync` | `{ lessons, feedback_through }` replaces the mirror, acknowledges feedback |
| GET | `/status` | counts, totals, last run(s), last error, pause, tier thresholds, schedule lines |
| GET | `/token` | the runner token (behind the Hub login like every route) |

## State

| File | Content |
|---|---|
| `sme.json` (beside config.json) | reviews by `kind|content id`, the content-id cache, errors, runs, feedback queue, pause |
| `sme-lessons.json` (beside config.json) | the lessons **mirror** |
| `SME_HOME/lessons.json`, `SME_HOME/reviews/` | the shared store of record and the review cache (core) |
| `config.json` → `sme.token` | the runner token |
| `sme-runner.lock` / `.json` / `.log` (repo root) | the runner's own |

All gitignored. Reads from printers are three small JSON GETs per printer,
cached ten minutes (`/printer/objects/query?configfile=settings`,
`/printer/info`, `/server/files/list?root=config`); never a gcode body
(MISTAKES.md 2026-09-14).

## Using the core from another project

See [sme/core/CONTEXT.md](../sme/core/CONTEXT.md): build a context JSON,
run `node sme/core/cli.js review --context ctx.json`, read the review from
stdout; lessons and the cache are already shared through `SME_HOME`. A
`photo` kind exists for finished-print stills (YT_Steam_Manager's
`finished_print_stills.py`); the example there maps its `print_stats_ledger.py`,
`filament_judge.py` and `printer_profiles.json` onto the contract. What
remains for a clean extraction into `ryvin/print-sme`: move `sme/core/` as
is (it has no dependency on the Hub), give it a `package.json` and a `bin`,
and point the adapter's `require("../sme/core/…")` lines at the package.

## Verification record

Recorded in the commit that introduced the module: both suites' pass counts
and their falsified runs going red (`U1HUB_SME_FALSIFY=1` flips the tier-1
routing, the family "best" and the queue-order expectations), the costing
and printer-sync suites, the full harness, `scripts/check-core.js`,
`scripts/check-index-js.js`, and a browser pass (Playwright, a throwaway Hub
with mocks) over the badge on a 3MF card, a print row, the SME list and the
draft copy buttons. No printer is touched by the module; the three Moonraker
GETs are the same read-only JSON endpoints core and other modules already
use. **Still to run on the deployed Hub**: the first `node scripts/sme-runner.js
--dry-run` (reads the real shelf: expect `queue: N pending of M unique
targets` with M under 2,500), then one real run with `SME_BATCH=1`, then the
schedule install and `-Status`.
