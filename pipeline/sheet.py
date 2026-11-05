"""v2 asset pipeline: per-direction views + inpaint layering (see docs/specs/art-pipeline.md).

  python sheet.py base    <set> --seeds 201 202     # bald mannequin, every direction, per seed
  python sheet.py pick    <set> --seed 201 [--dir NW=202 ...]   # choose base views -> base/<dir>.png
  python sheet.py part    <set> <part_id> --seed 7  # inpaint a part on each base view (S first)
  python sheet.py item    <set> <item_id>           # held item (weapon/shield)
  python sheet.py extract <set>                     # 128px cells + layers -> ../art/paperdoll2/<set>/
  python sheet.py qc      <set>                     # automatic checks on everything generated
  python sheet.py contact <set>                     # HTML contact sheet for human review

One large figure per image (832x1216, ~1100 px tall) so the LoCon's ~10 px "pixels" give
~110 game pixels of detail. NoobAI handles the direction (tags + a soft mannequin guide),
the LoCon the style; views other than S use the S view as a ControlNet reference so the
design stays the same. Parts are inpainted on the SAME base view and cut with the SAME
transform, so layers line up pixel-exactly when stacked.
"""
import argparse
import base64
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image

from common import ROOT, load_json, save_json
from guides import SHEET, VIEW

URL = "http://127.0.0.1:7860"
DIRS = SHEET["dirs"]
REF_W, REF_H = VIEW["size"]         # per-direction resolution (SDXL bucket)
FEET_Y = VIEW["feet_y"]
CELL, ORIGIN, FIG_H = 128, (64, 122), 110   # game cell, feet pixel, figure height in cells
BLOCK = VIEW["height"] / FIG_H              # view px per game px (10)

STYLE = {
    "lora": "<lora:ElinSpriteNoobLocon_byKonan:1>",
    "quality": "masterpiece, best quality, newest, absurdres, highres",
    "view_tags": "pixel art, chibi, solo, full body, standing, straight-on, arms at sides, white background, simple background",
    "negative": "worst quality, low quality, lowres, bad anatomy, bad hands, extra arms, extra legs, "
                "multiple girls, multiple boys, 2girls, 2boys, leotard, cleavage, panties, text, signature, watermark, logo, "
                "scenery, shadow, gradient background, dark background, colored background, cropped, out of frame, blurry",
    "sampler": "Euler a", "steps": 28, "cfg": 6.0,
    "checkpoint": "noobaiXLNAIXL_epsilonPred11Version",
    "controlnet": "noob-lineart-anime",
    "controlnet_depth": "noob-depth",
    # NoobAI direction tags; the LoCon only knows front views, so it is weaker on the others
    "dir_tags": {
        "S": "facing viewer, looking at viewer, front view",
        "SW": "looking to the side, three-quarter view, facing left",
        "W": "from side, profile, facing left",
        "NW": "from behind, three-quarter view, facing away, facing left",
        "N": "from behind, back, facing away",
    },
    "depth_weight": 0.6, "depth_end": 0.5,
    "dir_lora": {"S": 1.0, "SW": 0.9, "W": 0.75, "NW": 0.7, "N": 0.7},
    # back views must not turn the head toward the camera
    "dir_negative": {
        "S": "from side, from behind",
        "SW": "from behind, back",
        "W": "looking at viewer, facing viewer, from behind",
        "NW": "looking back, looking at viewer, facing viewer, eyes, breasts, cleavage, chest, navel",
        "N": "looking back, looking at viewer, facing viewer, face, eyes, from side, breasts, cleavage, chest, navel, knees",
    },
}


def lora(direction):
    return f"<lora:ElinSpriteNoobLocon_byKonan:{STYLE['dir_lora'][direction]:.2f}>"


# ---------------------------------------------------------------- webui API

def b64png(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def unb64(s):
    return Image.open(io.BytesIO(base64.b64decode(s))).convert("RGB")


_cn_names = {}


def controlnet_unit(image, module, weight, end, model=STYLE["controlnet"]):
    if model not in _cn_names:
        models = requests.get(f"{URL}/controlnet/model_list", timeout=30).json()["model_list"]
        _cn_names[model] = next((m for m in models if m.split(" [")[0] == model), None)
        if not _cn_names[model]:
            sys.exit(f"ControlNet model {model} not installed: {models}")
    return {"enabled": True, "image": b64png(image), "module": module, "model": _cn_names[model],
            "weight": weight, "guidance_start": 0.0, "guidance_end": end,
            "pixel_perfect": True, "resize_mode": "Crop and Resize", "control_mode": "Balanced", "low_vram": True}


def guide_unit(direction):
    """Depth of the 3D mannequin (mannequin3d.py): unlike an outline it tells front from back."""
    g = Image.open(ROOT / "out" / "v2" / "guides" / f"depth_{direction}.png").convert("RGB")
    return controlnet_unit(g, "none", STYLE["depth_weight"], STYLE["depth_end"], STYLE["controlnet_depth"])


def reference_unit(img):
    """reference_only needs no model: it steers style/design toward the given image."""
    return {"enabled": True, "image": b64png(img), "module": "reference_only", "model": "None",
            "weight": 0.6, "guidance_start": 0.0, "guidance_end": 0.8, "threshold_a": 0.5,
            "pixel_perfect": True, "resize_mode": "Crop and Resize", "control_mode": "Balanced", "low_vram": True}


def call(endpoint, payload, log_path):
    payload = {"sampler_name": STYLE["sampler"], "steps": STYLE["steps"], "cfg_scale": STYLE["cfg"],
               "override_settings": {"sd_model_checkpoint": STYLE["checkpoint"]},
               "override_settings_restore_afterwards": False, **payload}
    r = requests.post(f"{URL}/sdapi/v1/{endpoint}", json=payload, timeout=3600)
    r.raise_for_status()
    res = r.json()
    info = json.loads(res["info"])
    meta = {k: v for k, v in payload.items() if k not in ("init_images", "mask", "alwayson_scripts")}
    meta["seed"] = info["seed"]
    meta["infotext"] = info["infotexts"][0]
    save_json(log_path, meta)
    return unb64(res["images"][0])


def prompt(*parts):
    return ", ".join(p for p in parts if p)


# ---------------------------------------------------------------- geometry

def figure_mask(img):
    """Figure = everything except light, low-saturation pixels connected to the border."""
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    light = (a.min(axis=2) > 215) & ((a.max(axis=2) - a.min(axis=2)) < 22)
    h, w = light.shape
    ff = light.astype(np.uint8)
    pad = np.zeros((h + 2, w + 2), np.uint8)
    for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] + [(x, 0) for x in range(0, w, 16)] + [(x, h - 1) for x in range(0, w, 16)]:
        if ff[y, x] == 1:
            cv2.floodFill(ff, pad, (x, y), 2)
    return ff != 2


def view_geometry(mask):
    """Head box and neck row of one figure (mask of a single view)."""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return None
    top, bot = ys.min(), ys.max()
    H = bot - top
    widths = mask.sum(axis=1)
    band = range(int(top + 0.25 * H), int(top + 0.5 * H))
    neck = min(band, key=lambda y: widths[y]) if len(band) else int(top + 0.37 * H)
    hx = np.nonzero(mask[top:neck].any(axis=0))[0]
    return {"top": int(top), "bot": int(bot), "H": int(H), "neck": int(neck),
            "head": [int(hx.min()), int(top), int(hx.max()), int(neck)]}


# face window (fractions of the head box) that hair/headgear inpainting must not touch
FACE = {"S": (0.20, 0.42, 0.80, 1.0), "SW": (0.08, 0.42, 0.68, 1.0), "W": (0.0, 0.45, 0.52, 1.0),
        "NW": (0.0, 0.55, 0.14, 0.9), "N": None}


def part_mask(shape, g, kind, direction):
    """Inpaint mask (uint8 0/255) for one view, from its base geometry."""
    h, w = shape
    m = np.zeros((h, w), np.uint8)
    x0, y0, x1, y1 = g["head"]
    H, hw = g["H"], x1 - x0
    hh = y1 - y0
    if kind == "outfit":
        fig = np.zeros((h, w), np.uint8)
        fig[g["neck"] - int(0.02 * H):g["bot"] + int(0.03 * H)] = 255
        return fig  # combined with the dilated figure by the caller
    if kind.startswith("hair"):
        # hair_tails: as long as hair_long but hangs at the sides (twintails), never over the back
        down = {"hair_short": 0.05, "hair_medium": 0.25, "hair_long": 0.55, "hair_tails": 0.55}[kind]
        side = {"hair_short": 0.10, "hair_medium": 0.14, "hair_long": 0.18, "hair_tails": 0.18}[kind]
        cv2.rectangle(m, (int(x0 - side * hw), int(y0 - 0.10 * hh)), (int(x1 + side * hw), int(y1 + down * H)), 255, -1)
    elif kind == "headgear":
        cv2.rectangle(m, (int(x0 - 0.25 * hw), int(y0 - 0.55 * hh)), (int(x1 + 0.25 * hw), int(y0 + 0.55 * hh)), 255, -1)
    elif kind == "ears":  # thin bands just outside both sides of the head, mid height
        for ex in ((x0 - 0.22 * hw, x0 + 0.08 * hw), (x1 - 0.08 * hw, x1 + 0.22 * hw)):
            cv2.rectangle(m, (int(ex[0]), int(y0 + 0.30 * hh)), (int(ex[1]), int(y0 + 0.75 * hh)), 255, -1)
    f = FACE[direction]
    if f:
        cv2.rectangle(m, (int(x0 + f[0] * hw), int(y0 + f[1] * hh)), (int(x0 + f[2] * hw), int(y0 + f[3] * hh)), 0, -1)
    return m


# ---------------------------------------------------------------- set files

def set_dir(name):
    d = ROOT / "out" / "v2" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_set(name):
    return load_json(ROOT / "sets" / f"{name}.json")


# ---------------------------------------------------------------- automatic QC

def figures(mask, min_frac):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return [stats[k] for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= min_frac * mask.size]


def light_background(img):
    a = np.asarray(img.convert("RGB"))
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    return np.median(border.min(axis=1)) >= 200


def qc_view(img):
    """Refined view: one figure of the expected height standing on the feet line."""
    if not light_background(img):
        return ["background is not light"]
    problems = []
    figs = figures(figure_mask(img), 0.01)
    if len(figs) != 1:
        problems.append(f"{len(figs)} figures")
    if figs:
        f = max(figs, key=lambda s: s[cv2.CC_STAT_AREA])
        h, bottom = f[cv2.CC_STAT_HEIGHT], f[cv2.CC_STAT_TOP] + f[cv2.CC_STAT_HEIGHT]
        expected = VIEW["height"]
        if not 0.85 * expected <= h <= 1.12 * expected:
            problems.append(f"height {h}px vs {expected:.0f}px")
        if abs(bottom - FEET_Y) > 30:
            problems.append(f"feet at {bottom}px vs {FEET_Y}px")
    return problems


# ---------------------------------------------------------------- commands

def view_prompt(direction, *parts):
    return prompt(lora(direction), STYLE["quality"], STYLE["view_tags"], *parts, STYLE["dir_tags"][direction])


def cmd_base(a):
    """Every direction for every seed -> out/v2/<set>/base/<dir>_<seed>.png. S comes first
    and is the design reference for the other directions of the same seed."""
    s = load_set(a.set)
    bdir = set_dir(a.set) / "base"
    bdir.mkdir(exist_ok=True)
    for seed in a.seeds:
        for direction in a.dirs or DIRS:
            out = bdir / f"{direction}_{seed}.png"
            if out.exists() and not a.force:
                continue
            units = [guide_unit(direction)]
            ref = bdir / f"S_{a.ref or seed}.png"  # --ref: reuse an approved S view
            if direction != "S" and ref.exists():
                units.append(reference_unit(Image.open(ref).convert("RGB")))
            print("base", direction, seed, flush=True)
            img = call("txt2img", {
                "prompt": view_prompt(direction, s["base_prompt"]),
                "negative_prompt": prompt(STYLE["negative"], "multiple views", s.get("base_negative", ""), STYLE["dir_negative"][direction]),
                "seed": seed, "width": REF_W, "height": REF_H,
                "alwayson_scripts": {"controlnet": {"args": units}},
            }, out.with_suffix(".json"))
            img.save(out)
            print("  QC:", "; ".join(qc_view(img)) or "ok", flush=True)


def cmd_pick(a):
    """Choose base views: --seed for all directions, --dir NW=202 to override one."""
    bdir = set_dir(a.set) / "base"
    chosen = {d: a.seed for d in DIRS}
    for o in a.dir or []:
        d, seed = o.split("=")
        chosen[d] = int(seed)
    for d, seed in chosen.items():
        Image.open(bdir / f"{d}_{seed}.png").save(bdir / f"{d}.png")
    save_json(bdir / "picked.json", chosen)
    print("picked", chosen)


def cmd_part(a):
    s = load_set(a.set)
    p = s["parts"][a.part]
    d = set_dir(a.set)
    pdir = d / "parts" / a.part
    pdir.mkdir(parents=True, exist_ok=True)
    kind = p["mask"]
    neg = prompt(STYLE["negative"], "multiple views", p.get("negative", ""))  # + direction below
    character = s.get("part_prompt", "")
    for direction in a.dirs or DIRS:  # S first: it becomes the reference for the others
        out = pdir / f"{direction}.png"
        if out.exists() and not a.force:
            continue
        base = Image.open(d / "base" / f"{direction}.png").convert("RGB")
        bfig = figure_mask(base)
        g = view_geometry(bfig)
        m = mask_for(bfig.shape, g, kind, direction, bfig)
        # cn_weight 0 drops the base lineart: long robes need it gone, or the base's legs show through
        cn = p.get("cn_weight", 0.35)
        units = [controlnet_unit(base, "lineart_anime", cn, 0.4)] if cn else []
        if direction in ("SW", "W"):  # a front reference turns back views toward the camera
            units.append(reference_unit(Image.open(pdir / "S.png").convert("RGB")))
        print("part", a.part, direction, flush=True)
        img = call("img2img", {
            "init_images": [b64png(base)], "mask": b64png(Image.fromarray(m)),
            "denoising_strength": p.get("denoise", 0.9), "inpainting_fill": p.get("fill", 1), "mask_blur": 4,
            "inpaint_full_res": False, "inpainting_mask_invert": 0,
            "prompt": view_prompt(direction, character, p["prompt"]),
            "negative_prompt": prompt(neg, STYLE["dir_negative"][direction]), "seed": a.seed, "width": REF_W, "height": REF_H,
            "alwayson_scripts": {"controlnet": {"args": units}},
        }, pdir / f"{direction}.json")
        img.save(out)
        Image.fromarray(m).save(pdir / f"{direction}_mask.png")


def mask_for(shape, g, kind, direction, fig):
    m = part_mask(shape, g, kind, direction)
    if kind == "outfit":  # rows below the neck, inside the dilated convex hull of the body
        body = fig.astype(np.uint8) * 255
        body[:g["neck"]] = 0
        hull = np.zeros_like(body)
        pts = cv2.findNonZero(body)
        if pts is not None:  # the hull fills the gap between the legs so robes can reach the feet
            cv2.fillConvexPoly(hull, cv2.convexHull(pts), 255)
        r = max(3, int(0.06 * g["H"]))
        m = m & cv2.dilate(hull, np.ones((r, r), np.uint8))
    elif kind.startswith("hair") and (direction in ("S", "SW", "W") or kind != "hair_long"):
        # seen from the front, hair falls behind the torso (and only long hair covers the back):
        # keep the body interior out, or the inpaint repaints the clothes into the hair layer
        body = fig.astype(np.uint8) * 255
        body[:g["neck"] + int(0.02 * g["H"])] = 0
        e = max(3, int(0.03 * g["H"]))
        m = m & ~cv2.erode(body, np.ones((e, e), np.uint8))
    return m


# ---------------------------------------------------------------- extraction

def to_cells(img, alpha, n_colors=48):
    """Refined view (REF size) + bool alpha -> 128x128 RGBA by block majority vote."""
    a = np.asarray(img.convert("RGB"))
    q = Image.fromarray(a).quantize(n_colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    idx = np.asarray(q).astype(np.int16)
    idx[~alpha] = -1
    pal = np.array(q.getpalette()[:n_colors * 3]).reshape(-1, 3)
    out = np.zeros((CELL, CELL, 4), np.uint8)
    feet_y = FEET_Y
    cx = REF_W / 2
    for v in range(CELL):
        y0, y1 = feet_y + (v - ORIGIN[1]) * BLOCK, feet_y + (v + 1 - ORIGIN[1]) * BLOCK
        if y1 <= 0 or y0 >= REF_H:
            continue
        for u in range(CELL):
            x0, x1 = cx + (u - ORIGIN[0]) * BLOCK, cx + (u + 1 - ORIGIN[0]) * BLOCK
            if x1 <= 0 or x0 >= REF_W:
                continue
            blk = idx[max(0, int(y0)):int(y1), max(0, int(x0)):int(x1)].ravel()
            if not len(blk):
                continue
            opaque = blk[blk >= 0]
            if len(opaque) * 2 < len(blk):
                continue
            c = np.bincount(opaque).argmax()
            out[v, u, :3] = pal[c]
            out[v, u, 3] = 255
    return Image.fromarray(out, "RGBA")


def clean_alpha(rgba, min_px=4, keep_touching=None):
    """Drop tiny islands; optionally keep only islands touching a seed mask."""
    a = np.asarray(rgba).copy()
    n, lab, stats, _ = cv2.connectedComponentsWithStats((a[..., 3] > 0).astype(np.uint8), connectivity=8)
    for k in range(1, n):
        drop = stats[k, cv2.CC_STAT_AREA] < min_px
        if keep_touching is not None and not (keep_touching & (lab == k)).any():
            drop = True
        if drop:
            a[lab == k] = 0
    return Image.fromarray(a, "RGBA")


def cmd_extract(a):
    s = load_set(a.set)
    d = set_dir(a.set)
    art = ROOT.parent / "art" / "paperdoll2" / a.set
    art.mkdir(parents=True, exist_ok=True)
    geo = {}
    for direction in DIRS:
        base = Image.open(d / "base" / f"{direction}.png").convert("RGB")
        fig = figure_mask(base)
        g = view_geometry(fig)
        head = np.zeros_like(fig)
        head[:g["neck"] + int(0.02 * g["H"])] = True
        (art / "base_head").mkdir(exist_ok=True)
        (art / "base_body").mkdir(exist_ok=True)
        clean_alpha(to_cells(base, fig & head)).save(art / "base_head" / f"{direction}.png")
        clean_alpha(to_cells(base, fig & ~head)).save(art / "base_body" / f"{direction}.png")
        geo[direction] = {k: cell_xy(*v) if k == "head" else v for k, v in g.items()}
        geo[direction]["anchors"] = anchors(fig, g)

        for pid, p in s["parts"].items():
            src = d / "parts" / pid / f"{direction}.png"
            if not src.exists():
                continue
            img = Image.open(src).convert("RGB")
            m = np.asarray(Image.open(d / "parts" / pid / f"{direction}_mask.png")) > 127
            if p["mask"] == "outfit":
                alpha = figure_mask(img) & m
            else:  # layer = pixels the inpaint actually changed, inside its mask
                now, was = np.asarray(img).astype(np.int16), np.asarray(base).astype(np.int16)
                diff = np.abs(now - was).sum(axis=2)
                # white hair over pale skin changes less than a.diff, so also take pixels that turned
                # grey/white where the base had color (not over the background: the inpaint leaves
                # light grey haze there)
                chroma = lambda x: x.max(axis=2) - x.min(axis=2)  # white hair ~10, pale skin ~40
                m &= mask_for(fig.shape, g, p["mask"], direction, fig) > 0  # current mask rules
                # white hair is as light as the background, so over the base figure it always counts
                alpha = m & (figure_mask(img) | fig) & ((diff > a.diff) | (p["mask"].startswith("hair") & fig & (chroma(now) < 20) & (chroma(was) > 25) & (diff > 12)))
                if not p["mask"].startswith("hair"):  # a hat may paint background over the crown; never keep that
                    alpha &= ~((now.min(axis=2) > 225) & (chroma(now) < 20))
            cells = to_cells(img, alpha)
            seed = None
            if p["mask"] != "outfit":  # hair/hat islands must touch the head
                hb = np.zeros((CELL, CELL), bool)
                x0, y0, x1, y1 = cell_box(g["head"])
                hb[max(0, y0 - 2):y1 + 2, max(0, x0 - 2):x1 + 2] = True
                seed = hb
            (art / pid).mkdir(exist_ok=True)
            clean_alpha(cells, keep_touching=seed).save(art / pid / f"{direction}.png")
    # "borrow": {"N": "S"} reuses another view's layer, moved onto this view's head. For
    # headgear that looks the same from the back (a cone hat), whose back views the model fails.
    for pid, p in s["parts"].items():
        for direction, src in p.get("borrow", {}).items():
            (sx0, sy0, sx1, _), (tx0, ty0, tx1, _) = geo[src]["head"], geo[direction]["head"]
            dx, dy = round((tx0 + tx1 - sx0 - sx1) / 2), ty0 - sy0
            moved = Image.new("RGBA", (CELL, CELL))
            moved.paste(Image.open(art / pid / f"{src}.png"), (dx, dy))
            moved.save(art / pid / f"{direction}.png")
    write_manifest(s, art, geo)
    print(f"wrote {art}")


def hsl_pixels(rgba):
    a = np.asarray(rgba).reshape(-1, 4)
    a = a[a[:, 3] > 0, :3].astype(np.float32) / 255
    mx, mn = a.max(1), a.min(1)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(d == 0, 0, d / np.maximum(1e-6, 1 - np.abs(2 * l - 1)))
    r, g, b = a.T
    h = np.where(mx == r, ((g - b) / np.maximum(d, 1e-6)) % 6, np.where(mx == g, (b - r) / np.maximum(d, 1e-6) + 2, (r - g) / np.maximum(d, 1e-6) + 4)) * 60
    return h, s, l


def write_manifest(s, art, geo):
    """manifest.json for src/paperdoll2: parts, items, per-direction anchors, dye references."""
    h, sat, l = hsl_pixels(Image.open(art / "base_head" / "S.png"))
    skin = (h < 50) & (sat > 0.1) & (sat < 0.8) & (l > 0.5)
    skin_ref = [float(np.median(h[skin])), float(np.median(sat[skin])), float(np.median(l[skin]))] if skin.any() else [25, 0.5, 0.8]
    blues = []
    for pid, p in s["parts"].items():
        f = art / pid / "S.png"
        if p["mask"] == "outfit" and f.exists():
            ph, ps, pl = hsl_pixels(Image.open(f))
            blues.append(pl[(ph > 185) & (ph < 255) & (ps > 0.22)])
    blues = np.concatenate(blues) if blues else np.array([0.45])
    parts = {
        "base_head": {"id": "base_head", "slot": "head", "skinnable": True},
        "base_body": {"id": "base_body", "slot": "body_base", "skinnable": True},
    }
    for pid, p in s["parts"].items():
        if (art / pid).exists():
            parts[pid] = {"id": pid, "slot": p["slot"], "label": p.get("label", pid), "class": p.get("class"),
                          "skinnable": p["mask"] == "outfit"}
    items = {}
    for iid, it in s.get("items", {}).items():
        meta = art / "items" / f"{iid}.json"
        if meta.exists():
            items[iid] = {**load_json(meta), "file": f"items/{iid}.png", "label": it.get("label", iid), "kind": it["kind"]}
    save_json(art / "manifest.json", {
        "version": 2, "cell": [CELL, CELL], "origin": list(ORIGIN), "label": s["label"],
        "geometry": geo, "parts": parts, "items": items,
        "dye": {"skinRef": skin_ref, "eyeBand": [185, 255], "cloth1Band": [185, 255],
                "cloth1L": float(np.median(blues)) if len(blues) else 0.45, "cloth2Band": [33, 60], "cloth2L": 0.6},
    })


def cmd_item(a):
    """One held item (weapon/shield): generate, cut, stand it upright, scale to its length."""
    s = load_set(a.set)
    it = s["items"][a.item]
    d = set_dir(a.set) / "items"
    d.mkdir(exist_ok=True)
    raw = d / f"{a.item}.png"
    if not raw.exists() or a.force:
        # retry with the next seed until QC passes: white background and exactly one object
        for seed in range(a.seed, a.seed + 4):
            print("item", a.item, seed, flush=True)
            img = call("txt2img", {
                "prompt": prompt(STYLE["lora"].replace(":1>", ":0.7>"), STYLE["quality"],
                                 "pixel art, no humans, object focus, single object, centered, white background, simple background",
                                 it["prompt"]),
                "negative_prompt": prompt(STYLE["negative"], "1girl, 1boy, hand, holding, multiple views, multiple, pair, "
                                          "two, stand, pedestal, display stand, rack, ground, table"),
                "seed": seed, "width": 1024, "height": 1024,
            }, d / f"{a.item}.json")
            fig = figure_mask(img)
            n = len(figures(fig, 0.004))
            ys, xs = np.nonzero(fig)
            (_, _), (rw, rh), _ = cv2.minAreaRect(np.stack([xs, ys], axis=1).astype(np.float32)) if len(xs) else ((0, 0), (1, 1), 0)
            thin = it["kind"] != "weapon" or max(rw, rh) / max(1, min(rw, rh)) > 2.5  # a weapon is one long thin shape
            ok = light_background(img) and n == 1 and thin
            print("  QC:", "ok" if ok else f"background light={light_background(img)}, objects={n}, thin={thin}", flush=True)
            if ok:
                break
        img.save(raw)
    img = Image.open(raw).convert("RGB")
    fig = figure_mask(img)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fig.astype(np.uint8), connectivity=8)
    if n < 2:
        sys.exit(f"item {a.item}: no object found in {raw.name}, try another --seed")
    fig = lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))  # keep the largest object only
    ys, xs = np.nonzero(fig)
    # principal axis -> rotate so the item's long side is vertical
    cov = np.cov(np.stack([xs - xs.mean(), ys - ys.mean()]))
    vx, vy = np.linalg.eigh(cov)[1][:, -1]
    angle = np.degrees(np.arctan2(vx, vy))
    rgba = np.dstack([np.asarray(img), fig.astype(np.uint8) * 255])
    rot = Image.fromarray(rgba, "RGBA").rotate(-angle, resample=Image.NEAREST, expand=True)
    rot = rot.crop(rot.getbbox())
    if rot.width > rot.height:
        rot = rot.rotate(90, expand=True)
    # upright: "wide" says where the widest row belongs (mace head / staff orb on top,
    # a sword's cross guard in the lower part, just above the grip)
    rows = (np.asarray(rot)[..., 3] > 0).sum(axis=1)
    widest_low = np.argmax(rows) > len(rows) / 2
    if it.get("wide", "top") != "any" and widest_low != (it.get("wide", "top") == "bottom"):
        rot = rot.rotate(180)
    scale = it["length"] / rot.height
    w, h = max(1, round(rot.width * scale)), it["length"]
    small = rot.resize((w, h), Image.BOX)
    arr = np.asarray(small).copy()
    arr[..., 3] = np.where(arr[..., 3] > 127, 255, 0)
    art = ROOT.parent / "art" / "paperdoll2" / a.set / "items"
    art.mkdir(parents=True, exist_ok=True)
    out = Image.fromarray(arr, "RGBA").quantize(32, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).convert("RGBA")
    out.putalpha(Image.fromarray(arr[..., 3]))
    out.save(art / f"{a.item}.png")
    grip = [round(w * it["grip"][0]), round(h * it["grip"][1])]
    save_json(art / f"{a.item}.json", {"grip": grip, "angle": it.get("angle", 0)})
    print(f"wrote items/{a.item}.png {w}x{h} grip {grip}")


def cell_xy(*box):
    return list(cell_box(box))


def cell_box(box):
    x0, y0, x1, y1 = box
    f = lambda x, y: (int((x - REF_W / 2) / BLOCK + ORIGIN[0]), int((y - FEET_Y) / BLOCK + ORIGIN[1]))
    (u0, v0), (u1, v1) = f(x0, y0), f(x1, y1)
    return u0, v0, u1, v1


def anchors(fig, g):
    """head = neck center; hands = outermost figure pixels at the arm-end row."""
    to = lambda x, y: [int((x - REF_W / 2) / BLOCK + ORIGIN[0]), int((y - FEET_Y) / BLOCK + ORIGIN[1])]
    x0, _, x1, _ = g["head"]
    y_hand = int(g["neck"] + 0.27 * g["H"])
    xs = np.nonzero(fig[y_hand])[0]
    left, right = (int(xs.min()), int(xs.max())) if len(xs) else (x0, x1)
    return {"head": to((x0 + x1) / 2, g["neck"]), "hand_left": to(left, y_hand), "hand_right": to(right, y_hand)}


def cmd_qc(a):
    d = set_dir(a.set)
    for f in sorted(d.glob("base/*.png")) + sorted(d.glob("parts/*/[SNW]*.png")):
        if not f.name.endswith("_mask.png"):
            print(f.relative_to(d).as_posix(), "; ".join(qc_view(Image.open(f))) or "ok")


def cmd_contact(a):
    d = set_dir(a.set)
    rows = []
    for p in sorted(d.rglob("*.png")):
        if p.name.endswith("_mask.png"):
            continue
        rel = p.relative_to(d).as_posix()
        rows.append(f'<figure><img src="{rel}" loading="lazy"><figcaption>{rel}</figcaption></figure>')
    art = ROOT.parent / "art" / "paperdoll2" / a.set
    cells = []
    if art.exists():
        for p in sorted(art.rglob("*.png")):
            rel = Path("../../../../art/paperdoll2") / a.set / p.relative_to(art)
            cells.append(f'<figure class="cell"><img src="{rel.as_posix()}"><figcaption>{p.relative_to(art).as_posix()}</figcaption></figure>')
    html = f"""<!doctype html><meta charset=utf-8><title>{a.set} contact sheet</title>
<style>body{{background:#2a2438;color:#eee;font:12px sans-serif}} section{{display:flex;flex-wrap:wrap;gap:8px}}
figure{{margin:0;background:#fff}} figure img{{height:260px;display:block}} figcaption{{color:#333;padding:2px 4px}}
.cell{{background:repeating-conic-gradient(#ccc 0 25%,#eee 0 50%) 0/16px 16px}} .cell img{{height:256px;image-rendering:pixelated}}</style>
<h2>Game cells (128px, shown 2x)</h2><section>{''.join(cells)}</section><h2>Generations</h2><section>{''.join(rows)}</section>"""
    (d / "contact.html").write_text(html, encoding="utf-8")
    print(f"wrote {(d / 'contact.html').relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("base"); b.add_argument("set"); b.add_argument("--seeds", type=int, nargs="+", required=True)
    b.add_argument("--dirs", nargs="+", choices=DIRS); b.add_argument("--ref", type=int)
    r = sub.add_parser("pick"); r.add_argument("set"); r.add_argument("--seed", type=int, required=True); r.add_argument("--dir", nargs="*")
    p = sub.add_parser("part"); p.add_argument("set"); p.add_argument("part"); p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--dirs", nargs="+", choices=DIRS)
    e = sub.add_parser("extract"); e.add_argument("set"); e.add_argument("--diff", type=int, default=60)
    c = sub.add_parser("contact"); c.add_argument("set")
    q = sub.add_parser("qc"); q.add_argument("set")
    i = sub.add_parser("item"); i.add_argument("set"); i.add_argument("item"); i.add_argument("--seed", type=int, default=-1)
    for x in (b, p, i):
        x.add_argument("--force", action="store_true")
    a = ap.parse_args()
    {"base": cmd_base, "pick": cmd_pick, "part": cmd_part, "extract": cmd_extract,
     "contact": cmd_contact, "item": cmd_item, "qc": cmd_qc}[a.cmd](a)


if __name__ == "__main__":
    main()
