# Asset pipeline (generate → process → QC)

Python scripts that drive the parent AUTOMATIC1111 webui over its HTTP API, turn the
1024px "fake pixel art" into real game sprites on the shared palette, and produce a QC
contact sheet you approve assets from.

```
jobs/<name>.json ──generate.py──▶ out/<name>/raw/*.png + *.json (prompt, seed, settings)
                 ──process.py───▶ out/<name>/processed/*.png + *.json (+ process params)
                 ──qc.py────────▶ out/<name>/qc_report.json + report.html
```

## Setup

1. Python 3.10+ with `pip install -r requirements.txt` (requests, pillow, numpy).
   Optional, better background removal: `pip install rembg` (uses the `isnet-anime` model;
   downloads it on first run). Without rembg a flood-fill from the white border is used.
2. Enable the webui API: in `..\..\webui-user.bat` change
   `set COMMANDLINE_ARGS=--xformers --medvram-sdxl --opt-sdp-attention`
   to
   `set COMMANDLINE_ARGS=--xformers --medvram-sdxl --opt-sdp-attention --api`
   then start `webui-user.bat` as usual (API at http://127.0.0.1:7860/docs).

## Run

```bash
python generate.py jobs/test_batch.json     # skips assets that already exist; --force to redo
python process.py  jobs/test_batch.json
python qc.py       jobs/test_batch.json     # then open out/test_batch/report.html
```

In the report: green = pass, amber = warn (look at it), red = fail (unticked by default).
Tick/untick, then **Export approvals** → `approvals.json`.

## Job file

```json
{
  "name": "test_batch",            // output folder out/<name>
  "preset": "elin_sprite",         // key in presets.json
  "assets": [
    {"id": "mage_S", "group": "mage", "direction": "S", "seed": 1001,
     "prompt": "1girl, mage, blue robe, brown hair",
     "controlnet": {"image": "guides/mage_S.png", "module": "invert", "weight": 0.8}}
  ]
}
```

- `group` = assets that must match each other (one character's directions/frames). They
  share one scale factor and are checked for baseline/height/center consistency.
- `direction` (S, SW, W, NW, N) adds the preset's direction tags. The LoRA was trained on
  front views only, so N/NW/W will be unreliable without ControlNet guides.
- `seed` is optional (-1 = random); the actual seed is always recorded in `raw/<id>.json`.
- `controlnet` is optional. `image` is relative to the job file. `module`: `invert` when
  the guide is black lineart on white (e.g. a Blender Freestyle render), `lineart_anime`
  when the guide is a normal image. Model defaults to `noob-lineart-anime`. Optional
  `steps`, `cfg`, `negative` per asset.

## Presets (`presets.json`)

`elin_sprite` (64×64 canvas, 56px tall character, feet on row 61) and `elin_item`
(32×32). Each has generation settings (checkpoint, LoRA weight, Euler a, 28 steps,
CFG 5–5.5, 1024²), `process` settings and `qc` thresholds — tune them there.

`palette.hex` is the shared game palette; the first color is the outline color. It is a
placeholder: replace it with your final palette and re-run `process.py`.

## What process.py does

1. Background → alpha (rembg if installed, else flood-fill of near-white from the border;
   white *enclosed* by the character, e.g. between arm and body, stays opaque with
   flood-fill — QC's halo check and your eyes catch that).
2. Crop to the character, map every pixel to the nearest palette color.
3. Downscale by **majority vote per target cell** — nearest-neighbor that ignores
   anti-aliasing and the LoRA's misaligned fake pixels, so the result is crisp 1:1 pixels.
4. Place on the canvas, horizontally centered, lowest pixel on the `baseline` row.
5. 1px outline in palette color 0.

## Paper-doll sheets (`pack.py`)

Spec: `../docs/specs/character-dressing.md`.

```bash
python make_placeholders.py   # writes placeholder source art into ../art/paperdoll/ (overwrites it!)
python pack.py                # ../art/paperdoll/ -> ../assets/paperdoll/manifest.json + parts/*.png
```

`pack.py` validates every cell (64×64, binary alpha, palette colors, all anims/directions/
frames present, anchors complete) and refuses to write the manifest otherwise. Replace
placeholder parts with real ones by exporting cells from Aseprite into
`../art/paperdoll/<part_id>/` with the same file names.

Preview (from the `Project DND` folder):

```bash
python -m http.server 8765
```
then open http://localhost:8765/preview/index.html. Equip parts, dye, turn, walk in a
circle, and use the anchor editor (Download anchors.json → save it as
`art/paperdoll/<body id>/anchors.json` → re-run `pack.py`). The reusable code is
`../src/paperdoll/paperdoll.js` (engine-agnostic) and `three-sprite.js` (Three.js).

## QC checks (`qc.py`)

| check | level |
|---|---|
| canvas size ≠ preset | fail |
| near-blank (opaque < `min_fill`) | fail |
| sprite touches canvas edge / character touches raw image edge (cut off) | fail |
| semi-transparent pixels | fail |
| colors outside palette | fail |
| more than `max_colors` colors | warn |
| stray pixel islands ≤ `stray_max_px` (outline ring ignored) | fail; bigger detached parts → warn |
| white halo on the inner edge > `halo_max_ratio` | warn |
| foot baseline off the group median by > `baseline_tol` | fail |
| height / center x off the group median | warn |
| near-duplicate of another asset (≥ `duplicate_sim` identical pixels) — e.g. the model ignored the direction | fail |

## v2: AI layered sprites (`sheet.py`) — use this for real art

See `../docs/specs/art-pipeline.md`. Run with the webui's venv Python
(`../../venv/Scripts/python.exe`); the webui must run with `--api --lowvram` on this 6 GB GPU.

```
python guides.py                       # once: 5-view mannequin lineart guide
python sheet.py base A --seeds 201 202 # candidate base views per direction (prints automatic QC)
python sheet.py qc A                   # re-run QC on everything generated so far
bash run_set.sh A 201                  # pick base views of seed 201, all parts, items, extract, contact sheet
python sheet.py contact A              # out/v2/A/contact.html for human review
```

Parts, items and prompts live in `sets/A.json`. Output art goes to `../art/paperdoll2/A/`,
which `../creator/` and `../prototype/` load.
