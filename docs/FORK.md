# ryvin/u1hub — what this fork adds, and how it stays rebased

This is a fork of [dlgambill/u1hub](https://github.com/dlgambill/u1hub). Everything
upstream ships is here unchanged. The fork adds three switches, all of them
feature modules, so that the diff against upstream stays small and every
upstream release rebases in a few minutes.

## What the fork adds

| Feature flag | Default | Lite | What it does |
|---|---|---|---|
| `printer-sync` | **off** | off | Copies gcode that lands on a printer some other way (Orca straight to the machine, USB) into the Hub library, one file at a time, never while that printer is printing. See [printer-sync.md](printer-sync.md). |
| `library-colors` | on | off | Color dots under each library row, and a "printable on" chip bar that filters the library to files whose colors are all loaded on a chosen printer right now. Client only. It reads the match module's `/api/library-palettes`. |

Switch any of them from Settings → Features, or in `config.json`:

```json
"features": { "printer-sync": true }
```

`printer-sync` ships off until its live hardware gate is recorded below. Upstream
does the same with `slicing`.

## The whole diff against upstream

| File | Change |
|---|---|
| `modules/printer-sync.js` | new, server module |
| `public/modules/library-colors-ui.js` | new, client module |
| `test/printer-sync-standalone.js` | new, fork suite (part of `npm run test:standalone`) |
| `docs/FORK.md`, `docs/printer-sync.md` | new |
| `core/modules.js` | +1 `MODULE_TABLE` entry |
| `core/app.js` | +1 `CLIENT_TABLE` entry |
| `core/config.js` | 3 keys in `MODULE_DEFAULTS`, 2 in `LITE_OFF` |
| `test/mock-moonraker.js` | +1 route: `GET /server/files/gcodes/<name>` serves a stored file's bytes |
| `test/run-tests.js` | `U1HUB_HARNESS_SKIP_SLICE=1` lets a clone without upstream's private slice fixtures run the rest of the harness. The skip is printed. |
| `package.json` | the fork suite is appended to `test:standalone` |
| `.gitignore` | `docker-compose.override.yml`, `data/` (Docker deploy state) |

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
# rarely package.json "test:standalone" or .gitignore
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
| printer-sync against a real U1 (one small file pulled from an idle printer, Moonraker RSS before and after, busy printer skipped) | **not yet run**. Flip the `MODULE_DEFAULTS` entry to `true` in the commit that records it. |
| library-colors in a real browser against the live fleet | see the commit that introduced it |
