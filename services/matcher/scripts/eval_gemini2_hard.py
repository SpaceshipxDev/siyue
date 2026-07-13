"""Cache Gemini Embedding 2 vectors for the held-out hard datasets."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import numpy as np

from eval_gemini2_probe import EXT, ROOT, download_stable


def images(directory: Path) -> list[Path]:
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    )


def save_dataset(
    tag: str, references: list[tuple[str, Path]], queries: list[tuple[str, Path]],
) -> dict:
    cache = ROOT / "eval" / f"gemini2_{tag}_embeddings.npz"
    labels = [label for label, _ in references] + [label for label, _ in queries]
    paths = [path for _, path in references] + [path for _, path in queries]
    if cache.exists():
        stored = np.load(cache)
        vectors = stored["vectors"]
        latencies = stored["latencies"]
    else:
        vectors, latencies = asyncio.run(download_stable(paths))
        np.savez_compressed(
            cache, vectors=vectors, latencies=latencies,
            labels=np.asarray(labels),
            paths=np.asarray([str(path.relative_to(EXT)) for path in paths]),
            reference_count=np.asarray([len(references)]),
        )
    count = len(references)
    ref_vectors = vectors[:count].astype(np.float64)
    query_vectors = vectors[count:].astype(np.float64)
    similarities = np.einsum("qd,rd->qr", query_vectors, ref_vectors, optimize=True)
    order = np.argsort(-similarities, axis=1)
    ref_labels = np.asarray(labels[:count])
    truths = np.asarray(labels[count:])
    top1 = int(np.sum(ref_labels[order[:, 0]] == truths))
    top5 = int(sum(truth in ref_labels[row[:5]] for truth, row in zip(truths, order)))
    result = {
        "slice": tag, "references": count, "queries": len(queries),
        "top1": top1, "top1_pct": round(top1 / len(queries) * 100, 2),
        "top5": top5, "top5_pct": round(top5 / len(queries) * 100, 2),
        "api_latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "api_latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    print(json.dumps(result), flush=True)
    return result


def smartdoc15() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    frames = EXT / "smartdoc15-ch1" / "frames"
    backgrounds = sorted(path for path in frames.iterdir() if path.is_dir())
    labels = sorted(path.name for path in backgrounds[0].iterdir() if path.is_dir())
    references: list[tuple[str, Path]] = []
    queries: list[tuple[str, Path]] = []
    for label in labels:
        first = images(backgrounds[0] / label)
        references.append((label, first[0]))
        for background in backgrounds:
            queries.extend(
                (label, path) for path in images(background / label)
                if path != first[0]
            )
    return references, queries


def docunet() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    pairs: dict[str, list[Path]] = {}
    for path in images(EXT / "docunet" / "crop"):
        pairs.setdefault(path.name.split("_")[0], []).append(path)
    references = [(label, sorted(paths)[0]) for label, paths in sorted(pairs.items())]
    queries = [(label, sorted(paths)[1]) for label, paths in sorted(pairs.items())]
    return references, queries


def main() -> None:
    results = [
        save_dataset("smartdoc15", *smartdoc15()),
        save_dataset("docunet", *docunet()),
    ]
    (ROOT / "eval" / "gemini2_hard_report.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
