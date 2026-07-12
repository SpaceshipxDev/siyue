"""Benchmark a fast local-feature document fingerprint on external datasets.

This is intentionally independent of the production engine.  It answers the
architecture question first: can CPU SIFT retrieval identify the same page
across real capture changes quickly enough to replace the multi-second learned
geometric cascade?

All outputs stay beside the matcher on the external SSD.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "testdata" / "external"
OUT = ROOT / "eval" / "fast_local_probe.json"


@dataclass
class Features:
    keypoints: np.ndarray
    descriptors: np.ndarray
    width: int
    height: int


@dataclass
class Result:
    slice: str
    references: int
    queries: int
    correct: int
    accuracy_pct: float
    latency_p50_ms: float
    latency_p95_ms: float


def image_paths(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


def load_gray(path: Path, max_side: int = 1280) -> np.ndarray:
    with Image.open(path) as image:
        rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
    height, width = rgb.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale < 1.0:
        rgb = cv2.resize(
            rgb, (round(width * scale), round(height * scale)),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # Local contrast normalization is cheap and reduces illumination/stain bias.
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


class FastIndex:
    def __init__(self, nfeatures: int = 2200):
        self.sift = cv2.SIFT_create(
            nfeatures=nfeatures, contrastThreshold=0.015, edgeThreshold=16,
            sigma=1.2,
        )
        self.labels: list[str] = []
        self.features: list[Features] = []
        self.flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=48))

    def extract(self, path: Path) -> Features:
        gray = load_gray(path)
        keypoints, descriptors = self.sift.detectAndCompute(gray, None)
        if descriptors is None or not keypoints:
            descriptors = np.empty((0, 128), np.float32)
            points = np.empty((0, 2), np.float32)
        else:
            points = np.asarray([point.pt for point in keypoints], np.float32)
            descriptors = np.asarray(descriptors, np.float32)
        return Features(points, descriptors, gray.shape[1], gray.shape[0])

    def build(self, references: list[tuple[str, Path]]) -> None:
        for label, path in references:
            feature = self.extract(path)
            if len(feature.descriptors) < 8:
                continue
            self.labels.append(label)
            self.features.append(feature)
            self.flann.add([feature.descriptors])
        self.flann.train()

    def retrieve(self, query: Features, neighbours: int = 12) -> list[tuple[int, float, int]]:
        if len(query.descriptors) == 0:
            return []
        matches = self.flann.knnMatch(query.descriptors, k=min(neighbours, 2 * len(self.labels)))
        votes: defaultdict[int, float] = defaultdict(float)
        counts: defaultdict[int, int] = defaultdict(int)
        for row in matches:
            best_by_page: dict[int, float] = {}
            for match in row:
                best_by_page.setdefault(match.imgIdx, match.distance)
            ranked = sorted(best_by_page.items(), key=lambda item: item[1])
            if len(ranked) < 2:
                continue
            page, distance = ranked[0]
            other_distance = ranked[1][1]
            ratio = distance / max(other_distance, 1e-6)
            if ratio < 0.88:
                # Margin-weighted vote; repeated layout features receive little weight.
                votes[page] += (1.0 - ratio) ** 2
                counts[page] += 1
        return sorted(
            ((page, votes[page], counts[page]) for page in votes),
            key=lambda item: (item[1], item[2]), reverse=True,
        )

    def identify(self, path: Path) -> tuple[str | None, float]:
        started = time.perf_counter()
        query = self.extract(path)
        ranked = self.retrieve(query)
        label = self.labels[ranked[0][0]] if ranked else None
        return label, (time.perf_counter() - started) * 1000


def evaluate(name: str, references: list[tuple[str, Path]], queries: list[tuple[str, Path]]) -> Result:
    index = FastIndex()
    index.build(references)
    correct = 0
    latencies: list[float] = []
    for truth, path in queries:
        prediction, latency = index.identify(path)
        correct += prediction == truth
        latencies.append(latency)
    values = np.asarray(latencies)
    result = Result(
        slice=name,
        references=len(references),
        queries=len(queries),
        correct=correct,
        accuracy_pct=round(correct / max(len(queries), 1) * 100, 2),
        latency_p50_ms=round(float(np.percentile(values, 50)), 1),
        latency_p95_ms=round(float(np.percentile(values, 95)), 1),
    )
    print(json.dumps(asdict(result)), flush=True)
    return result


def smartdoc_qa() -> Result:
    captures = EXT / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    shots = {page.name: image_paths(page) for page in pages}
    references = [(label, paths[0]) for label, paths in shots.items()]
    queries = [(label, path) for label, paths in shots.items() for path in paths[1:]]
    return evaluate("smartdoc-qa/phone-ref", references, queries)


def smartdoc15() -> Result:
    frames = EXT / "smartdoc15-ch1" / "frames"
    backgrounds = sorted(path for path in frames.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    references: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = image_paths(backgrounds[0] / label)
        references.append((label, first[0]))
        for background in backgrounds:
            for path in image_paths(background / label):
                if path != first[0]:
                    queries.append((label, path))
    return evaluate("smartdoc15/all-video-frames", references, queries)


def docunet() -> Result:
    pairs: defaultdict[str, list[Path]] = defaultdict(list)
    for path in image_paths(EXT / "docunet" / "crop"):
        pairs[path.name.split("_")[0]].append(path)
    references = [(label, sorted(paths)[0]) for label, paths in sorted(pairs.items())]
    queries = [(label, sorted(paths)[1]) for label, paths in sorted(pairs.items())]
    return evaluate("docunet/crumpled-pairs", references, queries)


def main() -> None:
    results = [smartdoc_qa(), smartdoc15(), docunet()]
    OUT.write_text(json.dumps([asdict(result) for result in results], indent=2))


if __name__ == "__main__":
    main()
