# SME core — the context contract

`sme/core/` is the project-agnostic half of the 3D-printing SME: pure Node,
no Express, no Hub. It can be lifted into its own repo (`ryvin/print-sme`)
as is. A project (an **adapter**) builds one **context** JSON per target,
hands it to the core (`node sme/core/cli.js review --context ctx.json`, or
`require("./sme/core/review.js").reviewContext(ctx, opts)`), and gets a
validated **review** JSON back. Lessons and the review cache are shared
through **`SME_HOME`** (default `/mnt/e/Code/print-sme-data`, created on
first write), so a fix learned in one project is a known solution in every
other.

## Files

| File | What |
|---|---|
| `agent.md` | the reviewer's system prompt (role, rules, output schema) |
| `knowledge.md` | the dated, cited knowledge base; `refresh-knowledge` rewrites it (a shared copy in `SME_HOME/knowledge.md` wins over the repo's once one exists) |
| `schema.js` | review schema + `validateReview(review, kind)`, `validateContext(ctx)` |
| `tiers.js` | `pickTier(facts)`, model per tier, escalation rule, knowledge section selection, usage-limit / rejected-model detection |
| `lessons.js` | lesson shape, `matchLessons`, coverage, lesson-only review, merge / confirm / feedback |
| `family.js` | iteration histories: member order, settings diff, outcome effect, auto-lessons, member status lines |
| `claude.js` | the `claude -p` wrapper (stdin prompt, JSON out, tools off, alias fallback, usage-limit pause) |
| `store.js` | `SME_HOME`: `lessons.json` (the one source of truth), `reviews/<kind>-<hash>.json` cache |
| `review.js` | the pipeline: cache → lessons → prompt → model → validate → escalate → merge lessons |
| `cli.js` | the command |

## Context (what an adapter sends)

```jsonc
{
  "kind": "gcode" | "3mf" | "printer" | "family" | "photo",
  "key": "u1:file.gcode",            // the adapter's own id for the target (any string)
  "name": "file.gcode",              // what to call it in the prompt and in reviews
  "content_hash": "<sha1>",          // identity of the CONTENT: the same hash is served from the cache
  "paths": ["u1:file.gcode"],        // every place this content lives (optional)
  "sections": {                      // plain-text blocks the reviewer reads, in `order`
    "file": "FILE: ...\nPLATE: ...",
    "settings": "SLICER SETTINGS:\n  layer_height = 0.2\n  ...",
    "outcome": "OUTCOME HISTORY ...", "loadout": "...", "klipper": "..."
  },
  "order": ["file", "settings", "outcome", "loadout", "klipper"],
  "facts": {                         // what the tier router, the tags and the lesson matcher read
    "materials": ["PLA"],
    "multi_color": false,
    "prints": { "done": 3, "cancelled": 0, "error": 0 },
    "time_ratio": 1.05,              // median actual / slicer estimate, or null
    "geometry": { "steep_pct": 12, "flat_unsupported_pct": 0, "bed_contact_pct": 60, "floating": 0 } | null,
    "conflicting": false,
    "printer_types": ["u1"],
    "printer": { "name": "davinci", "type": "u1", "firmware": { "software_version": "v1.5.2-paxx12-21", "base_version": "1.5.2", "extended": true, "multiace": true } },   // optional
    "covers": ["settings", "outcome_history", "loadout", "klipper"]   // topics the context actually contains (a "not enough data" gap on one of these escalates)
  },
  "settings": { "layer_height": "0.2", "retraction_length": "0.8", "extruder.pressure_advance": 0.04 },   // flat key -> value, for lesson signatures
  "members": [...], "iterations": [...],   // family only (see family.js familyTable)
  "images": [{ "path": "/abs/still.jpg", "caption": "front, 2026-10-04" }]   // photo only; the model reads them with its Read tool
}
```

Tier-1 (routine) prompts send only `file`, `settings`, `outcome`, `loadout`
plus the knowledge sections that match the material and printer type. Tier 2
sends every context section but only the matching knowledge sections (printer
type, Filaments, Orca, Speed-vs-quality, Failure modes); tier 3 sends
everything, including the whole knowledge base (under 60 KB). Keep the context
sections under ~30 KB in all.

## Review (what comes back)

The schema in `agent.md` (`verdict`, `summary`, `settings[]`,
`printer_tuning[]`, `speed_quality[]`, `drafts {orca, klipper}`, `risks[]`,
`confidence`, `evidence[]`, `gaps[]`, `lessons_used[]`, `confirmed_lessons[]`,
`new_lessons[]`, `family`), validated and capped by `schema.js`. The core's
answer wraps it:

```jsonc
{ "status": "stored" | "cached" | "lessons" | "dry" | "paused" | "error",
  "review": { ... }, "tier": 2, "model": "sonnet", "model_id": "claude-sonnet-5",
  "escalated": false, "escalated_from": null,
  "usage": { "input_tokens": 9000, "output_tokens": 600, "cost_usd": 0.02 },
  "lessons": { "created": [], "merged": [], "confirmed": ["ls_…"], "auto": [] },
  "lessons_matched": ["ls_…"], "prompt_chars": 24000, "knowledge_sections": ["6. Filaments …"],
  "paused_until": null, "error": null }
```

Nothing in a review is applied by the core or by any adapter: `drafts` are
for a person.

## Shared state (`SME_HOME`)

- `lessons.json` — `{ lessons: { id: lesson } }`; written only through
  `store.js` (`absorb` after a review, `applyFeedback` from outcomes). An
  adapter that shows lessons keeps a **mirror** and syncs it from here.
- `reviews/<kind>-<content_hash>.json` — the review cache; `--force` skips it.
- `knowledge.md` — written by `refresh-knowledge`; the repo copy is the seed.

## Calling it from another project (YT_Steam_Manager example)

YT_Steam_Manager has `print_stats_ledger.py` (outcomes), `finished_print_stills.py`
(photos of finished prints), `recovery_recurrence.py`, `filament_judge.py`,
`printer_profile.py` / `settings/printer_profiles.json`. Its adapter would:

1. Build a context per finished print: `kind: "photo"`, `key: "<job id>"`,
   `content_hash: sha1(still bytes + job id)`, `images: [{ path, caption }]`
   from `finished_print_stills.py`, `sections.outcome` from
   `print_stats_ledger.py` (done / failed, duration vs estimate),
   `sections.settings` from the job's gcode header if it has one,
   `facts.printer_types` / `facts.printer` from `printer_profiles.json`,
   `facts.materials` from `filament_judge.py`, `facts.covers:
   ["images", "outcome_history", "loadout"]`.
2. `SME_HOME=/mnt/e/Code/print-sme-data node /mnt/e/Code/u1hub/sme/core/cli.js review --context ctx.json`
   (the core runs Claude Code with only its Read tool, scoped by `--add-dir`
   to the stills' folder, so it can look at the photos).
3. Read `status` and `review` from stdout; store the review in its own UI;
   lessons it produced are already in `SME_HOME/lessons.json` for everyone.
4. Later outcomes: `node sme/core/cli.js lessons feedback --ids ls_a,ls_b --outcome done`.

Any other project (FilamentHub, multiACE, bl2u1, printcat) does the same
with its own kinds (`gcode`, `3mf`, `printer`); only the adapter differs.
