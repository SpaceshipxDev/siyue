"""Measure SSCD retrieval independently from the slow geometric verifier."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.embed import SSCDEmbedder  # noqa: E402
from matcher.preprocess import preprocess, rotate_quadrants  # noqa: E402

EXT = ROOT / "testdata" / "external"
OUT = ROOT / "eval" / "sscd_retrieval_probe.json"


@dataclass
class Result:
    slice: str
    references: int
    queries: int
    top1: int
    top5: int
    top1_pct: float
    top5_pct: float
    latency_p50_ms: float
    latency_p95_ms: float


def images(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


class Index:
    def __init__(self):
        self.embedder = SSCDEmbedder(ROOT / "models" / "sscd_disc_mixup.torchscript.pt", 320)
        self.labels: list[str] = []
        self.vectors: np.ndarray | None = None

    def build(self, references: list[tuple[str, Path]]) -> None:
        self.labels = [label for label, _ in references]
        self.vectors = np.stack([
            self.embedder.embed(preprocess(path.read_bytes(), 1600, False).rgb)
            for _, path in references
        ])

    def identify(self, path: Path) -> tuple[list[str], float]:
        started = time.perf_counter()
        image = preprocess(path.read_bytes(), 1600, False).rgb
        rotations = self.embedder.embed_rotations(rotate_quadrants(image))
        assert self.vectors is not None
        similarity = np.einsum(
            "rd,nd->rn", rotations.astype(np.float64), self.vectors.astype(np.float64),
            optimize=True,
        )
        scores = similarity.max(axis=0)
        order = np.argsort(-scores)[:5]
        return [self.labels[int(index)] for index in order], (time.perf_counter() - started) * 1000


def evaluate(name: str, references: list[tuple[str, Path]], queries: list[tuple[str, Path]]) -> Result:
    index = Index()
    index.build(references)
    top1 = top5 = 0
    latencies: list[float] = []
    for truth, path in queries:
        predictions, latency = index.identify(path)
        top1 += bool(predictions and predictions[0] == truth)
        top5 += truth in predictions
        latencies.append(latency)
    values = np.asarray(latencies)
    result = Result(
        slice=name, references=len(references), queries=len(queries), top1=top1, top5=top5,
        top1_pct=round(top1 / max(1, len(queries)) * 100, 2),
        top5_pct=round(top5 / max(1, len(queries)) * 100, 2),
        latency_p50_ms=round(float(np.percentile(values, 50)), 1),
        latency_p95_ms=round(float(np.percentile(values, 95)), 1),
    )
    print(json.dumps(asdict(result)), flush=True)
    return result


def datasets() -> list[tuple[str, list[tuple[str, Path]], list[tuple[str, Path]]]]:
    output = []
    captures = EXT / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    shots = {page.name: images(page) for page in pages}
    output.append((
        "smartdoc-qa/phone-ref",
        [(label, paths[0]) for label, paths in shots.items()],
        [(label, path) for label, paths in shots.items() for path in paths[1:]],
    ))

    frames = EXT / "smartdoc15-ch1" / "frames"
    backgrounds = sorted(path for path in frames.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    refs: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        refs.append((label, first[0]))
        for background in backgrounds:
            queries.extend(
                (label, path) for path in images(background / label)
                if path != first[0]
            )
    output.append(("smartdoc15/all-video-frames", refs, queries))

    crop = EXT / "docunet" / "crop"
    pairs: dict[str, list[Path]] = {}
    for path in images(crop):
        pairs.setdefault(path.name.split("_")[0], []).append(path)
    output.append((
        "docunet/crumpled-pairs",
        [(label, sorted(paths)[0]) for label, paths in sorted(pairs.items())],
        [(label, sorted(paths)[1]) for label, paths in sorted(pairs.items())],
    ))
    return output


def main() -> None:
    results = [evaluate(*dataset) for dataset in datasets()]
    OUT.write_text(json.dumps([asdict(result) for result in results], indent=2))


if __name__ == "__main__":
    main()
