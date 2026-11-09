"""Hair and clothes layers on the frame-by-frame bodies (spec: docs/specs/body-layers.md).

Usage:
  python layers.py gen <body> <item> [--dirs S W] [--seed 7] [--force] [--key 2]   inpaint the item on a key frame per direction
  python layers.py extract <body> <item>   -> art/bodies/<body>/layers/<item>/sheet.png + layer.json

Items and prompts come from the v2 set (sets/A.json). The AI draws the item once per direction;
extract places it on every frame of the body's sheet: hair follows the drawn skull, clothes are
cut into rig bones that follow the rig (cut-out, candidate A of the spec).
"""
import argparse
import json
import math

import cv2
import numpy as np
from PIL import Image

import bodies
import rig
from common import ROOT, save_json
from sheet import (STYLE, b64png, call, clean_alpha, controlnet_unit, figure_mask, load_set, mask_for, prompt,
                   view_geometry)

DYE = {"hair": ["hair"], "body": ["cloth1", "cloth2"]}  # v2 slot -> dye ramps (src/paperdoll2/dye.js)
# outfit pieces: bone ends, far-to-near order breaks depth ties (torso before the arms in front of it)
BONES = {"torso": ("neck", "pelvis")} | {
    f"{part}_{n}": ends for n in "LR" for part, ends in (
        ("thigh", (f"hip_{n}", f"knee_{n}")), ("shin", (f"knee_{n}", f"ankle_{n}")), ("foot", (f"ankle_{n}", f"toe_{n}")),
        ("upper_arm", (f"shoulder_{n}", f"elbow_{n}")), ("forearm", (f"elbow_{n}", f"hand_{n}")))}
SKULL_TRUST = 4  # sprite px: a drawn skull further than this from the rig's head is a hand or a raised arm
# Key frames the AI draws an item on: idle, and walk with the limbs apart (in idle W the legs
# overlap, so one leg gets no clothes of its own). Hair uses key 1 only.
KEYS = {1: ("idle", 0), 2: ("walk", 0)}


def odir(name, item):
    d = ROOT / "out" / "bodies" / name / "layers" / item
    d.mkdir(parents=True, exist_ok=True)
    return d


def stem(d, key):
    return d if key == 1 else f"{d}_{key}"


def base_half(name, d, key=1):
    """Body frame a key frame is drawn on: frame 0 of its state, the left half of pair 0 (no fit shift)."""
    return bodies.halves(Image.open(bodies.fdir(name) / f"{KEYS[key][0]}_{d}_0.png").convert("RGB"))[0]


def cmd_gen(a):
    p = load_set("A")["parts"][a.item]
    for d in a.dirs or rig.DIRS:
        out = odir(a.body, a.item) / f"{stem(d, a.key)}.png"
        if out.exists() and not a.force:
            continue
        base = base_half(a.body, d, a.key)
        fig = bodies.main_figure(base)
        m = mask_for(fig.shape, view_geometry(fig), p["mask"], d, fig)
        cn = p.get("cn_weight", 0.35)  # the body's lineart keeps the item on its shape
        units = [controlnet_unit(base, "lineart_anime", cn, 0.4)] if cn else []
        print("layer", a.body, a.item, d, flush=True)
        img = call("img2img", {
            "init_images": [b64png(base)], "mask": b64png(Image.fromarray(m)),
            "denoising_strength": p.get("denoise", 0.9), "inpainting_fill": p.get("fill", 1), "mask_blur": 4,
            "inpaint_full_res": False, "inpainting_mask_invert": 0,
            "prompt": prompt(bodies.lora(d), STYLE["quality"], "pixel art, chibi, full body, white background, simple background",
                             bodies.SPECIES[a.body], p["prompt"], STYLE["dir_tags"][d]),
            "negative_prompt": prompt(STYLE["negative"], p.get("negative", ""), STYLE["dir_negative"][d]),
            "seed": a.seed, "width": rig.HALF, "height": rig.PAIR[1],
            "alwayson_scripts": {"controlnet": {"args": units}},
        }, out.with_suffix(".json"))
        img.save(out)
        Image.fromarray(m).save(odir(a.body, a.item) / f"{stem(d, a.key)}_mask.png")


def item_cell(name, item, kind, d, key=1):
    """The item drawn on a key frame of a direction, as a cell aligned with the body's cells."""
    base, img = base_half(name, d, key), Image.open(odir(name, item) / f"{stem(d, key)}.png").convert("RGB")
    fig = bodies.main_figure(base)
    m = np.asarray(Image.open(odir(name, item) / f"{stem(d, key)}_mask.png")) > 127
    if kind == "outfit":
        alpha = figure_mask(img) & m
    else:  # the v2 rule (sheet.cmd_extract): pixels the inpaint changed; white hair over pale skin changes little
        now, was = np.asarray(img).astype(np.int16), np.asarray(base).astype(np.int16)
        chroma = lambda x: x.max(axis=2) - x.min(axis=2)
        diff = np.abs(now - was).sum(axis=2)
        alpha = m & (figure_mask(img) | fig) & ((diff > 60) | (fig & (chroma(now) < 20) & (chroma(was) > 25) & (diff > 12)))
    return clean_alpha(bodies.to_art_cell(img, alpha), min_px=6), bodies.to_art_cell(base, fig)


def skull(cell, body, head_x):
    """(center x, top) of the drawn skull in a cell, from the columns around the rig's head."""
    a = np.asarray(cell)[..., 3] > 0
    h = int(body.head_h * rig.SCALE / rig.GRID)
    a[:, :max(int(head_x - 0.62 * h), 0)] = a[:, int(head_x + 0.62 * h):] = False
    rows = np.nonzero(a.any(axis=1))[0]
    if not len(rows):
        return None
    xs = np.nonzero(a[rows[0]:rows[0] + int(h * 0.4)].any(axis=0))[0]
    return np.array([(xs.min() + xs.max()) / 2, rows[0]])


def place_hair(layer, ref_cell, cell, body, ref_j, j, roll):
    """Hair moves with the head: by the drawn skull where it agrees with the rig, else by the rig."""
    rig_move = np.array(j["head"][:2]) - ref_j["head"][:2]
    if roll:  # a fallen body: turn around the head joint, as the rig does
        cx, cy = ref_j["head"][:2]
        turned = layer.rotate(-roll, Image.NEAREST, center=(cx, cy))
        return shift(turned, rig_move)
    s0, s = skull(ref_cell, body, ref_j["head"][0]), skull(cell, body, j["head"][0])
    move = rig_move if s0 is None or s is None else s - s0
    if np.abs(move - rig_move).max() > SKULL_TRUST:
        move = rig_move
    return shift(layer, move)


def shift(img, move):
    out = Image.new("RGBA", img.size)
    out.paste(img, (int(round(move[0])), int(round(move[1]))))
    return out


def bone_pieces(layer, ref_j, d, body):
    """Split an outfit cell by nearest bone (distance to the segment minus the limb's drawn radius)."""
    a = np.asarray(layer)
    ys, xs = np.nonzero(a[..., 3])
    pts = np.stack([xs, ys], axis=1).astype(float)
    k = rig.SCALE / rig.GRID
    t = math.radians(rig.YAW[d])
    torso_r = math.hypot((body.shoulders / 2 - 1.5) * math.cos(t), 7.0 * body.width * math.sin(t)) * k
    cost, front = [], []
    depth = lambda name: (ref_j[BONES[name][0]][2] + ref_j[BONES[name][1]][2]) / 2
    for name, (p, q) in BONES.items():
        p0, q0 = np.array(ref_j[p][:2]), np.array(ref_j[q][:2])
        v = q0 - p0
        u = np.clip(((pts - p0) @ v) / max(v @ v, 1e-6), 0, 1)
        dist = np.linalg.norm(pts - (p0 + u[:, None] * v), axis=1)
        r = torso_r if name == "torso" else 4.0 * body.limb * k
        cost.append(dist - r)
        front.append(dist - r - 1000 * (dist < r) if name != "torso" and depth(name) > depth("torso") else cost[-1])
    # A limb in front of the torso (the near arm in a side view) is what is drawn there: it takes those
    # pixels with it, and the torso keeps them too, so no hole opens when the limb swings away.
    owner, under = np.argmin(front, axis=0), np.argmin(cost, axis=0)
    pieces = {}
    for i, name in enumerate(BONES):
        sel = (owner == i) | ((under == i) & (name == "torso"))
        if sel.any():
            piece = np.zeros_like(a)
            piece[ys[sel], xs[sel]] = a[ys[sel], xs[sel]]
            pieces[name] = piece
    return pieces


def bone_angle(j, name):
    p, q = (np.array(j[n][:2]) for n in BONES[name])
    return math.degrees(math.atan2(*(q - p)[::-1])) if np.linalg.norm(q - p) > 1 else None


def pick_key(keys, j, name):
    """(piece, key joints) for a bone: among the key frames that drew most of it, the one whose bone
    points most like this frame's (a leg hidden in one key frame has few pixels there)."""
    have = [(pieces[name], ref_j) for pieces, ref_j in keys if name in pieces]
    if not have:
        return None
    most = max((pc[..., 3] > 0).sum() for pc, _ in have)
    have = [h for h in have if (h[0][..., 3] > 0).sum() >= 0.4 * most]
    a = bone_angle(j, name)
    off = lambda h: 0 if a is None or bone_angle(h[1], name) is None else abs((a - bone_angle(h[1], name) + 180) % 360 - 180)
    return min(have, key=off)


def place_outfit(keys, j, body_alpha):
    """Each piece follows its bone (turn about the bone's first joint, then move it there), far ones first.
    keys: [(pieces, joints of that key frame)]."""
    depth = lambda name: (j[BONES[name][0]][2] + j[BONES[name][1]][2]) / 2 - (0.5 if name == "torso" else 0)
    out = np.zeros((rig.CELL, rig.CELL, 4), np.uint8)
    for name in sorted([n for n in BONES if any(n in pieces for pieces, _ in keys)], key=depth):
        piece, ref_j = pick_key(keys, j, name)
        p0, q0 = (np.array(ref_j[n][:2]) for n in BONES[name])
        p, q = (np.array(j[n][:2]) for n in BONES[name])
        turn = math.degrees(math.atan2(*(q - p)[::-1]) - math.atan2(*(q0 - p0)[::-1])) if np.linalg.norm(q - p) > 1 else 0.0
        m = cv2.getRotationMatrix2D((float(p0[0]), float(p0[1])), -turn, 1.0)
        m[:, 2] += p - p0
        moved = cv2.warpAffine(piece, m, (rig.CELL, rig.CELL), flags=cv2.INTER_NEAREST)
        out[moved[..., 3] > 0] = moved[moved[..., 3] > 0]
    # clothes stay on the drawn body: 2 sprite px of slack for cloth standing off it
    out[~cv2.dilate(body_alpha.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)] = 0
    return Image.fromarray(out, "RGBA")


def cmd_extract(a):
    name, body = a.body, rig.BODIES[a.body]
    p = load_set("A")["parts"][a.item]
    kind = "outfit" if p["mask"] == "outfit" else "hair"
    art = bodies.ART / name
    meta = json.loads((art / "sheet.json").read_text())
    sheet = Image.open(art / "sheet.png").convert("RGBA")
    out = Image.new("RGBA", sheet.size)
    for d in rig.DIRS:
        if not (odir(name, a.item) / f"{d}.png").exists():
            print("  missing", d)
            continue
        layer, ref_cell = item_cell(name, a.item, kind, d)
        ref_j = rig.view_joints(body, rig.POSES["idle"][0], d)
        keys = []
        for key, (state, i) in KEYS.items() if kind == "outfit" else ():
            if (odir(name, a.item) / f"{stem(d, key)}.png").exists():
                kj = rig.view_joints(body, rig.POSES[state][i], d)
                keys.append((bone_pieces(item_cell(name, a.item, kind, d, key)[0], kj, d, body), kj))
        di = rig.DIRS.index(d)
        for state, st in meta["states"].items():
            for i, r in enumerate(st["dirs"][di]):
                box = (r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"])
                cell = sheet.crop(box)
                pose = rig.POSES[state][i]
                j = rig.view_joints(body, pose, d)
                if kind == "outfit":
                    placed = place_outfit(keys, j, np.asarray(cell)[..., 3] > 0)
                else:
                    placed = place_hair(layer, ref_cell, cell, body, ref_j, j, pose.roll)
                out.paste(placed, box[:2])
    dst = art / "layers" / a.item
    dst.mkdir(parents=True, exist_ok=True)
    out.save(dst / "sheet.png")
    save_json(dst / "layer.json", {"item": a.item, "slot": "outfit" if kind == "outfit" else "hair",
                                   "dye": DYE[p["slot"]], "method": "cutout" if kind == "outfit" else "anchored"})
    print("wrote", dst)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("body", choices=rig.BODIES); g.add_argument("item")
    g.add_argument("--dirs", nargs="+", choices=rig.DIRS); g.add_argument("--seed", type=int, default=7)
    g.add_argument("--force", action="store_true")
    g.add_argument("--key", type=int, choices=KEYS, default=1, help="key frame to draw on (2: walk, limbs apart)")
    e = sub.add_parser("extract"); e.add_argument("body", choices=rig.BODIES); e.add_argument("item")
    a = ap.parse_args()
    {"gen": cmd_gen, "extract": cmd_extract}[a.cmd](a)


if __name__ == "__main__":
    main()
