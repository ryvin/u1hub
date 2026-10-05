# bl2u1 (fork module): Convert to U1 with the owner's converter

The Models tab's **Convert to U1** button normally merges the file into a U1
template project and writes the copy **beside the original**. On this host the
3MF folders are mounted into the Hub **read-only** (`E:\3d` is the models root,
`E:\Downloads` is `<root>/downloads`), so that copy cannot be written. The
owner already runs a converter built for exactly this job:
[bl2u1](https://github.com/ryvin/bambu-to-snapmaker-converter) (container
`bambu-to-u1-converter`, port 8090). It re-centres models from the Bambu bed to
the U1 bed, maps filaments, keeps tree supports, and writes `<name>_U1.3mf` to
its own output folder.

Feature flag `bl2u1` (on; off in Lite). Module: `modules/bl2u1.js`.

## What happens when you press Convert

1. The module answers `POST /api/models/convert` **before** upstream's models
   module (it sits ahead of `models` in `MODULE_TABLE`).
2. It maps the card's models-relative path to the host path bl2u1 mounts:
   `downloads/...` → `/mnt/e/Downloads/...`, anything else →
   `/mnt/e/3d/...`. A path that tries to leave the root is refused.
3. It calls bl2u1's `POST /convert-file {"filepath": ...}`. bl2u1 writes the
   copy to its output folder (`/mnt/e/3D/converted_u1` here), which is inside
   `E:\3d`, so the copy shows up on the Models tab under `converted_u1/`. The
   module then asks the Models tab to re-scan.
4. The answer has the shape the card already shows: the copy's path, plus a
   note that bl2u1 did the conversion. A file with more than 4 filaments also
   gets a note pointing at multiACE (davinci) or re-assigning colours in Orca.

**When bl2u1 does not do it:**
- **The same file again:** bl2u1 has converted this content before, so the
  module answers 409 "Already converted by bl2u1", naming the copy so the card
  can offer it.
- **Not a Bambu Lab file:** the request goes on to upstream's template convert,
  which behaves exactly as before.
- **bl2u1 not reachable:** the request also goes on to upstream's template
  convert, and the Hub log records it.

## Configuration (`config.json`, all optional)

```json
"bl2u1": {
  "url": "http://host.docker.internal:8090",
  "roots": [ { "rel": "downloads/", "host": "/mnt/e/Downloads/" }, { "rel": "", "host": "/mnt/e/3d/" } ]
}
```

The defaults match `docker-compose.override.yml` on this host. The built-in
`url` applies **only inside the Hub's Docker container** (`/.dockerenv`): a Hub
run anywhere else - the test harness on the host, a Windows service - must set
`bl2u1.url`, or the module stays idle and the template convert answers. (On
2026-10-05 a harness Hub on this PC reached the owner's real bl2u1 through
`host.docker.internal` before this rule existed.) If bl2u1 answers "File not
found" for the mapped path, the roots do not describe this install and the
template convert answers too. If the 3MF mounts
change, change `roots` to match. `GET /api/bl2u1` shows the URL, the roots,
whether bl2u1 answers, and where its output folder lands on the Models tab.

## Tests

`node test/bl2u1-standalone.js` covers:
- path mapping both ways, including case-insensitive matching and refusing to climb out of the root;
- a mock bl2u1 receiving the host path;
- the response shape;
- the 409 for a file converted before;
- a non-Bambu file and an unreachable bl2u1 both falling through to upstream;
- the feature switched off, and Lite.

`U1HUB_BL2U1_FALSIFY=1` turns the host-path check red.
