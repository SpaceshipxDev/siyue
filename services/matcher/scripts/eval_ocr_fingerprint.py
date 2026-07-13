"""Evaluate cached Tesseract text fingerprints on detector-rectified frames."""

from __future__ import annotations

import json
import re
import subprocess
import time
from collections import Counter
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "testdata" / "external" / "smartdoc15-ch1"
CROPS = DATASET / "detector-crops"
CACHE = ROOT / "eval" / "ocr_detector_text.json"


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def recognize(path: Path) -> tuple[str, float]:
    started = time.perf_counter()
    result = subprocess.run(
        ["tesseract", str(path), "stdout", "--psm", "6", "-l", "eng"],
        check=True, capture_output=True, text=True,
    )
    return result.stdout, (time.perf_counter() - started) * 1000


def fingerprint(text: str) -> Counter[str]:
    value = re.sub(r"[^a-z0-9]+", "", text.lower())
    return Counter(value[index:index + 3] for index in range(max(0, len(value) - 2)))


def cosine(first: Counter[str], second: Counter[str]) -> float:
    shared = first.keys() & second.keys()
    numerator = sum(first[key] * second[key] for key in shared)
    first_norm = sum(value * value for value in first.values()) ** 0.5
    second_norm = sum(value * value for value in second.values()) ** 0.5
    return numerator / max(first_norm * second_norm, 1e-9)


def main() -> None:
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
    all_paths = [path for _, path in references] + [path for _, path in queries]

    cached = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    latencies = []
    for number, path in enumerate(all_paths, 1):
        key = str(path.relative_to(CROPS))
        if key not in cached:
            text, latency = recognize(path)
            cached[key] = {"text": text, "latency_ms": round(latency, 1)}
            latencies.append(latency)
        if number % 50 == 0:
            print(f"ocr {number}/{len(all_paths)}", flush=True)
    CACHE.write_text(json.dumps(cached, ensure_ascii=False, indent=2))

    ref_fingerprints = [fingerprint(cached[str(path.relative_to(CROPS))]["text"]) for _, path in references]
    top1 = top5 = 0
    cases = []
    for truth, path in queries:
        query = fingerprint(cached[str(path.relative_to(CROPS))]["text"])
        scores = np.asarray([cosine(query, reference) for reference in ref_fingerprints])
        order = np.argsort(-scores)
        top1 += labels[int(order[0])] == truth
        top5 += truth in [labels[int(index)] for index in order[:5]]
        cases.append({
            "truth": truth, "scores": [round(float(value), 6) for value in scores],
            "top5": [labels[int(index)] for index in order[:5]],
        })
    query_latencies = [cached[str(path.relative_to(CROPS))]["latency_ms"] for _, path in queries]
    report = {
        "references": len(references), "queries": len(queries),
        "top1": top1, "top1_pct": round(top1 / len(queries) * 100, 2),
        "top5": top5, "top5_pct": round(top5 / len(queries) * 100, 2),
        "latency_p50_ms": round(float(np.percentile(query_latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(query_latencies, 95)), 1),
    }
    (ROOT / "eval" / "ocr_fingerprint_cases.json").write_text(json.dumps(cases, indent=2))
    (ROOT / "eval" / "ocr_fingerprint_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
