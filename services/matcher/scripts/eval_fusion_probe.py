"""Probe SSCD shortlist + cached SIFT verification on SmartDoc-QA.

The output keeps per-candidate measurements so fusion can be selected from
evidence instead of guessed thresholds.  Query-time work is one SSCD batch,
one SIFT extraction, and five descriptor matches.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.embed import SSCDEmbedder  # noqa: E402
from matcher.preprocess import preprocess, rotate_quadrants  # noqa: E402

EXT = ROOT / "testdata" / "external"
OUT = ROOT / "eval" / "fusion_probe_cases.json"


def images(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


def sift_features(rgb: np.ndarray, sift: cv2.SIFT) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    height, width = rgb.shape[:2]
    scale = min(1.0, 1200 / max(height, width))
    if scale < 1.0:
        rgb = cv2.resize(rgb, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    keypoints, descriptors = sift.detectAndCompute(gray, None)
    if descriptors is None:
        return np.empty((0, 2), np.float32), np.empty((0, 128), np.float32), (gray.shape[1], gray.shape[0])
    points = np.asarray([point.pt for point in keypoints], np.float32)
    return points, np.asarray(descriptors, np.float32), (gray.shape[1], gray.shape[0])


def local_metrics(
    query: tuple[np.ndarray, np.ndarray, tuple[int, int]],
    reference: tuple[np.ndarray, np.ndarray, tuple[int, int]],
) -> dict[str, float | int]:
    query_points, query_descriptors, _ = query
    ref_points, ref_descriptors, (width, height) = reference
    if len(query_descriptors) < 2 or len(ref_descriptors) < 2:
        return {"good": 0, "inliers": 0, "coverage": 0, "ratio": 0.0}
    rows = cv2.BFMatcher(cv2.NORM_L2).knnMatch(query_descriptors, ref_descriptors, k=2)
    good = [row[0] for row in rows if len(row) == 2 and row[0].distance < 0.82 * row[1].distance]
    if len(good) < 4:
        return {"good": len(good), "inliers": 0, "coverage": 0, "ratio": 0.0}
    query_xy = np.asarray([query_points[item.queryIdx] for item in good], np.float32)
    ref_xy = np.asarray([ref_points[item.trainIdx] for item in good], np.float32)
    homography, mask = cv2.findHomography(
        query_xy, ref_xy, getattr(cv2, "USAC_MAGSAC", cv2.RANSAC), 4.0,
    )
    if homography is None or mask is None:
        return {"good": len(good), "inliers": 0, "coverage": 0, "ratio": 0.0}
    inlier_mask = mask.ravel().astype(bool)
    inliers = int(inlier_mask.sum())
    cells_x = np.clip((ref_xy[inlier_mask, 0] / width * 4).astype(int), 0, 3)
    cells_y = np.clip((ref_xy[inlier_mask, 1] / height * 4).astype(int), 0, 3)
    coverage = len(set((cells_y * 4 + cells_x).tolist()))
    return {
        "good": len(good), "inliers": inliers, "coverage": coverage,
        "ratio": round(inliers / len(good), 4),
    }


def main() -> None:
    captures = EXT / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    shots = {page.name: images(page) for page in pages}
    references = [(label, paths[0]) for label, paths in shots.items()]
    queries = [(label, path) for label, paths in shots.items() for path in paths[1:]]

    embedder = SSCDEmbedder(ROOT / "models" / "sscd_disc_mixup.torchscript.pt", 320)
    sift = cv2.SIFT_create(nfeatures=2500, contrastThreshold=0.012, edgeThreshold=16, sigma=1.2)
    labels = [label for label, _ in references]
    vectors = []
    local_refs = []
    for _, path in references:
        rgb = preprocess(path.read_bytes(), 1600, False).rgb
        vectors.append(embedder.embed(rgb))
        local_refs.append(sift_features(rgb, sift))
    bank = np.stack(vectors).astype(np.float64)

    cases = []
    started_all = time.perf_counter()
    for number, (truth, path) in enumerate(queries, 1):
        started = time.perf_counter()
        rgb = preprocess(path.read_bytes(), 1600, False).rgb
        rotations = embedder.embed_rotations(rotate_quadrants(rgb)).astype(np.float64)
        similarity = np.einsum("rd,nd->rn", rotations, bank, optimize=True).max(axis=0)
        order = np.argsort(-similarity)[:5]
        query_local = sift_features(rgb, sift)
        candidates = []
        for index in order:
            metrics = local_metrics(query_local, local_refs[int(index)])
            candidates.append({
                "label": labels[int(index)], "cosine": round(float(similarity[index]), 5),
                **metrics,
            })
        cases.append({
            "truth": truth, "file": str(path.relative_to(EXT)), "candidates": candidates,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        })
        if number % 25 == 0:
            print(f"{number}/{len(queries)}", flush=True)

    OUT.write_text(json.dumps(cases, indent=2))
    print(f"wrote {OUT} in {time.perf_counter() - started_all:.1f}s", flush=True)


if __name__ == "__main__":
    main()
