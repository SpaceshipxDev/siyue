from __future__ import annotations

import time
import os
from collections import defaultdict
from pathlib import Path
from threading import RLock

import numpy as np

from .bank import Page, PageBank
from .config import Settings
from .embed import SSCDEmbedder
from .features import FeatureModels
from .preprocess import preprocess, rotate_quadrants
from .score import Candidate
from .verify import verify_pair


class MatcherEngine:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        # Keep Torch Hub's SuperPoint/LightGlue artifacts with the service rather
        # than leaking setup state into a developer home directory.
        os.environ.setdefault("TORCH_HOME", str(self.settings.model_dir.resolve() / "torch-cache"))
        self.bank = PageBank(self.settings.data_dir)
        self.embedder = SSCDEmbedder(self.settings.sscd_path, self.settings.embed_size)
        self.features = FeatureModels(self.settings.max_keypoints, self.settings.feature_resize)
        self.lock = RLock()

    def register(self, image: bytes, page_id: str, component_id: str, kind: str) -> None:
        if not page_id.strip() or len(page_id) > 256:
            raise ValueError("page_id must be 1..256 characters")
        if not component_id.strip() or len(component_id) > 256:
            raise ValueError("component_id must be 1..256 characters")
        if kind not in {"front", "program", "drawing", "other"}:
            raise ValueError("kind must be front, program, drawing, or other")
        item = preprocess(image, self.settings.max_side, self.settings.doc_crop)
        with self.lock:
            embedding = self.embedder.embed(item.rgb)
            features = self.features.extract(item.rgb)
            self.bank.upsert(page_id, component_id, kind, item.rgb, embedding, self.features.to_numpy(features))

    def _passes(self, candidate: Candidate) -> bool:
        s = self.settings
        return (
            candidate.cosine >= s.min_cosine and candidate.inliers >= s.min_inliers
            and candidate.inlier_ratio >= s.min_inlier_ratio
            and candidate.coverage >= s.min_coverage
            and candidate.edge_agreement >= s.min_edge_agreement
            and candidate.score >= s.min_score
        )

    def match(self, image: bytes) -> dict:
        started = time.perf_counter()
        item = preprocess(image, self.settings.max_side, self.settings.doc_crop)
        rotations = rotate_quadrants(item.rgb)
        t0 = time.perf_counter()
        query_vectors = self.embedder.embed_rotations(rotations)
        embed_ms = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        pages = self.bank.all()
        if not pages:
            return self._response("no_match", None, [], started, embed_ms, 0.0, 0.0)
        bank_vectors = np.stack([page.embedding for page in pages])
        # Float64 einsum avoids spurious Accelerate/BLAS floating-point warnings
        # observed after OpenCV kernels on Apple Silicon; vectors are finite and
        # normalized, and the bank is small enough that this has negligible cost.
        similarities = np.einsum(
            "rd,nd->rn", query_vectors.astype(np.float64), bank_vectors.astype(np.float64),
            optimize=True,
        ).astype(np.float32)
        best_rotation = similarities.argmax(axis=0)
        best_cosine = similarities.max(axis=0)
        order = np.argsort(-best_cosine)[: self.settings.shortlist_k]
        shortlist_ms = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        query_feature_cache: dict[int, dict] = {}
        results: list[Candidate] = []
        embedding_winner_passed = False
        verify_limit = min(self.settings.verify_k, len(order))
        wide_embedding_margin = (
            len(order) > 1
            and best_cosine[order[0]] - best_cosine[order[1]] >= self.settings.early_cosine_margin
        )
        for rank, index in enumerate(order[:verify_limit]):
            page = pages[int(index)]
            reference_features = self.features.from_numpy(self.bank.load_features(page))
            reference_rgb = self.bank.load_image(page)
            candidate = None
            # SSCD can be quadrant-ambiguous on symmetric forms. Always try its
            # best rotation first; only if geometry rejects it, fall back through
            # the remaining rotations and retain the strongest geometric proof.
            rotation_ranking = [int(value) for value in np.argsort(-similarities[:, index])]
            if rank == 0:
                rotations_to_try = rotation_ranking
            else:
                rotations_to_try = rotation_ranking[:1]
                # If the retrieval winner failed geometry, a close SSCD runner-up
                # may be the real page with a 180-degree embedding ambiguity.
                # Bound this fallback to close candidates; query features are
                # cached, so it adds a matcher call but usually no extraction.
                if (
                    not embedding_winner_passed
                    and best_cosine[order[0]] - best_cosine[index] <= 0.06
                ):
                    rotations_to_try = rotation_ranking
            for rotation in rotations_to_try:
                rotation = int(rotation)
                if rotation not in query_feature_cache:
                    query_feature_cache[rotation] = self.features.extract(rotations[rotation])
                metrics = verify_pair(
                    self.features, reference_rgb, rotations[rotation], reference_features,
                    query_feature_cache[rotation], self.settings.homography_threshold,
                )
                attempt = Candidate(
                    page.page_id, page.component_id, float(metrics["score"]), float(best_cosine[index]),
                    int(metrics["inliers"]), float(metrics["inlier_ratio"]), int(metrics["coverage"]),
                    float(metrics["edge_agreement"]),
                )
                if candidate is None or attempt.score > candidate.score:
                    candidate = attempt
                if self._passes(attempt):
                    candidate = attempt
                    break
            assert candidate is not None
            results.append(candidate)
            if rank == 0:
                embedding_winner_passed = self._passes(candidate)
            # Early exit is safe only after the embedding winner also passes every
            # geometric gate. If it fails, continue down the shortlist.
            if rank == 0 and wide_embedding_margin and self._passes(candidate):
                break
        results.sort(key=lambda result: result.score, reverse=True)
        verify_ms = (time.perf_counter() - t0) * 1000
        accepted = [result for result in results if self._passes(result)]
        decision = "no_match"
        best = accepted[0] if accepted else (results[0] if results else None)
        if accepted:
            decision = "match"
            if len(accepted) > 1:
                relative_margin = (accepted[0].score - accepted[1].score) / max(accepted[0].score, 1e-9)
                if relative_margin < self.settings.ambiguous_score_margin and accepted[1].cosine >= self.settings.ambiguous_min_cosine:
                    decision = "ambiguous"
        return self._response(decision, best, results[:5], started, embed_ms, shortlist_ms, verify_ms)

    @staticmethod
    def _response(decision, best, candidates, started, embed_ms, shortlist_ms, verify_ms) -> dict:
        return {
            "decision": decision,
            "best": best.public() if best else None,
            "candidates": [candidate.public() for candidate in candidates],
            "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            "stages": {
                "embed_ms": round(embed_ms, 2), "shortlist_ms": round(shortlist_ms, 2),
                "verify_ms": round(verify_ms, 2),
            },
        }

    def stats(self) -> dict:
        return {
            "bank_size": self.bank.count(),
            "models": {
                "embedding": self.embedder.model_name,
                "features": self.features.superpoint_version,
                "matcher": self.features.lightglue_version,
            },
            "settings": {
                key: str(value) if isinstance(value, Path) else value
                for key, value in vars(self.settings).items()
            },
        }
