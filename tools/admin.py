"""Asset admin: find, download and replace game art. Spec: docs/specs/asset-admin.md.

Usage:  ../venv/Scripts/python.exe tools/admin.py [port]    (127.0.0.1 only, default 5181)
"""
import base64
import dataclasses
import datetime
import functools
import hashlib
import http.server
import io
import json
import os
import pathlib
import posixpath
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile

import numpy as np
from PIL import Image

PROJECT = pathlib.Path(__file__).resolve().parent.parent
ART = PROJECT / "art"
OVERRIDES = ART / "overrides"
HISTORY = PROJECT / "pipeline" / "out" / "admin_history"
MAX_UPLOAD = 32 * 1024 * 1024
DIRS = ["S", "SW", "W", "NW", "N"]  # order of dirs in sheet.json
STATIC = ("/tools/admin/", "/art/", "/prototype/src/", "/src/paperdoll2/", "/src/character/")
FRAME_SHAPE = re.compile(r"_(S|SW|W|NW|N)_\d+$")
LOCK = threading.Lock()
pending = {}  # upload token -> what /api/apply will write; only the latest upload stays


class Refuse(Exception):
    """A request the admin turns down; the message is shown to the user."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@dataclasses.dataclass
class Asset:
    id: str
    category: str
    name: str
    group: str
    files: list
    sheet: pathlib.Path = None  # the replaceable image; None = view and download only
    frames: dict = dataclasses.field(default_factory=dict)  # "<state>_<dir>_<i>" -> frame + rect
    meta: dict = None
    body: str = None  # a hair/clothes layer: the body it is worn on (art/bodies/<body>/layers/<item>/)

    @property
    def override_dir(self):
        return OVERRIDES / self.category / self.name

    @property
    def history_dir(self):
        return HISTORY / self.category / self.name

    def override_files(self):
        return sorted(self.override_dir.glob("*.png"))


def sheet_frames(meta):
    return {f"{state}_{d}_{i}": {"state": state, "dir": d, "index": i, **rect}
            for state, st in meta["states"].items()
            for d, rects in zip(DIRS, st["dirs"])
            for i, rect in enumerate(rects)}


def eye_frames(meta):
    e = meta["eyes"]
    return {f"{state}_{d}_0": {"state": state, "dir": d, "index": 0, "x": col * e["w"], "y": row * e["h"], "w": e["w"], "h": e["h"]}
            for col, state in enumerate(("open", "closed"))
            for row, d in enumerate(e["dirs"])}


# One row per source: a new layer needs one new row. Unknown files land in Unsorted, never hidden.
SOURCES = [
    ("body", "Body", "bodies/*/sheet.png", sheet_frames),
    ("face", "Face", "bodies/*/eyes.png", eye_frames),
    ("hair", "Hair", "bodies/*/layers/hair_*/sheet.png", sheet_frames),
    ("clothes", "Clothes", "bodies/*/layers/outfit_*/sheet.png", sheet_frames),
    ("weapons", "Weapons", "layers/weapons/*/sheet.png", sheet_frames),
    ("effects", "Effects", "layers/effects/*/sheet.png", sheet_frames),
]
CATEGORIES = [(c, label) for c, label, _, _ in SOURCES] + [("legacy", "Legacy"), ("unsorted", "Unsorted")]
LEGACY_ROOTS = ("paperdoll", "paperdoll2")


def scan():
    """Every asset under art/, by id. Ids are looked up here and never used as paths."""
    out, claimed = {}, set()

    def add(asset):
        out[asset.id] = asset
        claimed.update(asset.files)
        claimed.update(asset.override_files())

    for category, _, pattern, frames in SOURCES:
        for image in sorted(ART.glob(pattern)):
            # a body layer has the body's frame layout: its sheet.json is the body's
            body = image.parents[2].name if image.parent.parent.name == "layers" else None
            meta_path = image.parents[2] / "sheet.json" if body else image.with_name("sheet.json")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                found = frames(meta)
            except (OSError, ValueError, KeyError, TypeError):
                continue  # no usable metadata: it shows up in Unsorted instead
            if body:  # named <body>_<item>, so a downloaded frame file names its layer
                files = [image] + [p for p in (image.with_name("layer.json"), image.with_name("back.png")) if p.exists()]
                name, group = f"{body}_{image.parent.name}", body
            else:
                files = [image, meta_path] if image.name == "sheet.png" else [image]
                name = group = image.parent.name
            add(Asset(f"{category}/{name}", category, name, group, files, image, found, meta, body))
    for root in LEGACY_ROOTS:
        for folder, _, names in sorted(os.walk(ART / root)):
            folder = pathlib.Path(folder)
            files = [folder / n for n in sorted(names)]
            if files:
                rel = folder.relative_to(ART).as_posix()
                add(Asset(f"legacy/{rel}", "legacy", rel, "/".join(rel.split("/")[:2]), files))
    for path in sorted(p for p in ART.rglob("*") if p.is_file() and p not in claimed):
        rel = path.relative_to(ART).as_posix()
        out[f"unsorted/{rel}"] = Asset(f"unsorted/{rel}", "unsorted", rel, path.parent.relative_to(ART).as_posix(), [path])
    return out


def get_asset(index, asset_id):
    if asset_id not in index:
        raise Refuse("ไม่พบ Asset นี้", 404)
    return index[asset_id]


def editable(asset):
    if asset.sheet is None:
        raise Refuse("Asset หมวดนี้ดูและดาวน์โหลดได้อย่างเดียว", 403)
    return asset


def read_rgba(path):
    with Image.open(path) as im:
        return np.array(im.convert("RGBA"))


def crop(a, f):
    return a[f["y"]:f["y"] + f["h"], f["x"]:f["x"] + f["w"]]


def png_bytes(a):
    buf = io.BytesIO()
    Image.fromarray(a, "RGBA").save(buf, "PNG")
    return buf.getvalue()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        for wait in (0.1, 0.3, 1.0):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows: a reader still has the file open
                time.sleep(wait)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def same_pixels(a, b):
    """Colors under fully transparent pixels do not count: paint programs rewrite them."""
    a, b = a.copy(), b.copy()
    a[a[..., 3] == 0] = 0
    b[b[..., 3] == 0] = 0
    return np.array_equal(a, b)


def data_url(a):
    return "data:image/png;base64," + base64.b64encode(png_bytes(a)).decode()


# ---------------------------------------------------------------- reading

def with_eyes(asset, key, cell):
    """Body frames are stored without eyes: thumbnails draw them in, like the game."""
    f, eyes = asset.frames[key], asset.meta.get("eyes")
    if asset.category != "body" or not eyes or f["dir"] not in eyes["at"].get(f["state"], {}):
        return cell
    x, y = eyes["at"][f["state"]][f["dir"]][f["index"]]
    w, h = eyes["w"], eyes["h"]
    sprite = crop(read_rgba(asset.sheet.with_name("eyes.png")), {"x": 0, "y": eyes["dirs"].index(f["dir"]) * h, "w": w, "h": h})
    out = cell.copy()
    region = out[y:y + h, x:x + w]
    sprite = sprite[:region.shape[0], :region.shape[1]]
    mask = (sprite[..., 3] > 0) & (region[..., 3] > 0)  # stays inside the outline, like source-atop
    region[mask] = sprite[mask]
    return out


def worn(asset, key, cell):
    """A hair/clothes frame drawn on its body (and long hair's back piece behind it), as the game shows it."""
    f, body_dir = asset.frames[key], asset.sheet.parents[2]
    out = Image.fromarray(crop(read_rgba(body_dir / "sheet.png"), f))
    back = asset.sheet.with_name("back.png")
    if back.exists():
        out = Image.alpha_composite(Image.fromarray(crop(read_rgba(back), f)), out)
    return np.array(Image.alpha_composite(out, Image.fromarray(cell)))


def thumbnail(asset, q):
    if asset.frames:
        wanted = [k for k, f in asset.frames.items()
                  if q.get("state", f["state"]) == f["state"] and q.get("dir", f["dir"]) == f["dir"]]
        if not wanted:
            raise Refuse("ไม่มีเฟรมนี้", 404)
        cell = crop(read_rgba(asset.sheet), asset.frames[wanted[0]])
        return png_bytes(worn(asset, wanted[0], cell) if asset.body else with_eyes(asset, wanted[0], cell))
    images = [p for p in asset.files if p.suffix == ".png"]
    if not images:
        raise Refuse("ไม่มีภาพ", 404)
    return images[0].read_bytes()


def versions(asset):
    if not asset.history_dir.exists():
        return []
    found = [d for d in asset.history_dir.iterdir() if (d / "version.json").exists()]
    return [{"id": d.name, **json.loads((d / "version.json").read_text(encoding="utf-8"))}
            for d in sorted(found, key=lambda d: d.name, reverse=True)]


def summary(asset):
    keys = {p.stem for p in asset.override_files()}
    first = next(iter(asset.frames.values()), None)
    return {"id": asset.id, "category": asset.category, "name": asset.name, "group": asset.group, "body": asset.body,
            "editable": asset.sheet is not None, "edited": len(keys & set(asset.frames)),
            "dirs": sorted({f["dir"] for f in asset.frames.values()}, key=DIRS.index),
            "states": list(dict.fromkeys(f["state"] for f in asset.frames.values())),
            "hasThumb": bool(first) or any(p.suffix == ".png" for p in asset.files)}


def details(asset):
    keys = {p.stem for p in asset.override_files()}
    return {**summary(asset),
            "frames": [{"key": k, "edited": k in keys, **f} for k, f in asset.frames.items()],
            "orphans": sorted(keys - set(asset.frames)),
            "versions": versions(asset),
            "files": [{"name": p.name, "url": "/art/" + p.relative_to(ART).as_posix(), "size": p.stat().st_size} for p in asset.files]}


def download(asset, q):
    """Bytes and file name of one sheet, frame, listed file or orphaned override."""
    if "key" in q:
        if q["key"] not in asset.frames:
            raise Refuse("ไม่พบเฟรมนี้", 404)
        return png_bytes(crop(read_rgba(asset.sheet), asset.frames[q["key"]])), f"{asset.name}_{q['key']}.png"
    if "override" in q:
        match = [p for p in asset.override_files() if p.stem == q["override"]]
    else:
        match = [p for p in asset.files if p.name == q.get("file", asset.files[0].name)]
    if not match:
        raise Refuse("ไม่พบไฟล์นี้", 404)
    return match[0].read_bytes(), f"{asset.name.replace('/', '_')}_{match[0].name}"


def category_zip(index, category):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for a in index.values():
            if a.category == category:
                for p in a.files + a.override_files():
                    z.write(p, p.relative_to(ART).as_posix())
    return buf.getvalue()


# ---------------------------------------------------------------- replacing

def frame_stem(name):
    """Stem of a file named like a downloaded frame, or None."""
    stem = re.sub(r" \(\d+\)$", "", pathlib.PurePath(name).stem)  # " (1)": the browser's repeated download
    return stem if FRAME_SHAPE.search(stem) else None


def find_target(index, q):
    """(asset, frame key or None). A frame-shaped file name decides; otherwise the page's selection does."""
    stem = frame_stem(q.get("name", ""))
    selected = index.get(q.get("id"))
    if stem:
        for a in index.values():
            if a.sheet is not None and stem.startswith(a.name + "_") and stem[len(a.name) + 1:] in a.frames:
                return a, stem[len(a.name) + 1:]
        raise Refuse(f"ชื่อไฟล์ {stem} ไม่ตรงกับเฟรมใดเลย")
    if selected is None:
        raise Refuse("เปิด Asset ที่จะแทนก่อน หรือใช้ชื่อไฟล์แบบที่ดาวน์โหลดมา เช่น human_walk_S_2.png")
    key = q.get("key")
    if key is not None and key not in selected.frames:
        raise Refuse("ไม่พบเฟรมนี้", 404)
    return editable(selected), key


def open_upload(data):
    try:
        img = Image.open(io.BytesIO(data))
    except OSError:
        raise Refuse("ไฟล์นี้ไม่ใช่ PNG") from None
    except Image.DecompressionBombError:
        raise Refuse("ภาพนี้ใหญ่เกินไป") from None
    if img.format != "PNG":
        raise Refuse("ไฟล์นี้ไม่ใช่ PNG")
    if "A" not in img.getbands() and "transparency" not in img.info:
        raise Refuse("PNG นี้ไม่มีช่อง alpha พื้นหลังจะทึบในเกม")
    return img


def decode(img):
    try:
        return np.array(img.convert("RGBA"))
    except (OSError, SyntaxError, ValueError):
        raise Refuse("ไฟล์ PNG เสียหาย อ่านไม่ได้") from None


def frame_warnings(asset, key, before, after):
    out = []
    alpha = after[..., 3]
    if ((alpha > 0) & (alpha < 255)).any():
        out.append(f"{key}: มีพิกเซลโปร่งแสง เกมจะตัดที่ alpha 0.5")
    if asset.category == "body":
        feet = asset.meta.get("feetY")

        def on_feet(a):
            rows = np.nonzero(a[..., 3].any(axis=1))[0]
            return len(rows) > 0 and abs(int(rows.max()) - feet) <= 1

        if feet is not None and on_feet(before) and not on_feet(after):
            out.append(f"{key}: เท้าไม่อยู่บนเส้น y={feet} ตัวละครจะสั่น")
    return out


def upload_preview(index, q, data):
    asset, key = find_target(index, q)
    img = open_upload(data)
    current = read_rgba(asset.sheet)
    sheet_size = (current.shape[1], current.shape[0])
    if img.size == sheet_size and not frame_stem(q.get("name", "")):
        key = None
    else:
        if key is None:
            raise Refuse(f"ไฟล์ขนาด {img.width}×{img.height} ไม่ตรงกับชีต {sheet_size[0]}×{sheet_size[1]} "
                         "ถ้าเป็นไฟล์เฟรม ให้เลือกเฟรมก่อน")
        f = asset.frames[key]
        if img.size != (f["w"], f["h"]):
            raise Refuse(f"ไฟล์ขนาด {img.width}×{img.height} แต่เฟรม {key} ต้องเป็น {f['w']}×{f['h']}")
    upload = decode(img)
    candidate, changed, warnings = current.copy(), [], []
    for k in ([key] if key else asset.frames):
        f = asset.frames[k]
        before, after = crop(current, f), upload if key else crop(upload, f)
        if same_pixels(before, after):
            continue
        crop(candidate, f)[:] = after
        changed.append({"key": k, "state": f["state"], "dir": f["dir"], "index": f["index"], "w": f["w"], "h": f["h"],
                        "before": data_url(before), "after": data_url(after)})
        warnings += frame_warnings(asset, k, before, after)
    pending.clear()
    if not changed:
        return {"id": asset.id, "noChange": True}
    token = secrets.token_urlsafe(16)
    pending[token] = {"asset": asset.id, "hash": sha(asset.sheet), "png": png_bytes(candidate), "note": q.get("name", ""),
                      "frames": {c["key"]: crop(candidate, asset.frames[c["key"]]).copy() for c in changed}}
    return {"id": asset.id, "token": token, "frames": changed, "warnings": warnings}


def snapshot(asset, action, frames, note):
    """Store the sheet and its overrides as they are now, so that this step can be undone."""
    d = asset.history_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 10 ** 9:09d}"
    (d / "overrides").mkdir(parents=True)
    shutil.copy2(asset.sheet, d / asset.sheet.name)
    for p in asset.override_files():
        shutil.copy2(p, d / "overrides" / p.name)
    record = {"time": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "action": action, "frames": frames, "note": note}
    (d / "version.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def apply_upload(index, body):
    job = pending.pop(body.get("token"), None)
    if job is None:
        raise Refuse("รายการนี้หมดอายุแล้ว กรุณาอัปโหลดใหม่", 409)
    asset = editable(get_asset(index, job["asset"]))
    if sha(asset.sheet) != job["hash"]:
        raise Refuse("ชีตถูกเปลี่ยนหลังอัปโหลด กรุณาอัปโหลดใหม่", 409)
    snapshot(asset, "replace", sorted(job["frames"]), job["note"])
    current = read_rgba(asset.sheet)
    atomic_write(asset.sheet, job["png"])  # first: the one write another program can block
    for key, cell in job["frames"].items():
        override = asset.override_dir / f"{key}.png"
        if not override.exists():  # the sheet still holds the generated frame: keep it for "use pipeline frame"
            atomic_write(asset.history_dir / "pipeline" / override.name, png_bytes(crop(current, asset.frames[key])))
        atomic_write(override, png_bytes(cell))
    return {"id": asset.id}


def use_pipeline(index, body):
    asset = editable(get_asset(index, body.get("id")))
    key = body.get("key")
    override = next((p for p in asset.override_files() if p.stem == key), None)
    if override is None:
        raise Refuse("เฟรมนี้ไม่ได้แก้มือ", 404)
    if key in asset.frames:
        original = asset.history_dir / "pipeline" / override.name
        if not original.exists():
            raise Refuse(f"ไม่พบเฟรมต้นฉบับในเครื่องนี้ รัน {'layers.py' if asset.body else 'bodies.py'} extract แล้วลองอีกครั้ง", 409)
        snapshot(asset, "use_pipeline", [key], "")
        sheet = read_rgba(asset.sheet)
        crop(sheet, asset.frames[key])[:] = read_rgba(original)
        atomic_write(asset.sheet, png_bytes(sheet))
    else:  # orphaned: nothing to put back in the sheet
        snapshot(asset, "use_pipeline", [key], "")
    override.unlink()
    return {"id": asset.id}


def restore(index, body):
    asset = editable(get_asset(index, body.get("id")))
    version = next((v for v in versions(asset) if v["id"] == body.get("version")), None)
    if version is None:
        raise Refuse("ไม่พบรุ่นนี้", 404)
    source = asset.history_dir / version["id"]
    snapshot(asset, "restore", version["frames"], version["id"])
    atomic_write(asset.sheet, (source / asset.sheet.name).read_bytes())
    for p in asset.override_files():
        p.unlink()
    for p in (source / "overrides").glob("*.png"):
        atomic_write(asset.override_dir / p.name, p.read_bytes())
    return {"id": asset.id}


# ---------------------------------------------------------------- server

class Admin(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def origins(self):
        port = self.server.server_address[1]
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def reply(self, status, data, content_type, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}")
        self.end_headers()
        self.wfile.write(data)

    def reply_json(self, value, status=200):
        self.reply(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def guarded(self, fn):
        """A page on another site must not reach this server, even through a rebinding DNS name."""
        if self.headers.get("Host") not in self.origins():
            return self.reply_json({"error": "ไม่อนุญาต"}, 403)
        try:
            fn()
        except Refuse as e:
            self.reply_json({"error": str(e)}, e.status)
        except OSError as e:  # e.g. the file is open in another program
            self.reply_json({"error": f"อ่านหรือเขียนไฟล์ไม่ได้: {e}"}, 500)

    def do_GET(self):
        self.guarded(self.route_get)

    def do_HEAD(self):
        self.reply_json({"error": "ไม่รองรับ"}, 405)

    def do_POST(self):
        self.guarded(self.route_post)

    def route_get(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        path = posixpath.normpath(urllib.parse.unquote(url.path))
        if path == "/":
            self.path = "/tools/admin/index.html"
            return super().do_GET()
        if path.startswith("/api/"):
            return self.api_get(path[5:], q)
        if path.startswith(STATIC):
            self.path = path
            return super().do_GET()
        raise Refuse("ไม่พบหน้านี้", 404)

    def api_get(self, route, q):
        index = scan()
        if route == "categories":
            counts = [a.category for a in index.values()]
            return self.reply_json([{"id": c, "label": label, "count": counts.count(c)} for c, label in CATEGORIES])
        if route == "assets":
            return self.reply_json([summary(a) for a in index.values() if a.category == q.get("category")])
        if route == "download-category":
            if q.get("category") not in [c for c, _ in CATEGORIES]:
                raise Refuse("ไม่พบหมวดนี้", 404)
            return self.reply(200, category_zip(index, q["category"]), "application/zip", f"{q['category']}.zip")
        if route == "pending":
            job = pending.get(q.get("token"))
            if job is None:
                raise Refuse("รายการนี้หมดอายุแล้ว", 404)
            return self.reply(200, job["png"], "image/png")
        if route not in ("asset", "download", "thumb"):
            raise Refuse("ไม่พบหน้านี้", 404)
        asset = get_asset(index, q.get("id"))
        if route == "asset":
            return self.reply_json(details(asset))
        if route == "thumb":
            return self.reply(200, thumbnail(asset, q), "image/png")
        data, name = download(asset, q)
        self.reply(200, data, "application/octet-stream", name)

    def route_post(self):
        if self.headers.get("Origin", "").split("://")[-1] not in self.origins():
            raise Refuse("ไม่อนุญาต", 403)
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise Refuse("คำขอไม่ถูกต้อง") from None
        if size < 0:
            raise Refuse("คำขอไม่ถูกต้อง")
        if size > MAX_UPLOAD:
            self.close_connection = True  # the body is not read
            raise Refuse(f"ไฟล์ใหญ่เกิน {MAX_UPLOAD // 1024 // 1024} MB", 413)
        data = self.rfile.read(size)
        url = urllib.parse.urlsplit(self.path)
        route = url.path.removeprefix("/api/")
        actions = {"apply": apply_upload, "restore": restore, "use-pipeline": use_pipeline}
        with LOCK:
            index = scan()
            if route == "upload-preview":
                return self.reply_json(upload_preview(index, dict(urllib.parse.parse_qsl(url.query)), data))
            if route not in actions:
                raise Refuse("ไม่พบหน้านี้", 404)
            try:
                body = json.loads(data)
            except ValueError:
                raise Refuse("คำขอไม่ถูกต้อง") from None
            if not isinstance(body, dict):
                raise Refuse("คำขอไม่ถูกต้อง")
            self.reply_json(actions[route](index, body))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5181
    handler = functools.partial(Admin, directory=str(PROJECT))
    print(f"Asset admin: http://127.0.0.1:{port}/", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
