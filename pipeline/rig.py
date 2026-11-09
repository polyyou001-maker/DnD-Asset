"""Posable 3D chibi mannequin: skeleton + SDF body, depth guides and 2D joints per frame.

Usage:
  python rig.py preview <body>          -> out/bodies/<body>/rig_preview.png (all poses, 5 dirs)
  python rig.py guides  <body> [states] -> out/bodies/<body>/guides/<state>_<dir>_<pair>.png + joints.json

Units are game pixels: feet on y = 0, +y up, +z = the body's forward, +x = the body's left.
Guides are rendered at 10 generation px per game px, two frames per 1216×1216 image
(one per half), the layout bodies.py generates against (spec: docs/specs/body-animation.md).
"""
import json
import math
import sys
from dataclasses import dataclass

import numpy as np
from PIL import Image

from common import ROOT
from mannequin3d import capsule, ellipsoid, smin, V

DIRS = ["S", "SW", "W", "NW", "N"]
YAW = {"S": 0, "SW": 45, "W": 90, "NW": 135, "N": 180}
SCALE = 10                 # generation px per rig px (body sizes in the table below)
GRID = 8                   # the LoCon draws on an 8 px grid: one sprite px, in generation px
PAIR = (1216, 1216)        # one generation image = two frames side by side
HALF = PAIR[0] // 2
FEET_Y = 1150              # feet line in the generation image
CELL, CELL_FEET = 160, (80, 152)
CELL_ORIGIN = (CELL_FEET[0] - HALF // GRID // 2, CELL_FEET[1] - (FEET_Y // GRID))  # art grid -> cell


@dataclass(frozen=True)
class Body:
    height: float           # game px, feet to top of the head
    heads: float            # height / head height
    shoulders: float        # shoulder width, px
    width: float = 1.0      # torso / hip girth factor
    limb: float = 1.0       # arm and leg thickness factor
    hand: float = 1.0
    foot: float = 1.0
    neck: float = 2.0
    head_round: float = 1.0  # >1 rounder (halfling), <1 longer/sharper (elf)
    ear: float = 0.0        # how far a long ear reaches past the head, px (elf)
    arm_out: float = 0.0    # extra arm abduction, degrees: keeps the swinging hand off the crotch

    @property
    def head_h(self): return self.height / self.heads
    @property
    def torso_h(self): return self.height * 0.27
    @property
    def leg_len(self): return self.height - self.head_h - self.neck - self.torso_h


BODIES = {
    "human": Body(96, 3.0, 26, arm_out=6),
    "elf": Body(98, 3.0, 24, width=0.9, limb=0.9, neck=3.5, head_round=0.94, ear=9.0, arm_out=6),
    "dwarf": Body(80, 2.5, 32, width=1.3, limb=1.3, hand=1.45, foot=1.3, neck=1.0),
    "halfling": Body(74, 2.5, 22, width=0.95, limb=0.95, foot=1.45, head_round=1.08),
}


@dataclass(frozen=True)
class Pose:
    """Joint angles in degrees. Thigh/shoulder positive = forward; knee/elbow positive = bent."""
    thigh: tuple = (0, 0)      # (left, right)
    knee: tuple = (2, 2)
    shoulder: tuple = (0, 0)
    elbow: tuple = (10, 10)
    abduct: float = 9          # arms away from the body
    lean: float = 0            # upper body forward
    breathe: float = 0         # 0..1: chest and shoulders rise 1 px
    bob: float = 0             # extra pelvis offset (px) on top of the solved ground contact
    roll: float = 0            # falls over in the picture plane, head toward +x (same in every direction)


# Walk (spec table): left leg; the right leg is the same 3 frames later; arms opposite.
WALK_THIGH = [25, 12, -5, -22, -12, 10]
WALK_KNEE = [4, 18, 6, 10, 38, 48]


def walk_pose(i):
    j = (i + 3) % 6
    tl, tr = WALK_THIGH[i], WALK_THIGH[j]
    return Pose(thigh=(tl, tr), knee=(WALK_KNEE[i], WALK_KNEE[j]),
                shoulder=(-0.8 * tl, -0.8 * tr), elbow=(15 + max(0, -0.8 * tl), 15 + max(0, -0.8 * tr)),
                abduct=7, lean=3)


# Run (spec table): longer stride, knees high, arms bent; both feet leave the ground on passing.
RUN_THIGH = [38, 18, -10, -34, -20, 14]
RUN_KNEE = [8, 32, 14, 24, 70, 85]
RUN_BOB = [0, 0, 2, 0, 0, 2]


def run_pose(i):
    j = (i + 3) % 6
    tl, tr = RUN_THIGH[i], RUN_THIGH[j]
    return Pose(thigh=(tl, tr), knee=(RUN_KNEE[i], RUN_KNEE[j]), shoulder=(-0.9 * tl, -0.9 * tr),
                elbow=(70, 70), abduct=8, lean=9, bob=RUN_BOB[i])


IDLE_BREATH = [0, 0.5, 1, 0.5]
POSES = {
    "idle": [Pose(breathe=b, shoulder=(2 * b, 2 * b), elbow=(10 + 2 * b, 10 + 2 * b)) for b in IDLE_BREATH],
    "walk": [walk_pose(i) for i in range(6)],
    "run": [run_pose(i) for i in range(6)],
    # Attacks strike with the right arm (index 1), the weapon hand: wind-up, swing, impact, recover.
    "attack_slash": [
        Pose(thigh=(14, -8), knee=(8, 6), shoulder=(-10, 140), elbow=(25, 50), abduct=12, lean=-6),
        Pose(thigh=(18, -10), knee=(12, 6), shoulder=(-5, 100), elbow=(25, 20), abduct=12, lean=5),
        Pose(thigh=(24, -14), knee=(20, 6), shoulder=(-18, 45), elbow=(25, 15), abduct=12, lean=12),
        Pose(thigh=(14, -8), knee=(10, 6), shoulder=(-8, 20), elbow=(20, 20), abduct=10, lean=4),
    ],
    "attack_smash": [
        Pose(thigh=(10, -6), knee=(25, 25), shoulder=(10, 120), elbow=(25, 70), abduct=12, lean=8),
        Pose(thigh=(10, -6), knee=(6, 6), shoulder=(-10, 178), elbow=(20, 5), abduct=12, lean=-10),
        Pose(thigh=(16, -10), knee=(30, 30), shoulder=(-20, 55), elbow=(25, 5), abduct=12, lean=20),
        Pose(thigh=(12, -8), knee=(12, 12), shoulder=(-8, 30), elbow=(20, 15), abduct=10, lean=8),
    ],
    "attack_stab": [
        Pose(thigh=(8, -8), knee=(8, 6), shoulder=(20, -30), elbow=(30, 100), abduct=10, lean=-4),
        Pose(thigh=(12, -10), knee=(12, 6), shoulder=(15, -10), elbow=(30, 95), abduct=10, lean=4),
        Pose(thigh=(30, -22), knee=(28, 6), shoulder=(-25, 88), elbow=(30, 2), abduct=10, lean=16),
        Pose(thigh=(12, -8), knee=(10, 6), shoulder=(-5, 35), elbow=(20, 30), abduct=10, lean=6),
    ],
    "attack_cast": [
        Pose(shoulder=(50, 50), elbow=(70, 70), abduct=14),
        Pose(thigh=(4, -4), shoulder=(40, 130), elbow=(60, 30), abduct=14, lean=-4),
        Pose(thigh=(12, -8), knee=(10, 6), shoulder=(95, 95), elbow=(5, 5), abduct=14, lean=8),
        Pose(thigh=(6, -4), shoulder=(30, 40), elbow=(30, 30), abduct=12, lean=2),
    ],
    "hit": [
        Pose(thigh=(-4, 8), knee=(10, 14), shoulder=(-20, -20), elbow=(30, 30), abduct=16, lean=-12),
        Pose(thigh=(-2, 4), knee=(6, 8), shoulder=(-8, -8), elbow=(20, 20), abduct=12, lean=-5),
    ],
    "dead": [
        Pose(thigh=(30, 25), knee=(45, 40), shoulder=(10, 10), elbow=(25, 25), abduct=14, lean=18),
        Pose(thigh=(18, 10), knee=(30, 18), shoulder=(-15, 25), elbow=(30, 30), abduct=20, roll=52),
        Pose(thigh=(8, -4), knee=(12, 8), shoulder=(20, -10), elbow=(15, 20), abduct=25, roll=90),
    ],
}
FIT_MARGIN = 66  # canvas px from the last joint to the half edge: 34 of limb, the rest free
WIDE = ("dead",)  # a falling body does not fit half an image: these get one frame per image


def rot_x(p, deg, about):
    """Rotate point(s) in the y-z plane (pitch) around `about`; positive tips +y toward +z."""
    a = math.radians(deg)
    q = np.asarray(p, float) - about
    y, z = q[..., 1], q[..., 2]
    out = q.copy()
    out[..., 1] = y * math.cos(a) - z * math.sin(a)
    out[..., 2] = y * math.sin(a) + z * math.cos(a)
    return out + about


def limb(start, angle_deg, length, side=0.0, abduct_deg=0.0):
    """End point of a bone hanging down from `start`, swung forward by angle, out by abduct."""
    a, b = math.radians(angle_deg), math.radians(abduct_deg)
    d = np.array([side * math.sin(b), -math.cos(a) * math.cos(b), math.sin(a) * math.cos(b)])
    return np.asarray(start, float) + d * length


def skeleton(body: Body, pose: Pose):
    """Joint positions (game px, body space) with the lowest foot on y = 0."""
    leg = body.leg_len
    ankle_h = 3.0 * body.foot ** 0.5
    thigh_len = shin_len = (leg - ankle_h) / 2
    hip_x = 5.6 * body.width
    j = {}
    pelvis = np.array([0.0, leg, 0.0])
    for s, k in ((1, 0), (-1, 1)):  # +x = left
        n = "L" if s > 0 else "R"
        hip = pelvis + [s * hip_x, 0, 0]
        knee = limb(hip, pose.thigh[k], thigh_len)
        ankle = limb(knee, pose.thigh[k] - pose.knee[k], shin_len)
        j[f"hip_{n}"], j[f"knee_{n}"], j[f"ankle_{n}"] = hip, knee, ankle
        # foot points forward, flat when standing; it follows the shin a little when lifted
        pitch = max(0.0, (pose.knee[k] - 10) * 0.6)
        j[f"toe_{n}"] = ankle + np.array([0, -math.sin(math.radians(pitch)) * 6, math.cos(math.radians(pitch)) * 6.5 * body.foot])
    # ground contact: lift the whole body so the lowest foot point touches y = 0
    foot_r = 2.6 * body.foot
    low = min(min(j[f"ankle_{n}"][1], j[f"toe_{n}"][1]) for n in "LR") - foot_r
    lift = -low + pose.bob
    for k in j:
        j[k] = j[k] + [0, lift, 0]
    pelvis = pelvis + [0, lift, 0]
    j["pelvis"] = pelvis

    up = 0.9 * pose.breathe  # breathing raises everything above the waist
    chest = pelvis + [0, body.torso_h * 0.62 + up, 0]
    neck = pelvis + [0, body.torso_h + up, 0]
    head = neck + [0, body.neck + body.head_h * 0.5, 0]
    sh_y = neck[1] - 3.2
    upper = {"chest": chest, "neck": neck, "head": head}
    for s, k in ((1, 0), (-1, 1)):
        n = "L" if s > 0 else "R"
        upper[f"shoulder_{n}"] = np.array([s * (body.shoulders / 2 - 3.5 * body.limb), sh_y, 0])
    # lean the whole upper body forward around the pelvis
    for k, p in upper.items():
        j[k] = rot_x(p, pose.lean, pelvis)
    arm_up, arm_fore = body.torso_h * 0.47, body.torso_h * 0.4
    for s, k in ((1, 0), (-1, 1)):
        n = "L" if s > 0 else "R"
        sh = j[f"shoulder_{n}"]
        el = limb(sh, pose.shoulder[k] + pose.lean, arm_up, s, pose.abduct + body.arm_out)
        j[f"elbow_{n}"] = el
        j[f"hand_{n}"] = limb(el, pose.shoulder[k] + pose.lean + pose.elbow[k], arm_fore, s, (pose.abduct + body.arm_out) * 0.6)
    return j


def sdf(body: Body, j, p):
    """Signed distance of the posed body at points p (N×3, body space, game px)."""
    w, L, hr = body.width, body.limb, body.head_round
    hh = body.head_h
    head = j["head"]
    d = ellipsoid(p, head, V(hh * 0.52 * hr, hh * 0.5, hh * 0.47 * hr))
    d = smin(d, ellipsoid(p, head + [0, -hh * 0.05, -hh * 0.12], V(hh * 0.44, hh * 0.42, hh * 0.4)), 1.5)  # back of skull
    d = smin(d, ellipsoid(p, head + [0, -hh * 0.14, hh * 0.44 * hr], V(1.0, 1.1, 1.4)), 0.5)               # nose
    d = smin(d, ellipsoid(p, head + [0, -hh * 0.34, hh * 0.3], V(hh * 0.2 / hr, hh * 0.1, hh * 0.13)), 1.0)  # chin
    for s in (1, -1):
        d = smin(d, ellipsoid(p, head + [s * hh * 0.5 * hr, -hh * 0.05, -hh * 0.02], V(1.0, 2.0, 1.4)), 0.5)  # ears
        if body.ear:  # a pointed ear sweeping up and back, so the depth guide carries it
            root = head + [s * hh * 0.46 * hr, -hh * 0.06, -hh * 0.04]
            tip = head + [s * (hh * 0.5 * hr + body.ear), hh * 0.14, -hh * 0.16]
            d = smin(d, capsule(p, root, tip, 1.5), 0.8)
    d = smin(d, capsule(p, j["neck"] + [0, -1, 0], j["neck"] + [0, body.neck + 2, 0], 3.6 * w ** 0.5), 1.0)
    d = smin(d, ellipsoid(p, j["chest"], V(body.shoulders / 2 - 1.5, body.torso_h * 0.36, 7.0 * w)), 2.5)
    d = smin(d, ellipsoid(p, j["chest"] + [0, 0.5, 2.0], V(body.shoulders / 2 - 4, body.torso_h * 0.22, 5.0 * w)), 1.5)
    d = smin(d, ellipsoid(p, j["pelvis"] + [0, 1.5, 0], V(8.2 * w, 5.2, 6.4 * w)), 2.5)
    for s, n in ((1, "L"), (-1, "R")):
        d = smin(d, ellipsoid(p, j["pelvis"] + [s * 3.6 * w, -0.5, -4.6 * w], V(4.0 * w, 4.0, 3.2)), 1.5)   # buttocks
        d = smin(d, capsule(p, j[f"hip_{n}"], j[f"knee_{n}"], 4.9 * L), 1.2)
        d = smin(d, capsule(p, j[f"knee_{n}"], j[f"ankle_{n}"], 4.3 * L), 1.2)
        d = smin(d, capsule(p, j[f"ankle_{n}"] + (j[f"ankle_{n}"] - j[f"toe_{n}"]) * 0.25, j[f"toe_{n}"], 2.6 * body.foot), 1.0)
        d = smin(d, capsule(p, j[f"shoulder_{n}"], j[f"elbow_{n}"], 3.6 * L), 1.8)
        d = smin(d, capsule(p, j[f"elbow_{n}"], j[f"hand_{n}"], 3.2 * L), 1.0)
        d = smin(d, ellipsoid(p, j[f"hand_{n}"], V(3.0, 3.5, 3.0) * body.hand), 1.0)
    return d


def to_view(p, direction):
    """Body space -> view space for a camera looking straight at the S side (orthographic)."""
    t = math.radians(YAW[direction])
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    return np.stack([x * math.cos(t) - z * math.sin(t), y, x * math.sin(t) + z * math.cos(t)], axis=-1)


def from_view(q, direction):
    t = math.radians(YAW[direction])
    x, y, z = q[..., 0], q[..., 1], q[..., 2]
    return np.stack([x * math.cos(t) + z * math.sin(t), y, -x * math.sin(t) + z * math.cos(t)], axis=-1)


def roll_view(v, deg):
    """Rotate view-space points in the picture plane; positive tips +y toward +x."""
    a = math.radians(deg)
    out = np.array(v, float)
    out[..., 0] = v[..., 0] * math.cos(a) + v[..., 1] * math.sin(a)
    out[..., 1] = -v[..., 0] * math.sin(a) + v[..., 1] * math.cos(a)
    return out


def floor_shift(body, j, pose, direction):
    """View-space offset that lays a rolled body on the ground, centered on the feet line's x."""
    if not pose.roll:
        return np.zeros(3)
    names = list(j)
    v = roll_view(to_view(np.array([j[n] for n in names]), direction), pose.roll)
    r = np.array([body.head_h * 0.5 if n == "head" else 4.5 for n in names])
    return np.array([-((v[:, 0] - r).min() + (v[:, 0] + r).max()) / 2, -(v[:, 1] - r).min(), 0])


def fit_shift(body, state, i, direction):
    """Canvas px that bring a reach past the half back inside it, whole sprite px; extraction undoes them."""
    if state in WIDE:
        return 0
    j = skeleton(body, POSES[state][i])
    x = to_view(np.array(list(j.values())), direction)[:, 0] * SCALE
    room = HALF / 2 - FIT_MARGIN
    dx = max(0, -room - x.min()) - max(0, x.max() - room)
    return round(dx / GRID) * GRID


def half_guide(body, state, i, direction):
    """One frame's depth on its half, shifted by fit_shift."""
    dx = fit_shift(body, state, i, direction)
    wide = render_depth(body, POSES[state][i], direction, size=(2 * HALF, PAIR[1]))
    return wide.crop((HALF // 2 - dx, 0, HALF // 2 - dx + HALF, PAIR[1]))


def render_depth(body, pose, direction, size=(HALF, PAIR[1]), feet_y=FEET_Y, step=2):
    """Orthographic depth of one posed frame, near = white, background black."""
    W, H = size
    j = skeleton(body, pose)
    shift = floor_shift(body, j, pose, direction)
    cols, rows = np.meshgrid(np.arange(0, W, step) + step / 2, np.arange(0, H, step) + step / 2)
    x = (cols - W / 2) / SCALE
    y = (feet_y - rows) / SCALE
    keep = (np.abs(x) < W / 2 / SCALE) & (y > -2) & (y < body.height + 6)
    o = np.stack([x[keep], y[keep], np.full(keep.sum(), 40.0)], axis=-1)
    z = np.zeros(len(o))
    hit = np.zeros(len(o), bool)
    alive = np.ones(len(o), bool)
    for _ in range(110):
        idx = np.nonzero(alive)[0]
        if not len(idx):
            break
        q = o[idx].copy()
        q[:, 2] -= z[idx]
        dist = sdf(body, j, from_view(roll_view(q - shift, -pose.roll), direction))
        z[idx] += dist * 0.85
        hit[idx[dist < 0.03]] = True
        alive[idx[(dist < 0.03) | (z[idx] > 80)]] = False
    depth = np.zeros(x.shape)
    zz = np.where(hit, z, np.nan)
    if hit.any():
        near, far = np.nanmin(zz), np.nanmax(zz)
        depth[keep] = np.where(hit, 255 - (zz - near) / max(1e-6, far - near) * 200, 0)
    img = Image.fromarray(depth.astype(np.uint8)).resize((W, H), Image.BILINEAR)
    return img.convert("RGB")


def view_joints(body, pose, direction):
    """Every skeleton joint in cell coordinates: [x, y, depth] (sprite px, y down, feet at CELL_FEET, +depth = nearer)."""
    j = skeleton(body, pose)
    shift = floor_shift(body, j, pose, direction)
    out = {}
    for key, p in j.items():
        v = (roll_view(to_view(np.asarray(p), direction), pose.roll) + shift) * SCALE / GRID
        out[key] = [round(CELL_FEET[0] + float(v[0]), 1), round(CELL_FEET[1] - float(v[1]), 1), round(float(v[2]), 1)]
    return out


def joints_2d(body, pose, direction):
    """Named 2D anchors in cell coordinates (sprite px, y down, feet at CELL_FEET)."""
    v = view_joints(body, pose, direction)
    return {name: v[key] for name, key in (("head", "head"), ("hand_left", "hand_L"), ("hand_right", "hand_R"),
                                           ("foot_left", "ankle_L"), ("foot_right", "ankle_R"), ("pelvis", "pelvis"))}


def pairs(n):
    """Frame index pairs for one state: (0,1), (2,3), ... ; an odd last frame pairs with frame 0."""
    return [(i, i + 1 if i + 1 < n else 0) for i in range(0, n, 2)]


def image_frames(state):
    """The frames drawn in each generated image of a state."""
    n = len(POSES[state])
    return [(i,) for i in range(n)] if state in WIDE else pairs(n)


def out_dir(name):
    d = ROOT / "out" / "bodies" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def stride(body, state):
    """How far the stance foot moves per cycle, in sprite px -> world speed without foot sliding."""
    feet = [skeleton(body, p)["ankle_L"][2] for p in POSES[state]]
    return round(float(max(feet) - min(feet)) * SCALE / GRID, 2)


def cmd_guides(name, only=None):
    body = BODIES[name]
    gdir = out_dir(name) / "guides"
    gdir.mkdir(exist_ok=True)
    joints = {}
    for state, poses in POSES.items():
        joints[state] = {d: [joints_2d(body, p, d) for p in poses] for d in DIRS}
        if only and state not in only:
            continue
        for d in DIRS:
            for k, frames in enumerate(image_frames(state)):
                if state in WIDE:
                    render_depth(body, poses[frames[0]], d, size=PAIR).save(gdir / f"{state}_{d}_{k}.png")
                    continue
                img = Image.new("RGB", PAIR)
                img.paste(half_guide(body, state, frames[0], d), (0, 0))
                img.paste(half_guide(body, state, frames[1], d), (HALF, 0))
                img.save(gdir / f"{state}_{d}_{k}.png")
            print("guides", name, state, d, flush=True)
    meta = {"joints": joints, "stride_px": stride(body, "walk"), "run_stride_px": stride(body, "run"), "height": body.height}
    (out_dir(name) / "joints.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {gdir}  stride {meta['stride_px']:.1f}px, run {meta['run_stride_px']:.1f}px")


def cmd_preview(name, only=None):
    """Contact sheet of every pose in every direction at 1/4 size, for checking the rig."""
    body = BODIES[name]
    rows = [(s, i, p) for s, ps in POSES.items() for i, p in enumerate(ps) if not only or s in only]
    tw, th = PAIR[0] // 4, PAIR[1] // 4
    sheet = Image.new("RGB", (tw * len(DIRS), th * len(rows)))
    for r, (s, i, p) in enumerate(rows):
        for c, d in enumerate(DIRS):
            size = PAIR if s in WIDE else (HALF, PAIR[1])
            sheet.paste(render_depth(body, p, d, size=size, step=4).resize((size[0] // 4, th)), (c * tw, r * th))
    sheet.save(out_dir(name) / "rig_preview.png")
    print("wrote", out_dir(name) / "rig_preview.png")


if __name__ == "__main__":
    cmd, name, *only = sys.argv[1:]
    {"guides": cmd_guides, "preview": cmd_preview}[cmd](name, only)
