"""Rectify SmartDoc15 frames with the production candidate detector."""

from __future__ import annotations

import csv
import gzip
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.doc_detector import DocumentDetector  # noqa: E402

DATASET = ROOT / "testdata" / "external" / "smartdoc15-ch1"
SOURCE = DATASET / "frames"
OUTPUT = DATASET / "detector-crops"


def main() -> None:
    detector = DocumentDetector(ROOT / "models" / "document_corners_mobilenet_v3_small.pt")
    selected = {str(path.relative_to(SOURCE)): path for path in SOURCE.glob("background*/*/*.jpeg")}
    rows: dict[str, dict[str, str]] = {}
    with gzip.open(DATASET / "metadata.csv.gz", "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["image_path"] in selected:
                rows[row["image_path"]] = row

    ious: list[float] = []
    latencies: list[float] = []
    failures = 0
    for number, (relative, source) in enumerate(sorted(selected.items()), 1):
        rgb = cv2.cvtColor(cv2.imread(str(source)), cv2.COLOR_BGR2RGB)
        started = time.perf_counter()
        points = detector.corners(rgb)
        latencies.append((time.perf_counter() - started) * 1000)
        if points is None:
            failures += 1
            crop = rgb
            ious.append(0.0)
        else:
            row = rows[relative]
            truth = np.asarray([
                [float(row["tl_x"]), float(row["tl_y"])],
                [float(row["tr_x"]), float(row["tr_y"])],
                [float(row["br_x"]), float(row["br_y"])],
                [float(row["bl_x"]), float(row["bl_y"])],
            ], np.float32)
            intersection = cv2.intersectConvexConvex(points, truth)[0]
            union = cv2.contourArea(points) + cv2.contourArea(truth) - intersection
            ious.append(float(intersection / max(union, 1.0)))
            crop = detector.rectify(rgb)
            if crop is None:
                crop = rgb
        destination = OUTPUT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(
            str(destination), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR),
            [cv2.IMWRITE_JPEG_QUALITY, 90],
        )
        if number % 150 == 0:
            print(f"detected {number}/{len(selected)}", flush=True)
    print({
        "frames": len(selected), "failures": failures,
        "median_iou": round(float(np.median(ious)), 4),
        "iou80_pct": round(float(np.mean(np.asarray(ious) >= 0.8) * 100), 2),
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    })


if __name__ == "__main__":
    main()
