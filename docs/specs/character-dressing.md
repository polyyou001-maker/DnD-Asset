# Character dressing (paper-doll) — spec

Status: agreed with the user, 2026-11-05 (grilling rounds Q1–Q17).

## Goal

Dress a 2D pixel chibi in any class costume, hair, face, headgear, weapon, shield and
effect, in 8 directions, animated, with dyeable hair/clothes. One headgear or weapon
sprite must fit every body and every pose. The format is engine-agnostic (PNG + JSON)
and loads straight into Three.js, which the game uses.

## Player-facing behavior

- Pick class (body), hair style, face, headgear (top / mid / low), weapon, shield, effect.
- Pick a dye per ramp: hair, cloth1 (main clothes), cloth2 (secondary clothes).
- The character shows correctly from all 8 directions as the camera rotates or the
  character turns, and plays idle / walk.
- Equipping an item into a slot that conflicts with another item removes the old item.
- Some headgear hides hair (e.g. a full helm hides both hair pieces).

## Rules

### Cells and coordinates
- Every cell is **64×64 px**. The character is ~56 px tall, its feet on row **y = 61**.
- **Origin** (where the character stands in the world) = pixel `(32, 61)`, bottom-center.
- Pixel coordinates are integers, origin top-left of the cell, y down.

### Directions
- Order: `S=0, SW=1, W=2, NW=3, N=4, NE=5, E=6, SE=7`. `S` = facing the camera, `W` =
  facing screen-left.
- Only **S, SW, W, NW, N** are drawn ("drawn directions"). `NE, E, SE` reuse `NW, W, SW`
  **mirrored horizontally** — the whole composed cell is flipped, so anchors and layer
  order come along for free. Main hand / off hand swap sides when mirrored (accepted).
- Future: a part may provide its own E-side cells (`override` — not in MVP).
- Direction from angles (radians, Three.js `rotation.y` convention, camera yaw = the yaw of
  the vector from the look-at target to the camera):
  `rel = facingYaw − cameraYaw;  dir = mod(round(−rel / (π/4)), 8)`.

### Animations
- MVP: `idle` 2 frames @ 3 fps, `walk` 4 frames @ 8 fps. fps lives in the manifest.
- Only the **body** is animated. All other layers are one cell per drawn direction and
  follow the body through anchors, so they use the body's frame index implicitly.
- The **effect** layer has its own frames/fps and loops independently of the body.

### Layers and z-order
Layers (logical): `shadow, hair_back, body, face, hair_front, head_low, head_mid,
head_top, weapon, shield, effect`.

- `shadow` is not part of the sprite: the engine draws it as a blob on the ground plane.
- `effect` is not baked into the character atlas: it is a second quad drawn on top.
- The remaining layers are drawn per direction in the order given by
  `manifest.layerOrder[dir]` (back → front). Mirrored directions use their source's order.
  Default orders (editable in the manifest):

| dir | back → front |
|---|---|
| S  | hair_back, body, face, hair_front, head_low, head_mid, head_top, weapon, shield |
| SW | hair_back, body, face, hair_front, head_low, head_mid, head_top, weapon, shield |
| W  | weapon, hair_back, body, face, hair_front, head_low, head_mid, head_top, shield |
| NW | weapon, body, face, hair_front, hair_back, head_low, head_mid, head_top, shield |
| N  | weapon, shield, body, face, hair_front, hair_back, head_low, head_mid, head_top |

(In N/NW the back hair is seen from behind, so it is drawn over the body; the face part
simply has empty cells for N.)

### Anchors
- Each body frame stores anchors `head`, `hand_main`, `hand_off` as pixel coords.
- Every non-body piece has, per drawn direction, a `pivot` pixel and an `attach` anchor
  name. It is drawn at `anchor − pivot` (no rotation, no scaling).
  - hair, face, headgear → `head`; weapon → `hand_main`; shield → `hand_off`.
- Anchors are authored by clicking in the preview's anchor mode (exported as JSON) or by
  hand. Exporting them from a Blender mannequin is a later option.

### Slots and conflicts
- Loadout slots: `body, hair, face, head_top, head_mid, head_low, weapon, shield, effect`.
- A headgear part declares `occupies` (list of head slots) and is placed in all of them.
  Equipping an item clears every other item whose `occupies` overlaps.
- A part may declare `hides`: layers not drawn while it is worn (e.g. `["hair_front",
  "hair_back"]`).

### Dyeing (palette swap)
- `manifest.ramps` defines the **source ramp** for `hair`, `cloth1`, `cloth2`: 4 hex
  colors each, dark → light, all from `pipeline/palette.hex`.
- Each part declares which ramps it dyes (`dye: ["cloth1","cloth2"]`). Only those parts
  are recolored, so e.g. red eyes are safe when dyeing hair, because the face is its own part.
- Dyeing = exact RGB match of source ramp color *i* → target ramp color *i*, per pixel.
- `manifest.dyes[ramp][name]` = target ramp (4 hex). Skin and eyes are not dyeable (MVP).
- Consequence for generation: prompts must produce the source colors (clothes in blue for
  cloth1, red for cloth2, brown hair) so `process.py` maps them onto the source ramps.

## Data model

All paths are relative to the manifest. One manifest per asset set.

```jsonc
// assets/paperdoll/manifest.json
{
  "version": 1,
  "cell": [64, 64],
  "origin": [32, 61],
  "drawn": ["S", "SW", "W", "NW", "N"],
  "mirror": { "NE": "NW", "E": "W", "SE": "SW" },
  "anims": { "idle": { "frames": 2, "fps": 3 }, "walk": { "frames": 4, "fps": 8 } },
  "layerOrder": { "S": ["hair_back", "body", "..."], "SW": [], "W": [], "NW": [], "N": [] },
  "ramps": { "hair": ["#5a2e2a", "#8c4a3a", "#c2765a", "#eab08c"], "cloth1": [], "cloth2": [] },
  "dyes": { "hair": { "brown": ["..."], "blonde": ["..."] }, "cloth1": {}, "cloth2": {} },
  "parts": {
    "body_mage": {
      "slot": "body", "kind": "animated", "sheet": "parts/body_mage.png",
      "dye": ["cloth1", "cloth2"],
      // anchors[anim][dir][frame] = { head:[x,y], hand_main:[x,y], hand_off:[x,y] }
      "anchors": { "idle": { "S": [{ "head": [32, 22], "hand_main": [22, 44], "hand_off": [42, 44] }] } }
    },
    "hair_long": {
      "slot": "hair", "kind": "static", "sheet": "parts/hair_long.png", "attach": "head",
      "dye": ["hair"],
      // one sheet row per piece, one column per drawn direction
      "pieces": [ { "layer": "hair_back", "row": 0 }, { "layer": "hair_front", "row": 1 } ],
      "pivot": { "S": [32, 22], "SW": [32, 22], "W": [32, 22], "NW": [32, 22], "N": [32, 22] }
    },
    "helm_full": {
      "slot": "head_top", "kind": "static", "sheet": "parts/helm_full.png", "attach": "head",
      "occupies": ["head_top", "head_mid", "head_low"], "hides": ["hair_front", "hair_back"],
      "pieces": [ { "layer": "head_top", "row": 0 } ], "pivot": { "S": [32, 22] }
    },
    "aura": { "slot": "effect", "kind": "effect", "sheet": "parts/aura.png", "frames": 4, "fps": 6 }
  },
  "defaultLoadout": { "body": "body_mage", "hair": "hair_long", "face": "face_basic",
                      "dye": { "hair": "brown", "cloth1": "blue", "cloth2": "red" } }
}
```

Sheet layouts (grid of 64×64 cells, no padding):
- `animated`: row = `animIndex × 5 + drawnDirIndex` (anims in manifest key order),
  column = frame. Width = max frames × 64.
- `static`: row = piece row, column = drawn direction index (5 columns).
- `effect`: one row, column = frame; not directional.

Loadout (runtime / save game):
```json
{ "body": "body_knight", "hair": "hair_short", "face": "face_basic",
  "head_top": "hat_witch", "head_mid": null, "head_low": null,
  "weapon": "sword", "shield": "shield_round", "effect": null,
  "dye": { "hair": "blonde", "cloth1": "green", "cloth2": "gold" } }
```

### Baked atlas (runtime output of the composer)
`bake(manifest, sheets, loadout)` → one canvas with the same layout as an animated sheet
(rows = anim × 5 drawn dirs, cols = max frames), every cell fully composed and dyed.
Re-bake only when the loadout or dyes change. The effect stays a separate (dyed-never)
sheet.

## Three.js integration points

- Texture: `new THREE.CanvasTexture(atlas)`, `magFilter = minFilter = NearestFilter`,
  `generateMipmaps = false`, `colorSpace = SRGBColorSpace`. One texture per character.
- Frame UV (module function `frameUV(layout, anim, dir, frame)` → `{u0, v0, u1, v1}`):
  `u0 = col·64/W, u1 = (col+1)·64/W, v0 = 1 − (row+1)·64/H, v1 = 1 − row·64/H`.
  For a mirrored direction `u0`/`u1` are swapped. This is the same as a negative UV
  x-scale, but per-quad UVs let several characters share a texture without cloning it.
- Quad: a plane `64/ppu × 64/ppu` world units, translated so pixel `origin` (32, 61) sits
  at local (0, 0, 0): the mesh position is the character's feet.
- Billboard: cylindrical, Y-axis only: every frame `mesh.rotation.y = cameraYaw`, so
  sprites stay upright under the tilted isometric camera.
- Direction: `dirIndex(facingYaw, cameraYaw)` (formula above).
- Material: `MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5 })`. Alpha is binary,
  so `alphaTest` avoids sorting issues between characters.
- Shadow: a separate ground plane at y ≈ 0.01 under the feet. Effect: a second quad with
  the effect sheet, slightly toward the camera (`renderOrder` +1).

## Asset pipeline hook

1. Generate the whole character per direction/frame with the pipeline (`elin_sprite`),
   QC + approve. Headgear/weapons/shields: `elin_item` or drawn by hand.
2. In Aseprite, cut hair (back/front) and face off the body into layers and export source
   cells into `art/paperdoll/<part_id>/`:
   - animated: `<anim>_<dir>_<frame>.png` (e.g. `walk_SW_2.png`)
   - static: `<pieceRow>_<dir>.png` (e.g. `0_W.png`)
   - effect: `<frame>.png`
   - `part.json`: the part's manifest entry minus `sheet`/`anchors`
   - `anchors.json` (bodies): exported from the preview's anchor mode
3. `pipeline/pack.py` validates (cell size, palette colors, all cells present) and writes
   `assets/paperdoll/parts/<part_id>.png` and the manifest. `art/paperdoll/_set.json`
   holds the global manifest fields (anims, layerOrder, ramps, dyes, defaultLoadout).

## Edge cases

- Missing anchor for a frame → piece not drawn, warning in the console (preview shows it).
- Empty cell (all transparent), e.g. face facing N → nothing drawn, no error.
- Pieces may extend outside the 64×64 cell after offsetting: clipped (keep gear small).
- Mirroring makes the main hand flip sides. Accepted for MVP.
- Dye names missing from `dyes` → fall back to the source ramp (no recolor).
- Two items whose `occupies` overlap → the newly equipped one wins.

## Out of scope (MVP)

attack/cast animations, hat-hair variants, weapon rotation per frame, E-side overrides,
Blender anchor export, skin/eye dyeing, runtime 8-direction drawing (always 5 + mirror).

## Open questions

- Final palette and source-ramp colors (placeholder palette for now).
- Whether 56 px height is final once real sprites are in the 3D scene at game zoom.
