"""Draw placeholder paper-doll source art into art/paperdoll/ (then run pack.py).

Usage:  python make_placeholders.py

Simple shapes that follow the spec (docs/specs/character-dressing.md): 64x64 cells,
feet on y=61, 5 drawn directions, idle 2 / walk 4 frames, body anchors, head/hand pivots,
clothes and hair drawn in the source dye ramps. Replace with real art part by part.
"""
import shutil

import numpy as np
from PIL import Image, ImageDraw

from common import ROOT, save_json

ART = ROOT.parent / "art" / "paperdoll"
DIRS = ["S", "SW", "W", "NW", "N"]
ANIMS = {"idle": 2, "walk": 4}


def hx(s):
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


OUT = hx("1a1020")
SKIN, SKIN_SH = hx("fcdcc0"), hx("eab08c")
HAIR = [hx(c) for c in ("5a2e2a", "8c4a3a", "c2765a", "eab08c")]
CL1 = [hx(c) for c in ("1a2a5a", "2f55a0", "4a90d8", "98d0f8")]
CL2 = [hx(c) for c in ("7a1f2b", "c0303a", "f0605a", "f8a8a0")]
METAL = [hx(c) for c in ("5e4a63", "8f7f94", "c6bccb", "f4f1f2")]
GOLD = [hx(c) for c in ("8a4a10", "d08a20", "f8c840", "fff090")]
GREEN = [hx(c) for c in ("1f4a2a", "3a8040", "78c050", "c0e890")]
PURPLE = [hx(c) for c in ("3a1f5a", "6a3aa0", "a070d0", "e0b0f0")]
WHITE = hx("f4f1f2")

HEAD = (32, 24)   # head anchor in the reference pose; head pieces are drawn around it
HAND = (32, 40)   # grip point of hand-held pieces


def outline(img):
    a = np.array(img)
    solid = a[..., 3] > 0
    near = np.zeros_like(solid)
    near[1:, :] |= solid[:-1, :]
    near[:-1, :] |= solid[1:, :]
    near[:, 1:] |= solid[:, :-1]
    near[:, :-1] |= solid[:, 1:]
    a[near & ~solid] = OUT
    return Image.fromarray(a, "RGBA")


def cell():
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


# ---------------------------------------------------------------- bodies
def draw_body(cls, anim, d, f):
    img, g = cell()
    back = d in ("NW", "N")
    hw = {"S": 9, "SW": 8, "W": 6, "NW": 8, "N": 9}[d] - (1 if cls == "rogue" else 0)
    shift = {"S": 0, "SW": -1, "W": -2, "NW": 1, "N": 0}[d]  # head turns with the direction
    bob = (-1 if f % 2 else 0) if anim == "walk" else (1 if f == 1 else 0)
    swing = [0, 2, 0, -2][f] if anim == "walk" else 0
    hx_, hy = 32 + shift, 24 + bob

    # legs (planted foot always ends on y=61)
    lift_l, lift_r = (1 if swing > 0 else 0), (1 if swing < 0 else 0)
    leg = CL1[0] if cls != "knight" else METAL[1]
    g.rectangle([32 - 5, 52, 32 - 2, 61 - lift_l], fill=leg)
    g.rectangle([32 + 1, 52, 32 + 4, 61 - lift_r], fill=leg)

    # torso
    top, bottom = 34 + bob, 52 + bob
    if cls == "mage":
        g.polygon([(32 - hw, top), (32 + hw, top), (32 + hw + 3, 57), (32 - hw - 3, 57)], fill=CL1[1])
        g.rectangle([32 - hw, 41 + bob, 32 + hw, 42 + bob], fill=CL2[1])
    else:
        g.rectangle([32 - hw, top, 32 + hw, bottom], fill=CL1[1] if cls == "knight" else CL1[0])
        g.rectangle([32 - hw, 47 + bob, 32 + hw, 48 + bob], fill=CL2[1])
        if cls == "knight":
            if not back:
                g.rectangle([32 - hw + 2, top + 2, 32 + hw - 2, 45 + bob], fill=METAL[2])
            g.rectangle([32 - hw - 2, top, 32 - hw + 1, top + 3], fill=METAL[1])
            g.rectangle([32 + hw - 1, top, 32 + hw + 2, top + 3], fill=METAL[1])
        if cls == "rogue":
            g.rectangle([32 - hw, top, 32 + hw, top + 2], fill=CL2[2])
    g.line([(32 - hw + 1, top + 1), (32 - hw + 1, bottom - 2)], fill=CL1[2])  # highlight

    # hands (see spec: main hand = character's right hand)
    main_x = {"S": 32 - hw - 3, "SW": 32 - hw - 2, "W": 33, "NW": 32 + hw + 1, "N": 32 + hw + 3}[d]
    off_x = {"S": 32 + hw + 3, "SW": 32 + hw + 2, "W": 30, "NW": 32 - hw - 2, "N": 32 - hw - 3}[d]
    main = (main_x, 44 + bob + swing // 2)
    off = (off_x, 44 + bob - swing // 2)
    for x, y in (main, off):
        g.line([(32, top + 2), (x, y)], fill=CL1[1], width=3)
        g.rectangle([x - 1, y - 1, x + 1, y + 1], fill=SKIN)

    # head (skin; hair and face are separate parts)
    g.ellipse([hx_ - 10, hy - 10, hx_ + 10, hy + 9], fill=SKIN_SH if back else SKIN)
    return outline(img), {"head": [hx_, hy], "hand_main": list(main), "hand_off": list(off)}


# ---------------------------------------------------------------- head pieces (around HEAD)
def head_piece(kind, d):
    img, g = cell()
    x, y = HEAD
    back = d in ("NW", "N")
    side = {"S": 0, "SW": -1, "W": -2, "NW": 1, "N": 0}[d]
    if kind == "hair_short_back":
        if back:
            g.ellipse([x - 12, y - 12, x + 12, y + 8], fill=HAIR[1])
            g.ellipse([x - 9, y - 11, x + 6, y - 2], fill=HAIR[2])
    elif kind == "hair_long_back":
        if back:
            g.rectangle([x - 12, y - 4, x + 12, y + 18], fill=HAIR[1])
            g.ellipse([x - 12, y - 12, x + 12, y + 8], fill=HAIR[1])
            g.ellipse([x - 9, y - 11, x + 6, y - 2], fill=HAIR[2])
        elif d == "W":
            g.rectangle([x + 2, y - 6, x + 12, y + 18], fill=HAIR[0])
        else:
            g.rectangle([x - 13, y - 4, x + 13, y + 16], fill=HAIR[0])
    elif kind == "hair_front":
        if not back:
            g.chord([x - 12 + side, y - 12, x + 12 + side, y + 6], 180, 360, fill=HAIR[1])
            g.rectangle([x - 12 + side, y - 4, x - 9 + side, y + 4], fill=HAIR[1])
            g.rectangle([x + 9 + side, y - 4, x + 12 + side, y + 4], fill=HAIR[1])
            g.line([(x - 6 + side, y - 9), (x + 2 + side, y - 9)], fill=HAIR[3])
            if d == "W":
                g.ellipse([x - 4, y - 12, x + 12, y + 6], fill=HAIR[1])
    elif kind == "face":
        eyes = {"S": [x - 5, x + 4], "SW": [x - 7, x + 1], "W": [x - 8]}.get(d, [])
        for ex in eyes:
            g.rectangle([ex, y - 1, ex + 1, y + 2], fill=OUT)
            g.point((ex, y - 1), fill=WHITE)
        if eyes:
            mx = sum(eyes) // len(eyes) + 1
            g.line([(mx - 1, y + 5), (mx, y + 5)], fill=CL2[0])
    elif kind == "hat_witch":
        g.ellipse([x - 16, y - 12, x + 16, y - 7], fill=PURPLE[1])
        tip = x + {"S": 3, "SW": 5, "W": 7, "NW": -5, "N": -3}[d]
        g.polygon([(x - 9, y - 10), (x + 9, y - 10), (tip, y - 22)], fill=PURPLE[2])
        g.rectangle([x - 9, y - 12, x + 9, y - 11], fill=GOLD[2])
    elif kind == "glasses":
        eyes = {"S": [x - 5, x + 4], "SW": [x - 7, x + 1], "W": [x - 8]}.get(d, [])
        for ex in eyes:
            g.rectangle([ex - 2, y - 2, ex + 3, y + 3], outline=GOLD[1])
        if len(eyes) == 2:
            g.line([(eyes[0] + 3, y), (eyes[1] - 2, y)], fill=GOLD[1])
    elif kind == "scarf":
        g.rectangle([x - 11, y + 5, x + 11, y + 10], fill=GREEN[1])
        g.line([(x - 10, y + 6), (x + 10, y + 6)], fill=GREEN[2])
        if not back:
            g.rectangle([x - 8 + side, y + 3, x + 8 + side, y + 6], fill=GREEN[1])
    elif kind == "helm_full":
        g.ellipse([x - 12, y - 13, x + 12, y + 10], fill=METAL[1])
        g.ellipse([x - 9, y - 12, x + 5, y - 2], fill=METAL[2])
        if not back:
            g.rectangle([x - 8 + 2 * side, y - 1, x + 8 + 2 * side, y + 1], fill=OUT)
        g.rectangle([x - 1, y - 18, x + 1, y - 12], fill=CL2[1])
    return outline(img)


# ---------------------------------------------------------------- hand pieces (around HAND)
def hand_piece(kind, d):
    img, g = cell()
    x, y = HAND
    if kind == "sword":
        g.rectangle([x - 1, y - 22, x + 1, y - 3], fill=METAL[2])
        g.line([(x, y - 21), (x, y - 4)], fill=METAL[3])
        g.rectangle([x - 4, y - 3, x + 4, y - 2], fill=GOLD[1])
        g.rectangle([x - 1, y - 1, x + 1, y + 2], fill=HAIR[0])
    elif kind == "staff":
        g.rectangle([x - 1, y - 24, x, y + 14], fill=HAIR[1])
        g.ellipse([x - 4, y - 31, x + 3, y - 24], fill=GOLD[2])
        g.point((x - 2, y - 29), fill=GOLD[3])
    elif kind == "shield_round":
        w = {"S": 7, "SW": 6, "W": 3, "NW": 6, "N": 7}[d]
        g.ellipse([x - w, y - 7, x + w, y + 7], fill=GOLD[1])
        g.ellipse([x - w + 2, y - 5, x + w - 2, y + 5], fill=CL2[1] if d not in ("N", "NW") else HAIR[1])
    return outline(img)


def aura_frame(f):
    img, g = cell()
    for k in range(6):
        ang = (k / 6 + f / 24) * 2 * np.pi
        px = int(32 + 16 * np.cos(ang))
        py = int(48 - 30 * ((k * 0.17 + f * 0.25) % 1))
        g.rectangle([px, py, px + 1, py + 1], fill=PURPLE[3] if k % 2 else PURPLE[2])
    return img  # sparkles, no outline


# ---------------------------------------------------------------- write
def main():
    if ART.exists():
        shutil.rmtree(ART)
    ART.mkdir(parents=True)

    for cls in ("mage", "knight", "rogue"):
        pid = f"body_{cls}"
        (ART / pid).mkdir()
        anchors = {}
        for anim, n in ANIMS.items():
            anchors[anim] = {}
            for d in DIRS:
                anchors[anim][d] = []
                for f in range(n):
                    im, a = draw_body(cls, anim, d, f)
                    im.save(ART / pid / f"{anim}_{d}_{f}.png")
                    anchors[anim][d].append(a)
        save_json(ART / pid / "anchors.json", anchors)
        save_json(ART / pid / "part.json", {"slot": "body", "kind": "animated", "dye": ["cloth1", "cloth2"],
                                            "label": cls.title()})

    head_pivot = {d: list(HEAD) for d in DIRS}
    hand_pivot = {d: list(HAND) for d in DIRS}
    static = {
        "hair_short": ({"slot": "hair", "attach": "head", "dye": ["hair"], "label": "Short",
                        "pieces": [{"layer": "hair_back", "row": 0}, {"layer": "hair_front", "row": 1}]},
                       ["hair_short_back", "hair_front"], head_piece),
        "hair_long": ({"slot": "hair", "attach": "head", "dye": ["hair"], "label": "Long",
                       "pieces": [{"layer": "hair_back", "row": 0}, {"layer": "hair_front", "row": 1}]},
                      ["hair_long_back", "hair_front"], head_piece),
        "face_basic": ({"slot": "face", "attach": "head", "label": "Basic",
                        "pieces": [{"layer": "face", "row": 0}]}, ["face"], head_piece),
        "hat_witch": ({"slot": "head_top", "attach": "head", "occupies": ["head_top"], "label": "Witch hat",
                       "pieces": [{"layer": "head_top", "row": 0}]}, ["hat_witch"], head_piece),
        "helm_full": ({"slot": "head_top", "attach": "head", "occupies": ["head_top", "head_mid", "head_low"],
                       "hides": ["hair_front", "hair_back"], "label": "Full helm",
                       "pieces": [{"layer": "head_top", "row": 0}]}, ["helm_full"], head_piece),
        "glasses": ({"slot": "head_mid", "attach": "head", "occupies": ["head_mid"], "label": "Glasses",
                     "pieces": [{"layer": "head_mid", "row": 0}]}, ["glasses"], head_piece),
        "scarf": ({"slot": "head_low", "attach": "head", "occupies": ["head_low"], "label": "Scarf",
                   "pieces": [{"layer": "head_low", "row": 0}]}, ["scarf"], head_piece),
        "sword": ({"slot": "weapon", "attach": "hand_main", "label": "Sword",
                   "pieces": [{"layer": "weapon", "row": 0}]}, ["sword"], hand_piece),
        "staff": ({"slot": "weapon", "attach": "hand_main", "label": "Staff",
                   "pieces": [{"layer": "weapon", "row": 0}]}, ["staff"], hand_piece),
        "shield_round": ({"slot": "shield", "attach": "hand_off", "label": "Round shield",
                          "pieces": [{"layer": "shield", "row": 0}]}, ["shield_round"], hand_piece),
    }
    for pid, (part, kinds, fn) in static.items():
        (ART / pid).mkdir()
        part = {"kind": "static", **part,
                "pivot": hand_pivot if part["attach"].startswith("hand") else head_pivot}
        save_json(ART / pid / "part.json", part)
        for row, kind in enumerate(kinds):
            for d in DIRS:
                fn(kind, d).save(ART / pid / f"{row}_{d}.png")

    (ART / "aura").mkdir()
    save_json(ART / "aura" / "part.json", {"slot": "effect", "kind": "effect", "frames": 4, "fps": 6, "label": "Aura"})
    for f in range(4):
        aura_frame(f).save(ART / "aura" / f"{f}.png")

    order_front = ["hair_back", "body", "face", "hair_front", "head_low", "head_mid", "head_top", "weapon", "shield"]
    ramp = lambda cols: ["#" + "%02x%02x%02x" % c[:3] for c in cols]
    save_json(ART / "_set.json", {
        "version": 1,
        "cell": [64, 64],
        "origin": [32, 61],
        "drawn": DIRS,
        "mirror": {"NE": "NW", "E": "W", "SE": "SW"},
        "anims": {"idle": {"frames": 2, "fps": 3}, "walk": {"frames": 4, "fps": 8}},
        "layerOrder": {
            "S": order_front,
            "SW": order_front,
            "W": ["weapon", "hair_back", "body", "face", "hair_front", "head_low", "head_mid", "head_top", "shield"],
            "NW": ["weapon", "body", "face", "hair_front", "hair_back", "head_low", "head_mid", "head_top", "shield"],
            "N": ["weapon", "shield", "body", "face", "hair_front", "hair_back", "head_low", "head_mid", "head_top"],
        },
        "ramps": {"hair": ramp(HAIR), "cloth1": ramp(CL1), "cloth2": ramp(CL2)},
        "dyes": {
            "hair": {"brown": ramp(HAIR), "blonde": ramp(GOLD), "red": ramp(CL2), "blue": ramp(CL1),
                     "silver": ramp(METAL), "black": ["#1a1020", "#3b2a40", "#5e4a63", "#8f7f94"]},
            "cloth1": {"blue": ramp(CL1), "green": ramp(GREEN), "purple": ramp(PURPLE), "red": ramp(CL2),
                       "black": ["#1a1020", "#3b2a40", "#5e4a63", "#8f7f94"]},
            "cloth2": {"red": ramp(CL2), "gold": ramp(GOLD), "green": ramp(GREEN), "blue": ramp(CL1),
                       "purple": ramp(PURPLE)},
        },
        "defaultLoadout": {"body": "body_mage", "hair": "hair_long", "face": "face_basic",
                           "head_top": "hat_witch", "head_mid": None, "head_low": None,
                           "weapon": "staff", "shield": None, "effect": None,
                           "dye": {"hair": "brown", "cloth1": "blue", "cloth2": "red"}},
    })
    print(f"placeholder art -> {ART}")


if __name__ == "__main__":
    main()
