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
    feature_resize: int = _int("MATCHER_FEATURE_RESIZE", 768)
    max_keypoints: int = _int("MATCHER_MAX_KEYPOINTS", 768)
    shortlist_k: int = _int("MATCHER_SHORTLIST_K", 8)
    verify_k: int = _int("MATCHER_VERIFY_K", 5)
    min_cosine: float = _float("MATCHER_MIN_COSINE", 0.20)
    min_inliers: int = _int("MATCHER_MIN_INLIERS", 35)
    min_inlier_ratio: float = _float("MATCHER_MIN_INLIER_RATIO", 0.22)
    min_coverage: int = _int("MATCHER_MIN_COVERAGE", 8)
    min_edge_agreement: float = _float("MATCHER_MIN_EDGE", 0.10)
    min_score: float = _float("MATCHER_MIN_SCORE", 300.0)
    early_cosine_margin: float = _float("MATCHER_EARLY_COSINE_MARGIN", 0.08)
    ambiguous_score_margin: float = _float("MATCHER_AMBIGUOUS_MARGIN", 0.18)
    ambiguous_min_cosine: float = _float("MATCHER_AMBIGUOUS_COSINE", 0.72)
    homography_threshold: float = _float("MATCHER_H_THRESHOLD", 3.0)
    doc_crop: bool = os.getenv("MATCHER_DOC_CROP", "0").lower() in {"1", "true", "yes"}

    @property
    def sscd_path(self) -> Path:
        return self.model_dir / "sscd_disc_mixup.torchscript.pt"
