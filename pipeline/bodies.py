"""Frame-by-frame bodies: AI-drawn animation frames posed by the 3D rig (rig.py).

Usage:
  python bodies.py gen <body> [--dirs S W] [--states idle walk] [--seed 1] [--force]
  python bodies.py redo <body> <state> <dir> <pair> [--seed N] [--ref idle_W_1]   regenerate one pair
  python bodies.py check <body> [--redo] [--seed 7]   list (or regenerate) pairs failing QC
  python bodies.py blink <body>       eyes-closed frames (S, SW, W), picked up by extract
  python bodies.py extract <body>     -> art/bodies/<body>/sheet.png + eyes.png + sheet.json, out/.../qc.json
  python bodies.py qc <body>          -> out/bodies/<body>/qc.html (animated previews)

Run `python rig.py guides <body>` first. Spec: docs/specs/body-animation.md.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import rig
from common import ROOT, save_json
from sheet import (STYLE, call, clean_alpha, controlnet_unit, figure_mask, figures, light_background,
                   prompt, b64png)

ART = ROOT.parent / "art" / "bodies"
STATES = {"idle": {"fps": 4, "loop": True}, "walk": {"fps": 10, "loop": True}}
PPU = 87.5  # sprite px per world unit, same for every body (spec)
EYE_PX = {"S": 1000, "SW": 1000, "W": 300, "NW": 0, "N": 0}  # blue head px: least on a face, most on a back
BLINK_DIRS = ("S", "SW", "W")  # directions with a visible face
SHIRT_MIN = 0.08  # share of grey in the torso box below which a frame has lost its shirt
EYE_ZONE = {"S": (0.04, 0.96), "SW": (0.0, 0.76), "W": (0.0, 0.42)}  # share of the skull width, clear of the ear
EYES_W, EYES_H = 64, 48  # eye sprite; its top middle sits on the frame's head anchor

BASE = "bald, grey t-shirt, black shorts, barefoot, {eyes}light skin"  # eyes only where they show
SPECIES = {
    "human": "1girl, human",
    "elf": "1girl, elf, pointy ears, long pointy ears, slender",
    "dwarf": "1girl, dwarf, short, stocky, broad shoulders, thick arms, big hands",
    "halfling": "1girl, halfling, small, short, round face, big feet",
}
STATE_TAGS = {
    "idle": "standing, arms at sides, closed mouth",
    "walk": "walking, mid-stride, closed mouth",
}
# The depth guide already places the two figures; "multiple views" tags invited extra heads and
# mini figures once the guide was weaker (S), so only sameness is asked for.
PAIR_TAGS = "same character, identical outfit"
NEGATIVE = ("worst quality, low quality, lowres, bad anatomy, bad hands, extra arms, extra legs, "
            "different clothes, different hair, text, signature, watermark, logo, scenery, shadow, "
            "gradient background, dark background, colored background, cropped, out of frame, blurry, "
            "leotard, cleavage, panties, hair, holding, weapon, multiple views, extra heads, floating head, "
            "chibi inset, small figure, long shorts, bike shorts")
# Depth carries the pose. Front views barely change pose but need a face the smooth depth head
# suppresses, so S follows the guide more loosely.
DEPTH = {"S": (0.55, 0.5), "SW": (0.75, 0.6), "W": (0.8, 0.65), "NW": (0.8, 0.65), "N": (0.8, 0.65)}
# The depth head is a smooth ball: on front views the model then leaves the face blank (it read
# the S pilot as a back view), so faces are asked for explicitly where they show.
FACE_TAGS = {"S": "looking at viewer, facing viewer, (blue eyes:1.3), big eyes, (detailed face:1.2)",
             "SW": "(large blue eyes:1.2)", "W": "(blue eyes:1.1)",
             "NW": "(from behind:1.3), back of head", "N": "(from behind:1.3), back of head"}
FACE_NEG = {"S": "faceless, no eyes, featureless face, from behind, back of head, half-closed eyes, narrowed eyes, "
                 "small eyes, sleepy", "SW": "faceless, no eyes, half-closed eyes", "W": "faceless",
            "NW": "(face:1.3), (eyes:1.3)", "N": "(face:1.3), (eyes:1.3)"}


def fdir(name):
    d = ROOT / "out" / "bodies" / name / "frames"
    d.mkdir(parents=True, exist_ok=True)
    return d


def lora(direction):
    return f"<lora:ElinSpriteNoobLocon_byKonan:{STYLE['dir_lora'][direction]:.2f}>"


def ref_unit(img):
    return {"enabled": True, "image": b64png(img), "module": "reference_only", "model": "None",
            "weight": 0.7, "guidance_start": 0.0, "guidance_end": 0.9, "threshold_a": 0.5,
            "pixel_perfect": True, "resize_mode": "Crop and Resize", "control_mode": "Balanced", "low_vram": True}


def main_figure(img):
    """Figure mask of the largest object only (the pair prompt sometimes adds a tiny extra figure)."""
    fig = figure_mask(img)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fig.astype(np.uint8), connectivity=8)
    return lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])) if n > 1 else fig


def neck_y(body):
    """Generation row of the neck: everything above it is head."""
    return rig.FEET_Y - int((body.height - body.head_h) * rig.SCALE)


def eye_mask(half, body):
    """Blue pixels in the head: only the eyes are blue, so this tells a face from the back of a head."""
    a = np.asarray(half).astype(np.int16)
    out = (a[..., 2] > a[..., 0] + 40) & (a[..., 2] > 130)
    out[neck_y(body):] = False
    return out


def to_art_cell(half, fig, n_colors=48):
    """Half + figure mask -> CELL RGBA, one sprite px per GRID block of the LoCon's own pixel grid."""
    g, h, w = rig.GRID, rig.PAIR[1] // rig.GRID, rig.HALF // rig.GRID
    rgb = np.median(np.asarray(half).reshape(h, g, w, g, 3), axis=(1, 3)).astype(np.uint8)
    alpha = fig.reshape(h, g, w, g).mean(axis=(1, 3)) >= 0.5
    out = Image.new("RGBA", (rig.CELL, rig.CELL))
    if not alpha.any():
        return out
    # the palette comes from figure pixels only, so small colors like the eyes keep their own entries
    q = Image.fromarray(rgb[alpha][None]).quantize(n_colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    rgb[alpha] = np.array(q.getpalette()).reshape(-1, 3)[np.asarray(q)[0]]
    out.paste(Image.fromarray(np.dstack([rgb, alpha * np.uint8(255)]), "RGBA"), rig.CELL_ORIGIN)
    return out


def snap_feet(cell):
    """Stand the drawn feet on the feet line: the rig keeps a foot grounded every frame, so a
    drift of a few px is the model's and would read as jitter. Larger gaps stay for QC to report."""
    ys = np.nonzero(np.asarray(cell)[..., 3].any(axis=1))[0]
    dy = rig.CELL_FEET[1] - int(ys.max()) if len(ys) else 0
    return Image.fromarray(np.roll(np.asarray(cell), dy, axis=0), "RGBA") if abs(dy) <= 3 else cell


def clear_pockets(img, fig, body, guide):
    """Drop pure-white pockets enclosed by limbs and torso (figure_mask only floods from the border).
    The depth guide tells a real gap from a pale shirt: a pocket is mostly background there."""
    empty = np.asarray(guide.convert("L")) == 0
    white = fig & (np.asarray(img).min(axis=2) >= 245)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white.astype(np.uint8), connectivity=8)
    out = fig.copy()
    for i in range(1, n):  # below the neck only: eye whites and head highlights stay
        if stats[i, cv2.CC_STAT_AREA] >= 64 and stats[i, cv2.CC_STAT_TOP] > neck_y(body) and empty[lab == i].mean() > 0.5:
            out[lab == i] = False
    return out


def touches_edge(fig):
    """A figure cut by the half's side edge has a neighbour joined to it: extraction cannot save it."""
    return bool(fig[:, 0].any() or fig[:, -1].any())


def shirt_share(half, body):
    """Share of grey shirt pixels in the torso box of one half."""
    a = np.asarray(half).astype(np.int16)
    y0 = neck_y(body)
    box = a[y0 + 40:y0 + int(body.torso_h * rig.SCALE), rig.HALF // 2 - 70:rig.HALF // 2 + 70]
    chroma, value = box.max(axis=2) - box.min(axis=2), box.mean(axis=2)
    return float(((chroma < 24) & (value > 90) & (value < 240)).mean())


def tone_masks(a, body):
    """Shirt and skin pixels of a cell, the two colors the model drifts between frames."""
    rgb = a[..., :3].astype(int)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    chroma, value = rgb.max(axis=2) - rgb.min(axis=2), rgb.mean(axis=2)
    y0 = rig.CELL_FEET[1] - int((body.height - body.head_h) * rig.SCALE / rig.GRID)
    rows = np.zeros(a.shape[:2], bool)
    rows[y0:y0 + int(body.torso_h * rig.SCALE / rig.GRID)] = True
    opaque = a[..., 3] > 0
    return {"shirt": opaque & rows & (chroma < 26) & (value > 90),
            "skin": opaque & (r > 200) & (r > b + 25) & (g > 150)}


def tones(cell, body):
    a = np.asarray(cell)
    return {k: np.median(a[m][:, :3], axis=0) for k, m in tone_masks(a, body).items() if m.sum() > 10}


def match_tone(cell, target, body):
    """Scale the shirt and skin of a cell to the direction's reference tone (colors follow the
    half of the image they were drawn in, so a walk would otherwise flicker every frame)."""
    a = np.asarray(cell).copy()
    masks = tone_masks(a, body)
    for k, m in masks.items():
        if k in target and m.sum() > 10:
            gain = np.clip(target[k] / np.maximum(np.median(a[m][:, :3], axis=0), 1), 0.7, 1.4)
            a[m, :3] = np.clip(a[m, :3] * gain, 0, 255)
    return Image.fromarray(a, "RGBA")


def split_eyes(cell, body, d):
    """Cut brows and eyes off a face cell -> (faceless cell, eye sprite, sprite xy in the cell, blue px left)."""
    a = np.asarray(cell).copy()
    alpha = a[..., 3] > 0
    top = int(np.nonzero(alpha.any(axis=1))[0].min())
    h = int(body.head_h * rig.SCALE / rig.GRID)
    xs = np.nonzero(alpha[top:top + int(h * 0.4)].any(axis=0))[0]  # the upper skull has no ears
    left, w = int(xs.min()), int(xs.max() - xs.min())
    zone = np.zeros(alpha.shape, bool)
    zone[top + int(0.3 * h):top + int(0.82 * h), max(left - 3 * (d != "S"), 0) + int(EYE_ZONE[d][0] * w):left + int(EYE_ZONE[d][1] * w)] = True
    square = np.ones((3, 3), np.uint8)
    thin = ~cv2.morphologyEx(alpha.astype(np.uint8), cv2.MORPH_OPEN, square).astype(bool)
    spike = zone & alpha & thin & (a[..., :3].mean(axis=2) < 90)  # dark lash tips, not the far ear
    a[spike] = 0
    alpha &= ~spike
    inner = cv2.erode(alpha.astype(np.uint8), square).astype(bool)
    rim = alpha & ~inner
    rgb = a[..., :3].astype(int)
    skin = (rgb[..., 0] > 215) & (rgb[..., 0] > rgb[..., 2] + 20) & (rgb[..., 1] > 175)
    feat = zone & inner & ~skin
    if d == "S":  # next to the outline there it is the ear, not the eye
        feat &= cv2.erode(alpha.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    # eye whites are skin-coloured: closing the shape keeps them with the eye
    eye = cv2.morphologyEx(feat.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_CROSS, (5, 5))).astype(bool) & inner
    sprite = np.zeros_like(a)
    sprite[eye | spike] = np.asarray(cell)[eye | spike]
    tone, line = np.median(a[skin & zone][:, :3], axis=0), np.median(a[rim][:, :3], axis=0)
    a[cv2.dilate(eye.astype(np.uint8), square).astype(bool) & inner, :3] = tone
    if d != "S":  # eyes drawn on the outline leave their dark and blue there
        rgb = a[..., :3].astype(int)
        a[zone & rim & ((rgb.mean(axis=2) < line.mean() - 30) | (rgb[..., 2] > rgb[..., 0])), :3] = line
    ax = left if d == "W" else left + w // 2
    x = ax - EYES_W // 2
    rgb = a[..., :3].astype(int)
    blue = int((zone & alpha & (rgb[..., 2] > rgb[..., 0] + 25) & (rgb[..., 2] > 110)).sum())
    return Image.fromarray(a, "RGBA"), Image.fromarray(sprite, "RGBA").crop((x, top, x + EYES_W, top + EYES_H)), [x, top], blue


def vivid_eyes(sprite):
    """Saturate the grey-blue irises: the runtime dye (dye.js) only recolors saturated pixels."""
    a = np.asarray(sprite).copy()
    hls = cv2.cvtColor(a[..., :3], cv2.COLOR_RGB2HLS)
    iris = (a[..., 3] > 0) & (a[..., 2].astype(int) > a[..., 0].astype(int) + 10)
    hls[..., 2][iris] = np.maximum(hls[..., 2][iris], 128)
    a[iris, :3] = cv2.cvtColor(hls, cv2.COLOR_HLS2RGB)[iris]
    return Image.fromarray(a, "RGBA")


def halves(img):
    return img.crop((0, 0, rig.HALF, rig.PAIR[1])), img.crop((rig.HALF, 0, rig.PAIR[0], rig.PAIR[1]))


def qc_pair(img, body, direction):
    """Problems with one generated pair (empty list = ok)."""
    issues = []
    if not light_background(img):
        issues.append("dark background")
    want = body.height * rig.SCALE
    for side, half in zip(("left", "right"), halves(img)):
        figs = figures(figure_mask(half), 0.01)
        if not figs:
            issues.append(f"{side}: no figure")
            continue
        if len(figs) > 1:  # specks are dropped at extraction; a floating head or second body is not
            issues.append(f"{side}: {len(figs)} figures")
        fig = main_figure(half)
        if touches_edge(fig):
            issues.append(f"{side}: cut by the half edge")
        if shirt_share(half, body) < SHIRT_MIN:
            issues.append(f"{side}: no shirt")
        eyes = int(eye_mask(half, body).sum())
        if EYE_PX[direction] == 0 and eyes:
            issues.append(f"{side}: face on a back view")
        elif eyes < EYE_PX[direction]:
            issues.append(f"{side}: no eyes")
        ys = np.nonzero(fig.any(axis=1))[0]
        h = ys.max() - ys.min()
        if not 0.85 * want <= h <= 1.12 * want:
            issues.append(f"{side}: height {h} vs {want:.0f}")
        if abs(ys.max() - rig.FEET_Y) > 25:
            issues.append(f"{side}: feet at {ys.max()} vs {rig.FEET_Y}")
    return issues


def generate(name, state, direction, k, seed, ref=None):
    body = rig.BODIES[name]
    guide = Image.open(ROOT / "out" / "bodies" / name / "guides" / f"{state}_{direction}_{k}.png").convert("RGB")
    units = [controlnet_unit(guide, "none", *DEPTH[direction], STYLE["controlnet_depth"])]
    if ref is not None:
        units.append(ref_unit(ref))
    out = fdir(name) / f"{state}_{direction}_{k}.png"
    best, best_issues, best_log = None, None, None
    for attempt in range(3):
        img = call("txt2img", {
            "prompt": prompt(lora(direction), STYLE["quality"], "pixel art, chibi, full body, white background, simple background",
                             SPECIES[name], BASE.format(eyes="" if EYE_PX[direction] == 0 else "blue eyes, "), STATE_TAGS[state], PAIR_TAGS, STYLE["dir_tags"][direction],
                             FACE_TAGS[direction]),
            "negative_prompt": prompt(NEGATIVE, STYLE["dir_negative"][direction], FACE_NEG[direction]),
            "seed": seed + attempt * 1000, "width": rig.PAIR[0], "height": rig.PAIR[1],
            "alwayson_scripts": {"controlnet": {"args": units}},
        }, out.with_suffix(".json"))
        issues = qc_pair(img, body, direction)
        print(f"  {state} {direction} {k} seed {seed + attempt * 1000}: {'; '.join(issues) or 'ok'}", flush=True)
        if best is None or len(issues) < len(best_issues):
            best, best_issues, best_log = img, issues, out.with_suffix(".json").read_text()
        if not issues:
            break
    best.save(out)
    out.with_suffix(".json").write_text(best_log)  # the log of the attempt that was kept
    return best


def cmd_gen(a):
    for direction in a.dirs or rig.DIRS:
        ref_path = fdir(a.body) / f"idle_{direction}_0.png"
        ref = None
        for state in a.states or list(STATES):
            for k, _ in enumerate(rig.pairs(len(rig.POSES[state]))):
                out = fdir(a.body) / f"{state}_{direction}_{k}.png"
                if out.exists() and not a.force:
                    continue
                print("body", a.body, state, direction, k, flush=True)
                # the first pair of a direction is the identity reference for the rest of it
                if ref is None and ref_path.exists() and out != ref_path:
                    ref = Image.open(ref_path).convert("RGB")
                generate(a.body, state, direction, k, a.seed, ref if out != ref_path else None)


def cmd_blink(a):
    """Eyes-closed inpaint of idle frame 0 per direction with a visible face -> frames/blink_<dir>.png."""
    body = rig.BODIES[a.body]
    for d in a.dirs or BLINK_DIRS:
        half = halves(Image.open(fdir(a.body) / f"idle_{d}_0.png").convert("RGB"))[0]
        mask = cv2.dilate(eye_mask(half, body) * np.uint8(255), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
        out = fdir(a.body) / f"blink_{d}.png"
        img = call("img2img", {
            "prompt": prompt(lora(d), STYLE["quality"], "pixel art, chibi, closed eyes, eyelashes, simple face"),
            "negative_prompt": prompt(NEGATIVE, "open eyes, blue eyes, red eyes, orange eyes, eye, pupils"),
            "init_images": [b64png(half)], "mask": b64png(Image.fromarray(mask)), "seed": a.seed,
            "denoising_strength": 0.8, "inpainting_fill": 1, "mask_blur": 4, "inpaint_full_res": False,
            "inpainting_mask_invert": 0, "width": rig.HALF, "height": rig.PAIR[1],
        }, out.with_suffix(".json"))
        img.convert("RGB").save(out)
        Image.fromarray(mask).save(fdir(a.body) / f"blink_{d}_mask.png")
        print("blink", a.body, d, "eye px left:", int(eye_mask(img.convert("RGB"), body).sum()), flush=True)


def closed_eyes(name, body, d, tone):
    """Eye sprite of the eyes-closed inpaint of a direction (cmd_blink)."""
    src = fdir(name) / f"blink_{d}.png"
    if src.stat().st_mtime < (fdir(name) / f"idle_{d}_0.png").stat().st_mtime:
        print(f"  blink {d} is older than idle_{d}_0: run bodies.py blink {name}")
    half = Image.open(src).convert("RGB")
    guide = halves(Image.open(ROOT / "out" / "bodies" / name / "guides" / f"idle_{d}_0.png"))[0]
    cell = snap_feet(clean_alpha(to_art_cell(half, clear_pockets(half, main_figure(half), body, guide)), min_px=6))
    return split_eyes(match_tone(cell, tone, body), body, d)[1]


def cmd_check(a):
    """List the pairs failing qc_pair; with --redo regenerate them (a direction's reference first)."""
    for d in rig.DIRS:
        for state in STATES:
            for k, _ in enumerate(rig.pairs(len(rig.POSES[state]))):
                src = fdir(a.body) / f"{state}_{d}_{k}.png"
                issues = qc_pair(Image.open(src).convert("RGB"), rig.BODIES[a.body], d)
                if issues:
                    print(a.body, state, d, k, "; ".join(issues), flush=True)
                    if a.redo:
                        cmd_redo(argparse.Namespace(body=a.body, state=state, dir=d, pair=k, seed=a.seed, ref=None))


def cmd_redo(a):
    ref_path = fdir(a.body) / f"idle_{a.dir}_0.png"
    is_ref = (a.state, a.pair) == ("idle", 0)
    if a.ref:  # a good frame of this direction, when the usual reference pair is the bad one
        ref_path, is_ref = fdir(a.body) / f"{a.ref}.png", False
    ref = Image.open(ref_path).convert("RGB") if ref_path.exists() and not is_ref else None
    generate(a.body, a.state, a.dir, a.pair, a.seed, ref)


# ---------------------------------------------------------------- extraction + QC

def skin_lab(rgba):
    """Median Lab of skin-like pixels (warm, light) in a cell, for frame-to-frame color drift."""
    a = np.asarray(rgba)
    px = a[a[..., 3] > 0][:, :3]
    if not len(px):
        return None
    lab = cv2.cvtColor(px.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(float)
    skin = (px[:, 0] > 200) & (px[:, 0] > px[:, 2] + 25) & (px[:, 1] > 150)
    return np.median(lab[skin], axis=0) if skin.sum() > 10 else None


def cell_metrics(cell):
    a = np.asarray(cell)[..., 3] > 0
    ys, xs = np.nonzero(a)
    n = cv2.connectedComponentsWithStats(a.astype(np.uint8), connectivity=8)[0] - 1
    return {"top": int(ys.min()), "bottom": int(ys.max()), "islands": n} if len(ys) else None


def load_cells(name, body, state, d):
    """Cells of one state/direction (None where a pair is missing) and whether the half edge cut them."""
    n = len(rig.POSES[state])
    cells, cut = [None] * n, [False] * n
    for k, (i0, i1) in enumerate(rig.pairs(n)):
        src = fdir(name) / f"{state}_{d}_{k}.png"
        if not src.exists():
            continue
        guides = halves(Image.open(ROOT / "out" / "bodies" / name / "guides" / f"{state}_{d}_{k}.png"))
        for idx, half, guide in zip((i0, i1), halves(Image.open(src).convert("RGB")), guides):
            if idx == 0 and k > 0:
                continue  # an odd last frame was paired with frame 0: keep the first one
            fig = clear_pockets(half, main_figure(half), body, guide)
            cut[idx] = touches_edge(fig)
            cells[idx] = snap_feet(clean_alpha(to_art_cell(half, fig), min_px=6))
    return cells, cut


def apply_overrides(img, category, name, boxes):
    """Hand edits from the asset admin go on last, exactly as uploaded (docs/specs/asset-admin.md)."""
    keep = ROOT / "out" / "admin_history" / category / name / "pipeline"
    applied = 0
    for path in sorted((ART.parent / "overrides" / category / name).glob("*.png")):
        box = boxes.get(path.stem)
        with Image.open(path) as edit:
            if box is None or edit.size != (box[2] - box[0], box[3] - box[1]):
                print(f"  override without a matching frame: {path}")
                continue
            keep.mkdir(parents=True, exist_ok=True)
            img.crop(box).save(keep / path.name)  # the admin's "use pipeline frame" restores this
            img.paste(edit.convert("RGBA"), box[:2])
        applied += 1
    if applied:
        print(f"  {applied} {category} overrides applied")


def cmd_extract(a):
    name = a.body
    body = rig.BODIES[name]
    meta = json.loads((ROOT / "out" / "bodies" / name / "joints.json").read_text())
    states = list(STATES)
    cols = max(len(rig.POSES[s]) for s in states)
    sheet = Image.new("RGBA", (cols * rig.CELL, len(states) * len(rig.DIRS) * rig.CELL))
    drawn = {(s, d): load_cells(name, body, s, d) for s in states for d in rig.DIRS}
    tone = {}
    for d in rig.DIRS:  # every frame votes, so one bad pair cannot shift its whole direction
        refs = [tones(c, body) for s in states for c in drawn[s, d][0] if c]
        tone[d] = {k: np.median([r[k] for r in refs if k in r], axis=0) for r in refs for k in r}
    out_states, anchors, qc = {}, {}, {}
    eyes = Image.new("RGBA", (2 * EYES_W, len(BLINK_DIRS) * EYES_H))
    eye_at = {}
    for si, state in enumerate(states):
        n = len(rig.POSES[state])
        dirs_rects, anchors[state], eye_at[state] = [], {}, {}
        for di, d in enumerate(rig.DIRS):
            cells, cut = drawn[state, d]
            qc[f"{state}_{d}"] = frame_qc(cells, meta["joints"][state][d], state, cut)  # before tones hide drift
            cells = [match_tone(c, tone[d], body) if c else c for c in cells]
            if d in BLINK_DIRS:
                parts = [split_eyes(c, body, d) if c else (None, None, [0, 0], 0) for c in cells]
                cells = [p[0] for p in parts]
                eye_at[state][d] = [p[2] for p in parts]
                for f, p in zip(qc[f"{state}_{d}"], parts):
                    if p[3]:
                        f["issues"].append(f"{p[3]} eye px left")
                if state == "idle":
                    row = BLINK_DIRS.index(d) * EYES_H
                    eyes.paste(vivid_eyes(parts[0][1]), (0, row))
                    eyes.paste(closed_eyes(name, body, d, tone[d]), (EYES_W, row))
            rects = []
            for i, c in enumerate(cells):
                x, y = i * rig.CELL, (si * len(rig.DIRS) + di) * rig.CELL
                if c is not None:
                    sheet.paste(c, (x, y))
                rects.append({"x": x, "y": y, "w": rig.CELL, "h": rig.CELL})
            dirs_rects.append(rects)
            anchors[state][d] = meta["joints"][state][d]
        out_states[state] = {**STATES[state], "dirs": dirs_rects}
    apply_overrides(sheet, "body", name, {
        f"{s}_{d}_{i}": (r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"])
        for s, st in out_states.items() for d, rects in zip(rig.DIRS, st["dirs"]) for i, r in enumerate(rects)})
    apply_overrides(eyes, "face", name, {
        f"{s}_{d}_0": (c * EYES_W, r * EYES_H, (c + 1) * EYES_W, (r + 1) * EYES_H)
        for c, s in enumerate(("open", "closed")) for r, d in enumerate(BLINK_DIRS)})
    art = ART / name
    art.mkdir(parents=True, exist_ok=True)
    sheet.save(art / "sheet.png")
    eyes.save(art / "eyes.png")
    walk = STATES["walk"]
    # one walk cycle (6 frames) covers two strides: world speed in tiles/s = 2 strides per cycle
    cycle_s = len(rig.POSES["walk"]) / walk["fps"]
    save_json(art / "sheet.json", {
        "body": name, "frameW": rig.CELL, "frameH": rig.CELL, "feetY": rig.CELL_FEET[1], "ppu": PPU,
        "height": body.height, "walkSpeed": round(2 * meta["stride_px"] / PPU / cycle_s, 3),
        "states": out_states, "anchors": anchors,
        "eyes": {"w": EYES_W, "h": EYES_H, "dirs": list(BLINK_DIRS), "at": eye_at},  # rows of eyes.png; columns open, closed
    })
    save_json(ROOT / "out" / "bodies" / name / "qc.json", qc)
    bad = {k: v for k, v in qc.items() if any(f["issues"] for f in v)}
    print(f"wrote {art}  ({len(bad)} state/dir with QC issues)")
    for k, v in bad.items():
        print(" ", k, [f"{i}: {', '.join(f['issues'])}" for i, f in enumerate(v) if f["issues"]])


def frame_qc(cells, joints, state, cut):
    """Per-frame automatic checks against frame 0 of the same state/direction."""
    out = []
    m0 = cell_metrics(cells[0]) if cells[0] else None
    s0 = skin_lab(cells[0]) if cells[0] else None
    for i, c in enumerate(cells):
        issues = []
        m = cell_metrics(c) if c else None
        if m is None:
            out.append({"issues": ["missing"]})
            continue
        if m["islands"] > 1:
            issues.append(f"{m['islands']} islands")
        if cut[i]:
            issues.append("cut by the half edge")
        # feet: the lowest rig foot should sit on the drawn feet line
        foot = max(joints[i]["foot_left"][1], joints[i]["foot_right"][1])
        if abs(m["bottom"] - rig.CELL_FEET[1]) > 1 and foot > rig.CELL_FEET[1] - 5:
            issues.append(f"feet at {m['bottom']}")
        if m0 and abs(m["top"] - m0["top"]) > 3 + (3 if state == "walk" else 0):
            issues.append(f"head top {m['top']} vs {m0['top']}")
        s = skin_lab(c)
        if s is not None and s0 is not None and np.linalg.norm(s - s0) > 6:
            issues.append(f"skin dE {np.linalg.norm(s - s0):.1f}")
        out.append({"issues": issues, **m})
    return out


def cmd_qc(a):
    """HTML page with every state × direction playing at 1× and 3×, plus the raw pairs."""
    name = a.body
    meta = json.loads((ART / name / "sheet.json").read_text())
    qc = json.loads((ROOT / "out" / "bodies" / name / "qc.json").read_text())
    rows = []
    for state, st in meta["states"].items():
        for di, d in enumerate(rig.DIRS):
            frames = st["dirs"][di]
            issues = "; ".join(f"f{i}: {', '.join(f['issues'])}" for i, f in enumerate(qc.get(f"{state}_{d}", [])) if f["issues"])
            rows.append(f"<tr><td>{state} {d}</td><td><canvas data-s='{state}' data-d='{di}' width={rig.CELL} height={rig.CELL}></canvas>"
                        f"<canvas class=x3 data-s='{state}' data-d='{di}' width={rig.CELL} height={rig.CELL}></canvas></td>"
                        f"<td class=i>{issues or 'ok'}</td></tr>")
    html = f"""<!doctype html><meta charset=utf-8><title>{name} body QC</title>
<style>body{{background:#9ab88a;font:13px sans-serif}} canvas{{image-rendering:pixelated;background:#a9c79a;margin:2px}}
.x3{{width:480px;height:480px}} td{{padding:4px;vertical-align:middle}} .i{{color:#600;max-width:360px}}</style>
<h2>{name} — {meta['height']} px, walk {meta['walkSpeed']} tiles/s</h2><table>{''.join(rows)}</table>
<script>
const meta = {json.dumps({k: v for k, v in meta.items() if k != 'anchors'})};
const img = new Image(); img.src = '../../../../art/bodies/{name}/sheet.png?' + Date.now();
const eyes = new Image(); eyes.src = '../../../../art/bodies/{name}/eyes.png?' + Date.now();
const e = meta.eyes;
eyes.onload = () => img.decode().then(() => {{
  const cs = [...document.querySelectorAll('canvas')];
  const t0 = performance.now();
  (function tick(now) {{
    for (const c of cs) {{
      const st = meta.states[c.dataset.s], fr = st.dirs[c.dataset.d];
      const i = Math.floor(Math.max(now - t0, 0) / 1000 * st.fps) % fr.length, r = fr[i];  // the frame clock can start before t0
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
      g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      const at = e.at[c.dataset.s][e.dirs[c.dataset.d]];
      if (at) {{ g.globalCompositeOperation = 'source-atop'; g.drawImage(eyes, 0, c.dataset.d * e.h, e.w, e.h, at[i][0], at[i][1], e.w, e.h); }}
    }}
    requestAnimationFrame(tick);
  }})(t0);
}});
</script>"""
    p = ROOT / "out" / "bodies" / name / "qc.html"
    p.write_text(html, encoding="utf-8")
    print("wrote", p)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("body", choices=rig.BODIES)
    g.add_argument("--dirs", nargs="+", choices=rig.DIRS); g.add_argument("--states", nargs="+", choices=list(STATES))
    g.add_argument("--seed", type=int, default=1); g.add_argument("--force", action="store_true")
    r = sub.add_parser("redo"); r.add_argument("body", choices=rig.BODIES); r.add_argument("state", choices=list(STATES))
    r.add_argument("dir", choices=rig.DIRS); r.add_argument("pair", type=int); r.add_argument("--seed", type=int, default=7)
    r.add_argument("--ref", help="frame file to use as the reference, e.g. idle_W_1")
    e = sub.add_parser("extract"); e.add_argument("body", choices=rig.BODIES)
    q = sub.add_parser("qc"); q.add_argument("body", choices=rig.BODIES)
    b = sub.add_parser("blink"); b.add_argument("body", choices=rig.BODIES); b.add_argument("--seed", type=int, default=5)
    b.add_argument("--dirs", nargs="+", choices=BLINK_DIRS)
    c = sub.add_parser("check"); c.add_argument("body", choices=rig.BODIES)
    c.add_argument("--redo", action="store_true"); c.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    {"gen": cmd_gen, "redo": cmd_redo, "extract": cmd_extract, "qc": cmd_qc, "check": cmd_check, "blink": cmd_blink}[a.cmd](a)


if __name__ == "__main__":
    main()
