"""Shared helpers: load presets, palette and job files; resolve output folders."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_palette(path=ROOT / "palette.hex"):
    """Return a list of (r, g, b). The first entry is the outline color."""
    colors = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("# ") or line == "#":
            continue  # blank or comment
        hx = line.lstrip("#")
        colors.append(tuple(int(hx[i:i + 2], 16) for i in (0, 2, 4)))
    return colors


def load_job(job_path):
    """Load a job file and attach its preset. Returns (job, preset, out_dir)."""
    job = load_json(job_path)
    preset = load_json(ROOT / "presets.json")[job["preset"]]
    out_dir = ROOT / "out" / job["name"]
    return job, preset, out_dir
