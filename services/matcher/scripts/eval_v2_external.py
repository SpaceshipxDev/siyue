"""Cross-dataset completion audit for the integrated v2 matcher."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.config import Settings  # noqa: E402
from matcher.engine import MatcherEngine  # noqa: E402

EXT = ROOT / "testdata" / "external"


def images(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


def engine(tag: str) -> MatcherEngine:
    data = ROOT / "data-eval-v2" / tag
    shutil.rmtree(data, ignore_errors=True)
    return MatcherEngine(Settings(data_dir=data, model_dir=ROOT / "models"))


def known_slice(tag: str, references: list[tuple[str, Path]], queries: list[tuple[str, Path]]) -> dict:
    matcher = engine(tag)
    for label, path in references:
        matcher.register(path.read_bytes(), f"page:{label}", label, "other")
    correct = wrong = no_match = ambiguous = 0
    latencies = []
    for truth, path in queries:
        result = matcher.match(path.read_bytes())
        prediction = result["best"]["component_id"] if result["best"] else None
        if result["decision"] == "match" and prediction == truth:
            correct += 1
        elif result["decision"] == "no_match":
            no_match += 1
        elif result["decision"] == "ambiguous":
            ambiguous += 1
        else:
            wrong += 1
        latencies.append(result["latency_ms"])
    output = {
        "slice": tag, "references": len(references), "queries": len(queries),
        "correct": correct, "accuracy_pct": round(correct / len(queries) * 100, 2),
        "wrong_match": wrong, "no_match": no_match, "ambiguous": ambiguous,
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    print(json.dumps(output), flush=True)
    return output


def smartdoc_qa() -> tuple[dict, dict]:
    captures = EXT / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    shots = {page.name: images(page) for page in pages}
    known = known_slice(
        "smartdoc_qa",
        [(label, paths[0]) for label, paths in shots.items()],
        [(label, path) for label, paths in shots.items() for path in paths[1:]],
    )

    labels = sorted(shots)
    matcher = engine("unknowns")
    for label in labels[:10]:
        matcher.register(shots[label][0].read_bytes(), f"page:{label}", label, "other")
    false_accepts = rejected = 0
    latencies = []
    for label in labels[10:]:
        for path in shots[label]:
            result = matcher.match(path.read_bytes())
            false_accepts += result["decision"] == "match"
            rejected += result["decision"] == "no_match"
            latencies.append(result["latency_ms"])
    unknown = {
        "slice": "smartdoc_qa_unknowns", "queries": len(latencies),
        "rejected": rejected, "false_accepts": false_accepts,
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
    }
    print(json.dumps(unknown), flush=True)
    return known, unknown


def docunet() -> dict:
    pairs: dict[str, list[Path]] = {}
    for path in images(EXT / "docunet" / "crop"):
        pairs.setdefault(path.name.split("_")[0], []).append(path)
    return known_slice(
        "docunet",
        [(label, sorted(paths)[0]) for label, paths in sorted(pairs.items())],
        [(label, sorted(paths)[1]) for label, paths in sorted(pairs.items())],
    )


def main() -> None:
    smartdoc, unknown = smartdoc_qa()
    results = [smartdoc, unknown, docunet()]
    (ROOT / "eval" / "v2_external_report.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
