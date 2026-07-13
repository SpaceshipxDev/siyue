"""Build rectified SmartDoc15 frames from official corner ground truth.

These crops are an oracle upper-bound experiment, not production input.  They
show how much accuracy a page detector/rectifier can unlock.  Outputs remain in
the external dataset directory on Minas Tirith.
"""

from __future__ import annotations

import csv
import gzip
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "testdata" / "external" / "smartdoc15-ch1"
SOURCE = DATASET / "frames"
OUTPUT = DATASET / "oracle-crops"


def selected_frames() -> set[str]:
    return {
        str(path.relative_to(SOURCE))
        for path in SOURCE.glob("background*/*/frame_*.jpeg")
    }


def main() -> None:
    wanted = selected_frames()
    rows: dict[str, dict[str, str]] = {}
    with gzip.open(DATASET / "metadata.csv.gz", "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["image_path"] in wanted:
                rows[row["image_path"]] = row
    missing = wanted.difference(rows)
    if missing:
        raise RuntimeError(f"metadata missing for {len(missing)} selected frames")

    for number, relative in enumerate(sorted(wanted), 1):
        destination = OUTPUT / relative
        if destination.exists():
            continue
        row = rows[relative]
        image = cv2.imread(str(SOURCE / relative), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"could not read {relative}")
        source_quad = np.asarray([
            [float(row["tl_x"]), float(row["tl_y"])],
            [float(row["tr_x"]), float(row["tr_y"])],
            [float(row["br_x"]), float(row["br_y"])],
            [float(row["bl_x"]), float(row["bl_y"])],
        ], np.float32)
        width = 768
        height = round(width * float(row["model_height"]) / float(row["model_width"]))
        target_quad = np.asarray([
            [0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1],
        ], np.float32)
        transform = cv2.getPerspectiveTransform(source_quad, target_quad)
        crop = cv2.warpPerspective(image, transform, (width, height), flags=cv2.INTER_CUBIC)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(destination), crop, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise RuntimeError(f"could not write {destination}")
        if number % 150 == 0:
            print(f"rectified {number}/{len(wanted)}", flush=True)
    print(f"oracle crops ready: {len(wanted)} at {OUTPUT}")


if __name__ == "__main__":
    main()
