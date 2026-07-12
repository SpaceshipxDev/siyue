"""Evaluate original + detector-rectified SSCD retrieval."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.embed import SSCDEmbedder  # noqa: E402
from matcher.preprocess import preprocess, rotate_quadrants  # noqa: E402

EXT = ROOT / "testdata" / "external" / "smartdoc15-ch1"


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def main() -> None:
    source = EXT / "frames"
    crops = EXT / "detector-crops"
    backgrounds = sorted(path for path in source.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    references: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        references.append((label, first[0]))
        for background in backgrounds:
            pool = [path for path in images(background / label) if path != first[0]]
            queries.extend((label, path) for path in pool[1:3])

    embedder = SSCDEmbedder(ROOT / "models" / "sscd_disc_mixup.torchscript.pt", 320)
    reference_vectors = []
    for _, path in references:
        relative = path.relative_to(source)
        original = preprocess(path.read_bytes(), 1600, False).rgb
        rectified = preprocess((crops / relative).read_bytes(), 1600, False).rgb
        reference_vectors.append(np.stack([embedder.embed(original), embedder.embed(rectified)]))
    bank = np.stack(reference_vectors).astype(np.float64)  # pages, views, dimensions

    top1 = top5 = 0
    latencies = []
    cases = []
    for number, (truth, path) in enumerate(queries, 1):
        started = time.perf_counter()
        relative = path.relative_to(source)
        original = preprocess(path.read_bytes(), 1600, False).rgb
        rectified = preprocess((crops / relative).read_bytes(), 1600, False).rgb
        views = [*rotate_quadrants(original), *rotate_quadrants(rectified)]
        vectors = embedder.embed_rotations(views).astype(np.float64)
        # Maximum over query orientation/view and registered view.
        tensor = np.einsum("qd,pvd->qpv", vectors, bank, optimize=True)
        signals = {
            "original_original": tensor[:4, :, 0].max(axis=0),
            "original_crop": tensor[:4, :, 1].max(axis=0),
            "crop_original": tensor[4:, :, 0].max(axis=0),
            "crop_crop": tensor[4:, :, 1].max(axis=0),
        }
        similarities = signals["crop_crop"]
        order = np.argsort(-similarities)
        predictions = [labels[int(index)] for index in order[:5]]
        top1 += predictions[0] == truth
        top5 += truth in predictions
        latency = (time.perf_counter() - started) * 1000
        latencies.append(latency)
        cases.append({
            "truth": truth, "predictions": predictions,
            "scores": [round(float(similarities[index]), 5) for index in order[:5]],
            "signals": {name: [round(float(value), 6) for value in values] for name, values in signals.items()},
            "latency_ms": round(latency, 1),
        })
        if number % 50 == 0:
            print(f"{number}/{len(queries)}", flush=True)
    report = {
        "references": len(references), "queries": len(queries),
        "top1": top1, "top1_pct": round(top1 / len(queries) * 100, 2),
        "top5": top5, "top5_pct": round(top5 / len(queries) * 100, 2),
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    (ROOT / "eval" / "dualview_sscd_cases.json").write_text(json.dumps(cases, indent=2))
    (ROOT / "eval" / "dualview_sscd_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
