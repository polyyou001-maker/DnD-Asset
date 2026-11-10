# Hair and clothes layers on frame-by-frame bodies — spec

Status: draft, 2026-11-09. Round 1 (Q1–Q4) agreed with the user; the later decisions below were
taken by Claude on the user's instruction to finish the plan, and are marked *(chosen)* so they
can be overturned. Pilot built (`pipeline/layers.py`, Human `hair_short` + `outfit_fighter`,
candidate A); its results are under "Pilot results", the clothes method awaits the user's verdict.

## Goal

Dress the four frame-by-frame bodies (`art/bodies/<body>/`, 185 frames, 9 states, 5 drawn
directions) in hair and clothes that the player mixes freely and dyes, at a GPU cost of about
3–6 hours per item for all four species — not the ~30 h a fully per-frame item would take.

## Decisions

| # | Decision | Source |
|---|---|---|
| Q1 | Separate layers composed over the body at runtime (paper-doll), not baked dressed bodies | user |
| Q2 | Same items as v2 set A: outfits fighter, cleric, rogue, wizard; hair bob, long, short, twintails. Start with **one hair + one outfit on Human** (pilot) | user |
| Q3 | Generated in neutral dye colors, dyed at runtime with `src/paperdoll2/dye.js` (hair white → gradient map; outfit main cloth blue, trims gold → hue band swap) | user |
| Q4 | Budget ~3–6 GPU hours per item for 4 species: draw key frames only, code places them on the rest | user |
| D5 | Hair = static pieces per direction, attached to the rig's head joint like the eye layer | chosen |
| D6 | Clothes method decided by the pilot: rigid cut-out on rig bones (A) vs. inpainted key poses per state (B) | chosen |
| D7 | One set of layers per species (head and torso sizes differ); no sharing across species | chosen |
| D8 | Pilot items: `hair_short`, `outfit_fighter` (shortest hair, least loose cloth = cleanest test) | chosen |

## Player-facing behavior

- In the Lab (later the creator) the player picks species, hair, outfit and their dyes; every
  state (idle, walk, run, four attacks, hit, dead) plays in all 8 directions with them on.
- Hair and clothes stay on the body through every frame: no gaps of base shirt or skin where
  the outfit should cover, no floating cloth past the body.
- Dyeing changes only that layer (hair dye never touches the eyes or the outfit).

## Rules

### Hair (D5)
- Per species and direction, generate the hair **once** on `idle_<dir>_0` by inpainting the
  head region (white hair prompt, same depth guide and LoCon as the body), then extract it as
  `|dressed − base|` inside the head mask, the v2 method (`docs/specs/art-pipeline.md`).
  Cost: 5 images per species, 20 per style.
- Each frame draws the piece at the rig's head joint of that frame (`joints.json` head,
  plus the same `fit_shift` correction the body uses), exactly as eyes are placed.
- Layers: `hair_back` (behind the body) and `hair_front`. Short styles (bob, short) are
  front-only. Long and twintails have the back piece split off (rule R1 below).
- `hit`: hair follows the head joint; no sway. `dead` frames 1–2 rotate the piece with the
  body's fall angle (nearest neighbour; 90° is exact, the brief 52° frame is accepted as is).

### Clothes (D6, pilot)
Both candidates produce the same output (one layer frame per body frame) so the runtime does
not care which one wins.

- **A — cut-out on bones.** Inpaint the outfit on `idle_<dir>_0` per direction (5 images per
  species). Split it into pieces by the rig's bones (torso with chest/pelvis, upper and lower
  arm per side, thigh and shin per side) and place each piece per frame by its bone's joints
  (translate + rotate, nearest neighbour). Clip to the body frame's silhouette dilated by
  2 sprite px; skirts and robes get an "overhang" piece that is not clipped.
  Cost ≈ 10 images per species with the second key frame (walk frame 0), see Pilot results.
- **B — inpainted key poses.** Inpaint the outfit over one frame per state and direction
  (the contact or hit frame: 9 × 5 = 45 images per species) and carry it to the other frames
  of that state with candidate A's bone placement. Cost ≈ 45 images per species ≈ 3.5 h.
- **Pilot verdict rule:** run A first on Human `outfit_fighter`. If the Lab shows gaps or
  broken cloth on run, attacks or dead that the user does not accept, run B on the failing
  states only. The user decides from the Lab, not from metrics.

### Dye (Q3)
- Prompts keep the v2 dye colors: `white hair`; outfit main cloth `blue`, trims `gold`;
  avoid blue and gold in parts that must not dye.
- The body's eye layer is also blue: dyes apply per layer, so they never collide.

### Layer order
Per direction, back → front: `hair_back, body, eyes, outfit, hair_front`. In NW and N the
`hair_back` piece is the visible back of the head and is drawn after the outfit.

## Data model

Per body and item, next to the body:

```
art/bodies/<body>/layers/<item>/sheet.png    # same cell grid and rects as the body's sheet.json
art/bodies/<body>/layers/<item>/layer.json   # {"item", "slot": "outfit"|"hair", "dye": [...], "method": "cutout"|"keypose"|"anchored"}
```

- Every layer, hair included, is pre-rendered by the pipeline into a sheet with the body's
  frame rects, so the runtime only draws it over the body (no bone math in the game):
  `composeBody(..., layers)` in `prototype/src/bodySheet.js`, clothes first, hair last.
- Hair is placed per frame by the drawn skull (top and center of the skull columns around the
  rig's head), falling back to the rig's head joint when they disagree by more than 4 px; fallen
  frames turn it about the head joint by the pose's roll.
- The pipeline reads joints straight from the rig (`rig.view_joints`, every joint with depth),
  so `joints.json` keeps its six anchors.
- Admin shows them under the existing **Hair** and **Clothes** categories, per species, worn on
  the body. A replaced frame is an override (`art/overrides/{hair,clothes}/<body>_<item>/`) that
  `layers.py extract` pastes on last, as `bodies.py` does for the body; only `sheet.png` is
  replaceable (`back.png` is download only).

## Pipeline

1. `layers.py gen <body> <item>`: inpaint the item on `idle_<dir>_0` per direction (v2 masks and
   prompts from `sets/A.json`).
2. `layers.py extract <body> <item>`: cut it out, place it on every frame of the body's final
   sheet (admin overrides included), write the sheet and `layer.json`.
3. QC per frame: layer pixels inside the allowed mask; no base-shirt grey visible inside the
   outfit's torso area (gap check); hair islands touch the head.
4. Runs use `run_bodies.sh`-style restart and resume for the webui.

## Edge cases

- A hand passing in front of the face or chest: the body frame already draws it; the layer is
  drawn over the body, so cloth would cover the hand. Cut-out pieces of the arm are drawn
  after the torso piece, so a forward arm stays in front; checked in the pilot.
- `fit_shift` frames: layers use the same shift as the body frame.
- `dead` frames: the body lies in the picture plane; cut-out pieces rotate with their bones.
- Elf ears stay part of the body; hair is drawn over them except where the ear sticks out.
- Mirrored directions (NE, E, SE) flip the composed cell, as for the body.

## Pilot results (Human, 2026-11-09)

Cost: 10 images for both items (+4 to redo SW and W hair), about 1 hour; placement on all
185 frames takes 2 s.

- **Hair:** follows the head in every state, dead included; dyes in the Lab. A hand raised in
  front of the face (smash SW) is drawn under the hair.
- **Outfit (cut-out, A):** torso, shoulders and belt hold in every state; arms and legs follow
  their bones. Limbs hidden in the idle key frame have no armor when they swing out: in W the
  near leg runs bare and the far arm's forearm stays skin.
- **Second key frame (user's choice, 2026-11-09):** the outfit is also drawn on walk frame 0
  (limbs apart in every direction), `layers.py gen --key 2`; 5 more images per species. Each
  bone takes, among the key frames that drew at least 40 % of its most-drawn version, the one
  whose bone points most like the target frame's. W run and walk now have greaves on both legs.
  Still bare: a forearm reaching far forward or up (W run, NW slash) and the bare hands of
  stab S; hair still covers a hand raised in front of the face.

- **Near arm in side views (2026-11-10):** the bare forearms were the near arm in W (and SW/NW):
  in both key frames it hangs over the torso, the torso's wide side-view radius won those
  pixels, and the arm got no piece of its own. Now a limb nearer than the torso takes the pixels
  inside its own radius, and the torso keeps them too (no hole when the arm swings away). Forearm
  coverage (outfit share of the body inside the rig's forearm, all 370 per species): median
  0.89 → 0.94, frames under 0.3 from 9 to 2 over the four species; torso coverage unchanged.
  Still bare: the stab S hands (forearm points at the camera, 1–2 px long in the rig) and an arm
  raised behind the head in NW/N.

## Elf, Dwarf, Halfling (2026-11-09)

`hair_short` and `outfit_fighter` (both key frames) on the three other species: 45 images in
about 3 h, plus redos. Picked by eye from the raw images; redone with new seeds:
- outfit dwarf W and halfling W (bare legs, almost no armor), halfling NW (skin strip on the back);
- hair elf S, SW, W: elf W came out cream, too close to the pale skin for the `|dressed − base|`
  cut, which kept almost none of it. A hair whose raw image is not clearly whiter than the skin
  needs another seed.

The extraction also showed broken body frames from phase 2: dead frame 1 (the 52° fall) of
dwarf S/SW/NW/N and elf N had the shirt drawn over the head, elf NW 1–2 a second head. They
were regenerated, and the body QC gained a head-is-skin check (`docs/specs/body-animation.md`).

Known: the ears are partly cut into the hair piece (elf N, halfling) because the inpaint redraws
them. They land where the body's own ears are, so they only show if the head turns away from
the rig.

## Rest of set A (2026-11-10)

Decided with the user (round 2, recommended answers):

| # | Decision |
|---|---|
| R1 | Long hair and twintails: in S, SW, W the hair outside the idle body's silhouette is `hair_back` (`back.png`, drawn behind the body), the rest `hair_front`; NW and N are front only. Both pieces follow the head rigidly. Hair hidden by an arm in the key frame stays missing when the arm moves |
| R2 | Robes (`"skirt": true` in `sets/A.json`, cleric and wizard): the cloth below the hips that the cut-out would give to the torso or legs is one `skirt` piece. It turns with the torso about the pelvis, is drawn over the legs and is not clipped to the body. Of the two key frames it takes the one whose thighs are spread most like the target frame's. Fall back to key poses (B) only for states the user rejects in the Lab |
| R3 | v2 prompts unchanged; bad raw images get new seeds |
| R4 | All 6 items on Human first, one Lab check, then the other species |

- `layer.json` gains `"back": "back.png"` for split hair; `composeBody` takes `[{image, back}]` and
  draws the back sheets under everything (`destination-over`). The Lab loads all 8 items per body
  and has a Hair row.
- **White on white:** the white cleric robe (~230) and white hair hanging outside the body were cut
  away as background by `figure_mask`'s 215 threshold. Layers now treat only > 245 as background.
- **Human picks:** many raw images needed new seeds (yellow or cream hair, missing hair, wizard W
  white/cream or tiny, cleric S knee-length). The model rarely draws a floor-length chibi robe:
  wizard and cleric robes are knee- to calf-length in most directions, open at the front in some.
- Running two generations at once crashes the `--lowvram` webui; sweeps run one at a time with restart.
- **Elf, Dwarf, Halfling:** 150 images (~4 h) plus 30 redo images for 21 bad ones. The wizard robe
  in side views was the weakest (white, beige, green, almost none or a tiny extra figure): elf W
  needed 6 seeds. Long hair failed by turning yellow or bob-length, by changing the shirt below
  the hair (a brown skirt on dwarf N), or by matching the skin too closely (dwarf NW: the top of
  the head was cut away).
- All 8 items were re-extracted on all four species with the 245 threshold: `hair_short` and
  `outfit_fighter` gained 0.1–0.6 % pixels at the edges, none lost.
- **Known on these species:** the elf robe in NW changes shade between the two key frames mid-walk;
  dwarf long hair N keeps a little white shirt at the shoulders (dyed with the hair); rogue backs
  in NW/N are mostly bare skin (the model draws a short capelet); elf long hair S is thin.

## Open questions

1. Whether the cut-out needs per-frame cleanup when a body frame's silhouette differs much
   from the rig (AI drift) — the pilot will show.
2. Headgear and weapons in the new frames (separate spec).

## Out of scope

Hair sway and cloth physics, headgear, weapons drawn in the frames, the creator UI, NE/E/SE
own art, more than the 8 items above.
