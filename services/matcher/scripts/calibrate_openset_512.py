"""Dump per-query verified-candidate metrics for open-set gate calibration.

Mirrors eval_v2_external.py's smartdoc-qa protocol exactly (same references,
same queries) but records every verified candidate's full metrics so gate
configurations can be searched offline without re-running the models.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from matcher.config import Settings  # noqa: E402
from matcher.engine import MatcherEngine  # noqa: E402


def images(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


def engine(tag: str) -> MatcherEngine:
    data = ROOT / "data-eval-v2" / tag
    shutil.rmtree(data, ignore_errors=True)
    return MatcherEngine(Settings(data_dir=data, model_dir=ROOT / "models"))


def run(tag: str, references, queries, out):
    matcher = engine(tag)
    for label, path in references:
        matcher.register(path.read_bytes(), f"page:{label}", label, "other")
    records = []
    for truth, path in queries:
        result = matcher.match(path.read_bytes())
        records.append({
            "truth": truth,
            "query": path.name,
            "decision": result["decision"],
            "via": result.get("via"),
            "latency_ms": result["latency_ms"],
            "best": result["best"],
            "candidates": result["candidates"],
        })
        sys.stderr.write(".")
        sys.stderr.flush()
    (ROOT / "eval" / out).write_text(json.dumps(records, indent=1))
    sys.stderr.write(f"\n{tag}: {len(records)} queries -> eval/{out}\n")


def main() -> None:
    captures = ROOT / "testdata" / "external" / "smartdoc-qa" / "captures"
    pages = sorted(path for path in captures.iterdir() if path.is_dir())
    shots = {page.name: images(page) for page in pages}
    labels = sorted(shots)

    run(
        "cal_known_512",
        [(label, shots[label][0]) for label in labels],
        [(label, path) for label in labels for path in shots[label][1:]],
        "cal_known_512.json",
    )
    run(
        "cal_unknown_512",
        [(label, shots[label][0]) for label in labels[:10]],
        [(label, path) for label in labels[10:] for path in shots[label]],
        "cal_unknown_512.json",
    )


if __name__ == "__main__":
    main()
