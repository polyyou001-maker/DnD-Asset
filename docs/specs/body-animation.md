# Body animation — spec

Status: agreed with the user, 2026-11-06 (grilling rounds 1–3, Q1–Q19, all recommended answers).
Supersedes the puppet animation of `src/paperdoll2` for the body. Layer design (Q1–Q7) is
recorded at the end; it is built after the body passes QC.

## Goal

Bodies for the 4 SRD species whose animation reads as hand-drawn frame-by-frame pixel art:
legs that really step, arms that swing, a body that bobs and breathes. Every frame is drawn
by the AI, posed by a 3D mannequin, so poses are exact and joints are known per frame.

## Player-facing behavior

- Each species has its own silhouette (table below), visible at a glance on the map.
- Idle breathes; the eyes blink at random (every 2–5 s), not on the loop.
- Walking steps without foot sliding: the world speed matches the drawn stride.
- All of it in 8 directions (5 drawn, 3 mirrored), as the camera rotates.

## Bodies

Two skeleton sizes, three generated bodies (Elf has its own generation for the ears, on the
Human skeleton, slimmer):

| body | species | skeleton | height | heads | shoulders | notes |
|---|---|---|---|---|---|---|
| `human` | Human | medium | 96 px | 3 | 26 px | the reference body |
| `elf` | Elf | medium | 98 px | 3 | 24 px | slimmer, longer neck, long ears, sharper chin |
| `dwarf` | Dwarf | small | 80 px | 2.5 | 32 px | stocky, thick arms, big hands, short legs, wide feet |
| `halfling` | Halfling | small | 74 px | 2.5 | 22 px | slim, round face, big bare feet |

Heights are in rig px (1 rig px = 10 generation px). On the sprite they are 1.25× larger: a
Human stands 120 sprite px tall.

A body is drawn as the dressing base: bald, grey t-shirt, black shorts, barefoot. Hair, beard,
clothes come later as per-frame layers (Q14 A). One body type per skeleton (Q12).

## Frames and cells

- Cell 160×160, feet line y = 152, x centered (80). 1 sprite px = 8 generation px: the Elin
  LoCon draws on an 8 px grid, and sampling on any other grid breaks outlines and loses the eyes.
- `ppu` (sprite px per world unit) = 87.5 for every body, so species heights differ in the world.

## Animations (phase 1)

| state | frames | fps | loop | motion |
|---|---|---|---|---|
| `idle` | 4 | 4 | yes | breathing: chest/shoulders/head rise 1 px and back, hands sway 1 px |
| `walk` | 6 | 10 | yes | contact → down → passing, then the other side; lean 3°; bob 0/−2/+1 px |

Walk poses (left thigh / knee in degrees; the right leg is the same shifted by 3 frames; arms
swing opposite to the legs at 0.8× the thigh angle, elbows bent 15° + the swing):

| frame | 0 contact | 1 down | 2 passing | 3 contact | 4 down | 5 passing |
|---|---|---|---|---|---|---|
| left thigh | +25 | +12 | −5 | −22 | −12 | +10 |
| left knee | 4 | 18 | 6 | 10 | 38 | 48 |

The pelvis height is solved per frame so the lowest foot touches the ground. The stride the
rig produces (distance the stance foot travels in one cycle) sets the walk speed in the game.

Phase 2 (after phase 1 QC): run 6, attack 4 × 4 styles, hit 2, dead 3. Later: cast, sit, jump,
idle variants (smile, look around).

## Generation

1. `pipeline/rig.py` — posable SDF mannequin: per body, a skeleton (pelvis, spine, neck, head,
   shoulders, elbows, hands, hips, knees, ankles, toes) with capsules/ellipsoids on the bones,
   plus the front/back cues of `mannequin3d.py` (nose, toes, heels, back of the head).
   It renders depth for any pose × direction and writes the 2D joint positions (game px).
2. `pipeline/bodies.py` — per body and direction, frames are generated **two per image**
   (1216×1216, one depth guide per half). The first pair's first frame of each direction is
   the identity reference (`reference_only`) for that direction's other pairs; same seed.
   Depth ControlNet (`noob-depth`) carries the pose.
3. Extraction: each half → largest figure, enclosed white removed → median of each 8 px block
   (48 colors fitted to figure pixels) → 160 cell, feet snapped to the line (up to 3 px). Output `art/bodies/<body>/sheet.png` + `sheet.json` in the prototype Actor
   format (`frameW, frameH, feetY, ppu, states{fps, loop, dirs[5][frames]}`) plus
   `anchors[state][dir][frame] = {head, hand_left, hand_right, foot_left, foot_right}` from the rig.
4. Eyes (S, SW, W; NW and N show none): extraction cuts brows and eyes off every frame, inside a
   zone taken from the drawn skull, and fills them with skin. `sheet.png` is therefore faceless;
   the mouth stays on the body. `art/bodies/<body>/eyes.png` holds one sprite per direction, cut
   from idle frame 0 (column 0) and from the eyes-closed inpaint of that frame (column 1).
   `sheet.json` `eyes.at[state][dir][frame]` places a sprite on the drawn skull of that frame
   (left edge on W, centre on S and SW; top), so the eyes follow the head and never redraw.
5. At load `prototype/src/bodySheet.js` dyes the eyes with `look.eyes` (the 6 `EYE_COLORS`, through
   `dye.js`), draws them onto a copy of the sheet clipped to the outline, and adds the `blink`
   state: idle frames with closed eyes. The Actor shows it for 0.14 s every 2–5 s.

## QC

Automatic (per frame, report in `out/bodies/<body>/qc.json`):
- one figure; light background; not cut by the half's side edge; shirt present (grey share of
  the torso box ≥ 8 %); `generate` retries on these and keeps the attempt with the fewest issues;
- the support foot on the feet line (±1 px) in contact frames;
- head height within ±3 px of frame 0 of that state and direction (±6 px on walk, for the bob);
- median skin color within ΔE 6 of the idle frame 0 of that direction;
- no stray islands (connected components) beyond the figure;
- no blue eye pixels left in the face zone of the faceless frames.

Human review: GIF per direction at 1× and 3× in `out/bodies/<body>/qc.html` and live in the
animation lab ("Body QC"): face changes, limbs swapping sides, flicker. A failing frame is
regenerated alone (new seed, same reference).

## Layers (decided in Q1–Q7, built after the body)

`back, hair_back, body, bottom, feet, top, outer, face, ears, hair_front, head, face_acc,
weapon, offhand, effect`. Equipment drives the look, with a cosmetic slot over it later (Q2).
Face separate (expressions, eyes), hair split front/back, head slots `head` + `face_acc`,
one `back` slot (behind in S/SW/W, over the body in NW/N). Clothes and hair are inpainted on
every body frame (Q14 A).

## Out of scope (phase 1)

Clothing and hair frames, weapons in the new frames, run/attack/hit/dead, a second body type
per skeleton, E-side drawn directions.

## Open questions

- Two frames per image (Q15 B) passed the pilot and stays. Direction S needs looser depth
  (0.55/0.5) and face tags, or the smooth head comes out faceless. "Multiple views" pair tags
  add extra figures once depth is loose, so they were removed: depth alone places the two frames.
