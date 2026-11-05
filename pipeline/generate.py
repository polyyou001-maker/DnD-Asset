"""Batch-generate raw images through the AUTOMATIC1111 HTTP API (webui started with --api).

Usage:  python generate.py jobs/test_batch.json [--url http://127.0.0.1:7860] [--force]

Writes out/<job name>/raw/<asset id>.png plus <asset id>.json (prompt, seed, settings,
webui infotext) so every asset can be reproduced. Existing assets are skipped unless --force.
"""
import argparse
import base64
import json
import sys
from pathlib import Path

import requests

from common import ROOT, load_job, save_json


def build_prompt(preset, asset):
    parts = [preset["lora"], preset["prompt_prefix"]]
    if asset.get("direction"):
        parts.append(preset["direction_tags"][asset["direction"]])
    parts.append(asset["prompt"])
    return ", ".join(p for p in parts if p)


def resolve_controlnet_model(url, wanted):
    """The ControlNet API wants the exact listed name, e.g. 'noob-lineart-anime [abcd1234]'."""
    models = requests.get(f"{url}/controlnet/model_list", timeout=30).json()["model_list"]
    for m in models:
        if m.split(" [")[0] == wanted:
            return m
    sys.exit(f"ControlNet model '{wanted}' not found. Installed: {models}")


def build_payload(url, preset, asset, job_dir):
    payload = {
        "prompt": build_prompt(preset, asset),
        "negative_prompt": ", ".join(p for p in [preset["negative"], asset.get("negative", "")] if p),
        "seed": asset.get("seed", -1),
        "sampler_name": preset["sampler"],
        "steps": asset.get("steps", preset["steps"]),
        "cfg_scale": asset.get("cfg", preset["cfg"]),
        "width": preset["width"],
        "height": preset["height"],
        "batch_size": 1,
        "n_iter": 1,
        "override_settings": {"sd_model_checkpoint": preset["checkpoint"]},
        "override_settings_restore_afterwards": False,
    }
    cn = asset.get("controlnet")
    if cn:
        image_path = (job_dir / cn["image"]).resolve()
        payload["alwayson_scripts"] = {"controlnet": {"args": [{
            "enabled": True,
            "image": base64.b64encode(image_path.read_bytes()).decode(),
            # "invert" = guide is black lines on white; "lineart_anime" = guide is a normal image
            "module": cn.get("module", "invert"),
            "model": resolve_controlnet_model(url, cn.get("model", preset["controlnet_model"])),
            "weight": cn.get("weight", 0.8),
            "guidance_start": 0.0,
            "guidance_end": cn.get("guidance_end", 0.8),
            "pixel_perfect": True,
            "resize_mode": "Crop and Resize",
            "control_mode": "Balanced",
        }]}}
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    ap.add_argument("--url", default="http://127.0.0.1:7860")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    job_path = Path(args.job).resolve()
    job, preset, out_dir = load_job(job_path)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    try:
        requests.get(f"{args.url}/sdapi/v1/options", timeout=10).raise_for_status()
    except requests.RequestException as e:
        sys.exit(f"Cannot reach the webui API at {args.url} ({e}).\n"
                 "Start the webui with --api (add it to COMMANDLINE_ARGS in webui-user.bat).")

    for i, asset in enumerate(job["assets"], 1):
        png = raw_dir / f"{asset['id']}.png"
        if png.exists() and not args.force:
            print(f"[{i}/{len(job['assets'])}] skip {asset['id']} (exists)")
            continue
        print(f"[{i}/{len(job['assets'])}] generating {asset['id']} ...", flush=True)
        payload = build_payload(args.url, preset, asset, job_path.parent)
        r = requests.post(f"{args.url}/sdapi/v1/txt2img", json=payload, timeout=900)
        r.raise_for_status()
        result = r.json()
        info = json.loads(result["info"])
        png.write_bytes(base64.b64decode(result["images"][0]))

        meta_payload = {k: v for k, v in payload.items() if k != "alwayson_scripts"}
        if "alwayson_scripts" in payload:
            unit = dict(payload["alwayson_scripts"]["controlnet"]["args"][0])
            unit["image"] = asset["controlnet"]["image"]  # path, not base64
            meta_payload["controlnet"] = unit
        save_json(raw_dir / f"{asset['id']}.json", {
            "asset": asset,
            "job": job["name"],
            "preset": job["preset"],
            "seed": info["seed"],  # actual seed even when the request asked for -1
            "payload": meta_payload,
            "infotext": info["infotexts"][0],
        })
    print(f"done -> {raw_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
