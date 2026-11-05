"""Post-process raw generations into game-ready sprites.

Usage:  python process.py jobs/test_batch.json

For each raw image:  remove white background -> crop to the character -> map every pixel
to the shared palette -> downscale to true pixel size by majority vote per cell (a
"nearest-neighbor" that ignores anti-aliasing and the LoRA's misaligned fake pixels) ->
place on a fixed canvas (horizontally centered, feet on the baseline row) -> 1px outline.

All assets of one `group` (e.g. one character's directions/frames) share ONE scale factor
taken from the group's median height, so real size differences between frames survive
and QC can catch them.
"""
import argparse
import statistics
import sys

import numpy as np
from PIL import Image

from common import ROOT, load_job, load_json, load_palette, save_json

try:
    from rembg import new_session, remove  # optional: pip install rembg
except ImportError:
    remove = None
_rembg_session = None


def alpha_by_rembg(img):
    global _rembg_session
    if _rembg_session is None:
        _rembg_session = new_session("isnet-anime")
    return np.array(remove(img, session=_rembg_session, only_mask=True)) >= 128


def alpha_by_floodfill(rgb, tol):
    """Opaque = everything except near-white pixels connected to the image border."""
    white = (rgb >= 255 - tol).all(axis=2)
    bg = np.zeros_like(white)
    bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1] = white[0, :], white[-1, :], white[:, 0], white[:, -1]
    while True:  # grow the border seed through connected white pixels (4-connected)
        grown = bg.copy()
        grown[1:, :] |= bg[:-1, :]
        grown[:-1, :] |= bg[1:, :]
        grown[:, 1:] |= bg[:, :-1]
        grown[:, :-1] |= bg[:, 1:]
        grown &= white
        if (grown == bg).all():
            return ~bg
        bg = grown


def remove_background(img, cfg):
    mode = cfg["bg"]
    if mode == "rembg" or (mode == "auto" and remove is not None):
        if remove is None:
            sys.exit("bg=rembg but rembg is not installed (pip install rembg)")
        return alpha_by_rembg(img), "rembg:isnet-anime"
    return alpha_by_floodfill(np.array(img.convert("RGB")), cfg["white_tolerance"]), "floodfill-white"


def to_palette_index(rgb, palette):
    """Nearest palette index per pixel using the 'redmean' perceptual RGB distance."""
    pal = np.array(palette, dtype=np.float32)
    flat = rgb.reshape(-1, 3).astype(np.float32)
    out = np.empty(len(flat), dtype=np.int16)
    for s in range(0, len(flat), 65536):
        c = flat[s:s + 65536, None, :]
        rmean = (c[..., 0] + pal[None, :, 0]) / 2
        d = c - pal[None]
        dist = (2 + rmean / 256) * d[..., 0] ** 2 + 4 * d[..., 1] ** 2 + (2 + (255 - rmean) / 256) * d[..., 2] ** 2
        out[s:s + 65536] = dist.argmin(axis=1)
    return out.reshape(rgb.shape[:2])


def majority_downscale(idx, th, tw, n_colors):
    """idx: HxW palette indices, -1 = transparent. Each target cell takes its most common value."""
    h, w = idx.shape
    ys = np.linspace(0, h, th + 1).round().astype(int)
    xs = np.linspace(0, w, tw + 1).round().astype(int)
    out = np.full((th, tw), -1, dtype=np.int16)
    for y in range(th):
        for x in range(tw):
            block = idx[ys[y]:ys[y + 1], xs[x]:xs[x + 1]]
            out[y, x] = np.bincount(block.ravel() + 1, minlength=n_colors + 1).argmax() - 1
    return out


def add_outline(canvas, outline_index):
    """Transparent pixels 4-adjacent to the sprite become the outline color."""
    solid = canvas >= 0
    near = np.zeros_like(solid)
    near[1:, :] |= solid[:-1, :]
    near[:-1, :] |= solid[1:, :]
    near[:, 1:] |= solid[:, :-1]
    near[:, :-1] |= solid[:, 1:]
    canvas[near & ~solid] = outline_index
    return canvas


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1  # x0, y0, x1, y1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    args = ap.parse_args()

    job, preset, out_dir = load_job(args.job)
    cfg = preset["process"]
    palette = load_palette()
    cw, ch = cfg["canvas"]
    margin = 1 if cfg["outline"] else 0
    raw_dir, proc_dir = out_dir / "raw", out_dir / "processed"
    proc_dir.mkdir(parents=True, exist_ok=True)

    # pass 1: alpha + bbox for every raw image
    items = []
    for asset in job["assets"]:
        png = raw_dir / f"{asset['id']}.png"
        if not png.exists():
            print(f"missing raw {png.name}, skipped")
            continue
        img = Image.open(png).convert("RGB")
        alpha, bg_method = remove_background(img, cfg)
        if not alpha.any():
            print(f"{asset['id']}: background removal left nothing, skipped")
            continue
        items.append({"asset": asset, "img": img, "alpha": alpha, "bbox": bbox(alpha), "bg": bg_method})

    # one scale per group, from the group's median character height
    heights = {}
    for it in items:
        heights.setdefault(it["asset"].get("group", it["asset"]["id"]), []).append(it["bbox"][3] - it["bbox"][1])
    group_scale = {g: cfg["sprite_height"] / statistics.median(h) for g, h in heights.items()}

    # pass 2: palette-map, downscale, place, outline, save
    for it in items:
        asset = it["asset"]
        x0, y0, x1, y1 = it["bbox"]
        scale = group_scale[asset.get("group", asset["id"])]
        tw, th = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
        fit = min(1.0, (cw - 2 * margin) / tw, (cfg["baseline"] + 1 - margin) / th)  # never crop
        tw, th = max(1, int(tw * fit)), max(1, int(th * fit))

        rgb = np.array(it["img"])[y0:y1, x0:x1]
        idx = to_palette_index(rgb, palette)
        idx[~it["alpha"][y0:y1, x0:x1]] = -1
        small = majority_downscale(idx, th, tw, len(palette))

        canvas = np.full((ch, cw), -1, dtype=np.int16)
        left = (cw - tw) // 2
        top = cfg["baseline"] + 1 - th
        canvas[top:top + th, left:left + tw] = small
        if cfg["outline"]:
            canvas = add_outline(canvas, 0)

        pal = np.array(palette, dtype=np.uint8)
        rgba = np.zeros((ch, cw, 4), dtype=np.uint8)
        solid = canvas >= 0
        rgba[solid, :3] = pal[canvas[solid]]
        rgba[solid, 3] = 255
        Image.fromarray(rgba, "RGBA").save(proc_dir / f"{asset['id']}.png")

        meta_path = raw_dir / f"{asset['id']}.json"
        meta = load_json(meta_path) if meta_path.exists() else {"asset": asset}
        meta["process"] = {**cfg, "bg_method": it["bg"], "raw_bbox": it["bbox"],
                           "group_scale": round(scale, 5), "fit": round(fit, 4), "sprite_size": [tw, th]}
        save_json(proc_dir / f"{asset['id']}.json", meta)
        print(f"{asset['id']}: {tw}x{th} px ({it['bg']})")
    print(f"done -> {proc_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
