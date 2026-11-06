# Asset admin — spec

Status: agreed with the user, 2026-11-06 (two question rounds + layout round, all recommended
answers except that editing is limited to replacing files).

## Goal

One local page to find any game asset by category, download it, and replace it with a file
edited elsewhere (e.g. Aseprite), without hand edits being lost when the pipeline runs again.

## Scope of this version

Single user, on this machine only: served on `127.0.0.1`, no login. Editing means **download,
edit in another program, upload to replace**. The design leaves room to go online later by keeping
all file access behind the server API; nothing else is built for that now.

## User-facing behavior

### Layout (three panes)

- **Left, categories:** Body, Face, Hair, Clothes, Weapons, Effects, Legacy, each with its item
  count. A category with no files shows 0 and stays visible.
- **Middle, grid:** thumbnails of the selected category, a search box, and filters for body,
  direction and state. A marker shows items with hand-edited frames.
- **Right, details:** animated preview, frame strip, download buttons, replace button, version
  history. A frame strip entry is marked when it is a hand edit.

### Download

- A whole sheet or part image; a single frame; a whole category as ZIP.
- Frame files are named `<asset>_<state>_<dir>_<frame>.png` (e.g. `human_walk_S_2.png`), so an
  upload of that file is matched to its place without asking.

### Replace

1. Upload a frame, or a whole sheet (from the details pane; a frame file can also be dropped).
2. The server validates it (rules below). A refusal says what is wrong and changes nothing.
3. For a sheet, the server finds the frames that differ. Only those are replaced.
4. The page shows before/after for each changed frame, animated in context.
5. Confirm applies the change; Cancel leaves everything as it was.
6. The game and the lab see the new image on their next load.

The admin never commits: changes appear as ordinary working-tree changes in Git.

### History and undo

Every replace stores the previous version first. The details pane lists versions (time, frames
changed) with **Restore**. A hand-edited frame also has **Use pipeline frame**, which drops its
override and returns to the generated image. Both restoring and dropping are recorded as new
versions, so they can be undone too.

### Legacy

`art/paperdoll` and `art/paperdoll2` appear only under Legacy: view and download, no replace.

## Categories

| category | source | item | filters |
|---|---|---|---|
| Body | `art/bodies/<body>/sheet.png` + `sheet.json` | one body | body, direction, state |
| Face | `art/bodies/<body>/eyes.png` + `sheet.json.eyes` | one body's eye set | body, direction, open/closed |
| Hair, Clothes, Weapons, Effects | `art/layers/<category>/<part>/sheet.png` + `sheet.json`, when they exist | one part | body, direction, state |
| Legacy | `art/paperdoll/*`, `art/paperdoll2/*` | one folder | set |

Categories come from a table in the server, one entry per source pattern, so a new layer needs
one new row. Files that match no entry are listed under an "Unsorted" group shown only when
non-empty, so nothing is hidden silently.

## Rules

### Validation

| check | applies to | on failure |
|---|---|---|
| decodes as PNG with an alpha channel | all | refuse |
| frame size equals `frameW × frameH` (160×160 for Body) | frame | refuse |
| face cell size equals `eyes.w × eyes.h` | Face | refuse |
| image size equals the current sheet's size | sheet | refuse |
| file name, if parsed as a frame name, names an existing asset, state, direction and frame | frame | refuse |
| partly transparent pixels (alpha not 0 or 255) | all | warn: the game cuts alpha at 0.5 |
| nothing differs from the current file | all | report "no change", store nothing |
| lowest opaque row of a Body frame is not on `feetY` (±1) | Body frame | warn: the sprite will jitter |

Warnings do not block; they appear in the before/after step.

### Overrides

- A confirmed frame is written to `art/overrides/<category>/<asset>/<state>_<dir>_<frame>.png`
  **and** pasted into the live sheet at the rect given by `sheet.json`. Face frames use the states
  `open` and `closed` and always frame 0, e.g. `closed_SW_0.png`.
- `bodies.py extract` applies every override to `sheet.png` and `eyes.png` as its last step, after
  tone matching, so regenerating never loses a hand edit. Extract prints how many overrides it applied.
- **Use pipeline frame** needs the generated frame the override hides. The admin saves it to
  `pipeline/` in the asset's history folder before the first override of a frame, and extract refreshes
  it each time it applies that override. If that copy is missing (another machine), the button says
  to run extract first.
- An override of a frame that no longer exists (states or directions changed) is not applied; extract
  prints it and the admin shows it under the asset as orphaned, to download or delete.
- Hand-edited pixels are used exactly as uploaded: no palette, tone or feet snapping.
- Overrides are committed with the art, as they are source work that cannot be regenerated.

### Blink and eyes

Blink comes from the eye layer on the body sheet, not from a stored Body frame, so a Body override
applies to open and closed eyes alike. Edits to eyes go through Face.

## Data model

```
art/overrides/<category>/<asset>/<state>_<dir>_<frame>.png     hand-edited frames (in Git)
pipeline/out/admin_history/<category>/<asset>/<version>/       sheet + overrides as they were + version.json (gitignored)
pipeline/out/admin_history/<category>/<asset>/pipeline/        generated frames hidden by overrides (gitignored)
```

`version.json`: `{ "time": ISO-8601, "action": "replace" | "restore" | "use_pipeline",
"frames": ["walk_S_2"], "note": "<uploaded file name>" }`.

API of `tools/admin.py` (default port 5181, `127.0.0.1` only):

| method | path | purpose |
|---|---|---|
| GET | `/` | the admin page |
| GET | `/api/categories` | categories with counts |
| GET | `/api/assets?category=` | items of a category |
| GET | `/api/asset?id=` | details, frames, overrides, versions |
| GET | `/api/thumb?id=&state=&dir=` | thumbnail |
| GET | `/api/download?id=[&key= \| &file= \| &override=]` | sheet, frame, listed file or orphaned override |
| GET | `/api/download-category?category=` | ZIP |
| GET | `/api/pending?token=` | the sheet as it would be after apply, for the preview |
| POST | `/api/upload-preview` | validate; returns a token, changed frames, warnings |
| POST | `/api/apply` | apply a preview token |
| POST | `/api/restore` | restore a version |
| POST | `/api/use-pipeline` | drop one override (also deletes an orphaned one) |

The server runs on the webui venv's Python (it needs Pillow and numpy). Asset ids are resolved through
the category table, never used as paths, so a request cannot reach a file outside `art/`. Static files
are limited to `art/`, `tools/admin/` and the two game modules the preview uses. Every request must
carry the admin's own `Host`, and POST requests its own `Origin`, so that another website open in the
browser cannot read from or write to the local server. Each file write goes to a temporary file and
is then renamed over the target.

## Edge cases

- **Pipeline running during a replace:** the admin cannot detect it. Extract and an apply racing on
  one sheet could lose the apply's paste, but the override file survives and the next extract
  restores it.
- **Sheet changed between preview and apply:** apply compares the sheet's hash with the one from
  preview and refuses, asking to upload again.
- **Sheet upload with an old layout** (same size, frames moved): the diff marks many frames, which is
  visible in the before/after step before confirming.
- **Mirrored directions (NE, E, SE):** not stored; only the 5 drawn directions can be replaced.
- **Very large upload:** refused above 32 MB.
- **History growth:** kept without limit for now, in a gitignored folder of small PNGs. This folder
  exists only on this machine; committed versions remain in Git.

## Build order

1. `tools/admin.py`: category table, list, download.
2. Page: three panes, preview, downloads.
3. Replace: validation, preview, apply, history.
4. Overrides in `bodies.py extract`.

## Success criteria

- Every file under `art/` is reachable from a category or Unsorted.
- A frame edited in another program replaces its slot in under a minute and plays in the lab.
- Running `bodies.py extract` after a hand edit keeps the edit.
- A wrong-size file changes nothing and says why.
- Any replace can be undone from the page.

## Out of scope

Drawing in the browser, triggering AI generation, editing JSON values or metadata, adding new assets
from the page, replacing Legacy files, accounts and roles, hosting online.

## Open questions

None blocking. Port, override paths and file names are implementation defaults chosen during design.
