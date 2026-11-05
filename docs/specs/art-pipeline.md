# Art pipeline v2 — AI layered sprites

Status: 2026-11-05. Tool: `pipeline/sheet.py` (+ `guides.py`), sets in `pipeline/sets/<set>.json`.
Output art: `art/paperdoll2/<set>/` (read by `src/paperdoll2/`).

## Why v2

v1 failed the art bar for three reasons:
1. Its parts were hand-coded 64 px placeholders, not AI art.
2. Text direction tags ("three-quarter view", "profile") made the LoCon draw several
   small figures per image, on colored backgrounds.
3. The LoCon draws "pixels" of roughly fixed size (~10 px at SDXL resolution). A small
   figure therefore gets very few art pixels, so detail needs the figure about 1100 px tall.

## Target look (from the user's references)

Single chibi, 3–3.5 heads tall, ~110 art pixels tall, Elin-style soft pixel shading with
dark outlines, light background, no cast shadow. Game cell 128×128, feet at (64, 122).

## Method: per-direction views + inpaint layering

A first attempt drew all 5 views in one 1792×576 "turnaround" image. It failed: the LoCon
was trained on Elin sprites, which only face forward, so every view came out facing
front. With a strong guide it also painted the mannequin's boxes literally. The working
method gives NoobAI the direction and the LoCon only the style:

```
mannequin3d.py  depth map of a 3D chibi mannequin per direction (832×1216, ~1100 px tall)
   │ ControlNet depth (noob-depth) w 0.6, end 0.5 → size, feet line and facing
base        txt2img per direction: bald mannequin, black bodysuit
   │        NoobAI direction tags; LoCon 1.0 on S, down to 0.7 on back views
   │        non-S views use the S view as a reference_only ControlNet (same design)
pick        choose a seed per direction → base/<dir>.png
part        per direction inpaint on the base view (S first, then S as reference)
   │        Outside the mask the image stays the base, pixel for pixel.
extract     same fixed transform for every image (10 px block → 1 game px, majority vote
            after median-cut 48 colors):
              base_head / base_body  = base split at the neck
              outfit                 = figure ∩ outfit mask (replaces the body)
              hair / headgear / ears = |part − base| > T ∩ mask, islands touching the head
            + geometry.json (head box, neck, hand anchors) + manifest.json (dye references)
item        weapons/shields: txt2img object → stand upright (PCA) → scale to length → grip point
```

Back views (NW, N) need the depth guide. A 2D outline is the same from the front and the
back, so the LoCon turned them toward the camera. In the depth map the nose and toes
point at the camera in front views, and the back of the head and the buttocks bulge in
back views. Model: `models/ControlNet/noob-depth.safetensors` (Eugeoter/noob-sdxl-controlnet-depth,
fp16). Set A picks: S/SW 202 (older outline guide), W 311, NW 301, N 302 (depth guide).

Extraction rules learned from set A:
- Hair: white hair over pale skin changes less than the diff threshold, so pixels that became
  grey/white (chroma < 20) where the base was skin (chroma > 25) also count. Over the base figure
  they always count as figure (white hair is as light as the background).
- Headgear: never keep background-like pixels; a hat inpaint may paint background over the crown.
- Short/medium hair and `hair_tails` (twintails) ignore the torso interior in every view; only
  `hair_long` may cover the back.
- `borrow: {"N": "S"}` reuses another view's layer moved onto this view's head. Used for the witch
  hat, whose back views the model could not draw.
- Long robes: `cn_weight: 0` (no base lineart, or the base's legs show through), `fill: 1`.
  `fill: 0` draws a tiny second figure inside the mask.
- Items: retry seeds until one object on white, long and thin for weapons; `wide` says where the
  widest row goes (mace head on top, sword cross guard low).

Masks are derived from the generated base (silhouette, neck = narrowest row), not from
the guide, so they follow whatever the model actually drew. The face window is excluded
from hair/headgear masks so the face never changes.

## Dye rules (generation contract)

| Layer | Generate as | Runtime dye |
|---|---|---|
| hair | `white hair` | gradient map on lightness |
| outfit main cloth | blue cloth | hue band 195–255° → chosen color |
| outfit trims | gold | hue band 38–58° → chosen color |
| skin | base mannequin skin | shift pixels near the measured base skin color |
| eyes | `blue eyes` on the base | hue band, base_head only |

Avoid blue and gold in parts of an outfit that must not be dyed.

## QC checklist (per set, in `out/v2/<set>/contact.html`)

Automatic (fails block extraction):
- Base sheet: exactly 5 figures (connected components ≥ 3 % of the area), white background
  (border pixels light), figures within their slots.
- Refined views: one figure, height 90–110 % of the expected 1100 px, feet within ±20 px.
- Layers: no layer pixels outside their mask; hair/headgear islands must touch the head.

Human review (approve/reject per part, then re-run with another `--seed`):
- Same design in all 5 views (color, silhouette, accessories).
- Faces facing the right way; W is a clean profile; N shows no face.
- Clean outlines, no blur, no extra limbs; hands readable at 1×.
- Composite check in the creator: every outfit × hair × hat combination without gaps.

## Performance on this machine (RTX 4050 6 GB)

SDXL + ControlNet does not fit in 6 GB with `--medvram-sdxl`. The driver then spills into
system RAM, which measured 18–123 s/it. Use `--lowvram` and ControlNet `low_vram`. Also set
**NVIDIA Control Panel → Manage 3D settings → CUDA - Sysmem Fallback Policy → Prefer No
Sysmem Fallback**, so the driver fails fast instead of silently slowing down. One part is
6 generations (1 coarse + 5 views).
