from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path(os.getenv("MATCHER_DATA", "data"))
    model_dir: Path = Path(os.getenv("MATCHER_MODELS", "models"))
    max_side: int = _int("MATCHER_MAX_SIDE", 1600)
    embed_size: int = _int("MATCHER_EMBED_SIZE", 320)
    feature_resize: int = _int("MATCHER_FEATURE_RESIZE", 416)
    max_keypoints: int = _int("MATCHER_MAX_KEYPOINTS", 288)
    shortlist_k: int = _int("MATCHER_SHORTLIST_K", 8)
    verify_k: int = _int("MATCHER_VERIFY_K", 5)
    min_cosine: float = _float("MATCHER_MIN_COSINE", 0.20)
    # Open-set calibration (eval/cal_known.json vs eval/cal_unknown.json):
    # every observed unknown-page false accept had <=24 inliers, while p10 of
    # true accepts is 47. Floor 25; 25..39 needs corroboration; >=40 stands
    # alone. Composite score / edge gates stay out of acceptance — rectified
    # true matches legitimately score 0.0 edge at the 416px verify size.
    min_inliers: int = _int("MATCHER_MIN_INLIERS", 14)
    medium_inliers: int = _int("MATCHER_MEDIUM_INLIERS", 25)
    strong_inliers: int = _int("MATCHER_STRONG_INLIERS", 40)
    weak_min_ratio: float = _float("MATCHER_WEAK_MIN_RATIO", 0.28)
    medium_min_ratio: float = _float("MATCHER_MEDIUM_MIN_RATIO", 0.35)
    medium_min_coverage: int = _int("MATCHER_MEDIUM_MIN_COVERAGE", 6)
    min_inlier_ratio: float = _float("MATCHER_MIN_INLIER_RATIO", 0.11)
    min_coverage: int = _int("MATCHER_MIN_COVERAGE", 3)
    # Gemini fallback must prove itself, not argmax: same-page nearest
    # similarity on crumples is >=0.889 with margin p5=0.053 over the runner-
    # up, while unknown pages' nearest neighbours cluster below both bars.
    gemini_min_score: float = _float("MATCHER_GEMINI_MIN_SCORE", 0.90)
    gemini_min_margin: float = _float("MATCHER_GEMINI_MIN_MARGIN", 0.04)
    min_edge_agreement: float = _float("MATCHER_MIN_EDGE", 0.10)
    min_score: float = _float("MATCHER_MIN_SCORE", 300.0)
    early_cosine_margin: float = _float("MATCHER_EARLY_COSINE_MARGIN", 0.03)
    ambiguous_score_margin: float = _float("MATCHER_AMBIGUOUS_MARGIN", 0.18)
    ambiguous_min_cosine: float = _float("MATCHER_AMBIGUOUS_COSINE", 0.72)
    homography_threshold: float = _float("MATCHER_H_THRESHOLD", 3.0)
    doc_crop: bool = os.getenv("MATCHER_DOC_CROP", "0").lower() in {"1", "true", "yes"}
    learned_crop: bool = os.getenv("MATCHER_LEARNED_CROP", "1").lower() in {"1", "true", "yes"}

    @property
    def sscd_path(self) -> Path:
        return self.model_dir / "sscd_disc_mixup.torchscript.pt"

    @property
    def detector_path(self) -> Path:
        return self.model_dir / "document_corners_mobilenet_v3_small.pt"
