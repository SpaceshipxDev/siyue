"""Validate the fixed confidence-gated fusion rule on held-out hard sets."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from eval_fusion_probe import local_metrics, sift_features  # noqa: E402
from eval_gemini2_hard import EXT, docunet, images  # noqa: E402
from matcher.embed import SSCDEmbedder  # noqa: E402
from matcher.preprocess import preprocess, rotate_quadrants  # noqa: E402


def oracle_video() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    frames = EXT / "smartdoc15-ch1" / "oracle-crops"
    backgrounds = sorted(path for path in frames.iterdir() if path.is_dir())
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


def local_score(candidate: dict) -> float:
    return candidate["cosine"] + 0.0004 * candidate["inliers"] + 0.00004 * candidate["good"]


def fusion_score(candidate: dict) -> float:
    return (
        2.0 * candidate["cosine"] + 2.0 * candidate["gemini"]
        + 0.002 * candidate["inliers"] + 0.0005 * candidate["good"]
    )


def evaluate(
    tag: str,
    references: list[tuple[str, Path]],
    queries: list[tuple[str, Path]],
    gemini_cache: Path,
) -> dict:
    output = ROOT / "eval" / f"fusion_{tag}_cases.json"
    gemini = np.load(gemini_cache)
    gemini_vectors = gemini["vectors"].astype(np.float64)
    count = len(references)
    assert len(gemini_vectors) == count + len(queries)

    embedder = SSCDEmbedder(ROOT / "models" / "sscd_disc_mixup.torchscript.pt", 320)
    sift = cv2.SIFT_create(nfeatures=2500, contrastThreshold=0.012, edgeThreshold=16, sigma=1.2)
    labels = [label for label, _ in references]
    vectors = []
    local_refs = []
    for _, path in references:
        rgb = preprocess(path.read_bytes(), 1600, False).rgb
        vectors.append(embedder.embed(rgb))
        local_refs.append(sift_features(rgb, sift))
    bank = np.stack(vectors).astype(np.float64)
    gemini_bank = gemini_vectors[:count]

    cases = []
    for number, (truth, path) in enumerate(queries, 1):
        started = time.perf_counter()
        rgb = preprocess(path.read_bytes(), 1600, False).rgb
        rotations = embedder.embed_rotations(rotate_quadrants(rgb)).astype(np.float64)
        sscd = np.einsum("rd,nd->rn", rotations, bank, optimize=True).max(axis=0)
        gemini_scores = np.einsum("d,nd->n", gemini_vectors[count + number - 1], gemini_bank)
        sscd_order = np.argsort(-sscd)[:5]
        gemini_order = np.argsort(-gemini_scores)[:5]
        candidate_indices = list(dict.fromkeys([*map(int, sscd_order), *map(int, gemini_order)]))
        query_local = sift_features(rgb, sift)
        candidates = []
        for index in candidate_indices:
            candidates.append({
                "label": labels[index], "cosine": round(float(sscd[index]), 5),
                "gemini": round(float(gemini_scores[index]), 5),
                "sscd_top5": index in sscd_order, "gemini_top5": index in gemini_order,
                **local_metrics(query_local, local_refs[index]),
            })
        local_candidates = [candidate for candidate in candidates if candidate["sscd_top5"]]
        local_ranked = sorted(local_candidates, key=local_score, reverse=True)
        margin = local_score(local_ranked[0]) - local_score(local_ranked[1])
        fallback = margin < 0.03
        picked = max(candidates, key=fusion_score) if fallback else local_ranked[0]
        cases.append({
            "truth": truth, "prediction": picked["label"], "fallback": fallback,
            "local_margin": round(margin, 5), "latency_local_ms": round((time.perf_counter() - started) * 1000, 1),
            "candidates": candidates,
        })
        if number % 25 == 0:
            print(f"{tag}: {number}/{len(queries)}", flush=True)
    output.write_text(json.dumps(cases, indent=2))
    correct = sum(case["prediction"] == case["truth"] for case in cases)
    latencies = [case["latency_local_ms"] for case in cases]
    result = {
        "slice": tag, "queries": len(cases), "correct": correct,
        "accuracy_pct": round(correct / len(cases) * 100, 2),
        "gemini_fallbacks": sum(case["fallback"] for case in cases),
        "fallback_pct": round(sum(case["fallback"] for case in cases) / len(cases) * 100, 2),
        "local_latency_p50_ms": round(float(np.percentile(latencies, 50)), 1),
        "local_latency_p95_ms": round(float(np.percentile(latencies, 95)), 1),
    }
    print(json.dumps(result), flush=True)
    return result


def main() -> None:
    results = [
        evaluate(
            "smartdoc15_oracle", *oracle_video(),
            ROOT / "eval" / "gemini2_smartdoc15_oracle_embeddings.npz",
        ),
        evaluate(
            "docunet", *docunet(),
            ROOT / "eval" / "gemini2_docunet_embeddings.npz",
        ),
    ]
    (ROOT / "eval" / "fusion_hard_report.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
