from __future__ import annotations

import time
import os
from collections import defaultdict
from pathlib import Path
from threading import RLock

import numpy as np
import httpx

from .bank import Page, PageBank
from .config import Settings
from .doc_detector import DocumentDetector
from .embed import SSCDEmbedder
from .features import FeatureModels
from .gemini_embed import GeminiEmbedder
from .preprocess import document_crop, preprocess, resize_long_side, rotate_quadrants
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
        self.detector = DocumentDetector(self.settings.detector_path)
        self.gemini = GeminiEmbedder()
        self.lock = RLock()

    def _prepare(self, image: bytes) -> np.ndarray:
        item = preprocess(image, self.settings.max_side, False)
        if self.settings.learned_crop and self.detector.available:
            # The classical contour path is reliable only when the sheet truly
            # fills the frame. On wider scenes it can lock onto tables, screens,
            # or machinery; reserve those cases for the learned detector.
            classical = document_crop(item.rgb)
            if classical is not None:
                area_ratio = classical.shape[0] * classical.shape[1] / max(
                    item.rgb.shape[0] * item.rgb.shape[1], 1,
                )
                if area_ratio >= 0.55:
                    return resize_long_side(classical, self.settings.max_side)
            rectified = self.detector.rectify(item.rgb)
            if rectified is not None:
                return rectified
        elif self.settings.doc_crop:
            classical = document_crop(item.rgb)
            if classical is not None:
                return resize_long_side(classical, self.settings.max_side)
        return item.rgb

    def register(self, image: bytes, page_id: str, component_id: str, kind: str) -> None:
        if not page_id.strip() or len(page_id) > 256:
            raise ValueError("page_id must be 1..256 characters")
        if not component_id.strip() or len(component_id) > 256:
            raise ValueError("component_id must be 1..256 characters")
        if kind not in {"front", "program", "drawing", "other"}:
            raise ValueError("kind must be front, program, drawing, or other")
        rgb = self._prepare(image)
        with self.lock:
            embedding = self.embedder.embed(rgb)
            features = self.features.extract(rgb)
            gemini_embedding = None
            if self.gemini.available:
                try:
                    gemini_embedding = self.gemini.embed(rgb)
                except (httpx.HTTPError, RuntimeError, ValueError):
                    # Registration remains available during a transient remote
                    # outage; local SSCD + LightGlue is the primary path.
                    gemini_embedding = None
            self.bank.upsert(
                page_id, component_id, kind, rgb, embedding,
                self.features.to_numpy(features), gemini_embedding,
            )

    def _passes(self, candidate: Candidate, retrieval_confident: bool) -> bool:
        s = self.settings
        if (
            candidate.cosine < s.min_cosine
            or candidate.inliers < s.min_inliers
            or candidate.inlier_ratio < s.min_inlier_ratio
            or candidate.coverage < s.min_coverage
        ):
            return False
        if candidate.inliers >= s.strong_inliers:
            return True
        # Geometric flukes on never-enrolled pages live below the strong bar,
        # so smaller consensus sets must corroborate: 25..39 needs a dense
        # ratio or a confident retrieval margin, 14..24 needs both a dense
        # ratio and page-wide spread (no observed fluke combines the two).
        if candidate.inliers >= s.medium_inliers:
            return candidate.inlier_ratio >= s.weak_min_ratio or retrieval_confident
        return (
            candidate.inlier_ratio >= s.medium_min_ratio
            and candidate.coverage >= s.medium_min_coverage
        )

    def match(self, image: bytes) -> dict:
        started = time.perf_counter()
        rgb = self._prepare(image)
        rotations = rotate_quadrants(rgb)
        t0 = time.perf_counter()
        query_vectors = self.embedder.embed_rotations(rotations)
        embed_ms = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        # The bank may still contain program sheets enrolled by older app
        # versions. Ignore them at query time so the policy applies immediately
        # without requiring a destructive migration of the matcher data dir.
        pages = [page for page in self.bank.all() if page.kind == "drawing"]
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
        wide_embedding_margin = (
            len(order) == 1
            or best_cosine[order[0]] - best_cosine[order[1]] >= self.settings.early_cosine_margin
        )
        # Confident SSCD queries need one cheap geometric proof. Only the
        # low-margin tail pays for a five-candidate LightGlue rerank.
        verify_limit = 1 if wide_embedding_margin else min(self.settings.verify_k, len(order))
        for rank, index in enumerate(order[:verify_limit]):
            page = pages[int(index)]
            reference_features = self.features.from_numpy(self.bank.load_features(page))
            reference_rgb = self.bank.load_image(page)
            # Rectified phone captures are normally upright. Verify that view
            # first: SSCD can prefer 180 degrees on symmetric forms even when
            # local correspondence is strongest at zero. Fall back to SSCD's
            # rotation only when upright evidence is weak.
            rotations_to_try = [0]
            preferred = int(best_rotation[index])
            if wide_embedding_margin and preferred != 0:
                rotations_to_try.append(preferred)
            best_metrics = None
            for rotation in rotations_to_try:
                if rotation not in query_feature_cache:
                    query_feature_cache[rotation] = self.features.extract(rotations[rotation])
                metrics = verify_pair(
                    self.features, reference_rgb, rotations[rotation], reference_features,
                    query_feature_cache[rotation], self.settings.homography_threshold,
                )
                if best_metrics is None or (metrics["inliers"], metrics["score"]) > (
                    best_metrics["inliers"], best_metrics["score"],
                ):
                    best_metrics = metrics
                if metrics["inliers"] >= self.settings.min_inliers:
                    break
            assert best_metrics is not None
            metrics = best_metrics
            candidate = Candidate(
                page.page_id, page.component_id, float(metrics["score"]), float(best_cosine[index]),
                int(metrics["inliers"]), float(metrics["inlier_ratio"]), int(metrics["coverage"]),
                float(metrics["edge_agreement"]),
            )
            results.append(candidate)
        if wide_embedding_margin:
            results.sort(key=lambda result: result.cosine, reverse=True)
        else:
            # Identity ranking is driven by consensus size. Coverage and edge
            # agreement remain rejection evidence, but must not overturn a much
            # larger correspondence set on blurred or partly occluded pages.
            results.sort(key=lambda result: (result.inliers, result.score), reverse=True)
        verify_ms = (time.perf_counter() - t0) * 1000
        accepted = [result for result in results if self._passes(result, wide_embedding_margin)]
        decision = "no_match"
        best = accepted[0] if accepted else (results[0] if results else None)
        if accepted:
            decision = "match"
            if len(accepted) > 1 and accepted[0].inliers == accepted[1].inliers:
                relative_margin = abs(accepted[0].score - accepted[1].score) / max(accepted[0].score, 1e-9)
                if relative_margin < self.settings.ambiguous_score_margin:
                    decision = "ambiguous"
        if decision == "no_match" and self.gemini.available:
            gemini_pages = [page for page in pages if page.gemini_embedding is not None]
            if gemini_pages:
                try:
                    query_gemini = self.gemini.embed(rgb).astype(np.float64)
                    bank_gemini = np.stack([
                        page.gemini_embedding for page in gemini_pages
                    ]).astype(np.float64)
                    gemini_scores = np.einsum("d,nd->n", query_gemini, bank_gemini)
                    ranked = np.argsort(-gemini_scores)
                    top = float(gemini_scores[ranked[0]])
                    runner_up = float(gemini_scores[ranked[1]]) if len(ranked) > 1 else -1.0
                    # An embedding ranks, it does not prove. Accept only when
                    # the neighbour is both absolutely close and clearly ahead
                    # of every other enrolled page; otherwise stay no_match so
                    # the OCR fallback / review queue can take over.
                    if (
                        top >= self.settings.gemini_min_score
                        and top - runner_up >= self.settings.gemini_min_margin
                    ):
                        page = gemini_pages[int(ranked[0])]
                        fallback = Candidate(
                            page.page_id, page.component_id, top, top, 0, 0.0, 0, 0.0,
                        )
                        response = self._response(
                            "match", fallback, [fallback], started,
                            embed_ms, shortlist_ms, verify_ms,
                        )
                        response["via"] = "gemini_embedding_2"
                        return response
                except (httpx.HTTPError, RuntimeError, ValueError):
                    pass
        response = self._response(decision, best, results[:5], started, embed_ms, shortlist_ms, verify_ms)
        response["via"] = "local"
        return response

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
