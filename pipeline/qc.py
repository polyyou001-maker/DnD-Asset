"""Automated quality control + HTML contact sheet for processed sprites.

Usage:  python qc.py jobs/test_batch.json

Writes out/<job>/qc_report.json and out/<job>/report.html. Open the HTML, tick/untick
assets and press "Export approvals" to save approvals.json.

Per asset: canvas size, edge contact (cropped sprite), near-blank, binary alpha, palette
membership + color count, stray pixel islands, white halo on the inner edge.
Per group (same character): foot baseline, height and horizontal center consistency.
Whole batch: near-duplicate detection (e.g. the model ignored the direction prompt).
"""
import argparse
import base64
import html
import io
import json
import statistics
from collections import deque

import numpy as np
from PIL import Image

from common import ROOT, load_job, load_json, load_palette, save_json

FAIL, WARN = "fail", "warn"


def components(mask):
    """Sizes of 8-connected components of a small boolean mask."""
    seen = np.zeros_like(mask)
    sizes = []
    h, w = mask.shape
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        seen[y, x] = True
        q, n = deque([(y, x)]), 0
        while q:
            cy, cx = q.popleft()
            n += 1
            for ny in (cy - 1, cy, cy + 1):
                for nx in (cx - 1, cx, cx + 1):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
        sizes.append(n)
    return sorted(sizes, reverse=True)


def check_asset(rgba, cfg, qc, palette):
    issues, stats = [], {}
    h, w = rgba.shape[:2]
    a = rgba[..., 3]
    solid = a > 0

    if [w, h] != list(cfg["canvas"]):
        issues.append((FAIL, f"canvas {w}x{h}, expected {cfg['canvas'][0]}x{cfg['canvas'][1]}"))
    fill = solid.mean()
    stats["fill"] = round(float(fill), 3)
    if fill < qc["min_fill"]:
        issues.append((FAIL, f"near-blank: only {fill:.1%} opaque"))
        return issues, stats
    ys, xs = np.nonzero(solid)
    stats.update(bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                 baseline=int(ys.max()), height=int(ys.max() - ys.min() + 1),
                 center_x=round(float(xs.min() + xs.max() + 1) / 2, 1))
    if ys.min() == 0 or xs.min() == 0 or xs.max() == w - 1 or ys.max() == h - 1:
        issues.append((FAIL, "sprite touches the canvas edge (cropped?)"))

    partial = int(((a > 0) & (a < 255)).sum())
    if partial:
        issues.append((FAIL, f"{partial} semi-transparent pixels (alpha must be 0/255)"))

    colors = {tuple(c) for c in rgba[solid][:, :3].tolist()}
    off = colors - set(palette)
    stats["colors"] = len(colors)
    if off:
        issues.append((FAIL, f"{len(off)} colors not in the game palette"))
    if len(colors) > qc["max_colors"]:
        issues.append((WARN, f"{len(colors)} colors (max {qc['max_colors']})"))

    rgb = rgba[..., :3].astype(int)
    is_outline = solid & (rgb == palette[0]).all(axis=2)
    # islands are counted without the outer outline ring, which would inflate a 1px speck to 5px
    clear = ~solid
    touches_clear = np.zeros_like(solid)
    touches_clear[1:, :] |= clear[:-1, :]
    touches_clear[:-1, :] |= clear[1:, :]
    touches_clear[:, 1:] |= clear[:, :-1]
    touches_clear[:, :-1] |= clear[:, 1:]
    core = solid & ~(is_outline & touches_clear)
    sizes = components(core)
    stray = [s for s in sizes[1:] if s <= qc["stray_max_px"]]
    if stray:
        issues.append((FAIL, f"{len(stray)} stray pixel islands"))
    elif len(sizes) > 1:
        issues.append((WARN, f"{len(sizes) - 1} detached parts (sizes {sizes[1:6]})"))

    # inner ring = opaque, non-outline pixels next to the outline/transparency
    edge = np.zeros_like(solid)
    border = ~solid | is_outline
    edge[1:, :] |= border[:-1, :]
    edge[:-1, :] |= border[1:, :]
    edge[:, 1:] |= border[:, :-1]
    edge[:, :-1] |= border[:, 1:]
    ring = edge & solid & ~is_outline
    if ring.any():
        whiteish = (rgb[ring] >= 225).all(axis=1).mean()
        stats["halo"] = round(float(whiteish), 3)
        if whiteish > qc["halo_max_ratio"]:
            issues.append((WARN, f"possible white halo: {whiteish:.0%} of the inner edge is near-white"))
    return issues, stats


def similarity(a, b):
    """Share of the opaque union where both images have the same RGBA."""
    if a.shape != b.shape:
        return 0.0
    union = (a[..., 3] > 0) | (b[..., 3] > 0)
    if not union.any():
        return 1.0
    return float((a[union] == b[union]).all(axis=1).mean())


def png_b64(img, scale=1):
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    args = ap.parse_args()
    job, preset, out_dir = load_job(args.job)
    cfg, qc = preset["process"], preset["qc"]
    palette = load_palette()
    proc_dir, raw_dir = out_dir / "processed", out_dir / "raw"

    results, images = [], {}
    for asset in job["assets"]:
        png = proc_dir / f"{asset['id']}.png"
        r = {"id": asset["id"], "group": asset.get("group", asset["id"]),
             "direction": asset.get("direction", ""), "issues": [], "stats": {}}
        if not png.exists():
            r["issues"].append((FAIL, "no processed image (raw missing, or blank after background removal)"))
        else:
            images[asset["id"]] = np.array(Image.open(png).convert("RGBA"))
            r["issues"], r["stats"] = check_asset(images[asset["id"]], cfg, qc, palette)
            meta = load_json(proc_dir / f"{asset['id']}.json")
            x0, y0, x1, y1 = meta["process"]["raw_bbox"]
            if x0 == 0 or y0 == 0 or x1 == preset["width"] or y1 == preset["height"]:
                r["issues"].append((FAIL, "character touches the raw image edge (cut off by the model)"))
        results.append(r)

    # group consistency
    by_group = {}
    for r in results:
        if "baseline" in r["stats"]:
            by_group.setdefault(r["group"], []).append(r)
    for members in by_group.values():
        if len(members) < 2:
            continue
        mb = statistics.median(m["stats"]["baseline"] for m in members)
        mh = statistics.median(m["stats"]["height"] for m in members)
        mc = statistics.median(m["stats"]["center_x"] for m in members)
        for m in members:
            s = m["stats"]
            if abs(s["baseline"] - mb) > qc["baseline_tol"]:
                m["issues"].append((FAIL, f"foot baseline y={s['baseline']}, group median {mb:g}"))
            if abs(s["height"] - mh) / mh > qc["height_tol"]:
                m["issues"].append((WARN, f"height {s['height']}px vs group median {mh:g}px"))
            if abs(s["center_x"] - mc) > qc["center_tol"]:
                m["issues"].append((WARN, f"center x={s['center_x']} vs group median {mc:g}"))

    # near-duplicates across the batch
    ids = list(images)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            sim = similarity(images[a], images[b])
            if sim >= qc["duplicate_sim"]:
                for r in results:
                    if r["id"] in (a, b):
                        r["issues"].append((FAIL, f"near-duplicate of {b if r['id'] == a else a} ({sim:.0%})"))

    for r in results:
        levels = {lvl for lvl, _ in r["issues"]}
        r["status"] = FAIL if FAIL in levels else WARN if WARN in levels else "pass"
        r["issues"] = [{"level": lvl, "msg": msg} for lvl, msg in r["issues"]]
    save_json(out_dir / "qc_report.json", results)

    counts = {s: sum(r["status"] == s for r in results) for s in ("pass", WARN, FAIL)}
    print(f"QC: {counts['pass']} pass, {counts[WARN]} warn, {counts[FAIL]} fail")
    write_html(out_dir, job, results, proc_dir, raw_dir, counts)
    print(f"report -> {(out_dir / 'report.html').relative_to(ROOT)}")


def write_html(out_dir, job, results, proc_dir, raw_dir, counts):
    cards_by_group = {}
    for r in results:
        aid = r["id"]
        meta_path = proc_dir / f"{aid}.json"
        meta = load_json(meta_path) if meta_path.exists() else {}
        sprite = proc_dir / f"{aid}.png"
        raw = raw_dir / f"{aid}.png"
        sprite_tag = f'<img class="px" src="data:image/png;base64,{png_b64(Image.open(sprite), 4)}">' if sprite.exists() else '<div class="none">none</div>'
        raw_tag = ""
        if raw.exists():
            thumb = Image.open(raw).convert("RGB")
            thumb.thumbnail((256, 256))
            raw_tag = f'<img class="raw" src="data:image/png;base64,{png_b64(thumb)}">'
        issues = "".join(f'<li class="{i["level"]}">{html.escape(i["msg"])}</li>' for i in r["issues"]) or '<li class="ok">all checks passed</li>'
        payload = meta.get("payload", {})
        details = html.escape(json.dumps({"seed": meta.get("seed"), "prompt": payload.get("prompt"),
                                          "negative": payload.get("negative_prompt"),
                                          "stats": r["stats"], "process": meta.get("process")}, indent=1))
        checked = "checked" if r["status"] != FAIL else ""
        cards_by_group.setdefault(r["group"], []).append(f"""
<div class="card {r['status']}">
  <div class="head"><b>{html.escape(aid)}</b><span class="badge">{r['status']}</span></div>
  <div class="imgs"><div class="checker">{sprite_tag}</div>{raw_tag}</div>
  <ul>{issues}</ul>
  <label><input type="checkbox" data-id="{html.escape(aid)}" {checked}> approve</label>
  <details><summary>metadata</summary><pre>{details}</pre></details>
</div>""")
    groups = "".join(f'<h2>{html.escape(g)}</h2><div class="grid">{"".join(c)}</div>' for g, c in cards_by_group.items())
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC {html.escape(job['name'])}</title><style>
:root{{--bg:#f6f5f7;--card:#fff;--fg:#222;--muted:#666;--pass:#2e8b57;--warn:#c88a00;--fail:#c0303a;--line:#ddd}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16141a;--card:#221f27;--fg:#eee;--muted:#aaa;--line:#3a3640}}}}
body{{background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif;margin:0;padding:16px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}
.card{{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--pass);border-radius:6px;padding:10px}}
.card.warn{{border-left-color:var(--warn)}} .card.fail{{border-left-color:var(--fail)}}
.head{{display:flex;justify-content:space-between}} .badge{{text-transform:uppercase;font-size:12px;color:var(--muted)}}
.imgs{{display:flex;gap:8px;align-items:flex-end;margin:8px 0}}
.checker{{background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/16px 16px;line-height:0}}
.px{{image-rendering:pixelated;display:block}} .raw{{width:128px;border:1px solid var(--line)}}
ul{{margin:4px 0;padding-left:18px}} li.fail{{color:var(--fail)}} li.warn{{color:var(--warn)}} li.ok{{color:var(--pass)}}
pre{{white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto}}
.bar{{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}}
button{{padding:6px 12px}}
</style></head><body>
<div class="bar"><b>{html.escape(job['name'])}</b> <span>pass {counts['pass']} · warn {counts[WARN]} · fail {counts[FAIL]}</span>
<button onclick="exportApprovals()">Export approvals</button></div>
{groups}
<script>
function exportApprovals(){{
  const out={{approved:[],rejected:[]}};
  document.querySelectorAll('input[data-id]').forEach(c=>out[c.checked?'approved':'rejected'].push(c.dataset.id));
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{{type:'application/json'}}));
  a.download='approvals.json';a.click();
}}
</script></body></html>"""
    (out_dir / "report.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
