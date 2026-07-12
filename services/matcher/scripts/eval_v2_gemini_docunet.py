"""End-to-end DocUNet audit with Gemini Embedding 2 deformation fallback."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

for line in (PROJECT / ".env.local").read_text().splitlines():
    if line.startswith("GEMINI_API_KEY="):
        os.environ["GEMINI_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
        break

from matcher.config import Settings  # noqa: E402
from matcher.engine import MatcherEngine  # noqa: E402

DATASET = ROOT / "testdata" / "external" / "docunet" / "crop"
DATA = ROOT / "data-eval-v2" / "docunet_gemini"
REPORT = ROOT / "eval" / "v2_gemini_docunet_report.json"


def images(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in {".jpg", ".png"})


def main() -> None:
    shutil.rmtree(DATA, ignore_errors=True)
    matcher = MatcherEngine(Settings(data_dir=DATA, model_dir=ROOT / "models"))
    pairs: dict[str, list[Path]] = {}
    for path in images(DATASET):
        pairs.setdefault(path.name.split("_")[0], []).append(path)
    references = [(label, sorted(paths)[0]) for label, paths in sorted(pairs.items())]
    queries = [(label, sorted(paths)[1]) for label, paths in sorted(pairs.items())]
    for number, (label, path) in enumerate(references, 1):
        matcher.register(path.read_bytes(), f"page:{label}", label, "other")
        if number % 10 == 0:
            print(f"registered {number}/{len(references)}", flush=True)

    correct = wrong = no_match = 0
    latencies = []
    via: dict[str, int] = {}
    for number, (truth, path) in enumerate(queries, 1):
        result = matcher.match(path.read_bytes())
        prediction = result["best"]["component_id"] if result["best"] else None
        if result["decision"] == "match" and prediction == truth:
            correct += 1
        elif result["decision"] == "no_match":
            no_match += 1
        else:
            wrong += 1
        latencies.append(result["latency_ms"])
        via[result.get("via", "local")] = via.get(result.get("via", "local"), 0) + 1
        if number % 10 == 0:
            print(f"matched {number}/{len(queries)}", flush=True)
    report = {
        "references": len(references), "queries": len(queries),
        "correct": correct, "accuracy_pct": round(correct / len(queries) * 100, 2),
        "wrong_match": wrong, "no_match": no_match, "via": via,
        "latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    REPORT.write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
