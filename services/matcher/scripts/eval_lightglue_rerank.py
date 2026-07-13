"""Evaluate small-budget LightGlue only on ambiguous SSCD candidates."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.features import FeatureModels  # noqa: E402
from matcher.preprocess import preprocess  # noqa: E402
from matcher.verify import verify_pair  # noqa: E402

CROPS = ROOT / "testdata" / "external" / "smartdoc15-ch1" / "detector-crops"
CASES = ROOT / "eval" / "fusion_smartdoc15_detector_cases.json"
OUT = ROOT / "eval" / "lightglue_rerank_cases.json"
MARGIN = 0.03


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def dataset() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    backgrounds = sorted(path for path in CROPS.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    references: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        references.append((label, first[0]))
        for background in backgrounds:
            pool = [path for path in images(background / label) if path != first[0]]
            queries.extend((label, path) for path in pool[1:3])
    return references, queries


def main() -> None:
    references, queries = dataset()
    cases = json.loads(CASES.read_text())
    models = FeatureModels(max_keypoints=384, resize=512)
    ref_rgb = {}
    ref_features = {}
    for label, path in references:
        rgb = preprocess(path.read_bytes(), 1200, False).rgb
        ref_rgb[label] = rgb
        ref_features[label] = models.extract(rgb)

    output = {}
    for index, ((truth, path), case) in enumerate(zip(queries, cases)):
        ranked = sorted(
            (candidate for candidate in case["candidates"] if candidate["sscd_top5"]),
            key=lambda candidate: candidate["cosine"], reverse=True,
        )
        if ranked[0]["cosine"] - ranked[1]["cosine"] >= MARGIN:
            continue
        started = time.perf_counter()
        query_rgb = preprocess(path.read_bytes(), 1200, False).rgb
        query_features = models.extract(query_rgb)
        scores = []
        for candidate in ranked:
            metrics = verify_pair(
                models, ref_rgb[candidate["label"]], query_rgb,
                ref_features[candidate["label"]], query_features, 4.0,
            )
            scores.append({"label": candidate["label"], **metrics})
        # Rank by inliers first. The composite score's coverage/edge terms are
        # useful rejection gates but were shown to hurt identity ranking.
        prediction = max(scores, key=lambda item: (item["inliers"], item["score"]))["label"]
        output[str(index)] = {
            "truth": truth, "prediction": prediction, "scores": scores,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }
        if len(output) % 10 == 0:
            print(f"reranked {len(output)}", flush=True)
    OUT.write_text(json.dumps(output, indent=2))

    correct = 0
    for index, ((truth, _), case) in enumerate(zip(queries, cases)):
        ranked = sorted(
            (candidate for candidate in case["candidates"] if candidate["sscd_top5"]),
            key=lambda candidate: candidate["cosine"], reverse=True,
        )
        prediction = output[str(index)]["prediction"] if str(index) in output else ranked[0]["label"]
        correct += prediction == truth
    latencies = [item["latency_ms"] for item in output.values()]
    report = {
        "queries": len(queries), "correct": correct,
        "accuracy_pct": round(correct / len(queries) * 100, 2),
        "fallbacks": len(output),
        "fallback_latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "fallback_latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    (ROOT / "eval" / "lightglue_rerank_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
