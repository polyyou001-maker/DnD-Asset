"""Render depth guides of a 3D chibi mannequin, one per drawn direction.

Usage:  python mannequin3d.py   -> out/v2/guides/depth_<dir>.png (+ depth_contact.png)

The 2D outline guides are symmetric front-to-back, so the Elin LoCon (front views only)
turned every back view toward the camera. A depth map carries the cues an outline lacks:
nose and toes point at the camera in front views and away in back views, the back of the
head and the buttocks bulge on the far side. Same frame as guides.VIEW (feet line, height).

The body is a signed distance field (smooth union of ellipsoids/capsules) rendered with
an orthographic sphere tracer. Body units: height 1.0, feet at y=0, +z = facing forward.
"""
import numpy as np
from PIL import Image

from common import ROOT
from guides import VIEW

YAW = {"S": 0, "SW": 45, "W": 90, "NW": 135, "N": 180}  # degrees the body turns to face left


def ellipsoid(p, c, r):
    q = (p - c) / r
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / r, axis=-1)
    return k0 * (k0 - 1) / np.maximum(k1, 1e-6)


def capsule(p, a, b, r):
    pa, ba = p - a, b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0, 1)
    return np.linalg.norm(pa - h[:, None] * ba, axis=-1) - r


def smin(a, b, k=0.02):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def V(*v):
    return np.array(v, dtype=np.float64)


def body(p):
    """Chibi proportions matching guides.draw_mannequin: head 0.37, torso 0.27, legs the rest."""
    d = ellipsoid(p, V(0, 0.815, 0), V(0.192, 0.185, 0.170))           # head
    d = smin(d, ellipsoid(p, V(0, 0.80, -0.045), V(0.165, 0.15, 0.15)), 0.03)  # back of the skull
    d = smin(d, ellipsoid(p, V(0, 0.75, 0.155), V(0.02, 0.022, 0.03)), 0.01)   # nose
    d = smin(d, ellipsoid(p, V(0, 0.705, 0.12), V(0.07, 0.03, 0.04)), 0.02)    # chin
    for s in (-1, 1):
        d = smin(d, ellipsoid(p, V(s * 0.185, 0.78, -0.01), V(0.025, 0.045, 0.03)), 0.01)  # ears
    d = smin(d, capsule(p, V(0, 0.60, 0), V(0, 0.66, 0), 0.045), 0.02)          # neck
    d = smin(d, ellipsoid(p, V(0, 0.52, 0), V(0.165, 0.10, 0.095)), 0.04)       # chest
    d = smin(d, ellipsoid(p, V(0, 0.53, 0.04), V(0.13, 0.06, 0.07)), 0.03)      # front of the chest
    d = smin(d, ellipsoid(p, V(0, 0.41, 0), V(0.15, 0.075, 0.095)), 0.04)       # pelvis
    for s in (-1, 1):
        d = smin(d, ellipsoid(p, V(s * 0.06, 0.38, -0.065), V(0.065, 0.06, 0.05)), 0.03)  # buttocks
        d = smin(d, capsule(p, V(s * 0.06, 0.37, 0), V(s * 0.06, 0.05, 0), 0.052), 0.02)    # leg
        d = smin(d, capsule(p, V(s * 0.06, 0.035, -0.035), V(s * 0.065, 0.03, 0.085), 0.037), 0.02)  # foot, toes forward
        d = smin(d, capsule(p, V(s * 0.16, 0.595, 0), V(s * 0.205, 0.37, 0.01), 0.042), 0.04)    # arm
        d = smin(d, ellipsoid(p, V(s * 0.208, 0.345, 0.015), V(0.04, 0.05, 0.045)), 0.02)   # hand
    return d


def render(direction, scale=2):
    """Orthographic depth, near = white. Rendered at 1/scale and upsampled (depth is smooth)."""
    W, H = VIEW["size"]
    w, h = W // scale, H // scale
    cols, rows = np.meshgrid(np.arange(w) * scale + scale / 2, np.arange(h) * scale + scale / 2)
    x = (cols - W / 2) / VIEW["height"]
    y = (VIEW["feet_y"] - rows) / VIEW["height"]
    keep = (np.abs(x) < 0.4) & (y > -0.05) & (y < 1.05)
    t = np.radians(YAW[direction])
    # world -> body: inverse of the yaw that maps body forward (0,0,1) to (-sin t, 0, cos t)
    rot = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    o = np.stack([x[keep], y[keep], np.full(keep.sum(), 0.6)], axis=-1)
    z = np.zeros(len(o))
    hit = np.zeros(len(o), bool)
    alive = np.ones(len(o), bool)
    for _ in range(96):
        idx = np.nonzero(alive)[0]
        if not len(idx):
            break
        p = o[idx].copy()
        p[:, 2] -= z[idx]
        dist = body(p @ rot)
        z[idx] += dist * 0.9
        hit[idx[dist < 5e-4]] = True
        alive[idx[(dist < 5e-4) | (z[idx] > 1.2)]] = False
    depth = np.zeros((h, w))
    zz = np.where(hit, z, np.nan)
    near, far = np.nanmin(zz), np.nanmax(zz)
    vals = np.where(hit, 255 - (zz - near) / (far - near) * 200, 0)  # body 55..255, background 0
    depth[keep] = vals
    img = Image.fromarray(depth.astype(np.uint8)).resize((W, H), Image.BILINEAR)
    return img.convert("RGB")


def main():
    out = ROOT / "out" / "v2" / "guides"
    out.mkdir(parents=True, exist_ok=True)
    imgs = []
    for d in YAW:
        img = render(d)
        img.save(out / f"depth_{d}.png")
        imgs.append(img.resize((208, 304)))
        print("wrote depth", d, flush=True)
    sheet = Image.new("RGB", (208 * len(imgs), 304))
    for i, im in enumerate(imgs):
        sheet.paste(im, (208 * i, 0))
    sheet.save(out / "depth_contact.png")


if __name__ == "__main__":
    main()
