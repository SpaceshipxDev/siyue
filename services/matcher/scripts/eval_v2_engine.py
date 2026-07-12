"""End-to-end evaluation of the integrated low-latency matcher."""

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

FRAMES = ROOT / "testdata" / "external" / "smartdoc15-ch1" / "frames"
DATA = ROOT / "data-eval-v2"
REPORT = ROOT / "eval" / "v2_engine_report.json"


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".jpeg"})


def main() -> None:
    shutil.rmtree(DATA, ignore_errors=True)
    engine = MatcherEngine(Settings(data_dir=DATA, model_dir=ROOT / "models"))
    backgrounds = sorted(path for path in FRAMES.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        engine.register(first[0].read_bytes(), f"page:{label}", label, "other")
        for background in backgrounds:
            pool = [path for path in images(background / label) if path != first[0]]
            queries.extend((label, path) for path in pool[1:3])

    correct = wrong = no_match = ambiguous = 0
    latencies = []
    cases = []
    for number, (truth, path) in enumerate(queries, 1):
        result = engine.match(path.read_bytes())
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
        cases.append({"truth": truth, "prediction": prediction, **result})
        if number % 50 == 0:
            print(f"matched {number}/{len(queries)}", flush=True)
    report = {
        "references": len(labels), "queries": len(queries),
        "correct": correct, "accuracy_pct": round(correct / len(queries) * 100, 2),
        "wrong_match": wrong, "no_match": no_match, "ambiguous": ambiguous,
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    REPORT.write_text(json.dumps({"summary": report, "cases": cases}, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
