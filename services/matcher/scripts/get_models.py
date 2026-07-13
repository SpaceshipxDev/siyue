#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
SSCD_URL = "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt"


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 10_000_000:
        print(f"present: {destination} ({destination.stat().st_size / 1e6:.1f} MB)")
        return
    temporary = destination.with_suffix(destination.suffix + ".part")
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as source, temporary.open("wb") as target:
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
    if temporary.stat().st_size < 10_000_000:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("SSCD download was unexpectedly small")
    temporary.replace(destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(f"saved: {destination} ({destination.stat().st_size / 1e6:.1f} MB, sha256={digest})")


def prewarm_lightglue() -> None:
    print("pre-warming SuperPoint and LightGlue weights")
    os.environ.setdefault("TORCH_HOME", str(MODELS / "torch-cache"))
    from lightglue import LightGlue, SuperPoint
    SuperPoint(max_num_keypoints=32).eval()
    LightGlue(features="superpoint").eval()
    print("LightGlue weights ready")


def main() -> int:
    download(SSCD_URL, MODELS / "sscd_disc_mixup.torchscript.pt")
    prewarm_lightglue()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
