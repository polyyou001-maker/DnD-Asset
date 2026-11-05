"""Draw the turnaround guide: one chibi mannequin per drawn direction, side by side,
black lines on white, used as a ControlNet lineart guide (module "invert").

Usage:  python guides.py   -> out/v2/guides/turnaround.png

The guide fixes how many figures appear, where they stand, how big they are and which
way each one faces, so one generation yields 5 consistent views of the same design.
Geometry (slot centers, feet line, head size) lives in SHEET and is shared with sheet.py.
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from common import ROOT

SHEET = {
    "size": (1792, 576),            # an SDXL bucket (~1 MP)
    "dirs": ["S", "SW", "W", "NW", "N"],
    "slot_w": 1792 / 5,
    "feet_y": 556,
    "height": 520,                  # figure height in px, ~3.3 heads tall (chibi)
}


def slot_center(i):
    return SHEET["slot_w"] * (i + 0.5)


def draw_mannequin(sil, feat, cx, direction, H, feet):
    """Body shapes go into the silhouette mask; eyes/ear/nose are drawn as lines."""
    top = feet - H
    head_h = H * 0.37
    head_w = head_h * 1.04
    neck = top + head_h
    lw = 5
    side = direction in ("W",)
    three_q = direction in ("SW", "NW")
    back = direction in ("NW", "N")

    # body widths shrink as the figure turns sideways
    shoulder = H * (0.11 if side else 0.17 if three_q else 0.19)
    hip = shoulder * 0.9
    torso_bot = neck + H * 0.27
    leg_bot = feet

    # head
    hx = cx - (head_w * 0.06 if three_q else 0)
    sil.ellipse([hx - head_w / 2, top, hx + head_w / 2, neck + 6], fill=255)
    # torso (trapezoid)
    sil.polygon([(cx - shoulder, neck + 8), (cx + shoulder, neck + 8),
               (cx + hip, torso_bot), (cx - hip, torso_bot)], fill=255)
    # legs
    leg_w = H * 0.055
    gap = 0 if side else H * 0.025
    for s in ((-1,) if side else (-1, 1)):
        x0 = cx + s * (gap + leg_w) - leg_w
        sil.rounded_rectangle([x0, torso_bot - 4, x0 + leg_w * 2, leg_bot], radius=leg_w * 0.8, fill=255)
    if side:  # far leg slightly behind
        sil.rounded_rectangle([cx - leg_w * 0.2, torso_bot, cx + leg_w * 1.8, leg_bot - 4], radius=leg_w * 0.8, fill=255)
    # arms hanging at the sides
    arm_len = H * 0.26
    arm_w = H * 0.045
    arms = (-1,) if side else (-1, 1)
    for s in arms:
        ax = cx + s * (shoulder + arm_w * 1.15) if not side else cx - arm_w * 0.3
        if three_q and s == 1:
            ax -= shoulder * 0.25  # far arm tucks behind the torso
        sil.rounded_rectangle([ax - arm_w, neck + 10, ax + arm_w, neck + 10 + arm_len], radius=arm_w * 0.8, fill=255)

    # facial guide only where the face is visible: eyes push the model to face that way
    if not back:
        ey = neck - head_h * 0.38
        eh, ew = head_h * 0.17, head_w * 0.10
        if direction == "S":
            eyes = [hx - head_w * 0.2, hx + head_w * 0.2]
        elif direction == "SW":
            eyes = [hx - head_w * 0.28, hx + head_w * 0.06]
        else:  # W profile: one eye near the left edge
            eyes = [hx - head_w * 0.32]
        for ex in eyes:
            feat.ellipse([ex - ew, ey - eh, ex + ew, ey + eh], outline="black", width=lw)
        if direction == "W":  # nose/chin bump on the facing side
            feat.arc([hx - head_w * 0.56, ey, hx - head_w * 0.40, ey + head_h * 0.3], 90, 270, fill="black", width=lw)
    elif direction == "NW":  # ear on the left edge hints a back three-quarter view
        feat.ellipse([hx - head_w * 0.52, neck - head_h * 0.5, hx - head_w * 0.40, neck - head_h * 0.28], outline="black", width=lw)


def build():
    # Only the OUTER contour of each body is drawn: inner part lines (torso box, limbs)
    # made the model paint the mannequin's boxes instead of a character.
    sil_img = Image.new("L", SHEET["size"], 0)
    img = Image.new("RGB", SHEET["size"], "white")
    sil, feat = ImageDraw.Draw(sil_img), ImageDraw.Draw(img)
    for i, direction in enumerate(SHEET["dirs"]):
        draw_mannequin(sil, feat, slot_center(i), direction, SHEET["height"], SHEET["feet_y"])
    edge = sil_img.filter(ImageFilter.MaxFilter(7))
    edge = ImageChops.subtract(edge, sil_img)
    img.paste((0, 0, 0), mask=edge)
    out = ROOT / "out" / "v2" / "guides"
    out.mkdir(parents=True, exist_ok=True)
    img.save(out / "turnaround.png")
    print(f"wrote {(out / 'turnaround.png').relative_to(ROOT)}")


VIEW = {"size": (832, 1216), "feet_y": 1174, "height": 1100}


def build_views():
    """One guide per direction at detail resolution (one figure, ~1100 px tall)."""
    out = ROOT / "out" / "v2" / "guides"
    out.mkdir(parents=True, exist_ok=True)
    for direction in SHEET["dirs"]:
        sil_img = Image.new("L", VIEW["size"], 0)
        img = Image.new("RGB", VIEW["size"], "white")
        # no facial lines here: at full size the model paints the guide's eye ovals as extra eyes
        sil, feat = ImageDraw.Draw(sil_img), ImageDraw.Draw(Image.new("RGB", VIEW["size"]))
        draw_mannequin(sil, feat, VIEW["size"][0] / 2, direction, VIEW["height"], VIEW["feet_y"])
        edge = ImageChops.subtract(sil_img.filter(ImageFilter.MaxFilter(9)), sil_img)
        img.paste((0, 0, 0), mask=edge)
        img.save(out / f"view_{direction}.png")
    print("wrote view guides")


if __name__ == "__main__":
    build()
    build_views()
