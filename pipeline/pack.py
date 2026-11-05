"""Pack paper-doll source cells (art/paperdoll/) into sprite sheets + manifest.json.

Usage:  python pack.py [--src ../art/paperdoll] [--out ../assets/paperdoll]

Source layout (see docs/specs/character-dressing.md, "Asset pipeline hook"):
  _set.json                          global manifest fields (anims, layerOrder, ramps, dyes, ...)
  <part_id>/part.json                the part's manifest entry (without sheet/anchors)
  <part_id>/anchors.json             bodies only: anchors[anim][dir][frame]
  <part_id>/<anim>_<dir>_<frame>.png animated   |  <row>_<dir>.png static  |  <frame>.png effect
Every cell must be exactly the cell size, binary alpha, colors from palette.hex.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from common import ROOT, load_json, load_palette, save_json


def load_cell(path, cell, palette, errors):
    if not path.exists():
        errors.append(f"missing {path.relative_to(path.parents[1])}")
        return None
    img = Image.open(path).convert("RGBA")
    if list(img.size) != cell:
        errors.append(f"{path.name}: size {img.size}, expected {cell}")
        return None
    a = np.array(img)
    alpha = a[..., 3]
    if ((alpha > 0) & (alpha < 255)).any():
        errors.append(f"{path.parent.name}/{path.name}: semi-transparent pixels")
    off = {tuple(c) for c in a[alpha > 0][:, :3].tolist()} - palette
    if off:
        errors.append(f"{path.parent.name}/{path.name}: {len(off)} colors not in palette")
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT.parent / "art" / "paperdoll"))
    ap.add_argument("--out", default=str(ROOT.parent / "assets" / "paperdoll"))
    args = ap.parse_args()
    src, out = Path(args.src), Path(args.out)
    (out / "parts").mkdir(parents=True, exist_ok=True)

    manifest = load_json(src / "_set.json")
    cell, drawn, anims = manifest["cell"], manifest["drawn"], manifest["anims"]
    cw, ch = cell
    palette = set(load_palette())
    errors, parts = [], {}

    for part_dir in sorted(p for p in src.iterdir() if p.is_dir()):
        pid = part_dir.name
        part = load_json(part_dir / "part.json")
        kind = part["kind"]
        if kind == "animated":
            cols, rows = max(a["frames"] for a in anims.values()), len(anims) * len(drawn)
            cells = [((f, ai * len(drawn) + di), part_dir / f"{anim}_{d}_{f}.png")
                     for ai, (anim, a) in enumerate(anims.items())
                     for di, d in enumerate(drawn) for f in range(a["frames"])]
            anchors_path = part_dir / "anchors.json"
            part["anchors"] = load_json(anchors_path) if anchors_path.exists() else {}
            for anim, a in anims.items():
                for d in drawn:
                    if len(part["anchors"].get(anim, {}).get(d, [])) != a["frames"]:
                        errors.append(f"{pid}: anchors for {anim}/{d} must have {a['frames']} frames")
        elif kind == "static":
            cols, rows = len(drawn), max(p["row"] for p in part["pieces"]) + 1
            cells = [((di, r), part_dir / f"{r}_{d}.png") for r in range(rows) for di, d in enumerate(drawn)]
            missing = [d for d in drawn if d not in part.get("pivot", {})]
            if missing:
                errors.append(f"{pid}: pivot missing for {missing}")
        elif kind == "effect":
            cols, rows = part["frames"], 1
            cells = [((f, 0), part_dir / f"{f}.png") for f in range(cols)]
        else:
            errors.append(f"{pid}: unknown kind {kind}")
            continue

        sheet = Image.new("RGBA", (cols * cw, rows * ch), (0, 0, 0, 0))
        for (cx, cy), path in cells:
            img = load_cell(path, cell, palette, errors)
            if img is not None:
                sheet.paste(img, (cx * cw, cy * ch))
        sheet.save(out / "parts" / f"{pid}.png")
        part["sheet"] = f"parts/{pid}.png"
        parts[pid] = part

    if errors:
        print("\n".join(errors))
        sys.exit(f"pack failed: {len(errors)} problems")
    manifest["parts"] = parts
    save_json(out / "manifest.json", manifest)
    print(f"packed {len(parts)} parts -> {out}")


if __name__ == "__main__":
    main()
